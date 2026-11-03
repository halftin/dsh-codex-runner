import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { RunNotifier } from '../lib/run-notifier.js';
import { runFacts } from '../lib/run-facts.js';
import { atomicJson, readJson, runDirectory, runEvidence } from '../lib/run-store.js';
import { processStartedAt } from '../lib/process-evidence.js';
import { buildToolDefinition, buildStatusToolDefinition, LOGS_REL, SETTINGS_SPEC } from '../lib/core.js';
import { HEALTH_GRACE_MS } from '../lib/run-health.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-interruptions-'));
let passed=0;
async function test(name,fn){await fn();console.log('PASS interruptions '+name);passed++;}
const payload=call=>JSON.parse(call.prompt.split('\n').at(-1));
function fixture({record={},meta={status:'failed'},now=Date.now()}={}) {
  const cwd=fs.mkdtempSync(path.join(root,'cwd-')),home=path.join(cwd,'home');
  const r={runId:randomUUID(),label:'work',cwd,detached:true,sessionId:'origin',
    state:'running',notifyOnComplete:'off',createdAt:new Date(now).toISOString(),...record};
  const dir=runDirectory(path.join(cwd,LOGS_REL),r);
  atomicJson(path.join(dir,'run.json'),r);
  if(meta)atomicJson(path.join(dir,'result.meta.json'),{runId:r.runId,threadId:'thread',turnId:'turn',...meta});
  const calls=[],schedule={async create(sessionId,request){calls.push({sessionId,...request});return {id:'notice-'+calls.length};},async list(){return [];} };
  const notifier=new RunNotifier({home,schedule,now:()=>now,rpcTimeoutMs:20});notifier.track({cwd,record:r});
  return {cwd,home,dir,record:r,calls,schedule,notifier,now};
}

await test('sync lost return survives restart and wakes DSH even when notices are off',async()=>{
  const f=fixture({record:{detached:false}});await f.notifier.close();
  const restarted=new RunNotifier({home:f.home,schedule:f.schedule});
  try {await restarted.poll();await restarted.poll();assert.equal(f.calls.length,1);
    assert.equal(payload(f.calls[0]).wake_dsh,true);assert.equal(payload(f.calls[0]).handoff.action,'recover_task');
    assert.match(f.calls[0].prompt,/not a new task instruction/);
    assert.doesNotMatch(f.calls[0].prompt,/until that goal is achieved|repair interruptions|continue unfinished work/);
  }finally{await restarted.close();}
});

await test('sync return grace and durable receipt prevent duplicate notices',async()=>{
  const f=fixture({record:{detached:false,ownerPid:process.pid,ownerStartedAt:processStartedAt()},meta:{status:'ok',end:new Date().toISOString()}});
  try {await f.notifier.poll();assert.equal(f.calls.length,0);
    atomicJson(path.join(f.dir,'tool-returned.json'),{runId:f.record.runId});
    await f.notifier.poll();assert.equal(f.calls.length,0);assert.equal(f.notifier.runs.size,0);
  }finally{await f.notifier.close();}
  const g=fixture({record:{detached:false,ownerPid:process.pid,ownerStartedAt:processStartedAt()},meta:{status:'failed',end:new Date(Date.now()-20000).toISOString()}});
  try {await g.notifier.poll();assert.equal(g.calls.length,1);}finally{await g.notifier.close();}
});

await test('caller disconnect and host shutdown are interruptions, explicit stop stays stopped',async()=>{
  for(const reason of ['caller-disconnected','caller-aborted','host-shutdown','user-cancel','user-interrupt']) {
    const user=reason.startsWith('user-'),f=fixture({record:{detached:false,ownerPid:process.pid},meta:{status:'killed',abortReason:reason}});
    atomicJson(path.join(f.dir,'stop.json'),{runId:f.record.runId,reason});
    try {await f.notifier.poll();assert.equal(f.calls.length,user?0:1,reason);
      assert.equal(runFacts({status:'killed',meta:{abortReason:reason}}).handoff.action,user?'stopped':'recover_task');
    }finally{await f.notifier.close();}
  }
});

