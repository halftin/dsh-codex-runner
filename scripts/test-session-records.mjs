import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionRecords,probeSessionRecords,buildItemRecord,ITEM_RECORD_TYPE} from '../lib/session-records.js';
import {OutputWriter,readOutput} from '../lib/output-stream.js';
import {atomicJson,readJson} from '../lib/run-store.js';
import {createOutputView} from '../lib/output-view.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-session-records-'));
const session={id:randomUUID(),header:{cwd:root},events:[],snapshotEvents(){return this.events;}};
let enabled=true,flushFailure=false,appends=0;
const append=(s,type,data)=>{assert.equal(s,session);const seq=s.events.length;s.events.push({seq,type,data,ignorable:true});appends++;return seq;};
const options={lookupSession:id=>id===session.id?session:null,settings:()=>({streamOutputEnabled:enabled,supervisionEnabled:false}),
  load:async()=>({appendPluginRecord:append}),flush:async()=>{if(flushFailure)throw Error('injected flush failure');return true;}};
const makeRun=()=>{
  const record={runId:randomUUID(),callId:randomUUID(),sessionId:session.id,label:'records',backend:'app-server',createdAt:new Date().toISOString()};
  const dir=path.join(root,'.codex-runner/logs/runs',record.runId);atomicJson(path.join(dir,'run.json'),record);
  return {cwd:root,record,dir,writer:new OutputWriter({dir,runId:record.runId,backend:'app-server'})};
};
const cursor=run=>readJson(path.join(run.dir,'session-records.json'));
const item=(run,id,type='agentMessage',extra={})=>run.writer.append('item/completed',{threadId:'same-thread',turnId:'turn',item:{id,type,text:'正文 '+id,...extra}});
const tails=[];
const tail=overrides=>{const value=new SessionRecords({...options,...overrides});tails.push(value);return value;};
try {
  assert.equal((await probeSessionRecords(async()=>({}))).append,null);
  assert.match((await probeSessionRecords(async()=>{throw Object.assign(Error('missing'),{code:'ERR_MODULE_NOT_FOUND'});})).diagnostic,/ERR_MODULE_NOT_FOUND/);
  assert.equal((await probeSessionRecords(options.load)).append,append);
  const run=makeRun(),other=makeRun(),first=tail();first.track(run);first.track(other);
  run.writer.append('item/started',{item:{id:'one',type:'agentMessage',text:'unfinished'}});
  await first.poll();assert.equal(appends,0);assert.equal(cursor(run).cursor,1);
  item(run,'one');item(other,'one');await Promise.all([first.poll(),first.poll()]);
  assert.equal(appends,2);assert.deepEqual(session.events.map(e=>e.data.runId),[run.record.runId,other.record.runId]);
  assert.ok(session.events.every(e=>e.type===ITEM_RECORD_TYPE&&e.ignorable));
  assert.equal(cursor(run).cursor,2);assert.equal(cursor(run).count,1);
  await first.poll();assert.equal(appends,2);
  const view=createOutputView({lookupSession:options.lookupSession,settings:options.settings});
  const args={sessionId:session.id,callId:run.record.callId,runId:run.record.runId};
  assert.equal(view.read(args).item_records,true);
  assert.throws(()=>view.read({...args,runId:other.record.runId}),/mismatch/);
  assert.throws(()=>view.resource({...args,runId:other.record.runId,sequence:2}),/mismatch/);
  await first.close();const restarted=tail();restarted.track(run);await restarted.poll();assert.equal(appends,2);

  // Off preserves the unprocessed cursor, including terminal output; enabling catches up.
  enabled=false;item(run,'disabled');atomicJson(path.join(run.dir,'result.meta.json'),{status:'ok'});
  await restarted.poll();assert.equal(appends,2);assert.equal(cursor(run).cursor,2);assert.equal(view.read(args).status,'disabled');
  enabled=true;await restarted.poll();assert.equal(appends,3);assert.equal(restarted.runs.has(run.record.runId),false);

  // Crash after append but before durable cursor acknowledgement: reconcile, don't append again.
  const crash=makeRun(),crasher=tail();crasher.track(crash);item(crash,'committed');flushFailure=true;
  await crasher.poll();assert.equal(appends,4);assert.equal(cursor(crash).pending.outputSeq,1);assert.equal(cursor(crash).cursor,0);
  await crasher.close();flushFailure=false;const recovery=tail();recovery.track(crash);await recovery.poll();
  assert.equal(appends,4);assert.equal(cursor(crash).count,1);assert.equal(cursor(crash).pending,null);
  // Intent persisted, append never committed: absence from the restored session permits retry.
  item(crash,'never-appended');atomicJson(path.join(crash.dir,'session-records.json'),{...cursor(crash),pending:{outputSeq:2}});
  await recovery.poll();assert.equal(appends,5);assert.equal(cursor(crash).cursor,2);
  // No reconciliation API: hold pending, never blindly repeat an uncertain append.
  item(crash,'unknown');atomicJson(path.join(crash.dir,'session-records.json'),{...cursor(crash),pending:{outputSeq:3}});
  const held=tail({lookupSession:()=>({...session,snapshotEvents:undefined})});held.track(crash);await held.poll();
  assert.equal(appends,5);assert.match(readJson(path.join(crash.dir,'session-records-diagnostic.json')).error,/uncertain/);

  const absent=makeRun(),fallback=tail({load:async()=>({})});fallback.track(absent);item(absent,'fallback');await fallback.poll();
  assert.equal(cursor(absent),null);assert.equal(appends,5);assert.equal(readJson(path.join(absent.dir,'session-records-diagnostic.json')).status,'unavailable');
  assert.equal(view.read({sessionId:session.id,callId:absent.record.callId}).item_records,false);
  const wrong=tail({lookupSession:()=>({...session,id:'wrong-session'})});wrong.track(absent);await wrong.poll();assert.equal(appends,5);

  // Inline and sidecar payloads, UTF-8 byte bound, old exec names and unsupported types.
  const large=makeRun(),largeTail=tail();largeTail.track(large);
  const text='中文🧪'.repeat(10000);item(large,'large','agentMessage',{text});
  item(large,'cmd','commandExecution',{command:'echo ok',aggregatedOutput:'ok'.repeat(10000),exitCode:0});
  item(large,'file','fileChange',{changes:[{path:'file.js',diff:'+ added\n'.repeat(2000)}]});
  large.writer.append('item.completed',{item:{id:'exec',type:'agent_message',text:'exec compatible'}});
  item(large,'unknown','futureItem');await largeTail.poll();
  const records=session.events.filter(e=>e.data.runId===large.record.runId).map(e=>e.data);
  assert.equal(records.length,4);assert.ok(records.every(d=>Buffer.byteLength(d.text)<=8192));
  assert.ok(!records[0].text.includes('\ufffd'));assert.ok(text.startsWith(records[0].text));assert.equal(records[0].truncated,true);
  assert.equal(records[1].command,'echo ok');assert.equal(records[1].exitCode,0);assert.equal(records[2].paths,'file.js');
  assert.equal(records[3].text,'exec compatible');assert.equal(records[3].truncated,false);
  const event=readOutput(large.dir,large.record.runId,{after:3,limit:1}).events[0];
  assert.equal(buildItemRecord({...large.record,runId:randomUUID()},event),null);
  assert.equal(buildItemRecord(large.record,{...event,method:'item/started'}),null);
  assert.equal(buildItemRecord(large.record,event,{type:'toString'}),null);
  assert.equal(buildItemRecord(large.record,event,{type:'agentMessage',text:'\ufeffbody'}).text,'\ufeffbody');

  // Drain more than one page before retiring a finished run; two host tailers serialize on disk.
  const many=makeRun(),a=tail(),b=tail();a.track(many);b.track(many);
  for(let i=0;i<105;i++)item(many,String(i));atomicJson(path.join(many.dir,'result.meta.json'),{status:'ok'});
  await Promise.all([a.poll(),b.poll()]);await a.poll();await b.poll();
  assert.equal(cursor(many).count,105);assert.equal(session.events.filter(e=>e.data.runId===many.record.runId).length,105);
  assert.equal(a.runs.size,0);assert.equal(b.runs.size,0);
  console.log('SESSION-RECORDS-OK preview, exact identities, independent supervision, restart, crash reconciliation, locking, disabled, fallback and terminal drain');
} finally {
  for(const t of tails)await t.close();
  assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});
}
