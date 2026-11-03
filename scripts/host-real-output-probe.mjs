// Real Codex model + real DSH host, deterministic DSH dispatcher. No DSH provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export async function prepareRealOutputProbe({ctx,root,workspace,hostRequire,backend}) {
  assert.ok(process.env.DSH_DISPLAY_CODEX_EXE&&process.env.DSH_DISPLAY_CODEX_HOME,'Explicit real Codex paths required');
  const {LlmAdapter,createUserMessage,isAgentLoopRequest}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  const settings=ctx.get('settings');
  await settings.mutate('dsh-codex-runner',Object.entries({backend,codexExecutable:process.env.DSH_DISPLAY_CODEX_EXE,codexHome:process.env.DSH_DISPLAY_CODEX_HOME,sandboxMode:'read-only',approvalPolicy:'never',workspaceNetworkAccess:false,streamOutputEnabled:true,supervisionEnabled:false,autoAnswerQuestions:false}).map(([key,value])=>({op:'set',path:[key],value})),settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  const catalog=await ctx.get('codexRunner').getCatalog({refresh:true}),model=catalog.models.find(m=>m.isDefault&&!m.hidden)||catalog.models.find(m=>!m.hidden);
  assert.ok(model,'Real model catalog');const effort=model.efforts.some(e=>e.id==='low')?'low':model.defaultReasoningEffort;
  const sessionId=randomUUID(),callId='real_'+randomUUID(),title='Real Codex chat '+backend,provider='real-display-'+backend;
  const promptName='real-display-'+backend+'.md';
  fs.writeFileSync(path.join(workspace,promptName),'Output a commentary paragraph containing LIVE_STREAM_PROGRESS and bold text. Then use a PowerShell command to wait 8 seconds. Do not inspect or modify files, access network, or delegate. Finally answer exactly LIVE_STREAM_FINAL.');
  let calls=0;
  class Adapter extends LlmAdapter {async *stream(options){
    if(isAgentLoopRequest(options)&&++calls===1){const args=JSON.stringify({prompt_file:promptName,label:'real-display',model:model.id,effort,budget_ms:120000,notify_on_complete:'off'});
      yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:callId,name:'codex_run',argumentsDelta:args};yield {type:'block-end',index:0,block:{type:'tool-call',id:callId,name:'codex_run',arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:title};yield {type:'block-end',index:0,block:{type:'text',text:title}};yield {type:'finish',reason:{kind:'stop'}};
  }}
  const registration=ctx.get('llm').registerAdapter([provider],new Adapter());
  const entity=await ctx.get('workspaceRegistry').create(workspace,'Runner acceptance');
  const handle=await ctx.get('agents').create({sessionId,meta:{cwd:workspace},agentOptions:{provider,model:'fixture'}});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:title}],source:{kind:'user'}}));
  await ctx.get('sessionController').rename({sessionId,title});await entity.attachSession(sessionId);
  let runId;
  return {sessionId,callId,title,
    read(){const result=ctx.get('codexRunner').getOutput({sessionId,callId});runId=result.run_id;return result;},
    assertPassive(){assert.equal(calls,1);},
    async close(){
      try {if(!runId)try{this.read();}catch{}if(runId){const status=await ctx.get('tools').get('codex_status').execute({run_id:runId},{agent:handle.agent});if(status.running)await ctx.get('tools').get('codex_cancel').execute({run_id:runId},{agent:handle.agent});}
        await handle.agent.whenIdle();fs.writeFileSync(path.join(root,'real-display-'+backend+'.json'),JSON.stringify({classification:'real-Codex-model/real-DSH-host/deterministic-DSH-dispatcher',model:model.id,effort,calls,runId,sessionId,callId}));
      }finally{await handle.dispose();registration();}
    },
  };
}
