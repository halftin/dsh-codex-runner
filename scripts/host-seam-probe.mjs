// Opt-in experiment only. No provider/tool is added to the distributed plugin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const capabilities={agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<200;i++){const result=await fn();if(result)return result;await delay(100);}throw Error('Seam timeout: '+label);}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Seam timeout: '+label)),25000);})]);}finally{clearTimeout(timer);}}
export async function probeSeam({ctx,root,workspace,hostRequire}){
  const {LlmAdapter,isAgentLoopRequest}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  const service=ctx.get('subagents');assert.ok(service?.startActivation,'Real host must expose the public seam');
  const received=new Map(),observations=[],handles=[],activations=[];
  class Adapter extends LlmAdapter {
    async *stream(options){
      if(isAgentLoopRequest(options))for(const m of options.messages)if(m.source && !['system-prompt','runtime-context'].includes(m.source.kind))received.set(m.id,m);
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Probe received'};
      yield {type:'block-end',index:0,block:{type:'text',text:'Probe received'}};yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const unregisterAdapter=ctx.get('llm').registerAdapter(['seam-probe-model'],new Adapter());
  const parent=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'seam-probe-model',model:'fixture'}});handles.push(parent);
  const notices=id=>[...received.values()].filter(m=>m.source?.kind==='subagent-settled'&&m.source.senderSessionId===id);
  const controls=new Map();let starts=0;
  const provider={name:'runner-seam-contract-probe',capabilities,inheritsParentContext:false,async start(request){
    starts++;request.signal.throwIfAborted();const id=randomUUID(),deferred=Promise.withResolvers();let disposed=0;
    const abort=()=>deferred.resolve({output:[],stopReason:'aborted'});request.signal.addEventListener('abort',abort,{once:true});
    const state={id,request,resolve:deferred.resolve,get disposed(){return disposed;}};controls.set(id,state);
    return {id,result:deferred.promise,async dispose(){disposed++;request.signal.removeEventListener('abort',abort);deferred.resolve({output:[],stopReason:'aborted'});}};
  }};
  const unregister=service.registerProvider(provider);
  const start=async(delivery='parent',extra={})=>{
    const activation=await service.startActivation({provider:provider.name,label:'seam-contract',request:{parent:parent.agent,cwd:workspace,prompt:[{type:'text',text:'unchanged task'}],...extra},signal:new AbortController().signal,delivery});activations.push(activation);return activation;
  };
  const mark=(name,details={})=>{observations.push({name,...details});console.log('PASS seam '+name);};
  const settings=ctx.get('settings'),original=(await ctx.get('tools').get('codex_config').execute({})).settings;
  const set=async values=>settings.mutate('dsh-codex-runner',Object.entries(values).map(([key,value])=>({op:'set',path:[key],value})),settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  let unregisterRunner;
  try{
    assert.throws(()=>service.registerProvider(provider));mark('duplicate provider rejected');
    const a=await start();const control=controls.get(a.childId);assert.ok(control);assert.equal(control.request.prompt[0].text,'unchanged task');
    assert.ok((await service.listChildren(parent.agent.id)).some(c=>JSON.stringify(c).includes(a.childId)));
    await assert.rejects(service.sendMessage(parent.agent,a.childId,[{type:'text',text:'followup'}],{signal:new AbortController().signal}),e=>e.code==='NOT_CONTINUABLE');
    control.resolve({output:[{type:'text',text:'exact final 中文'}],stopReason:'completed'});
    assert.equal((await bounded(a.result,'parent result')).stopReason,'completed');
    await until(()=>notices(a.childId).length,'parent model receipt');assert.equal(notices(a.childId).length,1);assert.equal(control.disposed,1);
    assert.ok(JSON.stringify(notices(a.childId)).includes('exact final 中文'));mark('parent delivery, catalog, exact final text and cleanup',{childId:a.childId});
    mark('official external followup rejected while task text is preserved');
    const b=await start('caller');controls.get(b.childId).resolve({output:[{type:'text',text:'caller only'}],stopReason:'completed'});await bounded(b.result,'caller');await delay(200);
    assert.equal(notices(b.childId).length,0);assert.ok(!(await service.listChildren(parent.agent.id)).some(c=>JSON.stringify(c).includes(b.childId)));mark('caller delivery has result but no external catalog or parent notice');
    const c=await start('caller');await Promise.all([c.dispose(),c.dispose()]);assert.equal(controls.get(c.childId).disposed,1);assert.equal((await c.result).stopReason,'aborted');mark('concurrent dispose releases external handle once');
    const before=starts;await assert.rejects(start('caller',{agentOptions:{model:'other'}}),e=>e.code==='UNSUPPORTED_CAPABILITY');assert.equal(starts,before);mark('unsupported model override rejected before backend startup');
    const aborted=new AbortController();aborted.abort();await assert.rejects(service.startActivation({provider:provider.name,label:'aborted',request:{parent:parent.agent,prompt:[]},signal:aborted.signal,delivery:'caller'}));mark('pre-aborted startup rejected');
    const slots=[];for(let i=0;i<8;i++)slots.push(await start('caller'));
    await assert.rejects(start('caller'),e=>e.code==='ACTIVATION_LIMIT_REACHED');
    await slots[0].dispose();const reused=await start('caller');await reused.dispose();await Promise.all(slots.map(a=>a.dispose()));mark('eight-slot pool refuses ninth and reuses released capacity');
    const interrupted=await start('caller');service.interrupt(interrupted.childId,{kind:'ancestor',agent:parent.agent});assert.equal((await bounded(interrupted.result,'public interrupt')).stopReason,'aborted');mark('public interrupt reaches external provider abort signal');
    const orphanParent=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'seam-probe-model',model:'fixture'}});handles.push(orphanParent);
    const orphan=await service.startActivation({provider:provider.name,label:'parent teardown',request:{parent:orphanParent.agent,prompt:[]},signal:new AbortController().signal,delivery:'caller'});activations.push(orphan);
    await bounded(orphanParent.dispose(),'parent teardown');await delay(200);
    assert.equal(controls.get(orphan.childId).request.signal.aborted,false);assert.equal(controls.get(orphan.childId).disposed,0);
    mark('raw parent handle disposal does not automatically cancel external child');await orphan.dispose();
    const drainParent=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'seam-probe-model',model:'fixture'}});handles.push(drainParent);
    const drained=await service.startActivation({provider:provider.name,label:'explicit parent drain',request:{parent:drainParent.agent,prompt:[]},signal:new AbortController().signal,delivery:'caller'});activations.push(drained);
    await bounded(service.drainDescendants([drainParent.agent]),'drain descendants');assert.equal((await drained.result).stopReason,'aborted');assert.equal(controls.get(drained.childId).disposed,1);mark('explicit drainDescendants cancels child and awaits cleanup');
    let startupEntered,partialCleaned=false;const entered=new Promise(r=>{startupEntered=r;});
    const offStartup=service.registerProvider({name:'seam-startup-probe',capabilities,inheritsParentContext:false,async start(request){startupEntered();await new Promise((_,reject)=>{const abort=()=>{partialCleaned=true;reject(Error('startup cancelled after cleanup'));};if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});});}});
    try{const controller=new AbortController();const pending=service.startActivation({provider:'seam-startup-probe',label:'startup',request:{parent:parent.agent,prompt:[]},signal:controller.signal,delivery:'caller'});const rejected=assert.rejects(pending);await entered;controller.abort();await bounded(rejected,'startup cancellation');assert.equal(partialCleaned,true);mark('startup cancellation forwarded; provider performs partial cleanup');}finally{offStartup();}
    // A real plugin run behind the official lifecycle; its native tools remain accessible.
    await set({streamOutputEnabled:true,supervisionEnabled:true,autoAnswerQuestions:true});
    const requests=new Map(),runs=new Map();
    const tool=(name,args,agent=parent.agent,callId=randomUUID())=>ctx.get('tools').get(name).execute(args,{agent,callId});
    unregisterRunner=service.registerProvider({name:'runner-seam-driver-probe',capabilities,inheritsParentContext:false,async start(request){
      const token=request.prompt[0].text,options=requests.get(token);assert.ok(options,'Only experiment-owned bindings are accepted');requests.delete(token);
      const callId=randomUUID(),promptFile=path.join(workspace,'seam-'+token+'.md');fs.writeFileSync(promptFile,options.text);
      const launched=await tool('codex_run',{label:'seam-'+token,prompt_file:promptFile,model:options.model||'gpt-6.1-sol',effort:options.effort||'low',detach:true,budget_ms:20000,...(options.continueRun?{continue_run_id:options.continueRun}:{})},request.parent,callId);
      assert.ok(launched.run_id,JSON.stringify(launched));const id=randomUUID(),runId=launched.run_id;
      const state={id,runId,callId,options};runs.set(id,state);
      const result=(async()=>{const done=await until(async()=>{const r=await tool('codex_status',{run_id:runId},request.parent);return !r.running&&r.status!=='error'?r:null;},'runner finish');state.done=done;return {output:[{type:'text',text:done.answer||done.summary_text}],stopReason:['ok','completed'].includes(done.status)?'completed':['interrupted','cancelled'].includes(done.status)?'aborted':'error'};})();
      return {id,result,async dispose(){if(!state.done)await tool('codex_cancel',{run_id:runId},request.parent);await result;}};
    }});
    const run=async options=>{const token=randomUUID();requests.set(token,options);const a=await service.startActivation({provider:'runner-seam-driver-probe',label:'runner adapter experiment',request:{parent:parent.agent,cwd:workspace,prompt:[{type:'text',text:token}]},signal:new AbortController().signal,delivery:'parent'});activations.push(a);return {a,r:runs.get(a.childId)};};
    const first=await run({text:'COMPLETE'});assert.equal((await bounded(first.a.result,'first runner')).stopReason,'completed');
    const second=await run({text:'COMPLETE',continueRun:first.r.runId,model:'gpt-6-luna',effort:'low'});assert.equal((await bounded(second.a.result,'continued runner')).stopReason,'completed');
    const meta=r=>JSON.parse(fs.readFileSync(path.join(workspace,'.codex-runner/logs/runs',r.runId,'result.meta.json'),'utf8'));
    assert.equal(meta(first.r).threadId,meta(second.r).threadId);assert.notEqual(first.a.childId,second.a.childId);assert.equal(meta(second.r).model,'gpt-6-luna');mark('new official activation retains Codex thread and per-run model via plugin adapter',{first:first.r.runId,second:second.r.runId,thread:meta(first.r).threadId});
    const active=await run({text:'SUPERVISE STEER'});
    await until(()=>[...received.values()].some(m=>m.source?.kind==='codex-runner-supervision'&&m.source.runId===active.r.runId),'supervision reaches real model pipeline');
    const output=ctx.get('codexRunner').getOutput({sessionId:parent.agent.id,callId:active.r.callId});assert.equal(output.status,'ok');assert.ok(output.events.length);
    const steered=await tool('codex_say',{run_id:active.r.runId,action:'steer',message:'SEAM_STEER_OK'});assert.notEqual(steered.status,'error',JSON.stringify(steered));
    assert.equal((await bounded(active.a.result,'steered runner')).stopReason,'completed');assert.ok(meta(active.r).lastMessage.includes('SEAM_STEER_OK'));mark('existing output API, provider receipt and steering survive adapter',{runId:active.r.runId,cardMounted:false});
    const off=ctx.on('user-questions/request',request=>request.agent===parent.agent?new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(Error('probe question closed')),{once:true})):undefined,{prepend:true});
    try{
      const qrun=await run({text:'QUESTION'});const q=await until(async()=>{const r=await tool('codex_questions',{run_id:qrun.r.runId});return r.interactions?.find(q=>q.state==='pending');},'question');
      const answer=await tool('codex_answer',{run_id:qrun.r.runId,interaction_id:q.interactionId,response:{answers:{choice:{answers:['SEAM_ANSWER_OK']}}}});assert.notEqual(answer.status,'error',JSON.stringify(answer));
      assert.equal((await bounded(qrun.a.result,'answered runner')).stopReason,'completed');assert.equal(meta(qrun.r).lastMessage,'SEAM_ANSWER_OK');mark('original request answer survives adapter',{runId:qrun.r.runId});
    }finally{off();}
    const stopped=await run({text:'WAIT'});await bounded(stopped.a.dispose(),'runner cancel');assert.equal((await stopped.a.result).stopReason,'aborted');assert.equal(meta(stopped.r).status,'cancelled');mark('official dispose reaches plugin cancellation',{runId:stopped.r.runId,status:meta(stopped.r).status});
    await delay(3500);
    const scheduled=await ctx.get('schedule').list({sessionId:parent.agent.id});
    const pluginNotices=scheduled.filter(s=>s.prompt?.includes('[codex-run-notice:'));
    const durablePluginNotices=[...runs.values()].filter(r=>fs.existsSync(path.join(workspace,'.codex-runner/logs/runs',r.runId,'notified.json'))).map(r=>r.runId);
    assert.ok(durablePluginNotices.length,'Unmodified plugin still delivers its own notice');
    mark('overlap observed without changing production notification ownership',{nativeNotices:[...received.values()].filter(m=>m.source?.kind==='subagent-settled').length,pendingPluginNotices:pluginNotices.length,durablePluginNotices,warning:'Schedules may already have dispatched; zero pending is not proof of no duplicate.'});
    fs.writeFileSync(path.join(root,'seam-restart-pointer.json'),JSON.stringify({parentId:parent.agent.id,childId:a.childId}));
    await ctx.get('sessions').flush(parent.agent.session);
  }finally{
    for(const a of activations)await a.dispose().catch(()=>{});
    unregisterRunner?.();unregister();for(const h of handles)await h.dispose();unregisterAdapter();
    await set(Object.fromEntries(['streamOutputEnabled','supervisionEnabled','autoAnswerQuestions'].map(k=>[k,original[k]])));
    fs.writeFileSync(path.join(root,'seam-experiment.json'),JSON.stringify({classification:'real DSH 0.2.1-rc.3 / deterministic model / simulated provider and Codex',observations,received:[...received.values()]},null,2));
  }
}
export async function probeSeamRestart({ctx,root}){
  const pointer=JSON.parse(fs.readFileSync(path.join(root,'seam-restart-pointer.json'),'utf8'));
  const rows=await ctx.get('subagents').listChildren(pointer.parentId);
  assert.ok(rows.some(row=>JSON.stringify(row).includes(pointer.childId)));
  assert.equal(ctx.get('agents').get(pointer.childId),undefined);
  fs.writeFileSync(path.join(root,'seam-restart.json'),JSON.stringify({pointer,rows,externalAgentRestored:false,hardCrashDeliveryTested:false},null,2));
}
