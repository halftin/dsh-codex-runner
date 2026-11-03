import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<200;i++){const v=await fn();if(v)return v;await delay(100);}throw Error('Host-managed probe timeout');}
export async function probeHostManaged({ctx,root,workspace,hostRequire}){
  const {LlmAdapter,isAgentLoopRequest}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  let officialNotices=0,supervisionReads=0;
  class Adapter extends LlmAdapter{async *stream(options){if(isAgentLoopRequest(options)){officialNotices+=options.messages.filter(m=>m.source?.kind==='subagent-settled').length;supervisionReads+=options.messages.filter(m=>m.source?.kind==='codex-runner-supervision').length;}yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'received'};yield {type:'block-end',index:0,block:{type:'text',text:'received'}};yield {type:'finish',reason:{kind:'stop'}};}}
  const off=ctx.get('llm').registerAdapter(['host-managed-probe'],new Adapter());
  const handle=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'host-managed-probe',model:'fixture'}});
  const settings=ctx.get('settings'),old=(await ctx.get('tools').get('codex_config').execute({})).settings;
  const set=values=>settings.mutate('dsh-codex-runner',Object.entries(values).map(([key,value])=>({op:'set',path:[key],value})),settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  const exec={agent:handle.agent,callId:randomUUID()},tool=(name,args)=>ctx.get('tools').get(name).execute(args,exec);
  const ids=[],steps=[];let keepForShutdown=false;
  const run=async(text,extra={})=>{exec.callId=randomUUID();const label='managed-'+randomUUID(),file=path.join(workspace,label+'.md');fs.writeFileSync(file,text);const r=await tool('codex_run',{host_managed:true,label,prompt_file:file,model:'gpt-6.1-sol',effort:'low',budget_ms:20000,...extra});assert.ok(r.run_id,JSON.stringify(r));assert.equal(r.host_subagent.provider,'codex-runner');ids.push(r.run_id);return r;};
  try{
    await set({streamOutputEnabled:false,supervisionEnabled:false,autoAnswerQuestions:false});
    const first=await run('COMPLETE');assert.equal(first.status,'ok');await wait(async()=> (await tool('codex_status',{run_id:first.run_id})).host_subagent.state==='settled');steps.push('synchronous official collection');
    const second=await run('COMPLETE',{continue_run_id:first.run_id,model:'gpt-6-luna'});assert.equal(second.status,'ok');assert.equal(first.thread_id,second.thread_id);steps.push('same-thread continuation and model change');
    await set({supervisionEnabled:true,streamOutputEnabled:true});
    const live=await run('SUPERVISE STEER');await wait(()=>supervisionReads>0);
    const output=ctx.get('codexRunner').getOutput({sessionId:handle.agent.id,callId:exec.callId});assert.equal(output.status,'ok');
    const steer=await tool('codex_say',{run_id:live.run_id,action:'steer',message:'HOST_MANAGED_OK'});assert.notEqual(steer.status,'error');
    const done=await tool('codex_status',{run_id:live.run_id,wait_ms:10000});assert.equal(done.status,'ok');assert.ok(done.answer.includes('HOST_MANAGED_OK'));steps.push('supervision/output/steering preserve original tool identity');
    const rows=await tool('codex_list',{});assert.ok(rows.runs.some(r=>r.run_id===live.run_id&&r.host_subagent.child_id===live.run_id));
    assert.equal((await ctx.get('subagents').listChildren(handle.agent.id)).length,0);steps.push('plugin directory mapping without false native-catalog claim');
    await set({autoAnswerQuestions:true});
    const offQuestion=ctx.on('user-questions/request',request=>request.agent===handle.agent?new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(Error('probe closed')),{once:true})):undefined,{prepend:true});
    try{const qrun=await run('QUESTION');const q=await wait(async()=>{const r=await tool('codex_questions',{run_id:qrun.run_id});return r.interactions?.find(q=>q.state==='pending');});
      const answer=await tool('codex_answer',{run_id:qrun.run_id,interaction_id:q.interactionId,response:{answers:{choice:{answers:['HOST_ANSWER_OK']}}}});assert.notEqual(answer.status,'error');
      const finished=await tool('codex_status',{run_id:qrun.run_id,wait_ms:10000});assert.equal(finished.status,'ok');assert.equal(finished.answer,'HOST_ANSWER_OK');steps.push('managed original-request answer loop');
    }finally{offQuestion();}
    await set({backend:'exec'});
    try{const cli=await run('STREAM');await wait(async()=>{const r=ctx.get('codexRunner').getOutput({sessionId:handle.agent.id,callId:exec.callId});return r.status==='ok'&&r.events.length;});
      const result=await tool('codex_cancel',{run_id:cli.run_id});assert.equal(result.status,'ok');await wait(async()=> (await tool('codex_status',{run_id:cli.run_id})).host_subagent.state==='settled');steps.push('exec output and cancellation under official ownership');
    }finally{await set({backend:old.backend});}
    const cancel=await run('WAIT');ctx.get('subagents').interrupt(cancel.run_id,{kind:'ancestor',agent:handle.agent});
    const cancelled=await tool('codex_status',{run_id:cancel.run_id,wait_ms:10000});assert.equal(cancelled.status,'cancelled');steps.push('official interrupt reaches existing cancellation');
    assert.equal(officialNotices,0);steps.push('no official completion notice alongside plugin notifier');
    const shutdown=await run('WAIT',{budget_ms:60000});keepForShutdown=true;
    fs.writeFileSync(path.join(root,'host-managed-restart.json'),JSON.stringify({runId:shutdown.run_id,sessionId:handle.agent.id,cwd:workspace}));
    fs.writeFileSync(path.join(root,'host-managed-acceptance.json'),JSON.stringify({classification:'real host / deterministic model / simulated Codex',steps,ids,officialNotices,supervisionReads},null,2));
  }finally{
    await set(Object.fromEntries(['streamOutputEnabled','supervisionEnabled','autoAnswerQuestions'].map(k=>[k,old[k]])));
    if(!keepForShutdown){for(const run_id of ids)await tool('codex_cancel',{run_id}).catch(()=>{});await handle.dispose();off();}
    // On success the real host shutdown owns this final live parent and run.
  }
}
export async function probeHostManagedRestart({ctx,root}){
  const p=JSON.parse(fs.readFileSync(path.join(root,'host-managed-restart.json'),'utf8'));
  const value=await ctx.get('tools').get('codex_status').execute({run_id:p.runId,wait_ms:10000},{agent:{id:p.sessionId,session:{id:p.sessionId,header:{cwd:p.cwd}}}});
  assert.equal(value.status,'cancelled');assert.equal(value.host_subagent.native_catalog,false);
  fs.writeFileSync(path.join(root,'host-managed-after-restart.json'),JSON.stringify(value,null,2));
}
