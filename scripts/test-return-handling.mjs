import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { summarize, summarizeStatus, buildToolDefinition, buildStatusToolDefinition, LOGS_REL } from '../lib/core.js';
import { RunNotifier } from '../lib/run-notifier.js';
import { runManaged } from '../lib/managed-run.js';
import { atomicJson, readJson, runDirectory, listRecords } from '../lib/run-store.js';
import { historyTools } from '../lib/history.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-return-'));
const selected = process.argv[process.argv.indexOf('--case') + 1];
let passed = 0;
async function test(name, fn) {
  if (process.argv.includes('--case') && selected !== name) return;
  await fn(); console.log('PASS return ' + name); passed++;
}
function result(status, extra = {}) {
  return summarize('facts', {meta:{status, threadId:'thread-facts', lastMessage:'done', ...extra}, exitCode:0});
}

await test('completed', async () => {
  for (const [extra, reason, hasAnswer] of [[{},'turn_completed',true], [{lastMessage:' \n'},'empty_answer',false],
    [{subagents:{running:1}},'subagents_running',true], [{lastMessage:'',subagents:{unknown:1}},'subagents_running',false]]) {
    const r = result('ok', extra);
    assert.equal(r.status,'ok'); assert.equal(r.termination,'ok');
    assert.equal(r.turn_status,'completed','completed turn fact'); assert.equal(r.process_status,'terminal');
    assert.equal(r.task_state,'unknown','task remains unknown'); assert.equal(r.needs_dsh_decision,true,'completed decision');
    assert.equal(r.decision_reason,reason,'completed reason'); assert.equal(r.has_final_answer,hasAnswer,'final answer fact');
    assert.equal(r.resumable,true,'completed resumable'); assert.equal(r.automation,'none');
  }
});

await test('terminal-matrix', async () => {
  for (const status of ['failed','interrupted','aborted','killed','spawn-error','killed-unknown','needs_attention']) {
    const r=result(status, status==='killed'?{abortReason:'channel-budget'}:{});
    assert.equal(r.turn_status,status==='failed'?'failed':status==='interrupted'?'interrupted':'unknown','terminal turn '+status);
    assert.equal(r.needs_dsh_decision,true,'terminal decision '+status);
    assert.equal(r.decision_reason,status==='killed'?'channel-budget':status,'terminal reason '+status);
    assert.equal(r.resumable,true); assert.equal(r.automation,'none');
  }
  for (const status of ['cancelled','interrupted','aborted','failed']) {
    const r=result(status,{abortReason:'user-cancel'});
    assert.equal(r.needs_dsh_decision,false,'cancel decision'); assert.equal(r.resumable,false,'cancel resumable');
  }
  const manual=result('waiting_quota',{turnState:'completed',autoResumeAfterQuota:false});
  assert.equal(manual.automation,'none');assert.equal(manual.needs_dsh_decision,true);assert.equal(manual.resumable,true);
  const quota=result('waiting_quota',{turnState:'completed',autoResumeAfterQuota:true});
  assert.equal(quota.turn_status,'unknown'); assert.equal(quota.automation,'quota_resume','quota automation');
  assert.equal(quota.needs_dsh_decision,false,'quota decision'); assert.equal(quota.resumable,true);
  assert.equal(result('ok',{threadId:null}).resumable,false);
});

await test('status-evidence', async () => {
  for (const liveness of ['running','orphan','stale','unknown']) {
    const r=summarizeStatus('facts',{record:{},running:liveness==='running',liveness,meta:null});
    assert.equal(r.process_status,liveness,'process fact '+liveness);
    assert.equal(r.needs_dsh_decision,liveness!=='running','liveness decision '+liveness);
    assert.equal(r.task_state,'unknown');
  }
  const meta={status:'ok',threadId:'thread-facts',lastMessage:'done'};
  const direct=result('ok'), polled=summarizeStatus('facts',{record:{},meta,liveness:'terminal'});
  for (const key of ['status','termination','turn_status','process_status','task_state','needs_dsh_decision','decision_reason','automation','resumable','has_final_answer','answer_truncated']) assert.equal(polled[key],direct[key],key);
  const cancelled=summarizeStatus('facts',{record:{},meta,liveness:'terminal',userCancelled:true});
  assert.equal(cancelled.needs_dsh_decision,false); assert.equal(cancelled.resumable,false);
  const orphan=summarizeStatus('facts',{record:{},meta,liveness:'terminal',childAlive:true,childOwner:'match'});
  assert.equal(orphan.process_status,'orphan'); assert.equal(orphan.decision_reason,'orphan');
});

