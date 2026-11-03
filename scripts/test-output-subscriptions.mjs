import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../lib/run-store.js';
import {createOutputView} from '../lib/output-view.js';
import {OutputWriter} from '../lib/output-stream.js';
import {createRunEvents} from '../lib/run-events.js';
let definition;globalThis.window={__ModuleLoader__:{load:value=>{definition=value;}},location:{href:'http://localhost/'}};
await import('../lib/client.js');
const {createRecordDisplayStore,createRunEventHub}=definition.factory(()=>({}));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'output-subscriptions-'));
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function clock(){let time=0,id=0;const timers=new Map();return {now:()=>time,setTimer:(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;},clearTimer:key=>timers.delete(key),
  async advance(ms){const end=time+ms;for(let i=0;i<1000;i++){await flush();const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end){time=end;return;}time=next[1].at;timers.delete(next[0]);next[1].fn();}throw Error('Timer loop');},timers};}
const data={sessionId:'session',callId:'call',runId:'run-a'};
const event=n=>({sequence:n,method:'item/completed',params:{item:{id:'item-'+n,type:'agentMessage',text:'message '+n}}});
const result=(events=[],extra={})=>({run_id:'run-a',status:'ok',execution_status:'ok',events,next_cursor:events.at(-1)?.sequence||0,has_more:false,...extra});
try{
await test('exact lookup remains constant with 60 histories and preserves identity checks',()=>{
  const records=[];for(let n=0;n<60;n++){const runId=randomUUID(),record={runId,sessionId:'session',callId:'call-'+n,backend:'app-server',label:'test-'+n,createdAt:new Date().toISOString()};records.push(record);atomicJson(path.join(root,'.codex-runner/logs/runs',runId,'run.json'),record);}
  const target=records[0],view=createOutputView({lookupSession:()=>({header:{cwd:root}}),settings:()=>({})});
  const original=fs.readFileSync,readdir=fs.readdirSync;let reads=0,scans=0;
  fs.readFileSync=function(file,...args){if(String(file).endsWith('run.json'))reads++;return original.call(this,file,...args);};
  fs.readdirSync=function(...args){scans++;return readdir.apply(this,args);};
  try{for(let n=0;n<20;n++)view.read({sessionId:'session',callId:target.callId,runId:target.runId});assert.equal(reads,20);assert.equal(scans,0);
    assert.throws(()=>view.read({sessionId:'other',callId:target.callId,runId:target.runId}),/session/);
    assert.throws(()=>view.read({sessionId:'session',callId:'wrong',runId:target.runId}),/call/);
    assert.throws(()=>view.read({sessionId:'session',callId:target.callId,runId:'../escape'}),/run_id/);
    assert.equal(view.read({sessionId:'session',callId:target.callId}).run_id,target.runId);assert.ok(scans>0);
  }finally{fs.readFileSync=original;fs.readdirSync=readdir;}
});
await test('two cards share one cursor, drain terminal pages then remain idle',async()=>{
  const c=clock(),store=createRecordDisplayStore(c),calls=[],views=[];
  const read=async args=>{calls.push(args);return args.after===0?result([event(1)],{has_more:true}):result([event(2)]);};
  const off1=store.watch(data,read,v=>views[0]=v),off2=store.watch(data,read,v=>views[1]=v);
  await c.advance(100);assert.equal(calls.length,2);assert.deepEqual(calls.map(a=>a.after),[0,1]);
  assert.deepEqual(views[0].rows.map(r=>r.text),['message 1','message 2']);assert.deepEqual(views[0],views[1]);
  await c.advance(120000);assert.equal(calls.length,2);off1();off2();assert.equal(c.timers.size,0);store.close();
});
await test('event bursts coalesce, final output is appended and reconnect fills missed changes',async()=>{
  const c=clock(),store=createRecordDisplayStore(c),calls=[];let notify,phase=0,view;
  store.bindEvents(fn=>{notify=fn;return ()=>{notify=null;};});
  const read=async args=>{calls.push(args);return result([event(++phase)],{execution_status:phase===1?'running':'ok'});};
  const off=store.watch(data,read,v=>view=v);await flush();
  for(let i=0;i<10;i++)notify({run_id:'run-a',status:'output_changed'});
  await c.advance(0);assert.equal(calls.length,2);assert.equal(view.rows.length,2);
  await c.advance(60000);assert.equal(calls.length,2);
  notify({connected:true});await c.advance(0);assert.equal(calls.length,3);assert.equal(calls[2].after,2);assert.equal(view.rows.length,3);
  off();assert.equal(notify,null);store.close();
});
await test('shared settings hide terminal records immediately and stale replies cannot undo disable',async()=>{
  const c=clock(),store=createRecordDisplayStore(c);let resolve,calls=0,view;
  store.setEnabled(true);const off=store.watch(data,()=>{calls++;return new Promise(r=>resolve=r);},v=>view=v);
  store.setEnabled(false);assert.equal(view.status,'disabled');resolve(result([event(1)]));await flush();
  assert.equal(store.get('session','call').enabled,false);assert.equal(view.rows.length,0);
  store.invalidate();await c.advance(60000);assert.equal(calls,1);
  store.setEnabled(true);await c.advance(0);assert.equal(calls,2);resolve(result([event(1)]));await flush();
  assert.equal(view.rows.length,1);assert.equal(store.get('session','call').enabled,true);off();store.close();
});
await test('errors back off, remount during pending read discards old response',async()=>{
  const c=clock(),store=createRecordDisplayStore(c);let calls=0,resolve,view;
  const read=async()=>{calls++;if(calls<3)throw Error('offline');return result([event(1)]);};
  let off=store.watch(data,read,v=>view=v);await flush();await c.advance(4999);assert.equal(calls,1);
  await c.advance(1);assert.equal(calls,2);await c.advance(9999);assert.equal(calls,2);await c.advance(1);assert.equal(calls,3);off();
  off=store.watch(data,()=>new Promise(r=>resolve=r),v=>view=v);off();
  const finalOff=store.watch(data,async()=>result([event(2)]),v=>view=v);resolve(result([event(99)]));await c.advance(0);
  assert.deepEqual(view.rows.map(r=>r.text),['message 2']);finalOff();store.close();
});
await test('one reconnecting EventSource is shared and released by the last subscriber',()=>{
  const sources=[];globalThis.EventSource=class{constructor(){sources.push(this);}close(){this.closed=true;}};
  const hub=createRunEventHub(),a=[],b=[],off1=hub.subscribe(e=>a.push(e)),off2=hub.subscribe(e=>b.push(e));
  assert.equal(sources.length,1);sources[0].onopen();sources[0].onerror();assert.equal(sources[0].closed,undefined);
  sources[0].onopen();sources[0].onmessage({data:JSON.stringify({run_id:'run-a',status:'output_changed'})});assert.deepEqual(a,b);
  off1();assert.equal(sources[0].closed,undefined);off2();assert.equal(sources[0].closed,true);hub.close();delete globalThis.EventSource;
});
await test('invalidation arriving during an outstanding read is drained afterwards',async()=>{
  const c=clock(),store=createRecordDisplayStore(c);let complete,calls=0,view;
  const off=store.watch(data,async args=>{calls++;if(calls===1)return new Promise(r=>complete=r);assert.equal(args.after,1);return result([event(2)]);},v=>view=v);
  store.invalidate({run_id:'another-run'});store.invalidate({run_id:'run-a'});complete(result([event(1)]));
  await c.advance(0);assert.equal(calls,2);assert.deepEqual(view.rows.map(r=>r.text),['message 1','message 2']);off();store.close();
});
await test('completed independent records do not poll and a setting change reaches every record',async()=>{
  const c=clock(),store=createRecordDisplayStore(c),stops=[];let calls=0;store.setEnabled(true);
  for(let n=0;n<10;n++){const record={sessionId:'session',callId:'item-call-'+n,runId:'item-run-'+n};stops.push(store.watch(record,async()=>{calls++;return result([],{run_id:record.runId});}));}
  await c.advance(120000);assert.equal(calls,10);store.setEnabled(false);
  for(let n=0;n<10;n++)assert.equal(store.get('session','item-call-'+n).enabled,false);
  await c.advance(120000);assert.equal(calls,10);store.setEnabled(true);await c.advance(0);assert.equal(calls,20);
  stops.forEach(stop=>stop());store.close();
});
await test('terminal snapshot cannot precede the last persisted output boundary',()=>{
  const runId=randomUUID(),dir=path.join(root,'.codex-runner/logs/runs',runId),record={runId,sessionId:'session',callId:'race',backend:'app-server',label:'race',createdAt:new Date().toISOString()};
  atomicJson(path.join(dir,'run.json'),record);const writer=new OutputWriter({dir,runId,backend:'app-server'});
  writer.append('item/completed',{item:{id:'first',type:'agentMessage',text:'first'}});
  const original=fs.readFileSync;let injected=false;
  fs.readFileSync=function(file,...args){if(String(file)===path.join(dir,'result.meta.json')&&!injected){injected=true;writer.append('item/completed',{item:{id:'final',type:'agentMessage',text:'final'}});atomicJson(file,{status:'ok'});}return original.call(this,file,...args);};
  try{const view=createOutputView({lookupSession:()=>({header:{cwd:root}}),settings:()=>({})}),value=view.read({sessionId:'session',callId:'race',runId});
    assert.equal(value.execution_status,'ok');assert.equal(value.events.length,2);assert.equal(value.has_more,false);
  }finally{fs.readFileSync=original;}
});
await test('filesystem notifications cover output and final host-record commits without message payloads',async()=>{
  const runId=randomUUID(),dir=path.join(root,'events'),record={runId},events=createRunEvents(),seen=[];
  fs.mkdirSync(dir);events.subscribe(e=>seen.push(e));events.track(dir,record);
  const writer=new OutputWriter({dir,runId,backend:'app-server'});writer.append('item/completed',{item:{id:'a',type:'agentMessage',text:'private text'}});
  const until=async fn=>{for(let n=0;n<100&&!fn();n++)await new Promise(r=>setTimeout(r,20));assert.ok(fn());};
  try{await until(()=>seen.some(e=>e.status==='output_changed'));atomicJson(path.join(dir,'result.meta.json'),{status:'ok'});await until(()=>seen.some(e=>e.status==='ok'));
    const count=seen.length;atomicJson(path.join(dir,'session-records.json'),{runId,count:1});await until(()=>seen.length>count);
    assert.ok(seen.every(e=>Object.keys(e).sort().join(',')==='run_id,status'));assert.ok(!JSON.stringify(seen).includes('private text'));
    const reader=events.stream().body.getReader();await reader.read();await reader.cancel();
  }finally{events.close();}
});
console.log('OUTPUT-SUBSCRIPTIONS-OK '+passed);
}finally{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
