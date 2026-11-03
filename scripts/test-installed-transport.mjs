// Uses installed libraries extracted to os.tmpdir(), never starts a DSH host.
// DSH_TEST_RUNTIME: directory containing extracted node_modules and Connection
// client.browser.js. Only a fake read-only service and fake credentials are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {registerRunnerRpc} from '../lib/runner-service.js';

const runtime=path.resolve(process.env.DSH_TEST_RUNTIME||'');
const relative=path.relative(os.tmpdir(),runtime);
assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Runtime must be extracted under os.tmpdir()');
const require=createRequire(path.join(runtime,'probe.mjs'));
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const {HostConnectionService}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')));
let bundle;
globalThis.window={__ModuleLoader__:{load:value=>{bundle=value;}}};
await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js')));
const browser=bundle.factory(()=>{throw Error('Unexpected browser dependency');});
await import('../lib/client.js');
const pluginClient=bundle.factory(()=>({}));
const host=new Context(),client=new Context(),routes=new Map(),seen=[];
let authenticated=true,calls=0;
host.provide('webServer',{host:'127.0.0.1',protocol:'http:',register:route=>{
  assert.ok(!routes.has(route.path));routes.set(route.path,route);return ()=>routes.delete(route.path);
}});
new HostConnectionService(host,[],{isAuthenticated:()=>authenticated,authenticateApi:()=>undefined});
const service={getQuota:async()=>{calls++;return {scope:'account-wide',windows:{five_hour:{remaining_percent:42}}};},getCatalog:async()=>({models:[{id:'fake-model'}]}),refreshCatalog:async()=>({models:[{id:'fake-model'}]}),getSubagents:async runId=>({runId}),runEventStream:()=>new Response('data: {}\n\n',{headers:{'content-type':'text/event-stream'}})};
const plugin={apply:ctx=>registerRunnerRpc(ctx,service)};
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
let fiber=host.plugin(plugin);await fiber;await settle();
assert.ok(routes.has('/codex-runner'),'Actual Cordis injection must register the HTTP route');
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const route=[...routes.values()].find(r=>pathname===r.path||pathname.startsWith(r.path+'/'));
  seen.push({path:pathname,method:req.method,registered:!!route});
  if(!route){res.writeHead(req.method==='POST'?405:404);res.end('static fallback');return;}
  Promise.resolve(route.handler(req,res)).catch(error=>{res.writeHead(500);res.end(String(error));});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port+'/';
try{
  browser.installConnection(client,{transport:{fetch:(input,init)=>fetch(new URL(input,base),init)}});
  const api=pluginClient.connectionApi(client.get('connection'));
  assert.equal((await api.getQuota({probe:'fresh'})).windows.five_hour.remaining_percent,42);

  assert.equal((await api.getCatalog({refresh:true})).models[0].id,'fake-model');
  assert.equal((await api.refreshCatalog()).models.length,1);
  const runId='11111111-1111-4111-8111-111111111111';
  assert.equal((await api.getSubagents(runId)).runId,runId);
  assert.ok(seen.every(r=>r.method==='POST'&&r.registered));
  console.log('PASS real browser Connection -> HTTP -> real host Connection -> plugin read-only service (4 methods)');
  const before=calls;
  await assert.rejects(api.getQuota({probe:'not-a-probe'}),/Invalid quota request/);
  await assert.rejects(api.getQuota({write:true}),/Invalid read-only service request/);
  const unknown=await client.get('connection').rpc.call('/codex-runner','setPolicy',{});assert.equal(unknown.ok,false);
  authenticated=false;await assert.rejects(api.getQuota({probe:'fresh'}),/HTTP 401/);authenticated=true;
  assert.equal(calls,before);console.log('PASS HTTP authentication, RPC argument validation and write rejection');
  const events=await host.get('connection').createSharedFetchHandler('/api').fetch(new Request(base+'api/codex-runner/run-events'),{principal:{kind:'owner'}});
  assert.equal(events.status,200);assert.equal(events.headers.get('content-type'),'text/event-stream');
  const denied=await host.get('connection').createSharedFetchHandler('/api').fetch(new Request(base+'api/codex-runner/run-events'),{principal:{kind:'guest'}});assert.equal(denied.status,403);
  await fiber.dispose();await settle();assert.equal(routes.size,0);
  await assert.rejects(api.getQuota({probe:'fresh'}),/HTTP 405/);
  assert.equal(seen.at(-1).registered,false);console.log('PASS reproduces screenshot HTTP 405 when plugin route is absent; service is never called');
  fiber=host.plugin(plugin);await fiber;await settle();
  assert.equal((await api.getQuota({probe:'fresh'})).windows.five_hour.remaining_percent,42);
  console.log('PASS route restoration, stream owner fence and disposal');
  console.log('INSTALLED-TRANSPORT-OK; actual libraries, isolated HTTP listener, fake credentials/service; live host not verified');
}finally{
  await client.fiber.dispose();await host.fiber.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