await test('answer', async () => {
  const answer='完整总结🙂'.repeat(10000)+'FINAL RESULT: tests failed; continue work';
  const r=result('ok',{lastMessage:answer});
  assert.equal(r.has_final_answer,true);assert.equal(r.answer_truncated,false);
  assert.equal(r.answer,answer);assert.ok(r.summary_text.endsWith(answer));
  assert.equal(r.handoff.read_answer,false);
});

function noticeFixture(status, mode, detached = true, extra = {}) {
  const cwd=fs.mkdtempSync(path.join(root,'workspace-')), home=path.join(cwd,'host');
  const record={runId:randomUUID(),label:'notice',createdAt:new Date().toISOString(),state:'running',cwd,detached,sessionId:'origin',
    ...(mode === undefined ? {} : {notifyOnComplete:mode})};
  const dir=runDirectory(path.join(cwd,LOGS_REL),record);
  atomicJson(path.join(dir,'run.json'),record);
  atomicJson(path.join(dir,'result.meta.json'),{status,threadId:'thread-notice',lastMessage:'answer '.repeat(100),subagents:{running:1},...extra});
  const calls=[];
  const schedule={async create(sessionId,request){calls.push({sessionId,...request});return {id:'notice-id'};},async list(){return []}};
  const notifier=new RunNotifier({home,schedule});notifier.track({cwd,record});
  return {cwd,home,dir,record,calls,schedule,notifier};
}
await test('notify-modes', async () => {
  for (const [detached,mode,expected] of [[true,'off',1],[true,'decision',1],[true,'always',1],[true,undefined,1],
    [false,undefined,0],[false,'decision',0],[false,'always',0]]) {
    const f=noticeFixture('ok',mode,detached);
    if(!detached)atomicJson(path.join(f.dir,'tool-returned.json'),{runId:f.record.runId});
    try {
      await f.notifier.poll();await f.notifier.poll();
      assert.equal(f.calls.length,expected,'completion notice '+detached+'/'+mode);
      if(expected) {
        const payload=JSON.parse(f.calls[0].prompt.split('\n').at(-1));
        assert.equal(payload.wake_dsh,mode!=='off','completion wake '+detached+'/'+mode);
        for(const [key,value] of Object.entries({run_id:f.record.runId,label:'notice',turn_status:'completed',decision_reason:'subagents_running',has_final_answer:true,thread_id:'thread-notice',answer_truncated:true})) assert.equal(payload[key],value,'notice '+key);
        assert.ok(payload.answer_preview.length<=500);assert.equal(payload.subagents.running,1);
        assert.match(f.calls[0].prompt,/not a new task instruction/);
        assert.doesNotMatch(f.calls[0].prompt,/continue unfinished work|until that goal is achieved/);
        assert.match(f.calls[0].prompt,/do not duplicate active runs or quota recovery/);
      }
    } finally {await f.notifier.close();}
  }
});

