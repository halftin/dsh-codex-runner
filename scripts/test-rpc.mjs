import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {AppServerClient} from '../lib/app-server-client.js';
import {alive} from '../lib/run-store.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-rpc-'));
const fixture=path.join(root,'fixture.mjs');
fs.writeFileSync(fixture,`
import readline from 'node:readline';
import {spawn} from 'node:child_process';
const send=v=>console.log(JSON.stringify(v));
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{ready:true}});
 else if(m.method==='echo')send({id:m.id,result:m.params});
 else if(m.method==='worker'){const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});send({id:m.id,result:{pid:worker.pid}});}
 else if(m.method==='reject')send({id:m.id,error:{code:-32000,message:'fixture error'}});
 else if(m.method==='bad')console.log('malformed');
 else if(m.method==='large')console.log('x'.repeat(5000));
 else if(m.method==='notify') {send({method:'notice',params:{text:'中文'}});send({id:m.id,result:{}});}
 else if(m.method==='ask') {send({id:'server-1',method:'approval',params:{}});send({id:m.id,result:{}});}
 else if(m.id==='server-1')send({method:'approval-result',params:m});
 else if(m.method==='exit')process.exit(1);
}
`);
const create=opts=>new AppServerClient({executable:process.execPath,args:[fixture],cwd:root,timeoutMs:1000,...opts});
let pass=0;
async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
await test('RPC initialize and concurrent ID correlation',async()=>{const c=create();try{assert.equal((await c.initialize()).ready,true);const results=await Promise.all([c.request('echo',{a:1}),c.request('echo',{a:2})]);assert.deepEqual(results,[{a:1},{a:2}]);}finally{await c.close();}});
await test('structured error and request timeout',async()=>{const c=create();try{await c.initialize();await assert.rejects(c.request('reject'),e=>e.code===-32000);await assert.rejects(c.request('never',{},30),/timeout/);assert.equal(c.pending.size,0);}finally{await c.close();}});
await test('notifications and default server request denial',async()=>{const c=create();try{await c.initialize();const events=[];c.on('notification',(m,p)=>events.push([m,p]));await c.request('notify');await c.request('ask');await new Promise(r=>setTimeout(r,50));assert.equal(events[0][1].text,'中文');assert.equal(events.find(e=>e[0]==='approval-result')[1].error.code,-32601);}finally{await c.close();}});
await test('malformed frame rejects pending requests',async()=>{const c=create();try{await c.initialize();await assert.rejects(c.request('bad'),/Malformed/);}finally{await c.close();}});
await test('oversized frame fails closed',async()=>{const c=create({maxFrameBytes:1024});try{await c.initialize();await assert.rejects(c.request('large'),/frame limit/);}finally{await c.close();}});
await test('server exit rejects pending work',async()=>{const c=create();try{await c.initialize();await assert.rejects(c.request('exit'),/exited/);}finally{await c.close();}});
await test('spawn failure and idempotent close',async()=>{const c=create({cwd:path.join(root,'missing')});await assert.rejects(c.initialize());await Promise.all([c.close(),c.close()]);});
await test('consumer exceptions are contained',async()=>{const c=create();try{await c.initialize();c.on('notification',()=>{throw Error('consumer failure')});await assert.rejects(c.request('notify'),/consumer failure/);}finally{await c.close();}});
await test('forced close terminates an owned server and descendant',async()=>{const c=create();await c.initialize();const {pid}=await c.request('worker');assert.equal(alive(pid),true);await c.close();assert.equal(alive(pid),false);assert.equal(alive(c.child.pid),false);});
console.log('RPC-OK '+pass);
