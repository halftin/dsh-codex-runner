// Uses installed libraries extracted to os.tmpdir(), never starts a DSH host.
// DSH_TEST_RUNTIME: directory containing extracted node_modules and Connection
// client.browser.js. Only fake credentials, a fixture service and a temporary registry are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {registerRunnerRpc} from '../lib/runner-service.js';
import {createConfigurationEditor} from '../lib/configuration-editor.js';
import {DEFAULT_FIELD_REGISTRY,createFieldRegistryStore} from '../lib/codex-fields.js';
import {FALLBACK_CATALOG} from '../lib/model-catalog.js';

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
const editorHome=fs.mkdtempSync(path.join(os.tmpdir(),'shared-editor-'));
const editor=createConfigurationEditor({home:editorHome}),catalog={...FALLBACK_CATALOG,configuration:DEFAULT_FIELD_REGISTRY};
let registryTick=1000;
const fieldStore=createFieldRegistryStore({home:editorHome,now:()=>registryTick,identify:async()=>({version:'1.2.3',key:'transport-fixture'}),exportProtocol:async()=>({fields:{},protocol:[{name:'fixture.json',sha256:'fixture'}]}),fetchSchema:async()=>({type:'object',properties:{}})});
const service={getEditorRegistry:async({refresh=false}={})=>{if(refresh)registryTick+=1000;const configuration=await fieldStore.get({refresh});return editor.get({...catalog,configuration});},saveEditorRegistry:async args=>editor.save({...catalog,configuration:fieldStore.view()},args),getQuota:async()=>{calls++;return {scope:'account-wide',windows:{five_hour:{remaining_percent:42}}};},getCatalog:async()=>({models:[{id:'fake-model'}]}),refreshCatalog:async()=>({models:[{id:'fake-model'}]}),getSubagents:async runId=>({runId}),runEventStream:()=>new Response('data: {}\n\n',{headers:{'content-type':'text/event-stream'}})};
const plugin={apply:ctx=>registerRunnerRpc(ctx,service)};
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
const shared=host.get('connection').createSharedFetchHandler('/api');
routes.set('/api',{path:'/api',handler:async(req,res)=>{
  if(!authenticated){res.writeHead(401);res.end();return;}
  const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,body:Readable.toWeb(req),duplex:'half'});
  const response=await shared.fetch(request,{principal:{kind:'owner'}});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}});
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
  let registry=await api.getEditorRegistry();assert.equal(Object.keys(registry.definitions).length,31);
  assert.equal(Object.keys(registry.document.fields).length,21);
  assert.equal(registry.document.codexVersion,'1.2.3');const previousUpdate=registry.document.updatedAt;
  registry=await api.getEditorRegistry({refresh:true});assert.notEqual(registry.document.updatedAt,previousUpdate);
  assert.equal(registry.document.updatedAt,new Date(2000).toISOString());
  let registryDocument=structuredClone(registry.document);registryDocument.translations.settings.web_search={name:'网页搜索',description:'查询方式'};
  await api.saveEditorRegistry({document:registryDocument,revision:registry.revision,preview:true});
  assert.equal(fs.existsSync(path.join(editorHome,'codex-runner/i18n/zh-CN.user.json')),false);
  await api.saveEditorRegistry({document:registryDocument,revision:registry.revision});
  assert.equal((await api.getEditorRegistry()).document.translations.settings.web_search.name,'网页搜索');
  assert.equal((await api.getQuota({probe:'fresh'})).windows.five_hour.remaining_percent,42);

  assert.equal((await api.getCatalog({refresh:true})).models[0].id,'fake-model');
  assert.equal((await api.refreshCatalog()).models.length,1);
  const runId='11111111-1111-4111-8111-111111111111';
  assert.equal((await api.getSubagents(runId)).runId,runId);
  assert.ok(seen.every(r=>r.method==='POST'&&r.registered));
  console.log('PASS real browser Connection -> HTTP -> real host Connection -> plugin queries and registry editor (6 methods)');
  const before=calls;
  await assert.rejects(api.saveEditorRegistry({document:registryDocument,revision:registry.revision,path:editorHome}),/Invalid read-only/);
  await assert.rejects(api.getQuota({probe:'not-a-probe'}),/Invalid quota request/);
  await assert.rejects(api.getQuota({write:true}),/Invalid read-only service request/);
  const unknown=await client.get('connection').rpc.call('/codex-runner','setPolicy',{});assert.equal(unknown.ok,false);
  authenticated=false;await assert.rejects(api.getQuota({probe:'fresh'}),/HTTP 401/);authenticated=true;
  assert.equal(calls,before);console.log('PASS HTTP authentication, RPC argument validation and write rejection');
  const events=await host.get('connection').createSharedFetchHandler('/api').fetch(new Request(base+'api/codex-runner/run-events'),{principal:{kind:'owner'}});
  assert.equal(events.status,200);assert.equal(events.headers.get('content-type'),'text/event-stream');
  const denied=await host.get('connection').createSharedFetchHandler('/api').fetch(new Request(base+'api/codex-runner/run-events'),{principal:{kind:'guest'}});assert.equal(denied.status,403);
  // Drop only the dedicated carrier route: /api must still return real data.
  routes.delete('/codex-runner');
  assert.equal((await api.getQuota({probe:'fresh'})).windows.five_hour.remaining_percent,42);

  assert.equal((await api.getCatalog({refresh:true})).models[0].id,'fake-model');
  assert.equal((await api.refreshCatalog()).models.length,1);
  assert.equal((await api.getSubagents(runId)).runId,runId);
  assert.equal(seen.at(-1).path,'/api/codex-runner/getSubagents');
  registry=await api.getEditorRegistry();registryDocument=structuredClone(registry.document);registryDocument.translations.settings.web_search.name='共享接口检索';
  await api.saveEditorRegistry({document:registryDocument,revision:registry.revision});
  assert.equal((await api.getEditorRegistry()).document.translations.settings.web_search.name,'共享接口检索');
  const native=host.get('connection'),editorRoute=native.fetchRoutes.get('/api/codex-runner/getEditorRegistry');
  native.fetchRoutes.delete('/api/codex-runner/getEditorRegistry');
  await assert.rejects(api.getEditorRegistry(),error=>error.code==='codex-runner/editor-endpoint-unavailable'&&/HTTP 404/.test(error.message));
  assert.equal(fs.existsSync(path.join(editorHome,'codex-runner/i18n/zh-CN.user.json')),true,'404 reproduces with registry data present');
  native.fetchRoutes.set('/api/codex-runner/getEditorRegistry',editorRoute);
  assert.equal((await api.getEditorRegistry()).document.translations.settings.web_search.name,'共享接口检索');
  console.log('PASS reproduces missing editor endpoint HTTP 404 with real local registry; restoring route immediately restores loading');
  const count=calls;
  await assert.rejects(api.getQuota({probe:'bad'}),/Invalid quota request/);assert.equal(calls,count);
  const guest=await shared.fetch(new Request(base+'api/codex-runner/getQuota',{method:'POST'}),{principal:{kind:'guest'}});assert.equal(guest.status,403);
  const malformed=await shared.fetch(new Request(base+'api/codex-runner/getQuota',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{principal:{kind:'owner'}});assert.equal(malformed.status,400);
  authenticated=false;await assert.rejects(api.getQuota({probe:'fresh'}),/HTTP 401/);authenticated=true;
  console.log('PASS all six methods recover over shared /api after dedicated HTTP 405; auth/validation retained');
  await fiber.dispose();await settle();assert.deepEqual([...routes.keys()],['/api']);
  await assert.rejects(api.getQuota({probe:'fresh'}),/HTTP 404/);
  console.log('PASS both plugin surfaces removed on disposal; shared route returns 404');
  fiber=host.plugin(plugin);await fiber;await settle();
  assert.equal((await api.getQuota({probe:'fresh'})).windows.five_hour.remaining_percent,42);
  console.log('PASS route restoration, stream owner fence and disposal');
  console.log('SHARED-TRANSPORT-OK; actual libraries, isolated HTTP listener, fake credentials/service; live host not verified');
}finally{
  await client.fiber.dispose();await host.fiber.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(editorHome,{recursive:true,force:true});
}