await test('notify-failures', async () => {
  for(const status of ['failed','spawn-error','killed-unknown','killed','needs_attention','orphan','stale','interrupted','aborted']) {
    for (const mode of ['off','decision','always']) {
      const f=noticeFixture(status,mode,true,status==='killed'?{abortReason:'channel-budget'}:{});
      try {await f.notifier.poll();await f.notifier.poll();assert.equal(f.calls.length,1,'failure notice '+status+'/'+mode);}
      finally {await f.notifier.close();}
    }
  }
  for(const status of ['cancelled','interrupted','aborted']) {
    const f=noticeFixture(status,'always',true,['interrupted','aborted'].includes(status)?{abortReason:'user-interrupt'}:{});
    try {await f.notifier.poll();assert.equal(f.calls.length,0,'suppressed notice '+status);}finally{await f.notifier.close();}
  }
  const sync=noticeFixture('failed','always',false);
  atomicJson(path.join(sync.dir,'tool-returned.json'),{runId:sync.record.runId});
  try {await sync.notifier.poll();assert.equal(sync.calls.length,0,'sync tool result is the signal');}finally{await sync.notifier.close();}
});

await test('notify-durable', async () => {
  const f=noticeFixture('ok','decision');
  let reconciles=0;f.schedule.list=async()=>{reconciles++;return [];};
  await f.notifier.poll();await f.notifier.close();
  const again=new RunNotifier({home:f.home,schedule:f.schedule});again.track({cwd:f.cwd,record:f.record});
  try {await again.poll();assert.equal(f.calls.length,1,'completion durable dedup');assert.equal(reconciles,0,'completion durable no reconciliation');}finally{await again.close();}
  const g=noticeFixture('ok','decision');
  g.schedule.create=async()=>{g.calls.push('failed');throw Error('fixture notice error');};
  try {
    await g.notifier.poll();await g.notifier.poll();
    assert.equal(readJson(path.join(g.dir,'notify-error.json')).code,'schedule-create-failed','completion diagnostic');
    assert.equal(g.calls.length,1,'completion error no retry');
    assert.equal(readJson(path.join(g.dir,'result.meta.json')).status,'ok');
  }finally{await g.notifier.close();}
});