await test('missing and malformed execution records retain original session routing',async()=>{
  for(const broken of ['missing','malformed']) {
    const f=fixture();
    if(broken==='missing')fs.unlinkSync(path.join(f.dir,'run.json'));
    else fs.writeFileSync(path.join(f.dir,'run.json'),'{');
    await f.notifier.close();const restarted=new RunNotifier({home:f.home,schedule:f.schedule});
    try {await restarted.poll();await restarted.poll();assert.equal(f.calls.length,1);
      assert.equal(f.calls[0].sessionId,'origin');assert.equal(payload(f.calls[0]).decision_reason,'record_unavailable');
      assert.equal(payload(f.calls[0]).handoff.dispatch,'blocked');
    }finally{await restarted.close();}
  }
});

await test('heartbeat loss alerts once; silent model with fresh heartbeat remains healthy',async()=>{
  const f=fixture({record:{driverPid:process.pid,driverStartedAt:processStartedAt(),createdAt:new Date(Date.now()-HEALTH_GRACE_MS-1000).toISOString()},meta:{status:'running'}});
  try {await f.notifier.poll();await f.notifier.poll();assert.equal(f.calls.length,1);
    assert.equal(payload(f.calls[0]).decision_reason,'heartbeat_lost');
    assert.equal(payload(f.calls[0]).needs_dsh_decision,true);assert.equal(payload(f.calls[0]).wake_dsh,true);
    const status=await buildStatusToolDefinition({defineTool:d=>d,resolveCwd:()=>f.cwd}).execute({run_id:f.record.runId},{});
    assert.equal(status.handoff.action,'inspect_process');assert.equal(status.health_issue,'heartbeat_lost');
    atomicJson(path.join(f.dir,'result.hb.json'),{runId:f.record.runId,ts:new Date(f.now).toISOString(),lastOutAgeMs:9999999});
    await f.notifier.poll();assert.equal(f.calls.length,1);
    assert.equal(runEvidence(path.join(f.cwd,LOGS_REL),f.record,{now:f.now}).healthIssue,null);
  }finally{await f.notifier.close();}
});

await test('startup stalled and missing metadata notify without killing or replaying',async()=>{
  for(const kind of ['startup_stalled','metadata_unavailable']) {
    const f=fixture({record:{createdAt:new Date(Date.now()-HEALTH_GRACE_MS-1000).toISOString(),
      ...(kind==='startup_stalled'?{state:'spawning',ownerPid:process.pid,ownerStartedAt:processStartedAt()}:{driverPid:process.pid,driverStartedAt:processStartedAt()})},meta:null});
    atomicJson(path.join(f.dir,'result.hb.json'),{runId:f.record.runId,ts:new Date(f.now).toISOString()});
    try {await f.notifier.poll();await f.notifier.poll();assert.equal(f.calls.length,1);
      assert.equal(payload(f.calls[0]).decision_reason,kind);assert.equal(payload(f.calls[0]).handoff.dispatch,'blocked');
    }finally{await f.notifier.close();}
  }
});

await test('malformed reply metadata reports attention instead of silently breaking polling',async()=>{
  const f=fixture({record:{driverPid:process.pid,driverStartedAt:processStartedAt()},meta:{status:'running',replySignals:{broken:true}}});
  try {await f.notifier.poll();await f.notifier.poll();assert.equal(f.calls.length,1);
    assert.equal(payload(f.calls[0]).decision_reason,'metadata_invalid');assert.equal(payload(f.calls[0]).wake_dsh,true);
  }finally{await f.notifier.close();}
});

await test('terminal pending messages and failed children are visible decision facts',async()=>{
  const f=fixture({meta:{status:'failed',pendingMessages:0}});
  atomicJson(path.join(f.dir,'pending-messages.json'),[{id:'one',text:'queued task'},{id:'two',text:'next task'}]);
  try {await f.notifier.poll();assert.equal(payload(f.calls[0]).pending_messages,2);
    assert.equal(payload(f.calls[0]).decision_reason,'pending_messages');
    assert.equal(runFacts({status:'ok',answer:'partial',subagents:{failed:1}}).decision_reason,'subagents_failed');
  }finally{await f.notifier.close();}
});

