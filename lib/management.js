import { readSelection } from './selection-audit.js';
import { getCatalog } from './model-catalog.js';
import path from 'node:path';
import { atomicJson, recordFor, runDirectory, listRecords, validRunId, validateLabel, runEvidence } from './run-store.js';
import { LOGS_REL, readRunState, sleep, loadEffectiveSettings, settingsProblem } from './core.js';
import { diagnoseCodex } from './executable.js';

const output = { schema: { type: 'json' }, render: (_args, v) => [{ type:'text', text:v.summary_text }] };
export function managementTools({ defineTool, resolveCwd, quotaCoordinator, config = {} }) {
  const make = (name, description, parameters, execute) => defineTool({ name, description, parameters, output,
    isConcurrencySafe: () => true, presentCall: () => ({card:'generic', title:name, kind:'execute'}), execute });
  return [
    make('codex_list', 'List recorded Codex runs in this workspace. Use run_id for exact status and cancellation.', {}, async (_args,exec) => {
      const cwd=resolveCwd(exec); if(!cwd) return {status:'error',summary_text:'Missing workspace'};
      const problem=settingsProblem(loadEffectiveSettings({config}));
      if(problem)return {status:'error',summary_text:problem};
      const logDir=path.join(cwd,LOGS_REL);
      const runs=listRecords(logDir).slice(0,100).map(r=> { const s=readRunState(logDir,r.runId),selection=readSelection(logDir,r); return {model:selection?.model||s.meta?.model||null,effort:selection?.effort||s.meta?.effort||null,downgrade:selection?.downgrade??null,run_id:r.runId,label:r.label,created_at:r.createdAt,running:s.running,status:s.meta?.status || (s.running?'running':'needs_attention'),liveness:s.liveness}; });
      return {status:'ok',runs,summary_text:JSON.stringify(runs)};
    }),
    make('codex_cancel', 'Request cancellation of one exact run. The owning driver terminates its own process tree. Does not kill unverified historical PIDs.', {
      run_id:{type:'string',description:'Exact run ID (preferred)'}, label:{type:'string',description:'Latest run with this label'},
    }, async (args,exec) => {
      const cwd=resolveCwd(exec); if(!cwd) return {status:'error',summary_text:'Missing workspace'};
      const selector=args.run_id || args.label;
      if(!(validRunId(selector)||validateLabel(selector))) return {status:'error',summary_text:'Invalid run selector'};
      const logDir=path.join(cwd,LOGS_REL), r=recordFor(logDir,selector);
      if(!r) return {status:'error',summary_text:'Run not found; legacy tasks require manual inspection'};
      atomicJson(path.join(runDirectory(logDir,r),'cancel.json'),{runId:r.runId,requestedAt:new Date().toISOString()});
      try { await quotaCoordinator?.cancel(cwd, r.runId); }
      catch(error) { return {status:'error',summary_text:'Recovery cancellation failed: '+error.message}; }
      let s=readRunState(logDir,r.runId);
      if (s.meta?.status && s.meta.killVerified !== false) return {status:'ok',run_id:r.runId,kill_verified:s.meta.killVerified===true,summary_text:'Run already stopped'};
      if(!s.driverAlive && s.childAlive) return {status:'error',summary_text:'Driver unavailable; inspect the orphan before terminating it. No unverified PID was killed.'};
      if(!s.running && !s.driverAlive && !s.childAlive) return {status:'ok',run_id:r.runId,summary_text:'Run already stopped'};
      atomicJson(path.join(runDirectory(logDir,r),'cancel.json'),{runId:r.runId,requestedAt:new Date().toISOString()});
      const deadline=Date.now()+20000;
      do {
        await sleep(200); s=readRunState(logDir,r.runId);
        if(!s.driverAlive && !s.childAlive && !s.spawnPending && s.meta?.status) return {status:'ok',run_id:r.runId,kill_verified:s.meta.killVerified===true,summary_text:'Run stopped: '+r.runId};
      } while(Date.now()<deadline && !exec.signal?.aborted);
      return {status:'pending',run_id:r.runId,summary_text:'Cancellation requested; query codex_status for completion'};
    }),
    make('codex_release', 'Release a stale or orphan record from admission without killing processes or deleting evidence.', {
      run_id:{type:'string',required:true}, confirm:{type:'boolean',required:true},
    }, async (args,exec) => {
      const cwd=resolveCwd(exec); if(!cwd)return {status:'error',summary_text:'Missing workspace'};
      const logs=path.join(cwd,LOGS_REL), record=recordFor(logs,args.run_id);
      if(!record)return {status:'not_found',summary_text:'Run not found'};
      const evidence=runEvidence(logs,record);
      if(!['stale','orphan'].includes(evidence.liveness))return {status:'error',evidence,summary_text:'Only stale/orphan records can be released'};
      if(args.confirm!==true)return {status:'confirmation_required',evidence,summary_text:'Set confirm=true to release admission only'};
      atomicJson(path.join(runDirectory(logs,record),'released.json'),{runId:record.runId,at:new Date().toISOString(),evidence});
      return {status:'ok',evidence,summary_text:'Admission released; processes and evidence retained'};
    }),
    make('codex_doctor', 'Check Codex executable, CLI capabilities and login without making a model request.', {}, async (_args,exec) => {
      const cwd=resolveCwd(exec);if(!cwd)return {status:'error',summary_text:'Missing workspace'};
      const effective=loadEffectiveSettings({config}),problem=settingsProblem(effective);
      if(effective.settingsErrors.length)return {status:'error',summary_text:problem};
      const settings=effective.settings;
      let result; try { result=await diagnoseCodex(settings); } catch(e) {result={ok:false,problem:e.message};}
      const catalog=result.ok?await getCatalog({refresh:true,settings}):null;
      return {status:result.ok?'ok':'error',...result,catalog,summary_text:JSON.stringify({...result,catalog_source:catalog?.source||null})};
    }),
  ];
}