await test('managed-facts', async () => {
  for (const status of ['completed','failed','interrupted','aborted']) {
    const methods=[];
    class Client extends EventEmitter {
      async initialize() {}
      async close() {methods.push('close');}
      async request(method) {
        methods.push(method);
        if(method==='model/list')return {data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
        if(method==='thread/start')return {thread:{id:'thread-managed'}};
        if(method==='turn/start') {
          setTimeout(()=>{
            this.emit('notification','item/completed',{item:{type:'agentMessage',phase:'commentary',text:'working'}});
            this.emit('notification','turn/completed',{turn:{id:'turn',status}});
          },10);
          return {turn:{id:'turn'}};
        }
        throw Error('Unexpected automatic request '+method);
      }
    }
    const meta=await runManaged({cwd:root,logDir:path.join(root,randomUUID()),runId:randomUUID(),prompt:'one turn',model:'fixture',effort:'low'},()=>new Client());
    // Check the forbidden action itself before downstream terminal facts: an
    // injected extra turn may also alter completed/status as a side effect.
    assert.equal(methods.filter(m=>m==='turn/start').length,1,'no automatic continue');
    assert.equal(meta.status,status==='completed'?'ok':status,'managed terminal '+status);
    assert.equal(meta.lastMessage,'','commentary is not final answer');
    assert.equal(methods.filter(m=>m==='thread/start').length,1,'no automatic restart');
  }
});

await test('explicit-resume', async () => {
  const cwd=fs.mkdtempSync(path.join(root,'resume-')),trace=path.join(cwd,'requests.jsonl'),preload=path.join(cwd,'cli.mjs');
  fs.writeFileSync(preload, `import readline from 'node:readline';import fs from 'node:fs';
const send=v=>console.log(JSON.stringify(v));
for await(const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line),p=m.params; if(!m.id)continue;
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({method:m.method,params:p})+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:p.threadId||'thread-explicit'}}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});setTimeout(()=>{send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'full final answer'}}});send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});},20);}
 else send({id:m.id,result:{}});
}`);
  const old={NODE_OPTIONS:process.env.NODE_OPTIONS,CODEX_EXE:process.env.CODEX_EXE};
  process.env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;process.env.CODEX_EXE=process.execPath;
  const prompt=path.join(cwd,'next.md');fs.writeFileSync(prompt,'explicit next direction');
  const notices=[],notifier=new RunNotifier({home:path.join(cwd,'notice-home'),schedule:{async create(sessionId,request){notices.push(request);return {id:'detached-notice'};}}});
  const tracked=[],options={defineTool:d=>d,resolveCwd:()=>cwd,config:{backend:'app-server',autoModelAndEffort:true},onRunReserved:({record})=>{tracked.push(record);notifier.track({cwd,record});}};
  try {
    const run=buildToolDefinition(options),status=buildStatusToolDefinition(options);
    const first=await run.execute({label:'first',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt},{});
    assert.equal(first.status,'ok',JSON.stringify(first));assert.equal(first.resumable,true,'explicit completed resumable');
    assert.equal(first.notify_on_complete,'off');assert.equal(first.answer_truncated,false);assert.equal(first.answer,'full final answer');
    const polled=await status.execute({run_id:first.run_id},{});
    for(const key of ['turn_status','process_status','task_state','needs_dsh_decision','decision_reason','resumable','has_final_answer','answer_truncated'])assert.equal(polled[key],first[key],key);
    const read=historyTools(options).find(t=>t.name==='codex_read');
    const page=await read.execute({run_id:first.run_id,source:'answer',offset:0,limit:4},{});
    assert.equal(page.text,'full','answer pagination retained');
    const second=await run.execute({label:'second',model:'gpt-6-luna',effort:'low',prompt_file:prompt,continue_run_id:first.run_id},{});
    assert.equal(second.status,'ok',JSON.stringify(second));assert.notEqual(second.run_id,first.run_id);
    assert.equal(second.continuation_of,first.run_id,'continuation result audit');
    assert.equal(first.thread_action,'created');assert.equal(second.thread_action,'continued');
    assert.equal(second.thread_id,first.thread_id);assert.notEqual(second.run_id,first.run_id);
    assert.equal(second.model,'gpt-6-luna');assert.equal(second.effort,'low');
    assert.equal(tracked[1].continuationOf,first.run_id,'continuation stored audit');
    const requests=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
    const resumes=requests.filter(r=>r.method==='thread/resume');
    assert.equal(resumes.length,1,'only explicit resume');assert.equal(resumes[0].params.threadId,first.thread_id);
    assert.equal(requests.filter(r=>r.method==='thread/start').length,1,'no automatic thread restart');
    assert.equal(requests.filter(r=>r.method==='turn/start').length,2,'one turn per explicit call');
    assert.equal(requests.find(r=>r.method==='thread/resume').params.model,'gpt-6-luna');
    assert.equal(requests.filter(r=>r.method==='turn/start')[1].params.effort,'low');
    assert.equal(listRecords(path.join(cwd,LOGS_REL)).length,2,'no automatic new runs');
    assert.equal(readJson(path.join(cwd,LOGS_REL,'runs',second.run_id,'run.json')).continuationOf,first.run_id);
    const detached=await run.execute({label:'detached',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true},{agent:{session:{id:'origin'}}});
    assert.equal(detached.status,'running');assert.equal(detached.process_status,'running');assert.equal(detached.notify_on_complete,'decision');
    for(let i=0;i<60;i++) {await new Promise(r=>setTimeout(r,100));await notifier.poll();if(notices.length)break;}
    assert.equal(notices.length,1,'fake detached completion notice');await notifier.poll();assert.equal(notices.length,1);
    assert.equal(listRecords(path.join(cwd,LOGS_REL)).length,3,'notification does not create runs');
    for(const bad of [{notify_on_complete:'invalid'},{continuation_of:'invalid'}])assert.equal((await run.execute({label:'bad',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,...bad},{})).status,'error');
  }finally{await notifier.close();for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

assert.ok(passed,'selected test exists');
console.log('RETURN-HANDLING-OK '+passed);
