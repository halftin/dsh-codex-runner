import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildToolDefinition,buildSayToolDefinition,buildStatusToolDefinition,LOGS_REL} from '../lib/core.js';
import {atomicJson,readJson,runDirectory,reserveRun,updateRecord} from '../lib/run-store.js';
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'runner-conversation-'));
const driver=path.join(cwd,'driver.mjs');
fs.writeFileSync(path.join(cwd,'task.md'),'Exact follow-up\n{"format":"user"}\n');
fs.writeFileSync(driver,`import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
const arg=n=>process.argv[process.argv.indexOf(n)+1],dir=arg('--log-dir');
fs.writeFileSync(path.join(dir,'received.json'),JSON.stringify(process.argv));
fs.writeFileSync(path.join(dir,'result.meta.json'),JSON.stringify({status:'ok',threadId:process.argv.includes('--resume')?arg('--resume'):randomUUID(),lastMessage:'done'}));`);
let spawns=0;
const options={defineTool:d=>d,resolveCwd:()=>cwd,config:{backend:'exec',driverPath:driver,autoModelAndEffort:true},onSpawn:()=>spawns++};
const run=buildToolDefinition(options),exec={agent:{session:{id:'owner'}}};
let n=0;const call=(args={},context=exec)=>run.execute({label:'turn-'+(++n),prompt_file:'task.md',model:'gpt-6.1-sol',effort:'high',...args},context);
const first=await call();assert.equal(first.status,'ok',first.summary_text);
const second=await call({continue_run_id:first.run_id,model:'gpt-6-luna',effort:'low'});
assert.equal(second.status,'ok',second.summary_text);assert.equal(second.thread_id,first.thread_id);
assert.notEqual(second.run_id,first.run_id);assert.equal(second.continuation_of,first.run_id);
assert.equal(second.thread_action,'continued');
const args=readJson(path.join(cwd,LOGS_REL,'runs',second.run_id,'received.json'));
assert.equal(args[args.indexOf('--resume')+1],first.thread_id);
assert.equal(args[args.indexOf('--model')+1],'gpt-6-luna');assert.equal(args[args.indexOf('--effort')+1],'low');
const status=await buildStatusToolDefinition(options).execute({run_id:second.run_id},exec);
assert.equal(status.thread_action,'continued');
const third=await call({continue_run_id:second.run_id});assert.equal(third.thread_id,first.thread_id);
const independent=await call();assert.notEqual(independent.thread_id,first.thread_id);assert.equal(independent.thread_action,'created');
console.log('PASS exec multi-turn switch and switch-back preserve thread identity; new conversations stay independent');
for(const bad of [{continue_run_id:'invalid'},{continue_run_id:randomUUID()},
  {continue_run_id:first.run_id,resume_thread:first.thread_id},{continue_run_id:first.run_id,continuation_of:first.run_id}]){
  const before=spawns,result=await call(bad);assert.equal(result.status,'error');assert.equal(spawns,before);
}
const before=spawns;assert.equal((await call({continue_run_id:first.run_id},{agent:{session:{id:'other'}}})).status,'error');assert.equal(spawns,before);
const record=readJson(path.join(cwd,LOGS_REL,'runs',first.run_id,'run.json')),dir=runDirectory(path.join(cwd,LOGS_REL),record);
const meta=readJson(path.join(dir,'result.meta.json'));
for(const change of [{cwd:path.dirname(cwd)},{backend:'app-server'}]){
  atomicJson(path.join(dir,'run.json'),{...record,...change});const count=spawns;
  assert.equal((await call({continue_run_id:first.run_id})).status,'error');assert.equal(spawns,count);
}
atomicJson(path.join(dir,'run.json'),record);

for(const state of [{status:'ok',threadId:null},{status:'waiting_quota',threadId:first.thread_id},{status:'interrupted',abortReason:'user-interrupt',threadId:first.thread_id}]){
  atomicJson(path.join(dir,'result.meta.json'),{...meta,...state});
  const count=spawns,result=await call({continue_run_id:first.run_id});assert.equal(result.status,'error',JSON.stringify(result));assert.equal(spawns,count);
}
atomicJson(path.join(dir,'result.meta.json'),meta);
assert.equal((await buildSayToolDefinition(options).execute({run_id:first.run_id,message:'next',model:'gpt-6-luna'},exec)).status,'error');
console.log('PASS invalid, ambiguous, foreign, missing-thread, quota and interrupted continuations fail without creating a thread; say never silently ignores a requested model');

const logs=path.join(cwd,LOGS_REL),active=reserveRun(logs,'active',8);
updateRecord(logs,active,{cwd,backend:'exec',sessionId:'owner'});
atomicJson(path.join(runDirectory(logs,active),'result.meta.json'),{threadId:'active-thread'});
const activeCount=spawns;assert.equal((await call({continue_run_id:active.runId})).status,'error');assert.equal(spawns,activeCount);
console.log('PASS active conversation is rejected without spawning a competing run');
