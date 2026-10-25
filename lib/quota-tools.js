import path from 'node:path';
import { createQuotaView } from './quota-view.js';
import { loadEffectiveSettings, settingsProblem, LOGS_REL, readRunState } from './core.js';
import { recordFor, validRunId, validateLabel, runDirectory } from './run-store.js';
import { inspectProcessTree } from './process-evidence.js';
import { sendControl } from './run-control.js';

export function quotaTools({defineTool,resolveCwd,config={},quotaCoordinator,view=createQuotaView(),inspect=inspectProcessTree}) {
  const make=(name,description,parameters,execute)=>defineTool({name,description,parameters,output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:v.summary_text}]},isConcurrencySafe:()=>true,presentCall:()=>({card:'generic',title:name,kind:'read'}),
    async execute(args={},exec){try{const cwd=resolveCwd(exec);if(!cwd)throw Error('Missing workspace');const effective=loadEffectiveSettings({config}),problem=settingsProblem(effective);if(problem)throw Error(problem);return await execute(args,exec,cwd,effective.settings);}catch(error){return {status:'error',summary_text:error.message};}}});
  const readQuota=(args,cwd,settings)=>view.get({probe:args.probe||'none',timeoutMs:args.timeout_ms??15000,refresh:args.refresh??false,settings,logs:path.join(cwd,LOGS_REL),recovery:runId=>runId?quotaCoordinator?.state(cwd,runId):null});
  return [make('codex_quota','Read account-wide quota, resets, warning and recovery. Fresh probes call account/read and account/rateLimits/read only; never start a model turn.',{
    probe:{type:'string',description:'none | fresh | active | both'},timeout_ms:{type:'number'},refresh:{type:'boolean'},
  },async(args,_exec,cwd,settings)=>{const result=await readQuota(args,cwd,settings);return {...result,summary_text:JSON.stringify(result)};}),
  make('codex_diagnose','Inspect one managed run and its quota evidence without killing or restarting it. probe=true explicitly sends one intrusive steer; default is read-only.',{
    run_id:{type:'string'},label:{type:'string'},probe:{type:'boolean',description:'Explicit intrusive steer; default false'},
  },async(args,exec,cwd,settings)=>{
    const selector=args.run_id||args.label;if(!validRunId(selector)&&!validateLabel(selector))throw Error('Invalid run selector');
    const logs=path.join(cwd,LOGS_REL),record=recordFor(logs,selector);if(!record)return {status:'not_found',summary_text:'Run not found'};
    const state=readRunState(logs,record.runId),hb=state.hb,meta=state.meta;
    const heartbeatAge=hb?.ts?Math.max(0,Date.now()-Date.parse(hb.ts)):null;
    let classification=['orphan','stale'].includes(state.liveness)?state.liveness:state.running?'running':'upstream-unknown';
    if(state.running && heartbeatAge!==null && heartbeatAge>30000)classification='local-unresponsive';
    else if(state.running && hb?.turnState==='active')classification=/command/i.test(hb.lastEventType||'')||hb.lastCommandStartAt&&(!hb.lastReasoningAt||hb.lastCommandStartAt>hb.lastReasoningAt)?'active-tool':'active-model';
    const process_tree=state.driverAlive?inspect(record.driverPid||meta?.driverPid,record.driverStartedAt||meta?.driverStartedAt):{source:'run-evidence',nodes:state.childAlive?[{pid:state.childPid,ownership:state.childOwner}]:[],error:null};
    let control=null;
    if(args.probe===true)control=await sendControl(runDirectory(logs,record),record,'steer','Please report the current checkpoint and whether the active turn is progressing. This diagnostic is explicitly requested.',{signal:exec.signal});
    const result={status:'ok',run_id:record.runId,classification,run_status:meta?.status||state.liveness,driver_alive:state.driverAlive,child_alive:state.childAlive,
      heartbeat_age_ms:heartbeatAge,last_event_type:hb?.lastEventType||null,last_event_age_ms:hb?.lastEventAgeMs??null,turn_state:hb?.turnState||null,
      process_tree,intrusive:args.probe===true,control,quota:await readQuota({probe:'none'},cwd,settings)};
    return {...result,summary_text:JSON.stringify(result)};
  })];
}
