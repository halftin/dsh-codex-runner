import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runManaged } from '../lib/managed-run.js';
import { AppServerClient } from '../lib/app-server-client.js';
import { sendControl, validateControl } from '../lib/run-control.js';
import { atomicJson, readJson, alive } from '../lib/run-store.js';
import { buildToolDefinition, buildSayToolDefinition, LOGS_REL } from '../lib/core.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-managed-'));
const fixture = path.join(root, 'rpc.mjs');
fs.writeFileSync(fixture, `
import readline from 'node:readline';
import fs from 'node:fs';
const send = v => console.log(JSON.stringify(v));
let turn = 0, active, stallPause=false;
const notify = (method, params) => send({method, params:{threadId:'fixture-thread', ...params}});
const complete = (status='completed') => { notify('item/completed',{item:{type:'agentMessage',text:'中文 completed '+turn}}); notify('turn/completed',{turn:{id:active,status}}); };
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line), p=m.params;
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]},{id:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt',email:'fixture@example.invalid'}}});
 else if(m.method==='account/rateLimits/read'){
   let used=0;try{used=Number(fs.readFileSync(${JSON.stringify(path.join(root,'quota.txt'))},'utf8'));}catch{}
   send({id:m.id,result:{rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}});
 }
 else if(m.method==='thread/start'||m.method==='thread/resume'){
   fs.writeFileSync(${JSON.stringify(path.join(root,'native-config.json'))},JSON.stringify(p.config));
   send({id:m.id,result:{thread:{id:p.threadId||'fixture-thread'}}});
 }
 else if(m.method==='turn/start'){
   if(p.approvalPolicy!=='never'||!p.sandboxPolicy)throw Error('Missing explicit run policy');
   fs.writeFileSync(${JSON.stringify(path.join(root,'sandbox-policy.json'))},JSON.stringify(p.sandboxPolicy));
   active='turn-'+(++turn); notify('turn/started',{turn:{id:active}});send({id:m.id,result:{turn:{id:active}}});
   stallPause=p.input[0].text.includes('STALL_PAUSE');
   if(p.input[0].text.includes('HARD_QUOTA'))setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(root,'quota.txt'))},'100');notify('turn/completed',{turn:{id:active,status:'failed',error:{message:'Quota reached',codexErrorInfo:'usageLimitExceeded'}}});},30);
   else if(p.input[0].text.includes('RATE_ERROR'))setTimeout(()=>notify('turn/completed',{turn:{id:active,status:'failed',error:{message:'Transient rate limit',codexErrorInfo:'rateLimitExceeded'}}}),30);
   else if(!p.input[0].text.includes('WAIT'))setTimeout(complete,30);
   if(p.input[0].text.includes('QUOTA_EVENT'))setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(root,'quota.txt'))},'95');notify('account/rateLimits/updated',{});},500);
 }else if(m.method==='turn/steer'){
   fs.writeFileSync(${JSON.stringify(path.join(root,'steer.txt'))}, p.input[0].text);
   if(p.expectedTurnId!==active)send({id:m.id,error:{code:1,message:'wrong turn'}});
   else{send({id:m.id,result:{turnId:active}});if(!stallPause)setTimeout(complete,30);}
 }else if(m.method==='turn/interrupt'){send({id:m.id,result:{}});setTimeout(()=>complete('interrupted'),30);}
}
`);
const create = opts => new AppServerClient({ ...opts, executable: process.execPath, args: [fixture] });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn) { for (let i=0;i<100;i++) { const result=fn();if(result)return result;await pause(50); }throw Error('Fixture wait timeout'); }
let passes=0;
async function test(name, fn) { await fn();console.log('PASS '+name);passes++; }
function start(prompt='WAIT', extra={}) {
  const runId=randomUUID(), logDir=path.join(root,runId);
  const completion=runManaged({cwd:root,logDir,runId,prompt,model:'fixture',effort:'low',...extra},create);
  const meta=()=>readJson(path.join(logDir,'result.meta.json'));
  return {runId,logDir,completion,meta,ready:()=>waitFor(()=>meta()?.turnId),say:(action,message)=>sendControl(logDir,{runId},action,message)};
}
await test('new sandbox semantics require an explicit App Server policy mapping before starting a client',async()=>{
  const runId=randomUUID();let created=false;
  await assert.rejects(runManaged({cwd:root,logDir:path.join(root,runId),runId,sandbox:'future-sandbox'},()=>{created=true;}),/Invalid sandbox/);
  assert.equal(created,false);
});
await test('managed UTF8 result and verified connection exit',async()=>{
  const r=start('COMPLETE');const m=await r.completion;assert.equal(m.status,'ok');assert.match(m.lastMessage,/中文/);assert.equal(m.killVerified,true);assert.equal(alive(m.childPid),false);
  assert.equal(m.budgetMs,0);
});
await test('sandbox network booleans reach the native configuration and App Server permission policy',async()=>{
  const key='sandbox_workspace_write.network_access';
  for(const value of [true,false]){
    const r=start('COMPLETE',{sandbox:'workspace-write',config:{[key]:value}});
    assert.equal((await r.completion).status,'ok');
    assert.equal(readJson(path.join(root,'native-config.json'))[key],value);
    const policy=readJson(path.join(root,'sandbox-policy.json'));
    assert.equal(policy.type,'workspaceWrite');assert.equal(policy.networkAccess,value);
  }
});
await test('danger-full-access maps directly to the native policy without another plugin setting',async()=>{
  const r=start('COMPLETE',{sandbox:'danger-full-access'});
  assert.equal((await r.completion).status,'ok');
  assert.deepEqual(readJson(path.join(root,'sandbox-policy.json')),{type:'dangerFullAccess'});
});
await test('steer accepts matching active turn and affects completion',async()=>{
  const r=start();await r.ready();const reply=await r.say('steer','finish');assert.equal(reply.delivery,'accepted_by_active_turn');assert.equal((await r.completion).status,'ok');
});
await test('queue persists then starts a second turn',async()=>{
  const r=start();await r.ready();await r.say('queue','next');assert.equal(readJson(path.join(r.logDir,'pending-messages.json')).length,1);
  await r.say('steer','finish');const m=await r.completion;assert.match(m.lastMessage,/completed 2/);assert.equal(readJson(path.join(r.logDir,'pending-messages.json')).length,0);
});
await test('interrupt reports interrupted and preserves pending messages',async()=>{
  const r=start();await r.ready();await r.say('queue','later');await r.say('interrupt');const m=await r.completion;assert.equal(m.status,'interrupted');assert.equal(m.pendingMessages,1);
  await assert.rejects(r.say('steer','late'),/no longer active/);
});
await test('budget closes owned child',async()=>{const r=start('WAIT',{budgetMs:350});const m=await r.completion;assert.equal(m.abortReason,'channel-budget');assert.equal(m.killVerified,true);});
await test('startup handshake is covered by the run budget',async()=>{
  const runId=randomUUID(),started=Date.now();
  const m=await runManaged({cwd:root,logDir:path.join(root,runId),runId,prompt:'x',model:'fixture',effort:'low',budgetMs:200},opts=>new AppServerClient({...opts,executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}));
  assert.equal(m.abortReason,'channel-budget');assert.equal(m.killVerified,true);assert.ok(Date.now()-started<6000);
});
await test('cancel marker is scoped to exact run',async()=>{
  const r=start();await r.ready();atomicJson(path.join(r.logDir,'cancel.json'),{runId:randomUUID()});await pause(300);assert.equal(r.meta().status,undefined);
  atomicJson(path.join(r.logDir,'cancel.json'),{runId:r.runId});assert.equal((await r.completion).status,'cancelled');
});
await test('identity, expiration and payload rejection controls',async()=>{
  const id=randomUUID(), runId=randomUUID(), good={id,runId,action:'steer',message:'x',expiresAt:Date.now()+20000};
  assert.equal(validateControl(good,runId),good);
  for(const bad of [{runId:randomUUID()},{id:'../escape'},{expiresAt:0},{action:'execute'},{message:'x'.repeat(33000)}])assert.throws(()=>validateControl({...good,...bad},runId));
});
await test('log bound is visible',async()=>{const r=start('COMPLETE',{debugLogs:true,debugMaxBytes:1});const m=await r.completion;assert.equal(m.logTruncated,true);assert.equal(fs.existsSync(path.join(r.logDir,'events.jsonl')),false);});
await test('quota preflight waits without starting a model turn',async()=>{
  fs.writeFileSync(path.join(root,'quota.txt'),'95');
  try{const r=start('WAIT',{autoResumeAfterQuota:true});const m=await r.completion;assert.equal(m.status,'waiting_quota');assert.equal(m.turnId,null);assert.equal(m.pauseOutcome,'turn_not_started');assert.match(m.accountFingerprint,/^[a-f0-9]{64}$/);}finally{fs.writeFileSync(path.join(root,'quota.txt'),'0');}
});
await test('fresh quota event steers running turn to a confirmed pause',async()=>{
  try{const r=start('WAIT QUOTA_EVENT',{autoResumeAfterQuota:true});await r.ready();await r.say('queue','preserve me');const m=await r.completion;assert.equal(m.status,'waiting_quota');assert.equal(m.pauseOutcome,'turn_ended_after_pause_request');assert.equal(m.pendingMessages,1);assert.equal(m.killVerified,true);}finally{fs.writeFileSync(path.join(root,'quota.txt'),'0');}
});
for(const autoResumeAfterQuota of [false,true])await test('low-quota pause independent of recovery='+autoResumeAfterQuota,async()=>{
  fs.writeFileSync(path.join(root,'quota.txt'),'92');
  try{
    const r=start('WAIT',{quotaWarning:true,quotaWarningThreshold:10,autoResumeAfterQuota});
    const m=await r.completion;
    assert.equal(m.status,'waiting_quota');assert.equal(m.autoResumeAfterQuota,autoResumeAfterQuota);
    assert.equal(m.warning.threshold,10);assert.equal(m.warning.remaining,8);assert.equal(m.warning.delivery,'accepted');
    assert.equal(m.pauseOutcome,'turn_ended_after_pause_request');
    const text=fs.readFileSync(path.join(root,'steer.txt'),'utf8');assert.match(text,/请立即暂停/);
    assert.match(text,autoResumeAfterQuota?/恢复后将自动继续/:/等待用户手动继续/);
  }finally{fs.writeFileSync(path.join(root,'quota.txt'),'0');}
});
await test('quota warning stays silent above the threshold',async()=>{
  fs.writeFileSync(path.join(root,'quota.txt'),'92'); // 8% remaining > 5%
  try{
    const r=start('COMPLETE',{quotaWarning:true,quotaWarningThreshold:5});
    const m=await r.completion;
    assert.equal(m.status,'ok');
    assert.equal(m.warning,undefined);
  }finally{fs.writeFileSync(path.join(root,'quota.txt'),'0');}
});
await test('hard quota rejection between polls schedules recovery without claiming a checkpoint',async()=>{
  try{const r=start('HARD_QUOTA',{autoResumeAfterQuota:true});const m=await r.completion;assert.equal(m.status,'waiting_quota');assert.equal(m.pauseOutcome,'quota_rejection_without_checkpoint_confirmation');assert.equal(m.quota.state,'blocked');}finally{fs.writeFileSync(path.join(root,'quota.txt'),'0');}
});
await test('transient rate limit does not become a quota recovery task',async()=>{
  const r=start('RATE_ERROR',{autoResumeAfterQuota:true});const m=await r.completion;assert.equal(m.status,'failed');assert.equal(m.pauseOutcome,undefined);
});
await test('budget expiring during quota pause preserves the recovery state',async()=>{
  try{const r=start('WAIT QUOTA_EVENT STALL_PAUSE',{autoResumeAfterQuota:true,budgetMs:1400});const m=await r.completion;assert.equal(m.status,'waiting_quota');assert.equal(m.pauseOutcome,'budget_interrupt_without_checkpoint_confirmation');assert.equal(m.killVerified,true);}finally{fs.writeFileSync(path.join(root,'quota.txt'),'0');}
});
await test('default quota pause waits for checkpoint without a timed interrupt',async()=>{
  try {
    const r=start('WAIT QUOTA_EVENT STALL_PAUSE',{autoResumeAfterQuota:true,budgetMs:0});await r.ready();
    await waitFor(()=>readJson(path.join(r.logDir,'result.hb.json'))?.pauseState==='pause_requested');
    await pause(400);assert.equal(r.meta().status,undefined);
    await r.say('interrupt');assert.equal((await r.completion).pauseOutcome,'turn_ended_after_pause_request');
  }finally{fs.writeFileSync(path.join(root,'quota.txt'),'0');}
});
await test('core tool launches bundled App Server driver and routes controls',async()=>{
  const old={CODEX_EXE:process.env.CODEX_EXE,NODE_OPTIONS:process.env.NODE_OPTIONS,DSH_HOME:process.env.DSH_HOME};
  process.env.CODEX_EXE=process.execPath;process.env.NODE_OPTIONS='--import='+pathToFileURL(fixture).href;process.env.DSH_HOME=path.join(root,'host');
  let r;
  try {
    const prompt=path.join(root,'prompt.md');fs.writeFileSync(prompt,'WAIT');
    const opts={defineTool:d=>d,resolveCwd:()=>root,config:{backend:'app-server',defaultBudgetMs:10000,autoModelAndEffort:true}};
    r=await buildToolDefinition(opts).execute({label:'managed',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true},{});
    assert.equal(r.status,'running',JSON.stringify(r));const dir=path.join(root,LOGS_REL,'runs',r.run_id);
    assert.equal(r.budget_ms,10000);
    await waitFor(()=>readJson(path.join(dir,'result.meta.json'))?.turnId);
    assert.equal(readJson(path.join(dir,'result.meta.json')).budgetMs,10000);
    const reply=await buildSayToolDefinition(opts).execute({run_id:r.run_id,action:'steer',message:'finish'},{});
    assert.equal(reply.status,'ok',JSON.stringify(reply));
    const m=await waitFor(()=>{const v=readJson(path.join(dir,'result.meta.json'));return v?.status&&v;});assert.equal(m.status,'ok');assert.equal(m.killVerified,true);
  } finally {for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
await test('core tool routes quota-warning settings to the App Server driver',async()=>{
  const old={CODEX_EXE:process.env.CODEX_EXE,NODE_OPTIONS:process.env.NODE_OPTIONS,DSH_HOME:process.env.DSH_HOME};
  process.env.CODEX_EXE=process.execPath;process.env.NODE_OPTIONS='--import='+pathToFileURL(fixture).href;process.env.DSH_HOME=path.join(root,'host-warning');
  const cwd=path.join(root,'warning-cwd');fs.mkdirSync(path.join(cwd,'.codex-runner'),{recursive:true});
  fs.writeFileSync(path.join(root,'quota.txt'),'92');
  try {
    const prompt=path.join(cwd,'prompt.md');fs.writeFileSync(prompt,'WAIT');
    const opts={defineTool:d=>d,resolveCwd:()=>cwd,config:{backend:'app-server',quotaWarning:true,quotaWarningThreshold:10,autoModelAndEffort:true}};
    const r=await buildToolDefinition(opts).execute({label:'warn',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true,budget_ms:10000},{});
    assert.equal(r.status,'running',JSON.stringify(r));assert.equal(r.quota_warning,true);assert.equal(r.quota_warning_threshold,10);
    const dir=path.join(cwd,LOGS_REL,'runs',r.run_id);
    const m=await waitFor(()=>{const v=readJson(path.join(dir,'result.meta.json'));return v?.status&&v;});
    assert.equal(m.status,'waiting_quota');assert.equal(m.autoResumeAfterQuota,false);assert.equal(m.warning.threshold,10);
    assert.match(fs.readFileSync(path.join(root,'steer.txt'),'utf8'),/额度告警/);
  } finally {fs.writeFileSync(path.join(root,'quota.txt'),'0');for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
console.log('MANAGED-OK '+passes);
