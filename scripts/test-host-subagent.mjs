import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HostSubagents,hostSubagentInfo} from '../lib/host-subagent.js';
import {atomicJson} from '../lib/run-store.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-host-managed-'));
const wait=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Test wait expired');};
function fixture(){
  const cwd=fs.mkdtempSync(path.join(root,'case-')),parent={id:randomUUID(),session:{header:{cwd}}};parent.session.id=parent.id;
  const records=new Map(),activations=[];let provider,started=0,cancelled=0,rejectAdmission=false;
  const runtime={registerProvider(value){provider=value;return ()=>{provider=null;};},async startActivation(spec){
    if(rejectAdmission)throw Error('ACTIVATION_LIMIT_REACHED');assert.equal(spec.delivery,'caller');
    const handle=await provider.start({...spec.request,signal:spec.signal});
    const activation={childId:handle.id,dispose:()=>handle.dispose(),result:handle.result.then(async result=>{await handle.dispose();return result;})};activations.push(activation);return activation;
  }};
  const status=async({run_id})=>records.get(run_id);
  const cancel=async({run_id})=>{cancelled++;records.set(run_id,{run_id,status:'cancelled',running:false});return {status:'ok'};};
  const bridge=new HostSubagents({runtime,lookupAgent:id=>id===parent.id?parent:null,status,cancel,pollMs:5});
  const run=async args=>{started++;const runId=randomUUID();atomicJson(path.join(cwd,'.codex-runner/logs/runs',runId,'run.json'),{runId,cwd,label:'test',createdAt:new Date().toISOString()});
    const value={run_id:runId,status:args.detach?'running':'ok',running:!!args.detach,answer:args.detach?'':'complete'};records.set(runId,value);return value;};
  return {bridge,parent,run,records,activations,cwd,get provider(){return provider;},get started(){return started;},get cancelled(){return cancelled;},reject(){rejectAdmission=true;}};
}
try{
  const f=fixture();try{
    const args={model:'chosen',effort:'high',prompt_file:'exact.md'},exec={agent:f.parent,callId:'original-call'};
    const sync=await f.bridge.execute(args,exec,async(a,e)=>{assert.deepEqual(a,args);assert.equal(e.callId,'original-call');return f.run(a);});
    await wait(()=>hostSubagentInfo(f.cwd,sync.run_id).state==='settled');assert.equal(sync.host_subagent.native_catalog,false);assert.equal(f.cancelled,0);
    const active=await f.bridge.execute({detach:true},exec,f.run);assert.equal(f.activations.length,2);
    await f.activations.at(-1).dispose();await wait(()=>hostSubagentInfo(f.cwd,active.run_id).state==='settled');assert.equal(f.cancelled,1);
    await f.activations.at(-1).dispose();assert.equal(f.cancelled,1,'idempotent cleanup');
    await assert.rejects(f.provider.start({parent:f.parent,cwd:f.cwd,prompt:[{type:'text',text:'invented'}]}),/no authorized runner binding/);
    await assert.rejects(f.bridge.execute({}, {agent:{...f.parent}},f.run),/exact live/);
    f.reject();const before=f.started;await assert.rejects(f.bridge.execute({},exec,f.run),/ACTIVATION_LIMIT/);assert.equal(f.started,before);
    assert.equal(f.bridge.bindings.size,0);assert.equal(f.bridge.pending.size,0);
  }finally{await f.bridge.close();}
  const g=fixture();try{
    const live=await g.bridge.execute({detach:true},{agent:g.parent},g.run);await g.bridge.close();assert.equal(g.cancelled,1);assert.equal(g.records.get(live.run_id).status,'cancelled');
    await assert.rejects(g.bridge.execute({},{agent:g.parent},g.run),/closing/);
  }finally{await g.bridge.close();}
  const h=fixture();try{
    let release;const entered=Promise.withResolvers();
    const pending=h.bridge.execute({detach:true},{agent:h.parent},async args=>{entered.resolve();await new Promise(r=>{release=r;});return h.run(args);});
    const rejected=assert.rejects(pending,/Plugin unloaded/);await entered.promise;let closed=false;const closing=h.bridge.close().then(()=>{closed=true;});
    await new Promise(r=>setTimeout(r,10));assert.equal(closed,false,'unload waits for unpublished startup cleanup');release();await rejected;await closing;assert.equal(h.cancelled,1);
  }finally{await h.bridge.close();}
  const failed=fixture();try{await assert.rejects(failed.bridge.execute({},{agent:failed.parent},async()=>({status:'error',summary_text:'selection rejected'})),/selection rejected/);assert.equal(failed.bridge.active.size,0);}finally{await failed.bridge.close();}
  const missing=fixture();try{await assert.rejects(missing.bridge.execute({},{agent:missing.parent},async()=>({run_id:randomUUID(),status:'running'})),/record is unavailable/);assert.equal(missing.cancelled,1,'unpublished setup failure attempts cleanup');}finally{await missing.bridge.close();}
  assert.equal(hostSubagentInfo(root,'invalid'),null);
  console.log('HOST-SUBAGENT-OK binding authority, argument/call identity, sync/detach results, receipts, admission, cancellation, unload and startup rollback');
}finally{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
