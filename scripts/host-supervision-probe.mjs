import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function probeSupervision({ctx,root,workspace,hostRequire}) {
  const {LlmAdapter,createUserMessage,isAgentLoopRequest}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  const settings=ctx.get('settings');
  await settings.mutate('dsh-codex-runner',[{op:'set',path:['supervisionEnabled'],value:true}],settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  const evidence=[];
  for(const action of ['question','steer','queue','interrupt']){
    await settings.mutate('dsh-codex-runner',[{op:'set',path:['streamOutputEnabled'],value:action!=='question'}],settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
    let calls=0,stage=0,runId,readWhileActive=false,error;
    const title='Supervision '+action,sessionId=randomUUID(),promptFile='supervise-'+action+'.md';
    fs.writeFileSync(path.join(workspace,promptFile),'SUPERVISE '+action.toUpperCase());
    const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(workspace,'.codex-runner/logs/runs',runId,name),'utf8'));}catch{return null;}};
    class Adapter extends LlmAdapter {
      async *stream(options){
        let name,args;
        if(isAgentLoopRequest(options)){
          calls++;
          const messages=options.messages.filter(m=>m.source?.kind==='codex-runner-supervision');
          if(stage===0){stage=1;name='codex_run';args={prompt_file:promptFile,label:'supervise-'+action,model:'gpt-6.1-sol',effort:'high',budget_ms:30000,notify_on_complete:'off'};}
          else if(messages.length&&stage===1){
            const text=messages.at(-1).content.filter(c=>c.type==='text').map(c=>c.text).join('');
            const payload=JSON.parse(text.slice(text.indexOf('\n')+1));runId=payload.run_id;
            readWhileActive=!read('result.meta.json')?.status;
            assert.ok(readWhileActive,'Supervision must reach the provider before Codex completes');
            assert.equal(read('run.json').detached,true,'Supervision must release the initiating tool');
            const shown=ctx.get('codexRunner').getOutput({sessionId,callId:read('run.json').callId});
            assert.equal(shown.status,action==='question'?'disabled':'ok','Display and model supervision switches are independent');
            stage=2;name=action==='question'?'codex_questions':'codex_say';
            args=action==='question'?{run_id:runId}:{run_id:runId,action,message:action.toUpperCase()+'_OK'};
          }else if(stage===2&&action==='question'){
            // The previous real tool result must contain the full request.
            const text=JSON.stringify(options.messages);assert.ok(text.includes('Choose a marker'));
            const q=read('interactions.json').interactions.find(q=>q.state==='pending');assert.ok(q);
            stage=3;name='codex_answer';args={run_id:runId,interaction_id:q.interactionId,response:{answers:{choice:{answers:['MODEL_ANSWER_OK']}}}};
          }
        }
        if(name){const id=randomUUID(),value=JSON.stringify(args);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:value};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:value}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:title};yield {type:'block-end',index:0,block:{type:'text',text:title}};yield {type:'finish',reason:{kind:'stop'}};
      }
    }
    const registration=ctx.get('llm').registerAdapter(['runner-supervision-probe'],new Adapter());
    const handle=await ctx.get('agents').create({sessionId,meta:{cwd:workspace},agentOptions:{provider:'runner-supervision-probe',model:'fixture'}});
    const off=ctx.on('user-questions/request',request=>{
      if(request.agent!==handle.agent)return;
      return new Promise((_resolve,reject)=>{const cancel=()=>reject(Object.assign(Error('Test user did not answer'),{code:'ASK_CANCELLED'}));request.signal.addEventListener('abort',cancel,{once:true});});
    },{prepend:true});
    try{
      handle.agent.followup(createUserMessage({content:[{type:'text',text:title}],source:{kind:'user'}}));
      for(let i=0;i<300;i++){if(runId&&read('result.meta.json')?.status)break;await new Promise(r=>setTimeout(r,100));}
      assert.ok(runId,'No supervision input reached the model adapter');
      const meta=read('result.meta.json'),state=read('supervision-state.json');
      assert.ok(meta?.status,'Controlled run did not finish');assert.ok(state.modelCursor>0||state.questionsRead.length>0,'Actual model request must advance the receipt');
      if(action==='interrupt')assert.equal(meta.status,'interrupted');
      else {const final=meta.lastMessage;assert.ok(final.includes(action==='question'?'MODEL_ANSWER_OK':action.toUpperCase()+'_OK'),final);}
      if(action==='question')assert.equal(read('interactions.json').interactions[0].source,'model');
      await handle.agent.whenIdle();evidence.push({action,runId,sessionId,calls,readWhileActive,state,meta});
    }catch(e){error=e;throw e;}finally{
      if(runId&&!read('result.meta.json')?.status)await ctx.get('tools').get('codex_cancel').execute({run_id:runId},{agent:handle.agent});
      fs.writeFileSync(path.join(root,'supervision-'+action+'.json'),JSON.stringify({classification:'real-host/deterministic-model/fake-codex',calls,stage,runId,error:error?.message,evidence},null,2));
      off();await handle.dispose();registration();
    }
  }
  await settings.mutate('dsh-codex-runner',[{op:'set',path:['supervisionEnabled'],value:false},{op:'set',path:['streamOutputEnabled'],value:false}],settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  return evidence;
}
