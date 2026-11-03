import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQuotaView, normalizeQuotaWindows } from '../lib/quota-view.js';
import { quotaTools } from '../lib/quota-tools.js';
import { buildStatusToolDefinition, LOGS_REL } from '../lib/core.js';
import { reserveRun, runDirectory, updateRecord, atomicJson } from '../lib/run-store.js';
import { processStartedAt } from '../lib/process-evidence.js';
import { createRunEvents } from '../lib/run-events.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-quota-view-'));
let stamp=Date.now(),calls=[],fail=false,unknown=false;
const limits=()=>({rateLimits:{primary:{usedPercent:95,windowDurationMins:300,resetsAt:Math.floor(stamp/1000)+3600},secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:Math.floor(stamp/1000)+86400}}});
const connect=async fn=>{if(fail)throw Error('account transport fixture failure');return fn({request:async method=>{
  calls.push(method);if(method==='account/read')return {account:{type:'chatgpt',email:'private@example.invalid',planType:'plus'}};
  if(method==='account/rateLimits/read')return unknown?{}:limits();throw Error('Unexpected model method '+method);
}});};
const view=createQuotaView({connect,now:()=>stamp,identity:()=> 'fixture'});
let pass=0;async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
await test('fresh account-wide quota normalizes both windows without a turn or plaintext account identity',async()=>{
  const result=await view.get({probe:'fresh',settings:{backend:'app-server',quotaWarning:true,quotaWarningThreshold:5}});
  assert.equal(result.status,'ok');assert.equal(result.scope,'account-wide');assert.equal(result.windows.five_hour.remaining_percent,5);assert.equal(result.windows.seven_day.remaining_percent,80);
  assert.equal(result.account.plan,'plus');assert.match(result.account.fingerprint_prefix,/^[a-f0-9]{6}$/);assert.equal(JSON.stringify(result).includes('private@example.invalid'),false);
  assert.equal(result.warning.triggered,true);assert.deepEqual(calls.sort(),['account/rateLimits/read','account/read']);
});
await test('refresh cannot bypass rate limit; cached age and reset countdown remain explicit',async()=>{
  stamp+=10000;const result=await view.get({probe:'fresh',refresh:true,settings:{backend:'app-server'}});
  assert.equal(result.cached,true);assert.equal(result.refresh_limited,true);assert.equal(calls.length,2);assert.ok(result.windows.five_hour.reset_in_sec<3600);
  stamp+=181000;assert.equal((await view.get({probe:'none',settings:{backend:'app-server'}})).status,'stale');
});
await test('network failures retain last sample and distinguish account transport failure',async()=>{
  fail=true;const result=await view.get({probe:'fresh',settings:{backend:'app-server'}});
  assert.equal(result.status,'stale');assert.equal(result.probe.fresh.ok,false);assert.equal(result.transport,'unreachable');assert.match(result.error,/transport/);assert.equal(result.windows.five_hour.remaining_percent,5);
  const absent=createQuotaView({connect,identity:()=> 'absent'});
  assert.equal((await absent.get({probe:'fresh',settings:{backend:'app-server'}})).status,'unavailable');fail=false;
});
await test('unknown quota fields remain unknown and unknown windows are never guessed',async()=>{
  unknown=true;const fresh=createQuotaView({connect,identity:()=> 'unknown'});const result=await fresh.get({probe:'fresh',settings:{backend:'app-server'}});
  assert.equal(result.status,'unknown');assert.equal(result.windows.five_hour,null);assert.equal(result.transport,'reachable');unknown=false;
  assert.deepEqual(normalizeQuotaWindows({rateLimits:{primary:{usedPercent:20,windowDurationMins:123,resetsAt:1}}}),{five_hour:null,seven_day:null});
});
await test('exec last-run, status fields and recovery do not spawn an App Server',async()=>{
  const cwd=fs.mkdtempSync(path.join(root,'exec-')),logs=path.join(cwd,LOGS_REL),record=reserveRun(logs,'exec'),dir=runDirectory(logs,record);
  atomicJson(path.join(dir,'result.meta.json'),{status:'waiting_quota',backend:'exec',end:new Date().toISOString(),rateLimits:{primary:{used_percent:95,window_minutes:300,resets_at:Math.floor(Date.now()/1000)+3600}}});
  let connects=0;const offline=createQuotaView({connect:async()=>{connects++;throw Error('must not connect');},identity:()=> 'exec'});
  const result=await offline.get({probe:'both',settings:{backend:'exec'},logs,recovery:async runId=>({run_id:runId,phase:'wake_scheduled'})});
  assert.equal(result.source,'last-run');assert.equal(result.stale,true);assert.equal(result.probe.active,null);assert.equal(result.recovery.phase,'wake_scheduled');assert.equal(connects,0);
  const status=await buildStatusToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd}).execute({run_id:record.runId},{});
  assert.equal(status.quota_source,'last-run');assert.equal(status.quota_remaining,5);assert.ok(status.quota_sampled_at);
});
await test('active driver evidence and read-only diagnose do not steer or kill',async()=>{
  const cwd=fs.mkdtempSync(path.join(root,'active-')),logs=path.join(cwd,LOGS_REL),record=reserveRun(logs,'active'),dir=runDirectory(logs,record);
  updateRecord(logs,record,{state:'running',driverPid:process.pid,driverStartedAt:processStartedAt()});
  const sampledAt=Date.now(),window=limits().rateLimits.primary;
  atomicJson(path.join(dir,'result.meta.json'),{backend:'app-server',driverPid:process.pid,quota:{windows:[{kind:'primary',...window}],sampledAt}});
  atomicJson(path.join(dir,'result.hb.json'),{runId:record.runId,ts:new Date().toISOString(),turnState:'active',lastEventType:'item/reasoning/delta'});
  const offline=createQuotaView({connect:async()=>{throw Error('must not connect');},identity:()=> 'active'});
  const result=await offline.get({probe:'active',settings:{backend:'app-server'},logs});assert.equal(result.probe.active.ok,true);assert.equal(result.source_detail,'active-driver');
  const tools=quotaTools({defineTool:d=>d,resolveCwd:()=>cwd,view:offline,inspect:()=>({nodes:[{pid:process.pid}],source:'fixture'})});
  const diagnosis=await tools.find(t=>t.name==='codex_diagnose').execute({run_id:record.runId},{});
  assert.equal(diagnosis.intrusive,false);assert.equal(diagnosis.classification,'active-model');assert.equal(fs.readdirSync(dir).some(file=>file.startsWith('control-')),false);
  assert.doesNotThrow(()=>process.kill(process.pid,0));
});
await test('terminal run invalidation is event-driven, deduplicated and stream lifetime is owned',async()=>{
  const cwd=fs.mkdtempSync(path.join(root,'events-')),logs=path.join(cwd,LOGS_REL),record=reserveRun(logs,'event'),dir=runDirectory(logs,record),events=createRunEvents(),received=[];
  events.subscribe(event=>received.push(event));events.track(dir,record);
  const abort=new AbortController(),response=events.stream(abort.signal),reader=response.body.getReader();
  assert.match(response.headers.get('content-type'),/event-stream/);await reader.read();
  atomicJson(path.join(dir,'result.meta.json'),{status:'failed'});
  let eventDeadline;
  const next=await Promise.race([reader.read(),new Promise((_,reject)=>{eventDeadline=setTimeout(()=>reject(Error('Terminal event was not delivered')),5000);})]).finally(()=>clearTimeout(eventDeadline));assert.match(new TextDecoder().decode(next.value),new RegExp(record.runId));
  atomicJson(path.join(dir,'result.meta.json'),{status:'failed'});await new Promise(resolve=>setTimeout(resolve,100));assert.equal(received.length,1);
  abort.abort();assert.equal((await reader.read()).done,true);events.close();
});
console.log('QUOTA-VIEW-OK '+pass);
