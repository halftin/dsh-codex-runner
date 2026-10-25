import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withAppServer } from './app-server-client.js';
import { quotaDecision, accountFingerprint } from './quota-policy.js';
import { readJson, atomicJson, validRunId, recordFor, runDirectory, listRecords, runEvidence } from './run-store.js';
import { LOGS_REL, loadEffectiveSettings } from './core.js';

const phases = ['running','wake_scheduled','launching','resumed','cancelled','completed','needs_attention'];
// Only scalar inputs needed to resume the authorized task. Do not persist
// evidence, catalogs, arbitrary tool arguments or caller-owned objects.
function recoveryArgs(args={}) {
  const result={};
  for(const key of ['prompt_file','label','cwd','resume_thread','model','effort','notify_on_complete']) {
    if(typeof args[key]==='string')result[key]=args[key];
  }
  if(typeof args.unlock_effort==='boolean')result.unlock_effort=args.unlock_effort;
  if(Number.isFinite(args.budget_ms) && args.budget_ms>=0)result.budget_ms=args.budget_ms;
  return result;
}
const recoveryFields=['runId','generation','sessionId','cwd','phase','resumeAt','scheduleId','resumedRunId','error',
  'createdAt','finishedAt','wakeRetries','admissionRetries'];
// StorageDomain consumes parse(raw). This dependency-free validator is intentionally
// limited to our private persistence domain; it is not exposed as a host RPC schema.
export const recoveryDomain = { name: 'codex_runner_recovery', version: 1, tables: {
  runs: { valueSchema: { parse(value) {
    if (!value || !validRunId(value.runId) || !validRunId(value.generation) || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || !phases.includes(value.phase)) throw Error('Invalid quota recovery record');
    const result=Object.fromEntries(recoveryFields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
    if(value.args)result.args=recoveryArgs(value.args);
    return structuredClone(result);
  } } },
} };

export class QuotaCoordinator {
  constructor({ schedule, storageDomain, config = {}, runner, readQuota = async options => withAppServer(async client => ({
    decision: quotaDecision(await client.request('account/rateLimits/read'), Date.now()),
    fingerprint: accountFingerprint(await client.request('account/read', { refreshToken: false })),
  }),options) }) {
    this.schedule=schedule;this.storageDomain=storageDomain;this.config=config;this.runner=runner;this.readQuota=readQuota;
    this.chain=Promise.resolve();this.closed=false;
    this.ready=storageDomain.open(recoveryDomain);
    this.ready.catch(error=>{this.error=error.message;});
  }
  available(exec) { return !this.closed && !this.error && typeof exec?.agent?.session?.id === 'string'; }
  serial(fn) { const next=this.chain.then(fn);this.chain=next.catch(()=>{});return next; }
  async table() {
    const table=(await this.ready).table('runs');
    return {get:id=>table.get(id),entries:()=>table.entries(),delete:id=>table.delete(id),put:async(id,value)=>{
      value=recoveryDomain.tables.runs.valueSchema.parse(value);
      // Write protection first. A failed StorageDomain write must not make a
      // registered unresolved run eligible for retention deletion.
      let record;const logs=path.join(value.cwd,LOGS_REL);
      try {record=recordFor(logs,id);}catch{} // A redirected/missing store still needs a table diagnostic.
      const mark=()=>{if(record)atomicJson(path.join(runDirectory(logs,record),'recovery-state.json'),{
        runId:id,phase:value.phase,resumedRunId:value.resumedRunId || null});};
      if(['completed','cancelled'].includes(value.phase)) {await table.put(id,value);mark();}
      else {mark();await table.put(id,value);}
    }};
  }
  async state(cwd,runId) {
    const r=(await this.table()).get(runId);if(!r||path.resolve(cwd)!==path.resolve(r.cwd))return null;
    return {phase:r.phase,generation:r.generation,resume_at:r.resumeAt?new Date(r.resumeAt).toISOString():null,schedule_id:r.scheduleId||null,resumed_run_id:r.resumedRunId||null,error:r.error||this.error||null,
      retention_warning:!['completed','cancelled'].includes(r.phase)&&Date.now()-Date.parse(r.createdAt)>30*86400000?'Unresolved quota recovery is older than 30 days; inspect and explicitly cancel before cleanup':null};
  }
  async latestState() {
    const records=[...(await this.table()).entries()].map(([,record])=>record).filter(record=>!['completed','cancelled'].includes(record.phase)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    const latest=records[0];return latest?{cwd:latest.cwd,recovery:{run_id:latest.runId,...await this.state(latest.cwd,latest.runId)}}:null;
  }
  async track({cwd,record,exec,args,model,effort}) {
    const table=await this.table();
    const dir=runDirectory(path.join(cwd,LOGS_REL),record);
    const prompt=fs.readFileSync(path.resolve(cwd,args.prompt_file),'utf8');
    fs.writeFileSync(path.join(dir,'recovery-task.md'),prompt,{mode:0o600});
    await table.put(record.runId,{runId:record.runId,generation:randomUUID(),sessionId:exec.agent.session.id,cwd,phase:'running',
      args:recoveryArgs({...args,model,effort}),createdAt:new Date().toISOString()});
  }
  async removeSchedule(record) {
    if(record.scheduleId) await this.schedule.delete({sessionId:record.sessionId,id:record.scheduleId});
  }
  async cancel(cwd,runId) { return this.serial(async()=>{
    const table=await this.table();let r=table.get(runId);const seen=new Set();
    while(r && path.resolve(cwd)===path.resolve(r.cwd) && !seen.has(r.runId)) {
      seen.add(r.runId);
      const record=recordFor(path.join(cwd,LOGS_REL),r.runId);
      if(record)atomicJson(path.join(runDirectory(path.join(cwd,LOGS_REL),record),'cancel.json'),{runId:r.runId,requestedAt:new Date().toISOString()});
      // Invalidate before deleting: an already-delivered reminder cannot revive it.
      await table.put(r.runId,{...r,phase:'cancelled',finishedAt:new Date().toISOString(),generation:randomUUID()});await this.removeSchedule(r);
      r=r.resumedRunId?table.get(r.resumedRunId):null;
    }
  }); }
  async scheduleWake(table,r,quota) {
    const marker='[codex-quota:'+r.runId+':'+r.generation+']';
    // Recover the create-before-commit crash window without duplicate schedules.
    const existing=(await this.schedule.list({sessionId:r.sessionId})).find(s=>s.prompt?.includes(marker));
    const schedule=existing || await this.schedule.create(r.sessionId,{
      title:'Codex quota recovery',at:new Date(Math.max(quota.resumeAt,Date.now()+1000)).toISOString(),
      prompt:marker+' Call codex_quota_resume with run_id="'+r.runId+'" and generation="'+r.generation+'". This is only a recovery check for existing authorized work. Do not start a separate task. Stay quiet if the check is stale, cancelled, or still waiting; report only meaningful progress, failure, completion, or required user action.',
    });
    try { await table.put(r.runId,{...r,phase:'wake_scheduled',scheduleId:schedule.id,resumeAt:quota.resumeAt}); }
    catch(error) {
      if(!existing)try { await this.schedule.delete({sessionId:r.sessionId,id:schedule.id}); } catch(cleanupError) { error.message+='; schedule rollback failed: '+cleanupError.message; }
      throw error;
    }
  }
  async poll() { return this.serial(async()=>{
    if(this.closed)return;
    const table=await this.table();
    for(const [,r] of table.entries()) {
      try {
      if(['completed','cancelled'].includes(r.phase)) {
        // Unresolved records never expire automatically. A resolved record has
        // no usable generation and is retained for thirty days for inspection.
        if(!r.finishedAt)await table.put(r.runId,{...r,finishedAt:new Date().toISOString()});
        else if(Date.now()-Date.parse(r.finishedAt)>30*86400000) {await this.removeSchedule(r);await table.delete(r.runId);}
        continue;
      }
      if(r.phase==='resumed') {
        const child=table.get(r.resumedRunId);
        if(child && ['completed','cancelled'].includes(child.phase)) {
          const record=recordFor(path.join(r.cwd,LOGS_REL),r.runId);
          if(record)atomicJson(path.join(runDirectory(path.join(r.cwd,LOGS_REL),record),'recovery-resolved.json'),{runId:r.runId,resumedRunId:r.resumedRunId});
          await table.put(r.runId,{...r,phase:'completed',finishedAt:new Date().toISOString()});
        }
        continue;
      }
      if(!['running','wake_scheduled','launching'].includes(r.phase))continue;
      const settings=loadEffectiveSettings({config:this.config}).settings;
      const recoveryEnabled = settings.autoResumeAfterQuota === true;
      if(!recoveryEnabled) {
        const record=recordFor(path.join(r.cwd,LOGS_REL),r.runId);
        if(record)atomicJson(path.join(runDirectory(path.join(r.cwd,LOGS_REL),record),'quota-disabled.json'),{runId:r.runId});
        await table.put(r.runId,{...r,phase:'cancelled',generation:randomUUID()});await this.removeSchedule(r);continue;
      }
      const logs=path.join(r.cwd,LOGS_REL), record=recordFor(logs,r.runId);
      if(!record) {await table.put(r.runId,{...r,phase:'needs_attention',error:'Run record missing'});continue;}
      const dir=runDirectory(logs,record), meta=readJson(path.join(dir,'result.meta.json'));
      const evidence=runEvidence(logs,record);
      if(evidence.driverAlive || evidence.childAlive || evidence.spawnPending)continue;
      if(readJson(path.join(dir,'cancel.json'))?.runId===r.runId) {await table.put(r.runId,{...r,phase:'cancelled',generation:randomUUID()});await this.removeSchedule(r);continue;}
      if(r.phase==='wake_scheduled' && Date.now()>r.resumeAt+180000) {
        const marker='[codex-quota:'+r.runId+':'+r.generation+']';
        const exists=(await this.schedule.list({sessionId:r.sessionId})).some(s=>s.id===r.scheduleId || s.prompt?.includes(marker));
        if(!exists) {
          const wakeRetries=(r.wakeRetries||0)+1;
          if(wakeRetries>3)await table.put(r.runId,{...r,phase:'needs_attention',error:'Recovery schedule missing after three retries'});
          else await this.scheduleWake(table,{...r,generation:randomUUID(),scheduleId:null,wakeRetries},{resumeAt:Date.now()+1000});
        }
        continue;
      }
      if(r.phase==='launching') {
        const child=listRecords(logs).find(x=>x.recoveryParent===r.runId);
        await table.put(r.runId,{...r,phase:child?'resumed':'needs_attention',resumedRunId:child?.runId||null,error:child?null:'Recovery launch was interrupted; inspect before retrying'});continue;
      }
      if(r.phase==='running' && meta?.status) {
        if(meta.status==='waiting_quota' && meta.quota?.state==='blocked' && meta.killVerified===true && meta.accountFingerprint) {
          try {await this.scheduleWake(table,r,meta.quota);}catch(error){await table.put(r.runId,{...r,phase:'needs_attention',error:'Schedule persistence failed: '+error.message});}
        } else await table.put(r.runId,{...r,phase:meta.status==='ok'?'completed':'needs_attention',error:meta.error||meta.status});
      }
      } catch(error) {
        await table.put(r.runId,{...r,phase:'needs_attention',error:'Recovery polling failed: '+error.message});
      }
    }
  }); }
  async recover(args,exec) { return this.serial(async()=>{
    const table=await this.table(), r=table.get(args.run_id);
    const sessionId=exec?.agent?.session?.id, cwd=exec?.agent?.session?.header?.cwd;
    if(!r || r.generation!==args.generation || r.sessionId!==sessionId || !cwd || path.resolve(cwd)!==path.resolve(r.cwd) || r.phase!=='wake_scheduled') return {status:'ignored',summary_text:'Stale or unauthorized recovery check'};
    try {
    const settings=loadEffectiveSettings({config:this.config}).settings;
    const recoveryEnabled = settings.autoResumeAfterQuota === true;
    if(!recoveryEnabled) {await table.put(r.runId,{...r,phase:'cancelled',generation:randomUUID()});await this.removeSchedule(r);return {status:'cancelled',summary_text:'Automatic recovery is disabled'};}
    if(Date.now()<r.resumeAt)return {status:'waiting',summary_text:'Quota recovery time has not arrived'};
    const logs=path.join(r.cwd,LOGS_REL), record=recordFor(logs,r.runId);
    if(!record)throw Error('Run record missing');
    const dir=runDirectory(logs,record), meta=readJson(path.join(dir,'result.meta.json'));
    if(readJson(path.join(dir,'cancel.json'))?.runId===r.runId) {await table.put(r.runId,{...r,phase:'cancelled',generation:randomUUID()});await this.removeSchedule(r);return {status:'cancelled',summary_text:'Run was cancelled'};}
    const current=await this.readQuota({cwd:r.cwd,settings});
    const stillEnabled=loadEffectiveSettings({config:this.config}).settings;
    if(this.closed || exec.signal?.aborted || !(stillEnabled.autoResumeAfterQuota === true) || readJson(path.join(dir,'cancel.json'))?.runId===r.runId) {
      await table.put(r.runId,{...r,phase:'cancelled',generation:randomUUID()});await this.removeSchedule(r);
      return {status:'cancelled',summary_text:'Recovery was cancelled before launch'};
    }
    if(!current.fingerprint || current.fingerprint!==meta?.accountFingerprint || current.decision.state==='unknown') {
      await table.put(r.runId,{...r,phase:'needs_attention',error:'Account changed or quota cannot be verified'});
      return {status:'needs_attention',summary_text:'Account changed or quota cannot be verified; no task was started'};
    }
    await this.removeSchedule(r);
    if(current.decision.state==='blocked') {await this.scheduleWake(table,{...r,scheduleId:null,generation:randomUUID()},current.decision);return {status:'waiting',summary_text:'Quota remains limited; recovery rescheduled'};}
    const promptFile=path.join(dir,'resume-task.md');
    let text=meta.pauseOutcome==='turn_not_started' ? fs.readFileSync(path.join(dir,'recovery-task.md'),'utf8')
      : 'Continue the previously authorized task from this thread. First inspect the checkpoint and current files; a pause may have interrupted work. Verify existing changes before continuing. Do not duplicate completed work.';
    const pending=readJson(path.join(dir,'pending-messages.json'))||[];
    if(!Array.isArray(pending)||pending.length>32||pending.some(m=>typeof m.text!=='string'||Buffer.byteLength(m.text)>32000))throw Error('Invalid pending message archive');
    if(pending.length)text+='\n\nPreviously accepted instructions that were not yet consumed (in order):\n'+pending.map((m,i)=>(i+1)+'. '+m.text).join('\n\n');
    fs.writeFileSync(promptFile,text,{mode:0o600});
    await table.put(r.runId,{...r,phase:'launching'});
    const result=await this.runner().execute({...r.args,override_reason:r.args.override_reason||'Resume the model and effort of this previously authorized task',prompt_file:promptFile,label:'resume-'+r.runId,detach:true,resume_thread:meta.threadId,recovery_parent:r.runId},exec);
    if(result.status==='error' && /concurrency limit|admission.lock/.test(result.summary_text)) {
      const retries=(r.admissionRetries||0)+1;
      if(retries<=12){await this.scheduleWake(table,{...r,generation:randomUUID(),scheduleId:null,admissionRetries:retries},{resumeAt:Date.now()+300000});return {status:'waiting',summary_text:'Workspace is busy; retry scheduled in five minutes'};}
    }
    if(result.run_id && readJson(path.join(dir,'cancel.json'))?.runId===r.runId){
      const child=recordFor(logs,result.run_id);if(child)atomicJson(path.join(runDirectory(logs,child),'cancel.json'),{runId:child.runId});
    }
    await table.put(r.runId,{...r,phase:result.status==='running'?'resumed':'needs_attention',resumedRunId:result.run_id||null,error:result.status==='running'?null:result.summary_text});
    return result;
    } catch(error) {
      const latest=table.get(r.runId)||r;
      // A launcher may have spawned before failing. Preserve launching so the
      // next poll reconciles its durable recoveryParent record without retrying.
      await table.put(r.runId,{...latest,phase:latest.phase==='launching'?'launching':'needs_attention',error:'Recovery failed: '+error.message});
      try {await this.removeSchedule(r);}catch{}
      return {status:'needs_attention',summary_text:'Recovery failed; inspect before retrying: '+error.message};
    }
  }); }
  start() {this.timer=setInterval(()=>{this.poll().then(()=>{this.error=null;},error=>{this.error=error.message;});},2000);this.timer.unref?.();return this;}
  async close() {this.closed=true;clearInterval(this.timer);await this.chain;const domain=await this.ready;await domain.close();}
}
