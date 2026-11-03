import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {RunNotifier} from '../lib/run-notifier.js';
import {StatusPolling} from '../lib/status-polling.js';
import {captureReply, MAX_PENDING_REPLIES} from '../lib/reply-signals.js';
import {runManaged} from '../lib/managed-run.js';
import {sendControl} from '../lib/run-control.js';
import {atomicJson,readJson,runDirectory} from '../lib/run-store.js';
import {processStartedAt} from '../lib/process-evidence.js';
import {SETTINGS_DEFAULTS,validateSetting} from '../lib/core.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-reply-signals-'));
const only=process.env.SIGNAL_CASE;let passed=0;
async function test(id,fn){if(only && only!==id)return;await fn();passed++;console.log('PASS signals '+id);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function scheduler(){
  const calls=[],entries=[],deleted=[],delivered=[];
  return {calls,entries,deleted,delivered,
    dispatch(now){for(const row of [...entries])if(Date.parse(row.at)<=now){delivered.push(row);entries.splice(entries.indexOf(row),1);}},
    async create(sessionId,request){const row={id:randomUUID(),sessionId,...request};calls.push(row);entries.push(row);return row;},
    async list({sessionId}){return entries.filter(r=>r.sessionId===sessionId);},
    async delete({id}){deleted.push(id);const i=entries.findIndex(r=>r.id===id);if(i>=0)entries.splice(i,1);}};
}
function fixture({status='ok',mode='off',detached=true,sessionId='origin',live=false}={}) {
  const cwd=fs.mkdtempSync(path.join(root,'cwd-')),home=path.join(cwd,'host'),schedule=scheduler();
  const record={runId:randomUUID(),cwd,label:'test-reply',state:'running',detached,sessionId,notifyOnComplete:mode,
    createdAt:new Date().toISOString(),...(live?{driverPid:process.pid,driverStartedAt:processStartedAt()}: {})};
  const dir=runDirectory(path.join(cwd,'.codex-runner/logs'),record);
  atomicJson(path.join(dir,'run.json'),record);
  const meta={runId:record.runId,threadId:'thread',turnId:'turn-1',lastMessage:'final answer',autoResumeAfterQuota:status==='waiting_quota',...(status?{status}: {})};
  const write=()=>atomicJson(path.join(dir,'result.meta.json'),meta);write();
  const notifier=new RunNotifier({home,schedule});notifier.track({cwd,record});
  return {cwd,home,record,dir,meta,write,schedule,notifier};
}
const payload=call=>JSON.parse(call.prompt.split('\n').at(-1));
await test('off-detach',async()=>{
  const f=fixture();try {
    await f.notifier.poll();await f.notifier.poll();
    assert.equal(f.schedule.calls.length,1,'off detach visible signal');
    const p=payload(f.schedule.calls[0]);
    for(const key of ['run_id','label','turn_status','needs_dsh_decision','decision_reason','has_final_answer','answer_preview','thread_id','quota'])assert.ok(Object.hasOwn(p,key),'signal field '+key);
    assert.equal(p.wake_dsh,false,'off disables extra wake');
    assert.equal(p.turn_status,'completed','completion signal');
    assert.match(f.schedule.calls[0].prompt,/governed by the user instructions/,'Notification preserves user authority without prescribing continuation');
    assert.equal(p.handoff.action,'review_result');assert.equal(p.handoff.dispatch,'after_review');
    const again=new RunNotifier({home:f.home,schedule:f.schedule});again.track({cwd:f.cwd,record:f.record});
    try{await again.poll();assert.equal(f.schedule.calls.length,1,'restart signal dedup');}finally{await again.close();}
  }finally{await f.notifier.close();}
});
await test('sync',async()=>{
  for(const mode of ['off','decision','always']) {
    const f=fixture({mode,detached:false});atomicJson(path.join(f.dir,'tool-returned.json'),{runId:f.record.runId});try{await f.notifier.poll();assert.equal(f.schedule.calls.length,0,'sync no duplicate '+mode);}finally{await f.notifier.close();}
  }
});
await test('passive',async()=>{
  for(const [mode,wakes] of [['off',0],['decision',1],['always',1]]) {
    const f=fixture({mode}),messages=[];f.notifier.passive=async(sessionId,message)=>{messages.push({sessionId,...message});return {id:'message'};};
    try{await f.notifier.poll();await f.notifier.poll();assert.equal(messages.length,1,'passive once '+mode);assert.equal(f.schedule.calls.length,wakes,'wake policy '+mode);}
    finally{await f.notifier.close();}
  }
  const f=fixture({mode:'decision',status:'waiting_quota'}),messages=[];
  f.notifier.passive=async()=>{messages.push(1);};
  try{await f.notifier.poll();assert.equal(messages.length,1,'passive quota visible');assert.equal(f.schedule.calls.length,0,'quota decision no wake');}finally{await f.notifier.close();}
});
await test('states',async()=>{
  for(const status of ['failed','waiting_quota','needs_attention','spawn-error','killed','orphan','stale','interrupted','aborted']) {
    const f=fixture({status});f.meta.quota={state:'blocked',reason:'7d remaining 5%',remaining:5,resumeAt:Date.now()+7*86400000};f.write();
    try{await f.notifier.poll();await f.notifier.poll();assert.equal(f.schedule.calls.length,1,'state visible '+status);
      if(status==='waiting_quota'){const p=payload(f.schedule.calls[0]);assert.equal(p.needs_dsh_decision,false,'pause no decision');assert.equal(p.quota?.resumeAt,f.meta.quota.resumeAt,'pause recovery time');}
    }finally{await f.notifier.close();}
  }
  const f=fixture({status:'waiting_quota'});
  atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'wake_scheduled'});
  try {await f.notifier.poll();atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'needs_attention'});
    await f.notifier.poll();await f.notifier.poll();assert.equal(f.schedule.calls.length,2,'pause to attention signals');
  }finally{await f.notifier.close();}
});
await test('multi-turn',async()=>{
  const f=fixture({status:null,live:true});
  for(const id of ['turn-1','turn-1','turn-2','turn-2'])captureReply(f.dir,f.meta,{id,status:'completed'});
  assert.equal(f.meta.replySignals.length,2,'every live turn signalled once');
  f.write();
  try {
    await f.notifier.poll();await f.notifier.poll();assert.equal(f.schedule.calls.length,2,'every live turn signalled once');
    assert.deepEqual(f.schedule.calls.map(c=>payload(c).turn_id),['turn-1','turn-2'],'turn identity');
    f.meta.turnId='turn-3';captureReply(f.dir,f.meta,{id:'turn-3',status:'completed'});f.write();await f.notifier.poll();
    assert.equal(f.schedule.calls.length,3,'later turn after acknowledgement');
    assert.equal(f.meta.replySignals.length,1,'acknowledged snapshots reclaimed');
    const second=new RunNotifier({home:f.home,schedule:f.schedule});try{await second.poll();assert.equal(f.schedule.calls.length,3,'multi turn restart dedup');}finally{await second.close();}
  }finally{await f.notifier.close();}
});
await test('kind-reconcile',async()=>{
  const f=fixture({status:'waiting_quota'});
  atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'wake_scheduled'});
  try {
    await f.notifier.poll();
    const create=f.schedule.create;f.schedule.create=async(...args)=>{await create(...args);throw Error('lost attention response');};
    atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'needs_attention'});
    await f.notifier.poll();await f.notifier.poll();
    assert.equal(f.schedule.calls.length,2,'each kind one reminder');
    assert.equal(readJson(path.join(f.dir,'notified.json')).scheduleId,f.schedule.calls[1].id,'reconcile exact kind');
  }finally{await f.notifier.close();}
});
await test('backlog',async()=>{
  const f=fixture({status:null});
  try {for(let i=0;i<MAX_PENDING_REPLIES;i++)captureReply(f.dir,f.meta,{id:'turn-'+i,status:'completed'});
    assert.throws(()=>captureReply(f.dir,f.meta,{id:'overflow',status:'completed'}),/backlog/,'bounded reply backlog refuses loss');
    assert.equal(f.meta.replySignals.length,MAX_PENDING_REPLIES,'bounded reply snapshots');
  }finally{await f.notifier.close();}
});
await test('managed-turns',async()=>{
  const f=fixture({status:null,live:true}),methods=[];let turn=0;
  class Client extends EventEmitter {
    async initialize(){} async close(){}
    async request(method){methods.push(method);
      if(method==='model/list')return {data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
      if(method==='thread/start')return {thread:{id:'thread'}};
      if(method==='turn/start') {
        const id='turn-'+(++turn);setTimeout(()=>{
          this.emit('notification','item/completed',{item:{type:'agentMessage',text:'answer '+id}});
          this.emit('notification','turn/completed',{turn:{id,status:'completed'}});
          this.emit('notification','turn/completed',{turn:{id,status:'completed'}});
        },turn===1?600:50);return {turn:{id}};
      }
      throw Error('Unexpected request '+method);
    }
  }
  try {
    const done=runManaged({cwd:f.cwd,logDir:f.dir,runId:f.record.runId,prompt:'authorized task',model:'fixture',effort:'low'},()=>new Client());
    const accepted=await sendControl(f.dir,{runId:f.record.runId},'queue','explicit next task');
    assert.equal(accepted.delivery,'persisted_for_next_turn','explicit queued input');
    const result=await done;await f.notifier.poll();await f.notifier.poll();
    assert.equal(result.status,'ok','managed completes');assert.equal(result.replySignals?.length,2,'managed captures each turn');
    assert.equal(result.replySignals[0].process_status,'running','turn reply does not imply driver exit');
    assert.equal(f.schedule.calls.length,2,'managed every turn signal');assert.equal(methods.filter(m=>m==='turn/start').length,2,'only explicitly queued continuation');
  }finally{await f.notifier.close();}
  const g=fixture({status:null});turn=1;methods.length=0;
  try{await runManaged({cwd:g.cwd,logDir:g.dir,runId:g.record.runId,prompt:'one task',model:'fixture',effort:'low'},()=>new Client());
    assert.equal(methods.filter(m=>m==='turn/start').length,1,'no automatic continue');
  }finally{await g.notifier.close();}
});
function pollingFixture({enabled=false,minutes=30,live=true,sessionId='origin'}={}){
  const f=fixture({status:live?null:'ok',live,sessionId});let now=Date.now();
  const settings={streamOutputEnabled:false,supervisionEnabled:false,statusPollingEnabled:enabled,statusPollingIntervalMinutes:minutes};
  const poller=new StatusPolling({home:f.home,schedule:f.schedule,settings:()=>settings,now:()=>now});poller.track({cwd:f.cwd,record:f.record});
  return {...f,settings,poller,advance:ms=>{now+=ms;},now:()=>now};
}
await test('poll-off',async()=>{
  const f=pollingFixture();try{await f.poller.poll();assert.equal(f.schedule.calls.length,0,'poll off no schedule');}finally{await f.poller.close();await f.notifier.close();}
  for(const options of [{enabled:true,live:false},{enabled:true,sessionId:null}]) {
    const g=pollingFixture(options);try{await g.poller.poll();assert.equal(g.schedule.calls.length,0,'no active deliverable run no schedule');}finally{await g.poller.close();await g.notifier.close();}
  }
});
await test('poll-boundaries',async()=>{
  assert.equal(SETTINGS_DEFAULTS.statusPollingEnabled,false,'poll default off');assert.equal(SETTINGS_DEFAULTS.statusPollingIntervalMinutes,30,'poll default interval');
  for(const minutes of [15,30,60,120]) {
    assert.equal(validateSetting('statusPollingIntervalMinutes',minutes).ok,true,'valid interval '+minutes);
    const f=pollingFixture({enabled:true,minutes});try{const before=Date.now();await f.poller.poll();assert.equal(f.schedule.calls.length,1,'active polling created '+minutes);
      assert.ok(Date.parse(f.schedule.calls[0].at)-before>=minutes*60000-100,'poll interval scheduled '+minutes);
      await f.poller.poll();assert.equal(f.schedule.calls.length,1,'one pending query');
    }finally{await f.poller.close();await f.notifier.close();}
  }
  for(const minutes of [0,14,121,30.5,'30',NaN]) {
    assert.equal(validateSetting('statusPollingIntervalMinutes',minutes).ok,false,'invalid interval rejected');
    const f=pollingFixture({enabled:true,minutes});try{await f.poller.poll();assert.equal(f.schedule.calls.length,0,'invalid interval no query');}finally{await f.poller.close();await f.notifier.close();}
  }
});
await test('poll-supervision',async()=>{
  const f=pollingFixture({enabled:true});let supervised=false;f.poller.supervising=()=>supervised;
  try{await f.poller.poll();assert.equal(f.schedule.entries.length,1);supervised=true;await f.poller.poll();assert.equal(f.schedule.entries.length,0,'Active supervision removes the minute reminder');await f.poller.poll();assert.equal(f.schedule.calls.length,1);supervised=false;await f.poller.poll();assert.equal(f.schedule.entries.length,1,'Disabling supervision restores the independent report setting');}
  finally{await f.poller.close();await f.notifier.close();}
});
await test('poll-merge',async()=>{
  const f=pollingFixture({enabled:true}),g=fixture({status:null,live:true});
  try {
    f.poller.track({cwd:g.cwd,record:g.record});await f.poller.poll();await f.poller.poll();
    assert.equal(f.schedule.calls.length,1,'multi run one session schedule');
    for(const id of [f.record.runId,g.record.runId])assert.ok(f.schedule.calls[0].prompt.includes(id),'merged run identity');
    f.advance(30*60000);await f.poller.poll();await f.poller.poll();
    assert.equal(f.schedule.calls.length,1,'due query waits for host dispatch');
    f.schedule.dispatch(f.now());await f.poller.poll();await f.poller.poll();
    assert.equal(f.schedule.calls.length,2,'one next query after host dispatch');assert.equal(f.schedule.entries.length,1,'at most one pending query');
    assert.match(f.schedule.calls[1].prompt,/codex_status/,'refresh current facts');assert.match(f.schedule.calls[1].prompt,/do not duplicate active runs or quota recovery/,'query respects execution ownership');
    f.meta.status='ok';f.write();await f.poller.poll();assert.equal(f.schedule.entries.length,1,'remaining active run keeps polling');
    g.meta.status='waiting_quota';g.write();await f.poller.poll();assert.equal(f.schedule.entries.length,0,'no active runs deletes polling');
    const count=f.schedule.calls.length;f.advance(120*60000);await f.poller.poll();assert.equal(f.schedule.calls.length,count,'idle no token cost');
  }finally{await f.poller.close();await f.notifier.close();await g.notifier.close();}
});
await test('poll-streaming-exclusion',async()=>{
  for(const field of ['streamOutputEnabled','supervisionEnabled']){
    const f=pollingFixture({enabled:true});
    try{
      await f.poller.poll();assert.equal(f.schedule.entries.length,1);
      f.settings[field]=true;await f.poller.poll();assert.equal(f.schedule.entries.length,0);
      const count=f.schedule.calls.length;await f.poller.poll();assert.equal(f.schedule.calls.length,count);
      assert.equal(f.settings.statusPollingEnabled,true);assert.equal(f.settings.statusPollingIntervalMinutes,30);
      f.settings[field]=false;f.settings.autoAnswerQuestions=true;await f.poller.poll();assert.equal(f.schedule.entries.length,1);
      f.schedule.dispatch(f.now()+31*60000);f.settings[field]=true;await f.poller.poll();
      assert.equal(f.schedule.entries.length,0);assert.equal(f.schedule.calls.length,count+1);
      delete f.settings[field];await f.poller.poll();assert.equal(f.schedule.entries.length,0,'unset uses enabled default');
    }finally{await f.poller.close();await f.notifier.close();}
  }
});
await test('poll-handover',async()=>{
  const f=pollingFixture({enabled:true});
  try {
    await f.poller.poll();const first=f.schedule.entries[0];
    f.advance(31*60000);f.settings.statusPollingIntervalMinutes=60;
    await f.poller.poll();await f.poller.poll();
    assert.equal(f.schedule.deleted.includes(first.id),false,'overdue query not deleted before dispatch');
    assert.equal(f.schedule.entries.length,1,'overdue query remains sole pending query');
    f.schedule.dispatch(f.now());
    assert.deepEqual(f.schedule.delivered.map(r=>r.id),[first.id],'overdue query actually delivered');
    await f.poller.poll();assert.equal(f.schedule.entries.length,1,'consumed query renewed');
    assert.equal(Date.parse(f.schedule.entries[0].at)-f.now(),60*60000,'renewal uses current interval');
    const create=f.schedule.create,remove=f.schedule.delete,old=f.schedule.entries[0];let attempted=0,createSawOld=false,deleteSawReplacement=false,deleteSawEffective=false;
    f.schedule.create=async(...args)=>{attempted++;createSawOld=createSawOld||f.schedule.entries.some(r=>r.id===old.id);return create(...args);};
    f.schedule.delete=async request=>{
      deleteSawReplacement=deleteSawReplacement||f.schedule.entries.some(r=>r.id!==request.id);
      deleteSawEffective=deleteSawEffective||f.schedule.entries.length>=1;
      await remove(request);
    };
    f.settings.statusPollingIntervalMinutes=15;await f.poller.poll();
    assert.equal(attempted,1,'parameter change creates replacement');assert.equal(createSawOld,true,'old schedule exists during replacement create');
    assert.equal(deleteSawReplacement,true,'replacement confirmed before old schedule deleted');assert.equal(deleteSawEffective,true,'reschedule always has an effective schedule');
    assert.equal(f.schedule.entries.length,1,'replacement leaves one query');
  }finally{await f.poller.close();await f.notifier.close();}
  for(const ambiguous of [false,true]) {
    const g=pollingFixture({enabled:true});let second;
    try {
      await g.poller.poll();const old=g.schedule.entries[0],create=g.schedule.create;
      g.schedule.create=async(...args)=>{if(ambiguous)await create(...args);throw Error('replacement create failed');};
      g.settings.statusPollingIntervalMinutes=60;await g.poller.poll();
      assert.ok(g.schedule.entries.some(r=>r.id===old.id),'failed replacement keeps old schedule');
      assert.equal(g.schedule.deleted.includes(old.id),false,'failed replacement does not delete old');
      assert.match(g.poller.error,/replacement create failed/,'replacement failure diagnostic');
      await g.poller.close();second=new StatusPolling({home:g.home,schedule:g.schedule,settings:()=>g.settings,now:g.now});
      await second.poll();await second.poll();
      assert.equal(g.schedule.calls.length,ambiguous?2:1,'restart never duplicates uncertain replacement');
      assert.equal(g.schedule.entries.length,1,'restart retains one effective query');
      assert.equal(g.schedule.deleted.includes(old.id),ambiguous,'old retired only after replacement confirmation');
    }finally{await second?.close();await g.poller.close();await g.notifier.close();}
  }
  const h=pollingFixture({enabled:true});let restarted;
  try {
    await h.poller.poll();const old=h.schedule.entries[0],create=h.schedule.create;
    h.schedule.create=async(...args)=>{await create(...args);throw Error('response lost');};
    h.settings.statusPollingIntervalMinutes=60;await h.poller.poll();await h.poller.close();h.advance(30*60000);
    restarted=new StatusPolling({home:h.home,schedule:h.schedule,settings:()=>h.settings,now:h.now});await restarted.poll();
    assert.equal(h.schedule.deleted.includes(old.id),false,'late replacement confirmation preserves overdue old query');
    h.schedule.dispatch(h.now());assert.equal(h.schedule.delivered[0]?.id,old.id,'overdue old query delivered after restart');
    await restarted.poll();assert.equal(h.schedule.entries.length,1,'late handover leaves confirmed replacement');
  }finally{await restarted?.close();await h.poller.close();await h.notifier.close();}
});
await test('poll-restart',async()=>{
  const f=pollingFixture({enabled:true});await f.poller.poll();await f.poller.close();
  const second=new StatusPolling({home:f.home,schedule:f.schedule,settings:()=>f.settings});
  try{await second.poll();assert.equal(f.schedule.calls.length,1,'poll restart no duplicates');
    f.settings.statusPollingEnabled=false;await second.poll();assert.equal(f.schedule.entries.length,0,'disabled deletes pending query');
  }finally{await second.close();await f.notifier.close();}
});
await test('poll-ambiguous',async()=>{
  const f=pollingFixture({enabled:true}),create=f.schedule.create;
  f.schedule.create=async(...args)=>{await create(...args);throw Error('response lost');};
  try{await f.poller.poll();await f.poller.poll();assert.equal(f.schedule.calls.length,1,'ambiguous poll create reconciled once');assert.equal(f.schedule.entries.length,1,'ambiguous poll one pending');
    f.settings.statusPollingEnabled=false;await f.poller.poll();assert.equal(f.schedule.entries.length,0,'ambiguous poll cleanup');
  }finally{await f.poller.close();await f.notifier.close();}
});
assert.ok(passed,'selected signal case exists');console.log('REPLY-SIGNALS-OK '+passed);
