import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { quotaDecision, accountFingerprint } from '../lib/quota-policy.js';
import { QuotaCoordinator } from '../lib/quota-coordinator.js';
import { reserveRun, atomicJson, runDirectory, cleanupRuns, updateRecord } from '../lib/run-store.js';
import { LOGS_REL } from '../lib/core.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-quota-'));
let pass=0;async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
const now=Date.now(), reset=Math.floor(now/1000)+3600;
const response=(primary=10,secondary=20)=>({rateLimits:{primary:{usedPercent:primary,windowDurationMins:300,resetsAt:reset},secondary:{usedPercent:secondary,windowDurationMins:10080,resetsAt:reset+86400}}});
await test('threshold, latest window and exact three-minute buffer',()=>{
  assert.equal(quotaDecision(response(94),now,now).state,'ready');
  assert.equal(quotaDecision(response(95),now,now).resumeAt,reset*1000+180000);
  assert.equal(quotaDecision(response(99,95),now,now).resumeAt,(reset+86400)*1000+180000);
});
await test('stale, unknown, invalid unit and absent reset fail closed',()=>{
  assert.equal(quotaDecision(response(),now-61000,now).state,'unknown');
  assert.equal(quotaDecision({},now,now).state,'unknown');
  for(const value of [null,reset*1000,0]){const r=response(99);r.rateLimits.primary.resetsAt=value;assert.equal(quotaDecision(r,now,now).state,'unknown');}
});
await test('account binding excludes plaintext identity',()=>{
  const fingerprint=accountFingerprint({account:{type:'chatgpt',email:'fixture@example.invalid'}});
  assert.match(fingerprint,/^[a-f0-9]{64}$/);assert.equal(accountFingerprint({account:{type:'apiKey'}}),null);
});
function fixture(){
  const cwd=fs.mkdtempSync(path.join(root,'workspace-')),logs=path.join(cwd,LOGS_REL);
  const record=reserveRun(logs,'quota'),dir=runDirectory(logs,record),prompt=path.join(cwd,'task.md');fs.writeFileSync(prompt,'authorized task');
  const data=new Map(), schedules=new Map();let creates=0,launches=0;
  const table={get:id=>data.get(id),entries:()=>[...data.entries()],delete:async id=>data.delete(id),put:async(id,v)=>{data.set(id,structuredClone(v));}};
  const schedule={list:async()=>[...schedules.values()],create:async(sessionId,r)=>{creates++;const s={...r,id:randomUUID()};schedules.set(s.id,s);return s;},delete:async r=>{schedules.delete(r.id);}};
  const exec={agent:{session:{id:'fixture-session',header:{cwd}}}};
  let fresh={decision:{state:'ready'},fingerprint:'fixture-fingerprint'},launchResult=null,lastArgs=null;
  const coordinator=new QuotaCoordinator({schedule,storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})},config:{autoResumeAfterQuota:true},
    readQuota:async()=>typeof fresh==='function'?fresh():fresh,runner:()=>({execute:async args=>{launches++;lastArgs=args;return launchResult||{status:'running',run_id:randomUUID(),summary_text:'resumed'};}})});
  return {coordinator,exec,cwd,record,dir,data,schedules,schedule,launchResult:v=>{launchResult=v;},lastArgs:()=>lastArgs,counts:()=>({creates,launches}),fresh:v=>{fresh=v;},async track(){await coordinator.track({cwd,record,exec,args:{prompt_file:prompt,label:'quota'},model:'fixture',effort:'low'});},pause(){atomicJson(path.join(dir,'result.meta.json'),{status:'waiting_quota',killVerified:true,accountFingerprint:'fixture-fingerprint',threadId:'fixture-thread',quota:{state:'blocked',resumeAt:Date.now()-1}});}};
}
await test('durable wakeup is deduplicated and duplicate delivery launches once',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();await f.coordinator.poll();assert.equal(f.counts().creates,1);
    const r=f.data.get(f.record.runId),args={run_id:r.runId,generation:r.generation};
    assert.equal((await f.coordinator.recover(args,f.exec)).status,'running');assert.equal((await f.coordinator.recover(args,f.exec)).status,'ignored');assert.equal(f.counts().launches,1);
  }finally{await f.coordinator.close();}
});
await test('cancel invalidates already delivered reminder',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();const r=f.data.get(f.record.runId);await f.coordinator.cancel(f.cwd,r.runId);
    assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'ignored');assert.equal(f.counts().launches,0);assert.equal(f.schedules.size,0);
  }finally{await f.coordinator.close();}
});
await test('still blocked reschedules; wrong session and changed account cannot resume',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();let r=f.data.get(f.record.runId);
    assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},{agent:{session:{id:'other',header:{cwd:f.cwd}}}})).status,'ignored');
    f.fresh({decision:{state:'blocked',resumeAt:Date.now()-1},fingerprint:'fixture-fingerprint'});
    assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'waiting');assert.equal(f.counts().creates,2);
    r=f.data.get(f.record.runId);f.fresh({decision:{state:'ready'},fingerprint:'different-account'});
    assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'needs_attention');assert.equal(f.counts().launches,0);
  }finally{await f.coordinator.close();}
});
await test('schedule persistence failure is visible and starts no work',async()=>{
  const f=fixture();try{await f.track();f.pause();f.schedule.create=async()=>{throw Error('disk fixture failure');};await f.coordinator.poll();const r=f.data.get(f.record.runId);assert.equal(r.phase,'needs_attention');assert.match(r.error,/persistence failed/);assert.equal(f.counts().launches,0);}finally{await f.coordinator.close();}
});
await test('disabling recovery invalidates generation and removes reminder',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();const old=f.data.get(f.record.runId);f.coordinator.config.autoResumeAfterQuota=false;await f.coordinator.poll();const r=f.data.get(f.record.runId);assert.equal(r.phase,'cancelled');assert.notEqual(r.generation,old.generation);assert.equal(f.schedules.size,0);assert.ok(fs.existsSync(path.join(f.dir,'quota-disabled.json')));}finally{await f.coordinator.close();}
});
await test('warning alone cannot keep recovery scheduled',async()=>{
  const f=fixture();try{
    await f.track();f.pause();await f.coordinator.poll();assert.equal(f.schedules.size,1);
    f.coordinator.config.autoResumeAfterQuota=false;f.coordinator.config.quotaWarning=true;
    await f.coordinator.poll();
    const r=f.data.get(f.record.runId);assert.equal(r.phase,'cancelled');assert.equal(f.schedules.size,0);
    assert.equal(f.counts().launches,0);
  }finally{await f.coordinator.close();}
});
await test('cancel during quota check prevents the subsequent launch',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();const r=f.data.get(f.record.runId);f.fresh(()=>{atomicJson(path.join(f.dir,'cancel.json'),{runId:r.runId});return {decision:{state:'ready'},fingerprint:'fixture-fingerprint'};});assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'cancelled');assert.equal(f.counts().launches,0);}finally{await f.coordinator.close();}
});
await test('disable during quota read prevents launch even without a poll',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();const r=f.data.get(f.record.runId);
    f.fresh(()=>{f.coordinator.config.autoResumeAfterQuota=false;return {decision:{state:'ready'},fingerprint:'fixture-fingerprint'};});
    assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'cancelled');assert.equal(f.counts().launches,0);assert.equal(f.schedules.size,0);
  }finally{await f.coordinator.close();}
});
await test('workspace admission conflict retries with a finite ceiling',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();f.launchResult({status:'error',summary_text:'Workspace concurrency limit reached'});let r=f.data.get(f.record.runId);assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'waiting');r=f.data.get(r.runId);assert.equal(r.admissionRetries,1);f.data.set(r.runId,{...r,admissionRetries:12,resumeAt:Date.now()-1});assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'error');assert.equal(f.data.get(r.runId).phase,'needs_attention');}finally{await f.coordinator.close();}
});
await test('unconsumed queued instructions survive recovery exactly once',async()=>{
  const f=fixture();try{await f.track();f.pause();atomicJson(path.join(f.dir,'pending-messages.json'),[{id:randomUUID(),text:'Keep the unfinished requirement'}]);await f.coordinator.poll();const r=f.data.get(f.record.runId);await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec);const text=fs.readFileSync(f.lastArgs().prompt_file,'utf8');assert.equal(text.split('Keep the unfinished requirement').length,2);assert.equal((await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec)).status,'ignored');assert.equal(f.counts().launches,1);}finally{await f.coordinator.close();}
});
await test('quota transport failure becomes visible and removes spent reminder',async()=>{
  const f=fixture();try{await f.track();f.pause();await f.coordinator.poll();const r=f.data.get(f.record.runId);
    f.fresh(()=>{throw Error('fixture offline');});
    const result=await f.coordinator.recover({run_id:r.runId,generation:r.generation},f.exec);
    assert.equal(result.status,'needs_attention');assert.match(f.data.get(r.runId).error,/fixture offline/);assert.equal(f.schedules.size,0);assert.equal(f.counts().launches,0);
  }finally{await f.coordinator.close();}
});
await test('resolved recovery records expire after thirty days; unresolved records remain',async()=>{
  const f=fixture();try{await f.track();const r=f.data.get(f.record.runId);
    const old=new Date(Date.now()-31*86400000).toISOString();
    f.data.set(r.runId,{...r,phase:'completed',finishedAt:old});await f.coordinator.poll();assert.equal(f.data.has(r.runId),false);
    f.data.set(r.runId,{...r,phase:'needs_attention',finishedAt:old});await f.coordinator.poll();assert.equal(f.data.has(r.runId),true);
  }finally{await f.coordinator.close();}
});
await test('one missing workspace does not prevent another run scheduling',async()=>{
  const f=fixture();try{await f.track();f.pause();const r=f.data.get(f.record.runId);
    const bad={...r,runId:randomUUID(),cwd:path.join(f.cwd,'bad')};
    fs.mkdirSync(bad.cwd);fs.symlinkSync(f.dir,path.join(bad.cwd,path.dirname(LOGS_REL)),'junction');
    f.data.clear();f.data.set(bad.runId,bad);f.data.set(r.runId,r);
    await f.coordinator.poll();assert.equal(f.data.get(bad.runId).phase,'needs_attention');assert.equal(f.data.get(r.runId).phase,'wake_scheduled');
  }finally{await f.coordinator.close();}
});
await test('cancelling a parent invalidates and signals its resumed child',async()=>{
  const f=fixture();try{await f.track();f.pause();const r=f.data.get(f.record.runId),logs=path.join(f.cwd,LOGS_REL);
    const child=reserveRun(logs,'child'),childDir=runDirectory(logs,child);
    f.data.set(child.runId,{...r,runId:child.runId,generation:randomUUID(),phase:'running'});
    f.data.set(r.runId,{...r,phase:'resumed',resumedRunId:child.runId});
    await f.coordinator.cancel(f.cwd,r.runId);
    assert.equal(f.data.get(r.runId).phase,'cancelled');assert.equal(f.data.get(child.runId).phase,'cancelled');
    assert.equal(JSON.parse(fs.readFileSync(path.join(childDir,'cancel.json'),'utf8')).runId,child.runId);
  }finally{await f.coordinator.close();}
});
await test('completed child releases the parent artifacts for retention cleanup',async()=>{
  const f=fixture();try{await f.track();f.pause();const r=f.data.get(f.record.runId),childId=randomUUID();
    f.data.set(childId,{...r,runId:childId,phase:'completed'});
    f.data.set(r.runId,{...r,phase:'resumed',resumedRunId:childId});
    await f.coordinator.poll();assert.equal(f.data.get(r.runId).phase,'completed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'recovery-resolved.json'),'utf8')).resumedRunId,childId);
    updateRecord(path.join(f.cwd,LOGS_REL),f.record,{createdAt:new Date(0).toISOString()});
    cleanupRuns(path.join(f.cwd,LOGS_REL),1,0);assert.equal(fs.existsSync(f.dir),false);
  }finally{await f.coordinator.close();}
});
await test('lost wake marker reschedules with new generation at most three times',async()=>{
  const f=fixture();try {
    await f.track();f.pause();await f.coordinator.poll();
    for(let n=1;n<=4;n++) {
      const old=f.data.get(f.record.runId);f.schedules.clear();
      f.data.set(old.runId,{...old,resumeAt:Date.now()-240000});
      await f.coordinator.poll();const next=f.data.get(old.runId);
      if(n<=3) {assert.equal(next.phase,'wake_scheduled');assert.notEqual(next.generation,old.generation);assert.equal(next.wakeRetries,n);}
      else assert.equal(next.phase,'needs_attention');
    }
    assert.equal(f.counts().launches,0);
  } finally {await f.coordinator.close();}
});
await test('create then storage failure rolls back the newly created schedule',async()=>{
  const f=fixture();try {
    await f.track();const table=await f.coordinator.table(),original=table.put;
    table.put=async(id,r)=>{if(r.phase==='wake_scheduled')throw Error('put fixture failure');return original(id,r);};
    await assert.rejects(f.coordinator.scheduleWake(table,f.data.get(f.record.runId),{resumeAt:Date.now()+1000}),/put fixture/);
    assert.equal(f.schedules.size,0);assert.equal(f.counts().launches,0);
  } finally {await f.coordinator.close();}
});
console.log('QUOTA-OK '+pass);