await test('unresolved health delivery survives a later terminal event',async()=>{
  const f=fixture({record:{driverPid:process.pid,driverStartedAt:processStartedAt(),createdAt:new Date(Date.now()-HEALTH_GRACE_MS-1000).toISOString()},meta:{status:'running'}});
  const submitted=[];let fail=true;
  f.schedule.create=async(sessionId,request)=>{
    const row={id:'notice-'+submitted.length,...request};submitted.push(row);
    if(fail)throw Error('response lost');return row;
  };
  f.schedule.list=async()=>[];
  try {await f.notifier.poll();assert.equal(submitted.length,1);
    atomicJson(path.join(f.dir,'run.json'),{...f.record,driverPid:null});
    atomicJson(path.join(f.dir,'result.meta.json'),{status:'failed',turnId:'turn',runId:f.record.runId});
    const intent=readJson(path.join(f.dir,'notify-intent.json'));
    await f.notifier.poll();assert.equal(submitted.length,1);assert.equal(readJson(path.join(f.dir,'notify-intent.json')).key,intent.key);
    fail=false;f.schedule.list=async()=>submitted;
    await f.notifier.poll();await f.notifier.poll();assert.equal(submitted.length,2);
    assert.equal(readJson(path.join(f.dir,'notified.json')).keys.length,2);
  }finally{await f.notifier.close();}
});

await test('actual synchronous abort and host teardown retain a notification route',async()=>{
  const driver=path.join(root,'stop-driver.mjs');
  fs.writeFileSync(driver,`
import fs from 'node:fs';import path from 'node:path';
const arg=k=>process.argv[process.argv.indexOf(k)+1],dir=arg('--log-dir');
const timer=setInterval(()=>{
 let stop;try{stop=JSON.parse(fs.readFileSync(path.join(dir,'stop.json'),'utf8'));}catch{return;}
 fs.writeFileSync(path.join(dir,'result.meta.json'),JSON.stringify({status:'killed',abortReason:stop.reason,end:new Date().toISOString()}));
 clearInterval(timer);
},10);
`);
  for(const host of [false,true]) {
    const f=fixture();f.notifier.forget(f.record.runId);
    fs.writeFileSync(path.join(f.cwd,'task.md'),'original task');const controller=new AbortController();
    try {
      const result=await buildToolDefinition({defineTool:d=>d,resolveCwd:()=>f.cwd,config:{backend:'exec',driverPath:driver,autoModelAndEffort:true},
        onRunReserved:info=>f.notifier.track(info),onSpawn:child=>setTimeout(()=>host?child.stop():controller.abort(),30),
      }).execute({label:'interrupted',model:'gpt-6.1-sol',effort:'high',prompt_file:'task.md'},{signal:controller.signal,agent:{session:{id:'origin'}}});
      assert.equal(result.abort_reason,host?'host-shutdown':'caller-disconnected');
      assert.equal(result.handoff.action,'recover_task');
      const dir=runDirectory(path.join(f.cwd,LOGS_REL),{runId:result.run_id});
      assert.equal(fs.existsSync(path.join(dir,'cancel.json')),false);
      assert.equal(fs.existsSync(path.join(dir,'tool-returned.json')),false);
      await f.notifier.poll();assert.equal(f.calls.length,1);assert.equal(payload(f.calls[0]).wake_dsh,true);
    }finally{await f.notifier.close();}
  }
});

await test('hung notification RPC is bounded and other runs still deliver',async()=>{
  const f=fixture(),g=fixture();await g.notifier.close();
  f.notifier.track({cwd:g.cwd,record:g.record});
  f.schedule.create=async(sessionId,request)=>{
    if(request.prompt.includes(f.record.runId))return new Promise(()=>{});
    f.calls.push({sessionId,...request});return {id:'other'};
  };
  try {await f.notifier.poll();assert.equal(f.calls.length,1);assert.ok(f.calls[0].prompt.includes(g.record.runId));
    assert.equal(readJson(path.join(f.dir,'notify-error.json')).code,'schedule-create-failed');
    await f.notifier.poll();assert.equal(f.calls.length,1,'uncertain delivery must not blindly resend');
  }finally{await f.notifier.close();}
});

