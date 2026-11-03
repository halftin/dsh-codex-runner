import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runFacts } from '../lib/run-facts.js';
import { buildStatusToolDefinition, LOGS_REL } from '../lib/core.js';
import { RunNotifier } from '../lib/run-notifier.js';
import { captureReply } from '../lib/reply-signals.js';
import { runManaged } from '../lib/managed-run.js';
import { atomicJson, readJson, reserveRun, runDirectory, updateRecord, cleanupRuns } from '../lib/run-store.js';
import { historyTools } from '../lib/history.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-handoff-'));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS handoff ' + name); }
function fixture(meta = {}) {
  const cwd = fs.mkdtempSync(path.join(root, 'cwd-')), logs = path.join(cwd, LOGS_REL);
  const record = { runId:randomUUID(), label:'task', cwd, detached:true, sessionId:'origin',
    state:'running', createdAt:new Date().toISOString(), notifyOnComplete:'decision' };
  const dir = runDirectory(logs, record);
  atomicJson(path.join(dir, 'run.json'), record);
  const value = {runId:record.runId,threadId:'thread',turnId:'turn',lastMessage:'answer',...meta};
  atomicJson(path.join(dir, 'result.meta.json'), value);
  const calls = [], schedule = { async create(sessionId, request) {
    calls.push({sessionId,...request}); return {id:'notice-'+calls.length}; }, async list(){return [];} };
  const notifier = new RunNotifier({home:path.join(cwd,'home'),schedule});
  notifier.track({cwd,record});
  return {cwd,logs,dir,record,meta:value,calls,schedule,notifier};
}
const facts = overrides => runFacts({status:'ok',threadId:'thread',answer:'evidence',...overrides});
const payload = call => JSON.parse(call.prompt.split('\n').at(-1));

await test('ownership matrix leaves task acceptance to DSH', async () => {
  const cases = [
    [{}, 'review_result', 'after_review'],
    [{status:'failed'}, 'recover_task', 'after_review'],
    [{status:'killed',meta:{abortReason:'host-shutdown'}}, 'recover_task', 'after_review'],
    [{answer:''}, 'review_result', 'after_review'],
    [{status:'running'}, 'await_run', 'blocked'],
    [{evidence:{driverAlive:true}}, 'await_run', 'blocked'],
    [{evidence:{spawnPending:true}}, 'await_run', 'blocked'],
    [{evidence:{childAlive:true,childOwner:'unknown'}}, 'inspect_process', 'blocked'],
    [{meta:{killVerified:false}}, 'inspect_process', 'blocked'],
    [{subagents:{running:1}}, 'inspect_subagents', 'blocked'],
    [{subagents:{unknown:1}}, 'inspect_subagents', 'blocked'],
    [{status:'waiting_quota',meta:{autoResumeAfterQuota:true}}, 'await_quota', 'blocked'],
    [{status:'waiting_quota'}, 'quota_paused', 'blocked'],
    [{status:'waiting_quota',meta:{autoResumeAfterQuota:true},recovery:{phase:'cancelled'}}, 'quota_paused', 'blocked'],
    [{status:'waiting_quota',meta:{autoResumeAfterQuota:true},recovery:{phase:'needs_attention'}}, 'inspect_recovery', 'blocked'],
    [{recovery:{phase:'resumed',resumed_run_id:'successor'}}, 'follow_successor', 'blocked'],
    [{userCancelled:true,recovery:{resumed_run_id:'successor'}}, 'stopped', 'blocked'],
    [{status:'not_found'}, 'locate_run', 'blocked'],
    [{status:'needs_attention',evidence:{liveness:'stale',driverAlive:false,childAlive:false,spawnPending:false}}, 'recover_task', 'after_review'],
  ];
  for (const [input, action, dispatch] of cases) {
    const result=facts(input);
    assert.equal(result.handoff.action,action,JSON.stringify(input));
    assert.equal(result.handoff.dispatch,dispatch);
    assert.equal(result.task_state,'unknown');
  }
  assert.equal(facts({answer:'long',meta:{answerTruncated:true}}).handoff.read_answer,true);
  assert.equal(facts({answer:'ok'}).handoff.read_answer,false);
});

await test('dead driver with running metadata still notifies and survives host reload', async () => {
  const f=fixture({status:'running'});
  await f.notifier.close();
  const restarted=new RunNotifier({home:path.join(f.cwd,'home'),schedule:f.schedule});
  try {
    await restarted.poll();await restarted.poll();
    assert.equal(f.calls.length,1);
    assert.equal(payload(f.calls[0]).status,'stale');
    assert.equal(payload(f.calls[0]).handoff.action,'recover_task');
  } finally {await restarted.close();}
});

await test('fresh heartbeat without a driver produces attention instead of silence', async () => {
  const f=fixture({status:'running'});
  atomicJson(path.join(f.dir,'result.hb.json'),{runId:f.record.runId,ts:new Date().toISOString()});
  try {await f.notifier.poll();assert.equal(f.calls.length,1);
    assert.equal(payload(f.calls[0]).handoff.action,'inspect_process');
  } finally {await f.notifier.close();}
});

await test('two failed turns each deliver once and advance the reply cursor', async () => {
  const f=fixture({status:'failed',turnId:'turn-2'});
  captureReply(f.dir,f.meta,{id:'turn-1',status:'failed'});
  captureReply(f.dir,f.meta,{id:'turn-2',status:'failed'});
  atomicJson(path.join(f.dir,'result.meta.json'),f.meta);
  try {
    await f.notifier.poll();await f.notifier.poll();
    assert.equal(f.calls.length,2);
    assert.deepEqual(f.calls.map(call=>payload(call).turn_id),['turn-1','turn-2']);
    assert.equal(readJson(path.join(f.dir,'notified.json')).replySequence,2);
  } finally {await f.notifier.close();}
});

