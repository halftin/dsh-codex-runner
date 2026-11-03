import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { reserveRun, runDirectory, atomicJson, updateRecord, runEvidence, cleanupRuns, readJson } from '../lib/run-store.js';
import { buildStatusToolDefinition, buildSayToolDefinition, buildConfigToolDefinition, SETTINGS_SPEC, LOGS_REL } from '../lib/core.js';
import { processStartedAt } from '../lib/process-evidence.js';
import { runManaged } from '../lib/managed-run.js';
import { managementTools } from '../lib/management.js';
import { sendControl } from '../lib/run-control.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-reliability-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0;
async function test(name,fn) { await fn();console.log('PASS '+name);pass++; }
function workspace() { const cwd=fs.mkdtempSync(path.join(root,'cwd-'));return {cwd,logs:path.join(cwd,LOGS_REL)}; }
await test('PID reuse releases admission while files and unrelated process survive',()=>{
  const {logs}=workspace(),r=reserveRun(logs,'reused'),dir=runDirectory(logs,r);
  updateRecord(logs,r,{state:'running',createdAt:new Date(0).toISOString()});
  atomicJson(path.join(dir,'result.meta.json'),{childPid:process.pid,childStartedAt:new Date(0).toISOString()});
  assert.equal(runEvidence(logs,r).liveness,'stale');
  assert.ok(reserveRun(logs,'next'));cleanupRuns(logs,1,0);
  assert.ok(fs.existsSync(dir));assert.doesNotThrow(()=>process.kill(process.pid,0));
});
await test('matched orphan blocks until explicit release without process termination',async()=>{
  const {cwd,logs}=workspace(),r=reserveRun(logs,'orphan'),dir=runDirectory(logs,r);
  updateRecord(logs,r,{state:'running'});
  atomicJson(path.join(dir,'result.meta.json'),{childPid:process.pid,childStartedAt:processStartedAt()});
  assert.equal(runEvidence(logs,r).liveness,'orphan');assert.throws(()=>reserveRun(logs,'blocked'),/concurrency/);
  const tools=Object.fromEntries(managementTools({defineTool:d=>d,resolveCwd:()=>cwd}).map(t=>[t.name,t]));
  assert.equal((await tools.codex_release.execute({run_id:r.runId},{})).status,'confirmation_required');
  assert.equal((await tools.codex_release.execute({run_id:r.runId,confirm:true},{})).status,'ok');
  assert.ok(reserveRun(logs,'released'));assert.ok(fs.existsSync(dir));assert.doesNotThrow(()=>process.kill(process.pid,0));
});
await test('silent live driver remains running; unknown selector is not_found',async()=>{
  const {cwd,logs}=workspace(),r=reserveRun(logs,'silent'),dir=runDirectory(logs,r);
  updateRecord(logs,r,{state:'running',driverPid:process.pid,driverStartedAt:processStartedAt()});
  atomicJson(path.join(dir,'result.hb.json'),{runId:r.runId,ts:new Date().toISOString(),seq:1,lastOutAgeMs:3600000,lastEventAgeMs:3600000});
  const status=buildStatusToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd});
  const s=await status.execute({run_id:r.runId},{});assert.equal(s.status,'running');assert.equal(s.termination,'running');
  assert.equal(s.progress.last_out_age_ms,3600000);assert.equal(Object.hasOwn(s,'stalled'),false);
  assert.equal(s.health_issue,null);assert.doesNotMatch(s.summary_text,/疑似停滞/);
  assert.equal((await status.execute({label:'unknown'},{})).status,'not_found');
});
await test('status say and list reject invalid defaultBudgetMs before using them',async()=>{
  const {cwd}=workspace();
  const opts={defineTool:d=>d,resolveCwd:()=>cwd,config:{defaultBudgetMs:'invalid'}};
  const list=managementTools(opts).find(t=>t.name==='codex_list');
  for(const [tool,args] of [[buildStatusToolDefinition(opts),{label:'unknown'}],[buildSayToolDefinition(opts),{label:'unknown',message:'x'}],[list,{}]])
    assert.equal((await tool.execute(args,{})).status,'error');
});
await test('configuration tools cannot persist any setting or delete legacy files',async()=>{
  const {cwd}=workspace(),tool=buildConfigToolDefinition({defineTool:d=>d});
  const file=path.join(cwd,'.codex-runner','codex-runner.settings.json');atomicJson(file,{defaultEffort:'high'});
  const original=fs.readFileSync(file,'utf8');
  for(const key of Object.keys(SETTINGS_SPEC))for(const action of ['set','unset']) {
    const result=await tool.execute({action,key,value:'anything'});assert.equal(result.status,'error');assert.match(result.summary_text,/read-only/);
  }
  assert.equal((await tool.execute({action:'reset',scope:'project'})).status,'error');
  assert.equal(fs.readFileSync(file,'utf8'),original);
});
await test('dead admission owner can be reclaimed without killing a PID',()=>{
  const {logs}=workspace();fs.mkdirSync(logs,{recursive:true});atomicJson(path.join(logs,'admission.lock'),{owner:'run-admission',root:path.resolve(logs),tasks:path.resolve(logs,'runs'),pid:2147483647,startedAt:new Date(0).toISOString()});
  assert.ok(reserveRun(logs,'reclaimed'));
});
class Fake extends EventEmitter {
  constructor() {super();this.calls=[];this.closeThrows=false;}
  async initialize() {}
  async request(method) {
    this.calls.push(method);
    if(method==='model/list')return {data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start')return {turn:{id:'turn'}};
    return {};
  }
  async close() {if(this.closeThrows)throw Error('close fixture failure');}
}
await test('fifteen minutes of active thinking emits lightweight heartbeat and no interrupt',async()=>{
  const {cwd}=workspace(),runId=randomUUID(),dir=path.join(cwd,runId),client=new Fake();
  const realNow=Date.now;
  const done=runManaged({cwd,logDir:dir,runId,prompt:'x',model:'fixture',effort:'high',budgetMs:0},()=>client);
  try {
    await pause(300);Date.now=()=>realNow()+15*60000;await pause(400);
    const hb=readJson(path.join(dir,'result.hb.json'));
    assert.equal(hb.turnState,'active');assert.ok(hb.elapsedSec>=900);
    assert.equal('lastMessage' in hb,false);assert.equal('rateLimitsRaw' in hb,false);
    assert.equal(client.calls.includes('turn/interrupt'),false);
    atomicJson(path.join(dir,'cancel.json'),{runId});assert.equal((await done).status,'cancelled');
  }finally {Date.now=realNow;atomicJson(path.join(dir,'cancel.json'),{runId});await done;}
});
await test('close exception and final rename failure still resolve with durable terminal metadata',async()=>{
  const {cwd}=workspace(),runId=randomUUID(),dir=path.join(cwd,runId),client=new Fake();client.closeThrows=true;
  const rename=fs.renameSync;let failed=false;
  fs.renameSync=(from,to)=>{if(to===path.join(dir,'result.meta.json') && readJson(from)?.status && !failed){failed=true;throw Error('final persist fixture failure');}return rename(from,to);};
  try {
    const done=runManaged({cwd,logDir:dir,runId,prompt:'x',model:'fixture',effort:'high',budgetMs:0},()=>client);
    await pause(300);atomicJson(path.join(dir,'cancel.json'),{runId});
    const m=await done;assert.match(m.closeError,/close fixture/);assert.equal(failed,true);
    assert.equal(readJson(path.join(dir,'terminal.json')).status,'failed');
  }finally {fs.renameSync=rename;}
});
await test('control timeout keeps an undelivered request for its short TTL',async()=>{
  const {cwd}=workspace(),runId=randomUUID();
  atomicJson(path.join(cwd,'result.meta.json'),{runId,backend:'app-server',driverPid:process.pid});
  await assert.rejects(sendControl(cwd,{runId},'queue','retain',{timeoutMs:1}),/retained/);
  assert.equal(fs.readdirSync(cwd).filter(n=>n.startsWith('control-')).length,1);
});
console.log('RELIABILITY-OK '+pass);
