import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {QuotaCoordinator} from '../lib/quota-coordinator.js';
import {buildToolDefinition,LOGS_REL} from '../lib/core.js';
import {FALLBACK_CATALOG} from '../lib/model-catalog.js';
import {reserveRun,runDirectory,atomicJson} from '../lib/run-store.js';

// Real coordinator and tool entry; only host persistence, quota transport and
// the final process boundary are substitutes. No Codex process or account access.
async function fixture(patch={}) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'quota-entry-')),logs=path.join(cwd,LOGS_REL);
  const record=reserveRun(logs,'original'),dir=runDirectory(logs,record),prompt=path.join(cwd,'task.md');
  fs.writeFileSync(prompt,'Authorized offline fixture');
  const rows=new Map(),schedules=new Map(),launches=[];
  const table={get:id=>rows.get(id),entries:()=>[...rows],delete:async id=>rows.delete(id),put:async(id,r)=>rows.set(id,structuredClone(r))};
  const schedule={list:async()=>[...schedules.values()],create:async(_,r)=>{const item={...r,id:randomUUID()};schedules.set(item.id,item);return item;},delete:async r=>schedules.delete(r.id)};
  const config={autoResumeAfterQuota:true,...patch},exec={agent:{session:{id:'fixture-session',header:{cwd}}}};
  let runner,catalog=structuredClone(FALLBACK_CATALOG);
  const coordinator=new QuotaCoordinator({config,schedule,storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})},
    readQuota:async()=>({fingerprint:'fixture',decision:{state:'ready'}}),runner:()=>runner});
  runner=buildToolDefinition({defineTool:d=>d,resolveCwd:e=>e.agent.session.header.cwd,config,quotaCoordinator:coordinator,catalog:async()=>catalog,
    driver:async options=>{launches.push(options);return {detached:true,driverPid:null};}});
  await coordinator.track({cwd,record,exec,args:{prompt_file:prompt,label:'original',task_kind:'implement'},model:'gpt-6.1-sol',effort:'high'});
  atomicJson(path.join(dir,'result.meta.json'),{status:'waiting_quota',killVerified:true,accountFingerprint:'fixture',threadId:'original-thread',quota:{state:'blocked',resumeAt:Date.now()-1}});
  await coordinator.poll();const original=rows.get(record.runId),request={run_id:record.runId,generation:original.generation};
  return {config,exec,runner,coordinator,rows,schedules,launches,record,dir,prompt,request,
    setCatalog:value=>{catalog=value;},resume:()=>coordinator.recover(request,exec),
    async close(){await coordinator.close();assert.equal(path.dirname(cwd),fs.realpathSync(os.tmpdir()));fs.rmSync(cwd,{recursive:true,force:true});}};
}
let passed=0;
async function test(name,fn,config){const f=await fixture(config);try{await fn(f);console.log('PASS '+name);passed++;}finally{await f.close();}}
await test('default autonomy off resumes original pair despite changed defaults, using current sandbox',async f=>{
  f.config.defaultModel='gpt-6-astra';f.config.defaultEffort='low';f.config.sandboxMode='read-only';
  const result=await f.resume();assert.equal(result.status,'running',result.summary_text);
  assert.equal(result.model_source,'recovery');assert.equal(result.effort_source,'recovery');
  assert.equal(f.rows.get(f.record.runId).phase,'resumed');assert.equal(f.schedules.size,0);
  assert.equal(f.launches.length,1);assert.equal(f.launches[0].model,'gpt-6.1-sol');assert.equal(f.launches[0].effort,'high');
  assert.equal(f.launches[0].sandbox,'read-only');assert.equal(f.launches[0].resumeThread,'original-thread');
  assert.equal((await f.resume()).status,'ignored');assert.equal(f.launches.length,1);
});
await test('external arguments cannot impersonate the internal recovery capability',async f=>{
  const result=await f.runner.execute({prompt_file:f.prompt,label:'external',model:'gpt-6.1-sol',effort:'high',recovery:true,recovery_parent:f.record.runId},f.exec);
  assert.equal(result.status,'error');assert.match(result.summary_text,/model\/effort/);assert.equal(f.launches.length,0);
});
await test('autonomy on also preserves the recorded pair',async f=>{
  const result=await f.resume();assert.equal(result.status,'running',result.summary_text);assert.equal(result.model,'gpt-6.1-sol');assert.equal(result.effort,'high');
},{autoModelAndEffort:true});
await test('missing original selection never falls back to defaults',async f=>{
  delete f.rows.get(f.record.runId).args.model;
  const result=await f.resume();assert.equal(result.status,'error');assert.match(result.summary_text,/original model and effort/);
  assert.equal(f.launches.length,0);assert.equal(f.rows.get(f.record.runId).phase,'needs_attention');
});
await test('unavailable original model stops without choosing another model',async f=>{
  f.setCatalog({...FALLBACK_CATALOG,models:FALLBACK_CATALOG.models.filter(m=>m.id!=='gpt-6.1-sol')});
  assert.equal((await f.resume()).status,'error');assert.equal(f.launches.length,0);assert.equal(f.rows.get(f.record.runId).phase,'needs_attention');
});
await test('current effort cap still rejects the original pair without an unlock',async f=>{
  f.config.maxEffortAllowed='medium';const result=await f.resume();assert.equal(result.status,'error');assert.match(result.summary_text,/effort=high/);assert.equal(f.launches.length,0);
});
await test('unsupported original effort stops without reducing effort',async f=>{
  const catalog=structuredClone(FALLBACK_CATALOG);
  catalog.models.find(m=>m.id==='gpt-6.1-sol').efforts=catalog.models.find(m=>m.id==='gpt-6.1-sol').efforts.filter(e=>e.id!=='high');
  f.setCatalog(catalog);assert.equal((await f.resume()).status,'error');assert.equal(f.launches.length,0);
});
await test('evidence mode cannot silently replace missing original evidence',async f=>{
  const result=await f.resume();assert.equal(result.status,'error');assert.match(result.summary_text,/original selection evidence/);assert.equal(f.launches.length,0);
},{autoModelAndEffort:true,selectionMode:'evidence',selectionPolicy:{mode:'enforce'}});
await test('enforced evidence policy reuses original claims and checks current floors',async f=>{
  atomicJson(path.join(f.dir,'selection.json'),{caller_claims:{security_risk:true},stage:'execution'});
  const result=await f.resume();assert.equal(result.status,'error');assert.match(result.summary_text,/downgrade/);assert.equal(f.launches.length,0);
},{autoModelAndEffort:true,selectionMode:'evidence',selectionPolicy:{mode:'enforce'}});
await test('enforced evidence policy permits an unchanged authorized selection',async f=>{
  atomicJson(path.join(f.dir,'selection.json'),{caller_claims:{security_risk:false},stage:'execution'});
  const result=await f.resume();assert.equal(result.status,'running',result.summary_text);assert.equal(f.launches.length,1);
  const audit=JSON.parse(fs.readFileSync(path.join(f.launches[0].logDir,'selection.json'),'utf8'));
  assert.deepEqual(audit.caller_claims,{security_risk:false});assert.equal(audit.stage,'execution');
  assert.equal(f.rows.get(result.run_id).args.task_kind,'implement');
},{autoModelAndEffort:true,selectionMode:'evidence',selectionPolicy:{mode:'enforce'}});
await test('cancelled recovery never reaches the driver',async f=>{
  await f.coordinator.cancel(f.exec.agent.session.header.cwd,f.record.runId);assert.equal((await f.resume()).status,'ignored');assert.equal(f.launches.length,0);
});
await test('disabled recovery never reaches the driver',async f=>{
  f.config.autoResumeAfterQuota=false;assert.equal((await f.resume()).status,'cancelled');assert.equal(f.launches.length,0);
});
console.log('QUOTA-ENTRY-OK '+passed);