await test('unconfirmed schedule is not acknowledged and status exposes delivery trouble', async () => {
  const f=fixture({status:'failed'});
  f.schedule.create=async()=>{f.calls.push('unconfirmed');return null;};
  try {
    await f.notifier.poll();await f.notifier.poll();
    assert.equal(f.calls.length,1,'ambiguous write is not replayed');
    assert.equal(readJson(path.join(f.dir,'notified.json')),null);
    const status=buildStatusToolDefinition({defineTool:d=>d,resolveCwd:()=>f.cwd});
    const result=await status.execute({run_id:f.record.runId},{});
    assert.equal(result.notification.delivery,'needs_attention');
    assert.equal(result.handoff.action,'recover_task');
    assert.match(result.summary_text,/notification:/);
  } finally {await f.notifier.close();}
});

await test('status reads persisted quota successor and failed recovery without extra model calls', async () => {
  const f=fixture({status:'waiting_quota',autoResumeAfterQuota:true});
  try {
    const status=buildStatusToolDefinition({defineTool:d=>d,resolveCwd:()=>f.cwd});
    atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'resumed',resumedRunId:'new-run'});
    const resumed=await status.execute({run_id:f.record.runId},{});
    assert.equal(resumed.handoff.action,'follow_successor');assert.equal(resumed.handoff.run_id,'new-run');
    atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'needs_attention'});
    const attention=await status.execute({run_id:f.record.runId},{});
    assert.equal(attention.needs_dsh_decision,true);assert.equal(attention.automation,'none');
    assert.equal(attention.handoff.action,'inspect_recovery');
    assert.match(attention.summary_text,/DSH/);
  } finally {await f.notifier.close();}
});

await test('admission reserves the same thread before spawn even with distinct labels and spare slots', async () => {
  const logs=path.join(root,'admission',LOGS_REL);
  const first=reserveRun(logs,'first',4,{resumeThread:'one-thread'});
  assert.throws(()=>reserveRun(logs,'duplicate',4,{resumeThread:'one-thread'}),/thread already/);
  assert.ok(reserveRun(logs,'other-thread',4,{resumeThread:'two-thread'}));
  updateRecord(logs,first,{state:'failed'});
  atomicJson(path.join(runDirectory(logs,first),'result.meta.json'),{status:'failed',threadId:'one-thread'});
  assert.ok(reserveRun(logs,'authorized-continuation',4,{resumeThread:'one-thread'}),'terminal task can continue');
});

await test('managed timeout is recoverable but a user cancellation stays stopped', async () => {
  for (const user of [false,true]) {
    const f=fixture();let turns=0;
    class Client extends EventEmitter {
      async initialize(){} async close(){}
      async request(method) {
        if(method==='model/list')return {data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
        if(method==='thread/start')return {thread:{id:'thread'}};
        if(method==='turn/start') {turns++;
          atomicJson(path.join(f.dir,user?'cancel.json':'stop.json'),{runId:f.record.runId,reason:'host-shutdown'});
          return {turn:{id:'turn'}};
        }
        throw Error('Unexpected method '+method);
      }
    }
    try {
      const meta=await runManaged({cwd:f.cwd,logDir:f.dir,runId:f.record.runId,prompt:'task',model:'fixture',effort:'low'},()=>new Client());
      assert.equal(meta.abortReason,user?'user-cancel':'host-shutdown');
      const result=facts({status:meta.status,meta});
      assert.equal(result.handoff.action,user?'stopped':'recover_task');assert.equal(turns,1,'no blind replay');
    } finally {await f.notifier.close();}
  }
});

await test('answer reading stays on the original run turn after a later continuation', async () => {
  const f=fixture({backend:'app-server',status:'ok',turnId:'original',lastMessage:'stored original'});
  let missing=false;
  const tools=historyTools({defineTool:d=>d,resolveCwd:()=>f.cwd,connect:async fn=>fn({request:async method=>
    method==='thread/read'?{thread:{cwd:f.cwd}}:{data:[
      {id:'later',items:[{type:'agentMessage',text:'UNRELATED LATER ANSWER'}]},
      ...(!missing?[{id:'original',items:[{type:'agentMessage',text:'original answer'}]}]:[])]}})});
  const read=tools.find(t=>t.name==='codex_read');
  try {
    const result=await read.execute({run_id:f.record.runId},{});
    assert.equal(result.text,'original answer');assert.equal(result.turn_id,'original');
    missing=true;
    const fallback=await read.execute({run_id:f.record.runId},{});
    assert.equal(fallback.text,'stored original');assert.equal(fallback.read_source,'meta.lastMessage');
    atomicJson(path.join(f.dir,'result.meta.json'),{...f.meta,turnId:null});
    const unavailable=await read.execute({run_id:f.record.runId},{});
    assert.equal(unavailable.text,'stored original');assert.equal(unavailable.read_source,'meta.lastMessage');
  } finally {await f.notifier.close();}
});

await test('retention preserves undelivered task evidence until delivery is confirmed', async () => {
  const f=fixture({status:'failed'});
  try {
    updateRecord(f.logs,f.record,{createdAt:new Date(0).toISOString()});
    cleanupRuns(f.logs,1,0);assert.equal(fs.existsSync(f.dir),true);
    await f.notifier.poll();
    cleanupRuns(f.logs,1,0);assert.equal(fs.existsSync(f.dir),false);
  } finally {await f.notifier.close();}
});

console.log('HANDOFF-OK '+passed);
