import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as core from '../lib/core.js';
import { managementTools } from '../lib/management.js';
import { reserveRun, atomicJson, readJson, runDirectory, updateRecord, recordFor, listRecords } from '../lib/run-store.js';
import {readOutput} from '../lib/output-stream.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-lifecycle-'));
const preload=path.join(root,'fake-cli.mjs');
fs.writeFileSync(preload, `
import path from 'node:path';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const cmd=path.basename(process.argv[1]||'');
if(cmd==='exec') {
  fs.writeFileSync(path.join(process.cwd(),'exec-arguments.json'),JSON.stringify(process.argv));
  let text=''; for await (const chunk of process.stdin) text+=chunk;
  console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
  if(text.includes('WAIT')) {
    const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(path.join(process.cwd(),'fixture-child.json'),JSON.stringify({pid:worker.pid}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'child='+worker.pid}}));
    setInterval(()=>{},1000); await new Promise(()=>{});
  } else {
    if(text.includes('UTF8')) {
      const b=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'中文答复'}})+'\\n');
      const i=b.indexOf(Buffer.from('中'))+1;
      process.stdout.write(b.subarray(0,i)); await new Promise(r=>setTimeout(r,80)); process.stdout.write(b.subarray(i));
    } else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture complete'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
    process.exit(0);
  }
} else if(cmd==='queue') { console.log('Queued fixture message'); process.exit(0); }
`);
const oldEnv={CODEX_EXE:process.env.CODEX_EXE,NODE_OPTIONS:process.env.NODE_OPTIONS,DSH_HOME:process.env.DSH_HOME};
process.env.CODEX_EXE=process.execPath;
process.env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;
process.env.DSH_HOME=path.join(root,'dsh-home');
const options={defineTool:d=>d,resolveCwd:()=>root,config:{backend:'exec',autoModelAndEffort:true}};
const run=core.buildToolDefinition(options), status=core.buildStatusToolDefinition(options);
const managed=Object.fromEntries(managementTools(options).map(t=>[t.name,t]));
const prompt=path.join(root,'task.md'), logs=path.join(root,core.LOGS_REL);
const exec={}; let passed=0;
async function test(name, fn) { await fn(); passed++; console.log('PASS '+name); }
try {
  await test('protected overrides rejected, including tool writes',async()=>{
    for(const pair of ['sandbox_mode=danger-full-access','model_reasoning_effort=ultra','approval_policy=never']) assert.ok(core.codexConfigPairs({},[pair]).problems.length);
    const cfg=core.buildConfigToolDefinition(options);
    assert.equal((await cfg.execute({action:'set',key:'extraCodexConfig',value:['sandbox_mode=danger-full-access']},exec)).status,'error');
  });
  await test('unsafe label fails before writes',async()=>{
    assert.equal((await run.execute({label:'../../escape',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt},exec)).status,'error');
    assert.throws(()=>reserveRun(logs,'../escape'));
  });
  await test('spawn failure returns structured error',async()=>{
    const r=await core.runDriver({cwd:path.join(root,'missing'),driverPath:core.BUNDLED_DRIVER,promptFile:prompt,label:'probe',detach:true});
    assert.equal(r.meta.status,'spawn-error');
  });
  await test('sync real driver with deterministic fake CLI',async()=>{
    fs.writeFileSync(prompt,'COMPLETE');
    const r=await run.execute({label:'same',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt},exec);
    assert.equal(r.status,'ok',JSON.stringify(r)); assert.equal(r.answer,'fixture complete'); assert.ok(r.run_id);
    assert.equal(r.budget_ms,0);
    assert.equal(readJson(path.join(logs,'runs',r.run_id,'result.meta.json')).budgetMs,0);
    const stream=readOutput(path.join(logs,'runs',r.run_id),r.run_id);assert.equal(stream.status,'ok');assert.ok(stream.events.some(event=>event.params.item?.text==='fixture complete'));assert.equal(fs.existsSync(path.join(logs,'runs',r.run_id,'events.jsonl')),false);
    const args=readJson(path.join(root,'exec-arguments.json'));
    assert.equal(args.includes('--ignore-user-config'),false,'exec inherits Codex user configuration');
    for(const key of ['agents.enabled','agents.max_concurrent_threads_per_session','agents.default_subagent_model','agents.default_subagent_reasoning_effort'])assert.equal(args.some(arg=>arg.startsWith(key+'=')),false,key+' stays inherited');
  });
  await test('omitted exec driver budget defaults to unlimited',async()=>{
    fs.writeFileSync(prompt,'COMPLETE');
    const r=await core.runDriver({cwd:root,driverPath:core.BUNDLED_DRIVER,promptFile:prompt,label:'driver-default',logDir:path.join(root,'driver-default'),model:'gpt-6.1-sol',effort:'high'});
    assert.equal(r.meta.status,'ok');assert.equal(r.meta.budgetMs,0);
  });
  await test('sync and detached runs share one default and the same per-call precedence',async()=>{
    fs.writeFileSync(prompt,'COMPLETE');
    const configured=core.buildToolDefinition({...options,config:{...options.config,defaultBudgetMs:600000}});
    for(const detach of [false,true])for(const [budget_ms,expected] of [[undefined,600000],[0,0],[300000,300000]]){
      const started=await configured.execute({label:'shared-budget',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach,...(budget_ms===undefined?{}:{budget_ms})},exec);
      const result=detach?await status.execute({run_id:started.run_id,wait_ms:10000},exec):started;
      assert.equal(result.status,'ok',result.summary_text);assert.equal(result.budget_ms,expected);
      assert.equal(readJson(path.join(logs,'runs',started.run_id,'result.meta.json')).budgetMs,expected);
    }
  });
  let background;
  await test('same label new generation does not return old result',async()=>{
    fs.writeFileSync(prompt,'WAIT');
    background=await run.execute({label:'same',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true},exec);
    assert.equal(background.status,'running',JSON.stringify(background));
    const r=await status.execute({run_id:background.run_id},exec); assert.equal(r.running,true);
    const duplicate=await run.execute({label:'same',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true},exec);
    assert.equal(duplicate.status,'error');
  });
  await test('workspace concurrency enforced for different labels',async()=>{
    assert.equal((await run.execute({label:'other',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true},exec)).status,'error');
  });
  await test('list and queue use exact run',async()=>{
    const listing=await managed.codex_list.execute({},exec); assert.ok(listing.runs.some(r=>r.run_id===background.run_id));
    let snap; for(let i=0;i<40;i++){snap=core.readRunState(logs,background.run_id);if(snap.meta?.threadId)break;await core.sleep(200);}
    assert.equal(snap.meta.threadId,'fixture-thread');
    const say=core.buildSayToolDefinition(options);
    assert.equal((await say.execute({run_id:background.run_id,message:'fixture message'},exec)).status,'ok');
  });
  await test('cancel stops driver, CLI and descendant',async()=>{
    const snap=core.readRunState(logs,background.run_id);
    const pid=JSON.parse(fs.readFileSync(path.join(root,'fixture-child.json'),'utf8')).pid; assert.ok(core.pidAlive(pid));
    const r=await managed.codex_cancel.execute({run_id:background.run_id},exec);
    // Cancellation may return pending while the driver is still unwinding.
    // The real contract is that the whole process tree is gone shortly after.
    assert.ok(r.status==='ok'||r.status==='pending',JSON.stringify(r));
    if(r.status==='ok') assert.equal(r.kill_verified,true);
    let dead=false;
    for(let i=0;i<100;i++){
      if(!core.pidAlive(pid)&&!core.pidAlive(snap.meta.childPid)){dead=true;break;}
      await core.sleep(200);
    }
    assert.equal(dead,true,JSON.stringify(r));
  });
  await test('prefix labels cannot cross-read',async()=>{
    fs.writeFileSync(prompt,'COMPLETE');
    const r=await run.execute({label:'job-child',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt},exec); assert.equal(r.status,'ok');
    assert.equal(core.readMeta(logs,'job').meta,null);
  });
  await test('status returns the complete final answer',async()=>{
    const r=await status.execute({label:'job-child'},exec);
    assert.equal(r.answer,'fixture complete');assert.equal(r.answer_truncated,false);
  });
  await test('corrupt records cannot redirect paths or break listing',()=>{
    const r=reserveRun(logs,'corrupt');
    atomicJson(path.join(runDirectory(logs,r),'run.json'),{...r,runId:'../../escape'});
    assert.equal(recordFor(logs,r.runId),null);
    assert.ok(!listRecords(logs).some(x=>x.label==='corrupt'));
  });
  await test('split UTF-8 output survives stream chunks',async()=>{
    fs.writeFileSync(prompt,'UTF8');
    const r=await run.execute({label:'unicode',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt},exec);
    assert.equal(r.answer,'中文答复');
  });
  await test('detached runs use the shared unlimited default',async()=>{
    fs.writeFileSync(prompt,'COMPLETE');
    const r=await run.execute({label:'detached-budget',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true},exec);
    const done=await status.execute({run_id:r.run_id,wait_ms:10000},exec);
    assert.equal(done.budget_ms,0);assert.equal(done.status,'ok');
  });
  await test('budget termination is verified',async()=>{
    fs.writeFileSync(prompt,'WAIT');
    const r=await run.execute({label:'budget',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,budget_ms:800},exec);
    assert.equal(r.termination,'channel-budget',JSON.stringify(r));assert.equal(r.kill_verified,true);
  });
  await test('shared default budget stops a detached run and preserves recovery evidence',async()=>{
    fs.writeFileSync(prompt,'WAIT');
    const configured=core.buildToolDefinition({...options,config:{...options.config,defaultBudgetMs:900}});
    const started=await configured.execute({label:'background-budget',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,detach:true},exec);
    const result=await status.execute({run_id:started.run_id,wait_ms:10000},exec);
    assert.equal(result.termination,'channel-budget',result.summary_text);assert.equal(result.kill_verified,true);
    assert.equal(result.needs_dsh_decision,true);assert.equal(result.handoff.action,'recover_task');
  });
  await test('explicit budget preserves DSH recovery while user cancellation remains separate',async()=>{
    fs.writeFileSync(prompt,'WAIT');
    const r=await run.execute({label:'budget-recovery',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt,budget_ms:1200},exec);
    assert.equal(r.termination,'channel-budget',JSON.stringify(r));assert.equal(r.kill_verified,true);
    assert.equal(r.needs_dsh_decision,true);assert.equal(r.resumable,true);
    assert.equal(r.handoff.action,'recover_task');assert.equal(r.handoff.dispatch,'after_review');
    const polled=await status.execute({run_id:r.run_id},exec);
    assert.equal(polled.handoff.action,'recover_task');assert.equal(polled.resumable,true);
  });
  await test('driver no longer blocks on historical quota',()=>{
    const text=fs.readFileSync(core.BUNDLED_DRIVER,'utf8');
    assert.ok(!text.includes('if (beforePct !== null && beforePct >= quotaLimit)'));
  });
  await test('completed records with reused PIDs do not block or cancel unrelated processes',async()=>{
    const r=reserveRun(logs,'reused-pid');
    updateRecord(logs,r,{state:'running',driverPid:process.pid});
    atomicJson(path.join(runDirectory(logs,r),'result.meta.json'),{status:'ok',childPid:process.pid});
    const cancelled=await managed.codex_cancel.execute({run_id:r.runId},exec);
    assert.equal(cancelled.status,'ok');assert.match(cancelled.summary_text,/already stopped/);
    fs.writeFileSync(prompt,'COMPLETE');
    assert.equal((await run.execute({label:'after-reuse',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt},exec)).status,'ok');
  });
  console.log('LIFECYCLE-OK '+passed);
} finally {
  for(const record of (await managed.codex_list.execute({},exec)).runs||[]) if(record.running) await managed.codex_cancel.execute({run_id:record.run_id},exec);
  for(const [key,value] of Object.entries(oldEnv)) if(value===undefined) delete process.env[key]; else process.env[key]=value;
  console.log('Evidence: '+root);
}