await test('health and reply acknowledgements cannot overwrite each other into repeat notices',async()=>{
  const f=fixture({record:{driverPid:process.pid,driverStartedAt:processStartedAt(),createdAt:new Date(Date.now()-HEALTH_GRACE_MS-1000).toISOString()},
    meta:{status:'running',replySignals:[{turn_id:'prior',status:'ok',sequence:1,answer_preview:'partial'}]}});
  try {await f.notifier.poll();await f.notifier.poll();assert.equal(f.calls.length,2);}
  finally{await f.notifier.close();}
});

await test('quota recovery remains owned by its switch and is not replayed by generic recovery',async()=>{
  for(const enabled of [false,true]) {
    const f=fixture({meta:{status:'waiting_quota',autoResumeAfterQuota:enabled}});
    try {await f.notifier.poll();assert.equal(payload(f.calls[0]).handoff.action,enabled?'await_quota':'quota_paused');}
    finally{await f.notifier.close();}
  }
});

await test('both real drivers forward task text unchanged and sync tool results persist receipts',async()=>{
  const preload=path.join(root,'raw-cli.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
const mode=path.basename(process.argv[1]||''),send=v=>console.log(JSON.stringify(v));
if(mode==='exec') {
 let text='';for await(const c of process.stdin)text+=c;
 fs.writeFileSync(path.join(process.cwd(),'received.txt'),text);
 send({type:'thread.started',thread_id:'fixture-thread'});
 send({type:'item.completed',item:{type:'agent_message',text:'done'}});
 send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});process.exit(0);
} else if(mode==='app-server') {
 for await(const line of readline.createInterface({input:process.stdin})) {
  const m=JSON.parse(line);if(m.id===undefined)continue;let result={};
  if(m.method==='model/list')result={data:[{id:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]};
  else if(m.method==='account/read')result={account:{type:'chatgpt'}};
  else if(m.method==='thread/start')result={thread:{id:'fixture-thread'}};
  else if(m.method==='turn/start'){
   fs.writeFileSync(path.join(process.cwd(),'received.txt'),m.params.input[0].text);
   result={turn:{id:'turn'}};
   setTimeout(()=>{send({method:'item/completed',params:{threadId:'fixture-thread',item:{type:'agentMessage',text:'done'}}});
    send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'turn',status:'completed'}}});},30);
  }
  send({id:m.id,result});
 }
 process.exit(0);
}
`);
  const original=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;
  try {for(const backend of ['exec','app-server']) {
    const f=fixture();await f.notifier.close();
    const prompt='直接实现用户目标。\r\nKeep this task unchanged.\n\n## 用户自定格式\n```json\n{"message":"中文🙂","next":null}\n```\n<section>用户 HTML</section>\n  保留缩进与尾部空格  \n';fs.writeFileSync(path.join(f.cwd,'task.md'),prompt);
    const result=await buildToolDefinition({defineTool:d=>d,resolveCwd:()=>f.cwd,config:{backend,selectionMode:'evidence',selectionPolicy:{mode:'audit'}},
      catalog:async()=>({models:[{id:'gpt-6.1-sol',efforts:[{id:'medium'},{id:'high'}],serviceTiers:[]}]})
    }).execute({label:'raw',prompt_file:'task.md',evidence:{files:[],acceptance:'Implement original task',uncertainty:'unknown'}},{agent:{session:{id:'origin'}}});
    assert.equal(result.status,'ok',result.summary_text);
    assert.equal(fs.readFileSync(path.join(f.cwd,'received.txt'),'utf8'),prompt,backend);
    assert.equal(fs.existsSync(path.join(f.cwd,'.codex-runner','preamble.md')),false);
    const dir=runDirectory(path.join(f.cwd,LOGS_REL),{runId:result.run_id});
    assert.equal(readJson(path.join(dir,'tool-returned.json')).runId,result.run_id);
    assert.equal(Object.hasOwn(SETTINGS_SPEC,'preamblePath'),false);
  }}finally{process.env.NODE_OPTIONS=original;}
});

console.log('INTERRUPTIONS-OK '+passed);
