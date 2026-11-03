import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {runManaged} from '../lib/managed-run.js';
import {historyTools} from '../lib/history.js';
import {RunNotifier} from '../lib/run-notifier.js';
import {createRunEvents} from '../lib/run-events.js';
import {createRunRetention} from '../lib/run-retention.js';
import {createDebugLog,answerSnapshot,isFinalAnswerItem,failureSummary} from '../lib/run-data.js';
import {reserveRun,runDirectory,atomicJson,readJson,cleanupRuns,updateRecord} from '../lib/run-store.js';
import {buildToolDefinition,buildStatusToolDefinition,SETTINGS_DEFAULTS,validateSetting,driverArgs,LOGS_REL} from '../lib/core.js';
import {QuotaCoordinator,recoveryDomain} from '../lib/quota-coordinator.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-data-'));
const cases=new Map(),test=(id,fn)=>cases.set(id,fn);
const bulk=['events.jsonl','answer.txt','result.err.log','result.jsonl'];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const appFinal='答'.repeat(25000)+'\nTAIL: tests failed; task remains unfinished.🙂';
const execFinal='answer-preview '.repeat(4000)+'\nTAIL: verification failed; continue the task.🙂';
function fixture() {
  const cwd=fs.mkdtempSync(path.join(root,'workspace-')),logs=path.join(cwd,LOGS_REL),record=reserveRun(logs,'data');
  const dir=runDirectory(logs,record);updateRecord(logs,record,{cwd,backend:'app-server'});
  return {cwd,logs,record,dir};
}
const read=(f,extras={})=>historyTools({defineTool:d=>d,resolveCwd:()=>f.cwd,...extras}).find(t=>t.name==='codex_read');
const call=(tool,f,args={})=>tool.execute({run_id:f.record.runId,...args},{});
function noBulk(dir,label) {for(const name of bulk)assert.equal(fs.existsSync(path.join(dir,name)),false,label+' no bulk '+name);}
class Fake extends EventEmitter {
  constructor({failure=false}={}) {super();this.failure=failure;this.stderrTail='中文'.repeat(1800)+' token=private-stderr person@example.invalid';}
  async initialize() {}
  async close() {}
  async request(method) {
    if(method==='model/list')return {data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
    if(method==='thread/start')return {thread:{id:'native-data'}};
    if(method==='turn/start') {
      setTimeout(()=>{
        this.emit('notification','item/completed',{item:{type:'reasoning',text:'PRIVATE REASONING'}});
        this.emit('notification','item/completed',{item:{type:'agentMessage',phase:'commentary',text:'PRIVATE PROGRESS'}});
        this.emit('notification','item/completed',{item:{type:'agentMessage',phase:'final_answer',text:appFinal}});
        this.emit('notification','item/completed',{item:{type:'agentMessage',phase:'commentary',text:'PRIVATE LATE PROGRESS'}});
        this.emit('notification','turn/completed',{turn:{id:'turn-data',status:this.failure?'failed':'completed',
          ...(this.failure?{error:{message:'token=private-error broken',codexErrorInfo:'rateLimitExceeded'}}:{})}});
      },10);
      return {turn:{id:'turn-data'}};
    }
    throw Error('Unexpected request '+method);
  }
}
async function managed(extra={},failure=false) {
  const f=fixture();const m=await runManaged({cwd:f.cwd,logDir:f.dir,runId:f.record.runId,prompt:'data',model:'fixture',effort:'low',...extra},()=>new Fake({failure}));
  return {...f,m};
}

test('settings',()=>{
  assert.equal(SETTINGS_DEFAULTS.retentionDays,0,'default project history has no age limit');
  assert.equal(SETTINGS_DEFAULTS.retentionMaxRuns,0,'default project history has no count limit');
  for(const name of ['retentionDays','retentionMaxRuns']){
    for(const value of [0,1,30,365,5000])assert.equal(validateSetting(name,value).ok,true);
    for(const value of [-1,1.5,Infinity,'30',2147483648])assert.equal(validateSetting(name,value).ok,false);
  }
  assert.equal(SETTINGS_DEFAULTS.debugLogs,false,'default debug off');
  assert.equal(SETTINGS_DEFAULTS.debugMaxBytes,2097152,'default debug limit');
  assert.equal(validateSetting('maxLogBytes',65536).ok,false,'removed limit is no longer a configuration field');
  for(const v of [0,-1,1.5,Infinity,1073741825])assert.equal(validateSetting('debugMaxBytes',v).ok,false,'invalid debug limit');
  const args=driverArgs({driverPath:'driver',promptFile:'task',label:'data',cwd:root,debugLogs:true,debugMaxBytes:32});
  assert.ok(args.includes('--debug-logs'),'debug flag forwarded');assert.ok(args.includes('--debug-max-bytes'),'debug bytes forwarded');
});
test('final-message-types',()=>{
  for(const type of ['agentMessage','agent_message'])for(const phase of [undefined,null,'final_answer'])assert.equal(isFinalAnswerItem({type,phase}),true);
  for(const item of [null,{type:'reasoning'},{type:'commandExecution'},{type:'agentMessage',phase:'commentary'},{type:'agentMessage',phase:'analysis'},{type:'agent_message',phase:'future_phase'}])assert.equal(isFinalAnswerItem(item),false);
  assert.equal(answerSnapshot(appFinal).lastMessage,appFinal);
});
test('app-default',async()=>{
  const f=await managed();assert.equal(f.m.status,'ok');noBulk(f.dir,'app');
  assert.equal(f.m.lastMessage,appFinal,'complete app final answer without reasoning or commentary');assert.equal(f.m.answerLength,appFinal.length,'app original answer length');
  assert.equal(f.m.answerTruncated,false,'complete app flag');assert.equal(readJson(path.join(f.dir,'result.meta.json')).answerTruncated,false);
  assert.ok(readJson(path.join(f.dir,'pending-messages.json')),'pending metadata retained');assert.ok(readJson(path.join(f.dir,'run.json')),'run metadata retained');
  assert.equal(readJson(path.join(f.dir,'result.hb.json')).final,true,'app final heartbeat retained');
  const opts={defineTool:d=>d,resolveCwd:()=>f.cwd,config:{}};
  const status=await buildStatusToolDefinition(opts).execute({run_id:f.record.runId},{});
  assert.equal(status.turn_status,'completed','terminal facts preserved');assert.equal(status.answer_truncated,false,'full final answer in status');
  assert.equal(status.answer,appFinal);assert.ok(status.summary_text.endsWith(appFinal));
});
test('app-failure',async()=>{
  const f=await managed({},true);assert.equal(f.m.status,'failed');noBulk(f.dir,'app failure');
  assert.equal(f.m.error_class,'rateLimitExceeded','app error class');assert.equal(f.m.termination,'failed','app termination');
  assert.ok(Buffer.byteLength(f.m.stderr_tail)<=2048,'app stderr byte bound');assert.ok(f.m.stderr_tail.includes('[secret]'),'app stderr redacted');
  assert.equal(f.m.stderr_tail.includes('private-stderr'),false,'app stderr secret absent');assert.equal(f.m.error.includes('private-error'),false,'app error redacted');
});
test('debug-limit',async()=>{
  const dir=fs.mkdtempSync(path.join(root,'debug-')),file=path.join(dir,'events.jsonl');
  const debug=createDebugLog(dir,{debugLogs:true,debugMaxBytes:100});debug.write({message:'first'});
  const before=fs.statSync(file).size;debug.write({message:'x '.repeat(1000)});debug.write({message:'tiny'});
  assert.equal(fs.statSync(file).size,before,'debug permanently stops after overflow');assert.equal(debug.truncated,true,'debug overflow flag');
  const f=await managed({debugLogs:true,debugMaxBytes:100000});const text=fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8');
  assert.ok(Buffer.byteLength(text)<=100000,'managed debug cap');assert.equal(text.includes('答'),false,'debug excludes complete answer');
  assert.equal(fs.existsSync(path.join(f.dir,'answer.txt')),false,'debug no answer file');
});
test('debug-existing',()=>{
  const dir=fs.mkdtempSync(path.join(root,'existing-')),file=path.join(dir,'events.jsonl');fs.writeFileSync(file,'existing');
  const writer=createDebugLog(dir,{debugLogs:true,debugMaxBytes:100});
  assert.throws(()=>writer.write({message:'new'}),{code:'EEXIST'},'debug refuses existing output');
  assert.equal(fs.readFileSync(file,'utf8'),'existing','existing debug untouched');
});

const preload=path.join(root,'fake-exec.mjs');
fs.writeFileSync(preload,`
import path from 'node:path';
if(path.basename(process.argv[1]||'')==='exec') {
  let text='';for await(const c of process.stdin)text+=c;
  const send=o=>console.log(JSON.stringify(o));
  send({type:'thread.started',thread_id:'exec-data'});
  send({type:'turn.started',turn_id:'first'});
  send({type:'item.completed',item:{type:'reasoning',text:'PRIVATE REASONING'}});
  send({type:'item.completed',item:{type:'agent_message',phase:'commentary',text:'PRIVATE PROGRESS'}});
  send({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:${JSON.stringify(execFinal)}}});
  send({type:'item.completed',item:{type:'agent_message',phase:'commentary',text:'PRIVATE LATE PROGRESS'}});
  send({type:'item.completed',item:{type:'command_execution',aggregated_output:'x '.repeat(10000)}});
  send({type:'item.completed',item:{type:'command_execution',aggregated_output:'small'}});
  if(text.includes('FAIL')) {
    console.error('stderr '+('中文'.repeat(1600))+' token=private-stderr');
    send({type:'turn.failed',error:{message:'token=private-error execution failed'}});process.exit(1);
  }
  send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
  if(text.includes('TWO_TURNS')) {
    send({type:'turn.started',turn_id:'empty-second'});
    send({type:'item.completed',item:{type:'agent_message',phase:'commentary',text:'working'}});
    send({type:'turn.completed',turn_id:'empty-second'});
  }
  process.exit(0);
}
`);
async function execRun(config={},prompt='COMPLETE') {
  const f=fixture();atomicJson(path.join(f.dir,'result.meta.json'),{status:'ok'});
  const task=path.join(f.cwd,'task.md');fs.writeFileSync(task,prompt);
  const env={CODEX_EXE:process.env.CODEX_EXE,NODE_OPTIONS:process.env.NODE_OPTIONS};
  process.env.CODEX_EXE=process.execPath;process.env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;
  try {
    const result=await buildToolDefinition({defineTool:d=>d,resolveCwd:()=>f.cwd,config:{backend:'exec',autoModelAndEffort:true,...config}}).execute({label:'exec-data',model:'gpt-6.1-sol',effort:'high',prompt_file:task},{});
    assert.equal(result.status,prompt==='FAIL'?'failed':'ok','exec run status');
    const dir=path.join(f.logs,'runs',result.run_id);return {...f,result,dir,m:readJson(path.join(dir,'result.meta.json'))};
  }finally{for(const [k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
test('exec-default',async()=>{
  const f=await execRun();noBulk(f.dir,'exec');assert.equal(f.m.lastMessage,execFinal,'complete exec final answer without process output');
  assert.equal(f.result.answer,execFinal);assert.ok(f.result.summary_text.endsWith(execFinal));
  assert.equal(f.m.answerTruncated,false,'complete exec flag');assert.equal(f.m.answerLength,execFinal.length,'exec original length');
  for(const file of ['run.json','result.meta.json','result.hb.json','selection.json'])assert.ok(readJson(path.join(f.dir,file)),'exec fixed '+file);
});
test('exec-failure',async()=>{
  const f=await execRun({},'FAIL');noBulk(f.dir,'exec failure');assert.equal(f.m.error_class,'turn-error','exec error class');
  assert.equal(f.m.termination,'failed','exec termination');assert.ok(Buffer.byteLength(f.m.stderr_tail)<=2048,'exec stderr byte bound');
  assert.equal(f.m.error.includes('private-error'),false,'exec error redacted');assert.equal(f.m.stderr_tail.includes('private-stderr'),false,'exec stderr redacted');
});
test('exec-empty-second',async()=>{
  const f=await execRun({},'TWO_TURNS'),signals=f.m.replySignals;
  assert.equal(signals.length,2,'exec two turns captured');
  assert.equal(signals[0].has_final_answer,true,'exec first turn has answer');
  assert.match(signals[0].answer_preview,/answer-/,'exec first turn snapshot retained');
  assert.equal(signals[1].turn_id,'empty-second','exec second turn identity');
  assert.equal(signals[1].has_final_answer,false,'exec empty second turn has no final answer');
  assert.equal(signals[1].answer_preview,'','exec empty second preview');
  assert.equal(signals[1].answer_truncated,false,'exec empty second truncation reset');
  assert.equal(signals[1].decision_reason,'empty_answer','exec empty second decision');
  assert.equal(f.m.lastMessage,'','exec final meta has no previous answer');
  assert.equal(f.m.answerLength,0,'exec final answer length reset');
  assert.equal(f.m.answerTruncated,false,'exec final truncation reset');
  assert.equal(f.result.has_final_answer,false,'exec result empty second answer');
  assert.equal(f.result.decision_reason,'empty_answer','exec result empty second decision');
  assert.equal(f.result.answer.includes('answer-'),false,'exec result never reports previous answer');
});
test('exec-debug',async()=>{
  const f=await execRun({debugLogs:true,debugMaxBytes:500});const text=fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8');
  assert.ok(Buffer.byteLength(text)<=500,'exec debug cap');assert.equal(f.m.logTruncated,true,'exec debug overflow flag');
  assert.equal(text.includes('small'),false,'exec stops after debug overflow');assert.equal(text.includes('answer-answer'),false,'exec debug excludes answer');
});
test('native-answer',async()=>{
  const f=fixture();atomicJson(path.join(f.dir,'result.meta.json'),{backend:'app-server',threadId:'native',turnId:'target',lastMessage:'META',answerTruncated:true});
  fs.writeFileSync(path.join(f.dir,'answer.txt'),'LEGACY');let calls=[];
  const tool=read(f,{connect:async fn=>fn({request:async(method,p)=>{
    calls.push(method);if(method==='thread/read')return {thread:{cwd:f.cwd}};
    assert.equal(p.sortDirection,'desc','latest native turn first');
    return p.cursor?{data:[{id:'target',items:[{type:'agentMessage',text:'NATIVE🙂'},{type:'agentMessage',phase:'commentary',text:'ignore'}]}]}:
      {data:[{id:'newer',items:[{type:'commandExecution'}]}],nextCursor:'older'};
  }})});
  const r=await call(tool,f);assert.equal(r.text,'NATIVE🙂','native answer preferred');assert.equal(r.read_source,'native_thread','native answer source');
  assert.equal(r.answer_truncated,false,'native ignores meta truncation');assert.equal(calls.length,3,'native pagination crosses non-answer turn');
  const mismatch=await call(read(f,{connect:async fn=>fn({request:async()=>({thread:{cwd:root}})})}),f);
  assert.equal(mismatch.status,'error','native workspace mismatch fails closed');
});
test('meta-fallback',async()=>{
  const f=fixture();atomicJson(path.join(f.dir,'result.meta.json'),{backend:'app-server',threadId:'native',turnId:'target',lastMessage:'META',answerTruncated:true});
  const tool=read(f,{connect:async()=>{throw Error('offline');}});const r=await call(tool,f);
  assert.equal(r.text,'META','offline meta fallback');assert.equal(r.read_source,'meta.lastMessage','fallback source');assert.equal(r.answer_truncated,true,'fallback truncation');assert.equal(r.fallback_reason,'offline');
  assert.equal((await call(tool,f,{source:'turns'})).status,'error','turns offline remains error');
  atomicJson(path.join(f.dir,'result.meta.json'),{backend:'exec',lastMessage:'EXEC'});
  const exec=await call(read(f,{connect:async()=>{assert.fail('exec must not connect');}}),f);
  assert.equal(exec.text,'EXEC','exec meta answer');assert.equal(exec.read_source,'meta.lastMessage','exec source');
  assert.equal((await call(tool,f,{source:'turns'})).status,'error','exec turns unsupported');
});
test('history-path',async()=>{
  const f=fixture(),outside=path.join(root,'outside-meta.json');atomicJson(outside,{backend:'exec',lastMessage:'OUTSIDE'});
  fs.symlinkSync(outside,path.join(f.dir,'result.meta.json'),'file');
  const result=await call(read(f),f);assert.equal(result.status,'error','history rejects redirected metadata');
  assert.equal(JSON.stringify(result).includes('OUTSIDE'),false,'outside answer never returned');
});
test('events-summary',async()=>{
  const f=fixture();atomicJson(path.join(f.dir,'result.meta.json'),{status:'ok',debugLogs:true,lastMessage:'PRIVATE ANSWER',answerLength:50000,answerTruncated:true,subagents:{running:1},quota:{state:'ready'}});
  fs.writeFileSync(path.join(f.dir,'events.jsonl'),'DEBUG');
  const denied=await call(read(f),f,{source:'events'});assert.equal(denied.status,'error','events default denied');assert.match(denied.summary_text,/turns/,'events guidance');
  const allowed=await call(read(f,{config:{debugLogs:true}}),f,{source:'events'});assert.equal(allowed.text,'DEBUG','debug events available');
  const summary=await call(read(f,{connect:async()=>assert.fail('summary must not connect')}),f,{source:'summary'});
  assert.equal(summary.turn_status,'completed','summary turn status');assert.equal(summary.decision_reason,'subagents_running','summary decision reason');
  assert.equal(summary.answer_length,50000,'summary original answer length');assert.equal(summary.answer_truncated,true,'summary answer truncation');
  assert.ok(summary.subagents);assert.ok(summary.quota);assert.equal(JSON.stringify(summary).includes('PRIVATE ANSWER'),false,'summary excludes answer');
});
test('notifier-meta',async()=>{
  const f=fixture();const record=updateRecord(f.logs,f.record,{detached:true,sessionId:'origin'});
  atomicJson(path.join(f.dir,'result.meta.json'),{status:'failed',error:'META_ERROR token=private-error',stderr_tail:'META_STDERR token=private-stderr'});
  for(const file of bulk)fs.writeFileSync(path.join(f.dir,file),'DEBUG_MUST_NOT_ENTER');
  const calls=[],notifier=new RunNotifier({home:path.join(root,randomUUID()),schedule:{async create(id,request){calls.push(request);return {id:'notice'};}}});
  try {notifier.track({cwd:f.cwd,record});await notifier.poll();assert.equal(calls.length,1,'U8 sends once');
    assert.ok(calls[0].prompt.includes('META_STDERR'),'U8 stderr comes from meta');assert.ok(calls[0].prompt.includes('META_ERROR'),'U8 error comes from meta');
    for(const text of ['DEBUG_MUST_NOT_ENTER','private-error','private-stderr'])assert.equal(calls[0].prompt.includes(text),false,'U8 excludes '+text);
  }finally{await notifier.close();}
});
test('notifier-managed-failure',async()=>{
  const f=fixture(),record=updateRecord(f.logs,f.record,{detached:true,sessionId:'origin'}),calls=[];
  const notifier=new RunNotifier({home:path.join(root,randomUUID()),schedule:{async create(id,request){calls.push(request);return {id:'failure-notice'};}}});
  let closing,releaseClose;
  const closeStarted=new Promise(resolve=>{closing=resolve;});
  const closed=new Promise(resolve=>{releaseClose=resolve;});
  class Failure extends Fake {
    async close(){closing();await closed;}
  }
  const done=runManaged({cwd:f.cwd,logDir:f.dir,runId:record.runId,prompt:'fail',model:'fixture',effort:'low'},()=>new Failure({failure:true}));
  try {
    notifier.track({cwd:f.cwd,record});await closeStarted;
    const snapshot=readJson(path.join(f.dir,'result.meta.json')).replySignals[0];
    assert.match(snapshot.error,/broken/,'failed turn snapshot error summary');
    assert.match(snapshot.stderr_tail,/中文/,'failed turn snapshot stderr summary');
    await notifier.poll();await notifier.poll();
    assert.equal(calls.length,1,'failed turn live signal exactly once');
    const p=JSON.parse(calls[0].prompt.split('\n').at(-1));
    assert.match(p.error,/broken/,'failed turn error summary');
    assert.match(p.stderr_tail,/中文/,'failed turn stderr summary');
    for(const key of ['error','stderr_tail']) {
      assert.ok(p[key].length<=400,'failed turn bounded '+key);
      assert.equal(p[key].includes('private-'),false,'failed turn redacted '+key);
    }
    releaseClose();const meta=await done;
    assert.equal(meta.status,'failed','real managed failure');assert.ok(meta.replySignals.length,'real managed reply outbox');
    await notifier.poll();assert.equal(calls.length,1,'failed turn terminal no duplicate');
    const again=new RunNotifier({home:notifier.root.replace(/[\\/]codex-runner[\\/]notifier-runs$/,''),schedule:notifier.schedule});
    try{again.track({cwd:f.cwd,record});await again.poll();assert.equal(calls.length,1,'failed turn restart no duplicate');}finally{await again.close();}
  }finally{releaseClose();await done;await notifier.close();}
  // Existing snapshots written before the summary was available still use
  // the matching turn's bounded meta diagnostics, without a second signal.
  const g=await managed({},true),r=updateRecord(g.logs,g.record,{detached:true,sessionId:'origin'}),sent=[];
  const meta=readJson(path.join(g.dir,'result.meta.json'));
  delete meta.replySignals[0].error;delete meta.replySignals[0].stderr_tail;atomicJson(path.join(g.dir,'result.meta.json'),meta);
  const fallback=new RunNotifier({home:path.join(root,randomUUID()),schedule:{async create(id,request){sent.push(request);return {id:'fallback'};}}});
  try{fallback.track({cwd:g.cwd,record:r});await fallback.poll();await fallback.poll();
    assert.equal(sent.length,1,'existing failed snapshot exactly once');const p=JSON.parse(sent[0].prompt.split('\n').at(-1));
    assert.match(p.error,/broken/,'existing failed snapshot meta error');assert.match(p.stderr_tail,/中文/,'existing failed snapshot meta stderr');
  }finally{await fallback.close();}
});
test('quota-fields',async()=>{
  const f=fixture(),task=path.join(f.cwd,'task.md');fs.writeFileSync(task,'authorized recovery');const data=new Map();
  const table={get:id=>data.get(id),entries:()=>data.entries(),put:async(id,value)=>data.set(id,value)};
  const coordinator=new QuotaCoordinator({schedule:{},storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})}});
  const allowed={prompt_file:task,label:'quota',cwd:f.cwd,resume_thread:'thread',model:'fixture',effort:'low',notify_on_complete:'off',unlock_effort:true,budget_ms:60000};
  try {
    await coordinator.track({cwd:f.cwd,record:f.record,exec:{agent:{session:{id:'origin'}}},model:'fixture',effort:'low',
      args:{...allowed,evidence:{files:['large'].concat(Array(1000).fill('evidence'))},catalog:{models:Array(1000).fill('model')},override_reason:'UNRELATED PRIVATE DATA',arbitrary:'discard'}});
    const record=data.get(f.record.runId);
    assert.deepEqual(Object.keys(record).sort(),['runId','generation','sessionId','cwd','phase','args','createdAt'].sort(),'quota record field whitelist');
    assert.deepEqual(record.args,allowed,'quota recovery argument whitelist');
    assert.ok(JSON.stringify(record).length<2048,'quota record excludes large unrelated objects');
    const parse=recoveryDomain.tables.runs.valueSchema.parse;
    assert.deepEqual(parse({...record,catalog:{large:true},args:{...allowed,evidence:{large:true}}}),record,'quota schema strips unrelated fields');
    assert.equal(Object.hasOwn(parse({...record,args:{...allowed,model:{large:true}}}).args,'model'),false,'quota schema rejects object argument');
  }finally{await coordinator.close();}
});
test('run-events',async()=>{
  for(const file of ['result.meta.json','terminal.json','run.json']) {
    const f=fixture(),events=createRunEvents(),seen=[];events.subscribe(e=>seen.push(e));events.track(f.dir,f.record);
    try {
      atomicJson(path.join(f.dir,file),file==='run.json'?{...f.record,state:'running'}:{status:'running'});await pause(50);
      assert.equal(seen.length,0,'run-events ignores active status');
      atomicJson(path.join(f.dir,file),file==='run.json'?{...f.record,state:'spawn-error'}:{status:'ok'});
      for(let i=0;i<50&&!seen.length;i++)await pause(20);
      assert.equal(seen.length,1,'terminal refresh without events file '+file);assert.equal(seen[0].run_id,f.record.runId);
      atomicJson(path.join(f.dir,file),file==='run.json'?{...f.record,state:'failed'}:{status:'failed'});await pause(50);
      assert.equal(seen.length,1,'terminal refresh deduplicated');assert.equal(fs.existsSync(path.join(f.dir,'events.jsonl')),false);
    }finally{events.close();}
  }
});
test('cleanup',()=>{
  const f=fixture();atomicJson(path.join(f.dir,'result.meta.json'),{status:'ok'});
  const fixed=['run.json','result.meta.json','result.hb.json','terminal.json','selection.json','pending-messages.json','notify-intent.json'];
  for(const file of fixed.slice(2))atomicJson(path.join(f.dir,file),file==='terminal.json'?{status:'ok'}:{fixture:true});
  const before=Object.fromEntries(fixed.map(file=>[file,fs.readFileSync(path.join(f.dir,file),'utf8')]));
  for(const file of bulk)fs.writeFileSync(path.join(f.dir,file),'legacy');cleanupRuns(f.logs);
  noBulk(f.dir,'cleanup');for(const file of fixed)assert.equal(fs.readFileSync(path.join(f.dir,file),'utf8'),before[file],'fixed metadata retained '+file);
  updateRecord(f.logs,f.record,{createdAt:new Date(0).toISOString()});
  cleanupRuns(f.logs,1,0);assert.equal(fs.existsSync(f.dir),false,'expired terminal run removed');
});
test('retention-age-and-count',async()=>{
  const recent=fixture(),expired=fixture(),day=86400000;
  updateRecord(recent.logs,recent.record,{createdAt:new Date(Date.now()-15*day).toISOString()});
  updateRecord(expired.logs,expired.record,{createdAt:new Date(Date.now()-31*day).toISOString()});
  for(const f of [recent,expired])atomicJson(path.join(f.dir,'result.meta.json'),{status:'ok',lastMessage:'Historical final answer'});
  cleanupRuns(expired.logs);
  assert.equal(fs.existsSync(expired.dir),true,'default cleanup preserves history older than thirty days');
  cleanupRuns(recent.logs);cleanupRuns(expired.logs,30,0);
  assert.equal(fs.existsSync(recent.dir),true,'history older than seven days survives within thirty days');
  assert.equal(fs.existsSync(expired.dir),false,'safe history older than thirty days is removed');
  cleanupRuns(recent.logs,14);
  assert.equal(fs.existsSync(recent.dir),false,'explicit project retention still overrides the default');

  const cwd=fs.mkdtempSync(path.join(root,'history-count-')),logs=path.join(cwd,LOGS_REL),records=[];
  const created=Date.now();
  for(let i=0;i<1001;i++){
    const record={runId:randomUUID(),label:'history',state:'completed',createdAt:new Date(created-i*60000).toISOString()};
    const dir=runDirectory(logs,record);records.push(dir);
    atomicJson(path.join(dir,'run.json'),record);
    atomicJson(path.join(dir,'result.meta.json'),{status:'ok',backend:'exec',threadId:'history-thread-'+i,lastMessage:'Final answer '+i});
  }
  cleanupRuns(logs);
  assert.equal(fs.readdirSync(path.join(logs,'runs')).length,1001,'default cleanup preserves more than a thousand runs');
  cleanupRuns(logs,30,1000);
  assert.equal(fs.readdirSync(path.join(logs,'runs')).length,1000,'retain the latest thousand runs in this workspace');
  assert.equal(readJson(path.join(records[999],'result.meta.json')).lastMessage,'Final answer 999','thousandth answer remains readable');
  assert.equal(fs.existsSync(records[1000]),false,'oldest excess safe record is removed before thirty days');
  const tools=Object.fromEntries(historyTools({defineTool:d=>d,resolveCwd:()=>cwd}).map(tool=>[tool.name,tool]));
  const page=await tools.codex_sessions.execute({offset:999,limit:1},{});
  assert.equal(page.sessions[0].run_id,path.basename(records[999]),'DSH can list the oldest retained session');
  assert.equal(page.next_offset,null,'retained history pagination ends at the thousandth record');
  const answer=await tools.codex_read.execute({run_id:page.sessions[0].run_id},{});
  assert.equal(answer.text,'Final answer 999','DSH can retrieve the full historical answer after cleanup');
  const retention=createRunRetention({home:path.join(root,randomUUID()),retentionDays:()=>0,retentionMaxRuns:()=>2});
  try{
    retention.track(cwd);retention.sweep();
    assert.equal(fs.readdirSync(path.join(logs,'runs')).length,2,'daily cleanup uses the configured count independently of zero days');
    assert.equal(fs.existsSync(records[0]),true,'latest record survives configured count cleanup');
  }finally{retention.close();}
  for(const value of [-1,0.5,Infinity])assert.throws(()=>cleanupRuns(logs,0,value),/Retention limits/);
});

test('cleanup-protection',()=>{
  for(const type of ['active','no-terminal','waiting','recovery','symlink','hb-pid']) {
    const f=fixture();atomicJson(path.join(f.dir,'result.meta.json'),{...(type==='no-terminal'?{}:{status:type==='waiting'?'waiting_quota':'ok'}),...(type==='active'?{childPid:process.pid}:{})});
    updateRecord(f.logs,f.record,{createdAt:new Date(0).toISOString()});
    if(type==='recovery')atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'needs_attention'});
    if(type==='hb-pid')atomicJson(path.join(f.dir,'result.hb.json'),{childPid:process.pid});
    if(type==='symlink')fs.symlinkSync(root,path.join(f.dir,'redirect'),'junction');
    fs.writeFileSync(path.join(f.dir,'answer.txt'),'protected');cleanupRuns(f.logs,1,0);
    assert.equal(fs.existsSync(path.join(f.dir,'answer.txt')),true,'cleanup protects '+type);
    if(type==='recovery') {
      atomicJson(path.join(f.dir,'cancel.json'),{runId:f.record.runId});cleanupRuns(f.logs,1,0);
      assert.equal(fs.existsSync(f.dir),false,'explicit cancellation permits cleanup');
    }
  }
});
test('retention-load-daily',()=>{
  const f=fixture();atomicJson(path.join(f.dir,'result.meta.json'),{status:'ok'});
  updateRecord(f.logs,f.record,{createdAt:new Date(Date.now()-365*86400000).toISOString()});
  const home=path.join(root,randomUUID());let r=createRunRetention({home});r.track(f.cwd);r.close();
  fs.writeFileSync(path.join(f.dir,'answer.txt'),'legacy');r=createRunRetention({home});
  try {assert.equal(fs.existsSync(path.join(f.dir,'answer.txt')),false,'plugin load cleanup');
    fs.writeFileSync(path.join(f.dir,'events.jsonl'),'debug');r.sweep();assert.equal(fs.existsSync(path.join(f.dir,'events.jsonl')),false,'daily sweep cleanup');
    assert.equal(fs.existsSync(path.join(f.dir,'result.meta.json')),true,'default load and daily cleanup preserve year-old history');
  }finally{r.close();}
});
test('quota-unresolved',async()=>{
  const f=fixture(),data=new Map(),task=path.join(f.cwd,'task.md');fs.writeFileSync(task,'task');
  const table={get:id=>data.get(id),entries:()=>data.entries(),put:async(id,v)=>data.set(id,v),delete:async id=>data.delete(id)};
  const coordinator=new QuotaCoordinator({storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})},schedule:{},runner:()=>null});
  try {
    await coordinator.track({cwd:f.cwd,record:f.record,exec:{agent:{session:{id:'origin'}}},args:{prompt_file:task}});
    const old={...data.get(f.record.runId),phase:'needs_attention',createdAt:new Date(Date.now()-31*86400000).toISOString()};data.set(old.runId,old);
    updateRecord(f.logs,f.record,{createdAt:new Date(0).toISOString()});
    atomicJson(path.join(f.dir,'result.meta.json'),{status:'ok'});await coordinator.poll();cleanupRuns(f.logs,1,0);
    assert.equal(data.has(old.runId),true,'unresolved quota record retained');assert.equal(fs.existsSync(f.dir),true,'unresolved quota run retained');
    assert.match((await coordinator.state(f.cwd,old.runId)).retention_warning,/30 days/,'unresolved quota warning');
  }finally{await coordinator.close();}
});
test('utf8-bound',()=>{
  const value=failureSummary('token=private-error','中'.repeat(3000)+' token=private-stderr','failure');
  assert.ok(Buffer.byteLength(value.stderr_tail)<=2048,'UTF8 2KB diagnostic bound');assert.equal(value.stderr_tail.includes('\uFFFD'),false,'UTF8 not split');
  assert.equal(value.stderr_tail.includes('private-stderr'),false,'diagnostic secret removed');
  const a=answerSnapshot('x'.repeat(19999)+'🙂end');assert.equal(a.lastMessage.endsWith('\uD83D'),false,'answer surrogate not split');
});

let passed=0;
for(const [id,fn]of cases)if(!process.env.DATA_CASE||process.env.DATA_CASE===id) {await fn();console.log('PASS data '+id);passed++;}
if(!passed)throw Error('Unknown DATA_CASE');
console.log('DATA-LIFECYCLE-OK '+passed+'\nEvidence: '+root);
