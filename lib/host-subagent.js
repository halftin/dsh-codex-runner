import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,recordFor,runDirectory,updateRecord,validRunId} from './run-store.js';

const PROVIDER='codex-runner';
const capabilities={agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminalResult=value=>({output:[{type:'text',text:value.answer||value.summary_text||'Codex run ended; inspect codex_status.'}],
  stopReason:['ok','completed'].includes(value.status)?'completed':['cancelled','interrupted','aborted'].includes(value.status)?'aborted':'error'});

export function hostSubagentInfo(cwd,runId){
  if(!cwd||!validRunId(runId))return null;
  const logs=path.join(cwd,'.codex-runner/logs'),record=recordFor(logs,runId);
  if(!record?.hostSubagent)return null;
  const receipt=readJson(path.join(runDirectory(logs,record),'host-subagent.json'));
  return {...record.hostSubagent,...(receipt?.runId===runId?{state:receipt.state,stop_reason:receipt.stopReason||null}:{}),catalog:'plugin',native_catalog:false};
}

/** Opt-in lifecycle ownership. Caller delivery deliberately preserves RunNotifier.
 * Private, one-use bindings carry native options; the public seam's AgentOptions
 * capability is never misrepresented as Codex model/effort support.
 */
export class HostSubagents {
  constructor({runtime,lookupAgent,status,cancel,pollMs=500}){
    Object.assign(this,{runtime,lookupAgent,status,cancel,pollMs});this.bindings=new Map();this.active=new Set();this.pending=new Set();this.closed=false;
    this.unregister=runtime.registerProvider({name:PROVIDER,capabilities,inheritsParentContext:false,start:request=>this.start(request)});
  }
  async execute(args,exec,run){
    if(this.closed)throw Error('Official subagent service is closing');
    const parent=exec?.agent,cwd=parent?.session?.header?.cwd;
    if(!parent||this.lookupAgent(parent.id)!==parent||!cwd)throw Error('Host-managed runs require the exact live DSH parent Agent and workspace');
    const token=randomUUID(),controller=new AbortController(),signal=exec.signal?AbortSignal.any([exec.signal,controller.signal]):controller.signal;
    const binding={args,exec,run,parent,cwd,controller,finished:Promise.withResolvers()};this.bindings.set(token,binding);this.pending.add(binding);
    try{
      const activation=await this.runtime.startActivation({provider:PROVIDER,label:args.label||'Codex',request:{parent,cwd,prompt:[{type:'text',text:token}]},signal,delivery:'caller'});
      binding.activation=activation;
      // Always observe the official post-cleanup result, including detached runs.
      void activation.result.then(result=>this.save(binding.state,'settled',result.stopReason),error=>this.save(binding.state,'cleanup-error',null,String(error.message))).catch(()=>{});
      return {...binding.launched,host_subagent:hostSubagentInfo(cwd,binding.launched.run_id)};
    }finally{this.bindings.delete(token);this.pending.delete(binding);binding.finished.resolve();}
  }
  save(state,status,stopReason,error){
    if(!state?.file)return;
    atomicJson(state.file,{runId:state.runId,provider:PROVIDER,childId:state.runId,delivery:'caller',state:status,stopReason,error,updatedAt:new Date().toISOString()});
  }
  async start(request){
    const token=request.prompt?.length===1&&request.prompt[0]?.type==='text'?request.prompt[0].text:null,binding=this.bindings.get(token);
    if(!binding||request.parent!==binding.parent||path.resolve(request.cwd)!==path.resolve(binding.cwd))throw Error('Use codex_run(host_managed=true); no authorized runner binding exists');
    this.bindings.delete(token);request.signal.throwIfAborted();
    const exec={...binding.exec,signal:request.signal};
    const launched=await binding.run(binding.args,exec);binding.launched=launched;
    if(!launched?.run_id)throw Error(launched?.summary_text||'Codex did not create a run');
    const state={runId:launched.run_id,exec,done:launched.status!=='running'?launched:null};binding.state=state;
    let cancelPromise;
    const cancel=()=>cancelPromise??=Promise.resolve().then(()=>this.cancel({run_id:state.runId},exec)).then(result=>{if(result?.status==='error')throw Error(result.summary_text||'Codex cancellation failed');});
    const onAbort=()=>{void cancel().catch(error=>{state.cancelError=error;});};
    try{
      const logs=path.join(binding.cwd,'.codex-runner/logs'),record=recordFor(logs,launched.run_id);
      if(!record)throw Error('Codex run record is unavailable: '+launched.run_id);
      state.file=path.join(runDirectory(logs,record),'host-subagent.json');
      updateRecord(logs,record,{hostSubagent:{provider:PROVIDER,child_id:record.runId,delivery:'caller',parent_session_id:binding.parent.id}});
      this.save(state,'accepted');
      if(request.signal.aborted){await cancel();request.signal.throwIfAborted();}
      request.signal.addEventListener('abort',onAbort,{once:true});
      state.result=(async()=>{
        while(!state.done){
          if(state.cancelError)throw state.cancelError;
          const current=await this.status({run_id:state.runId},exec);
          if(current.status==='error')throw Error(current.summary_text||'Cannot collect Codex state');
          if(!current.running){state.done=current;break;}
          await delay(this.pollMs);
        }
        return terminalResult(state.done);
      })();
      // Avoid an unhandled rejection before the host accepts the handle.
      void state.result.catch(()=>{});
      let disposal;
      state.dispose=()=>disposal??=(async()=>{
        try{
          if(!state.done||['orphan','unknown','stale'].includes(state.done.process_status))await cancel();
          await state.result;
        }finally{request.signal.removeEventListener('abort',onAbort);this.active.delete(state);}
      })();
      this.active.add(state);return {id:record.runId,result:state.result,dispose:state.dispose};
    }catch(error){request.signal.removeEventListener('abort',onAbort);await cancel();throw error;}
  }
  async close(){
    if(this.closed)return;this.closed=true;this.unregister();
    for(const binding of this.pending)binding.controller.abort(Error('Plugin unloaded'));
    const settled=await Promise.allSettled([...this.active].map(state=>state.dispose()).concat([...this.pending].map(binding=>binding.finished.promise)));
    const failures=settled.filter(r=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Host-managed Codex cleanup failed');
  }
}
