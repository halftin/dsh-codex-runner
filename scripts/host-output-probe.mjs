import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {specialItems} from './special-content-fixture.mjs';

export async function prepareOutputProbe({ctx,root,workspace,hostRequire,backend='app-server'}) {
  const {LlmAdapter,createUserMessage,isAgentLoopRequest}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  let calls=0;const callId='stream_'+randomUUID(),sessionId=randomUUID(),title='Codex output acceptance '+backend;
  const workspaceEntity=await ctx.get('workspaceRegistry').create(workspace,'Runner acceptance');
  fs.writeFileSync(path.join(workspace,'stream.md'),'STREAM WAIT');
  const finishFile=path.join(workspace,'.smoke-finish-'+backend);fs.rmSync(finishFile,{force:true});let finished=false;
  class Adapter extends LlmAdapter {
    async *stream(options) {
      if(isAgentLoopRequest(options)&&++calls===1) {
        const args=JSON.stringify({prompt_file:'stream.md',label:'stream-card-'+backend,model:'gpt-6.1-sol',effort:'high',budget_ms:120000});
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'tool-call-delta',index:0,id:callId,name:'codex_run',argumentsDelta:args};
        yield {type:'block-end',index:0,block:{type:'tool-call',id:callId,name:'codex_run',arguments:args}};
        yield {type:'finish',reason:{kind:'tool-calls'}};return;
      }
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:title};
      yield {type:'block-end',index:0,block:{type:'text',text:title}};yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const provider='runner-output-probe-'+backend;
  const registration=ctx.get('llm').registerAdapter([provider],new Adapter());
  const handle=await ctx.get('agents').create({sessionId,meta:{cwd:workspace},agentOptions:{provider,model:'fixture'}});
  const settings=ctx.get('settings');
  // This probe verifies display alone; automatic question handling would detach
  // the initiating tool and legitimately cause a second model request.
  const set=async value=>settings.mutate('dsh-codex-runner',[{op:'set',path:['backend'],value:backend},{op:'set',path:['streamOutputEnabled'],value},{op:'set',path:['supervisionEnabled'],value:false},{op:'set',path:['autoAnswerQuestions'],value:false}],settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  await set(true);handle.agent.followup(createUserMessage({content:[{type:'text',text:title}],source:{kind:'user'}}));
  let stream;
  const hasOutput=value=>value?.events.some(e=>e.method==='item/agentMessage/delta'||String(e.params?.item?.text||'').startsWith('Live 中文'));
  for(let i=0;i<150;i++){try{stream=ctx.get('codexRunner').getOutput({sessionId,callId});if(hasOutput(stream))break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(hasOutput(stream),'Real host must read output while tool and fake Codex are active');
  for(const item of specialItems.filter(v=>v.id!=='special-large'))assert.deepEqual(stream.events.find(e=>e.params?.item?.id===item.id)?.params.item,item);
  const large=stream.events.find(e=>e.payload),chunks=[];assert.ok(large,'Long content must retain a downloadable payload');
  let offset=0;
  for(;;){const part=ctx.get('codexRunner').getOutputResource({sessionId,callId,sequence:large.sequence,offset,limit:32767});chunks.push(Buffer.from(part.data,'base64'));offset=part.next_offset;if(!part.has_more)break;}
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()).item,specialItems.at(-1));
  assert.equal(calls,1);await ctx.get('sessionController').rename({sessionId,title});
  await ctx.get('sessionPersistence').flush();await workspaceEntity.attachSession(sessionId);
  return {sessionId,callId,title,runId:stream.run_id,set,fullResource:Buffer.concat(chunks),
    assertPassive(){assert.ok(calls<=(finished?2:1),'Display must not invoke another model step');},
    async finish(){finished=true;fs.writeFileSync(finishFile,'finish');const result=await ctx.get('tools').get('codex_status').execute({run_id:stream.run_id,wait_ms:10000},{agent:handle.agent});assert.equal(result.running,false);assert.ok(result.answer.includes('SMOKE_FINAL_'+backend));await handle.agent.whenIdle();},
    async close(){
      this.assertPassive();await ctx.get('tools').get('codex_cancel').execute({run_id:stream.run_id},{agent:handle.agent});
      await handle.agent.whenIdle();
      fs.writeFileSync(path.join(root,'output-host-'+backend+'.json'),JSON.stringify({classification:'real-host/deterministic-model/fake-codex',backend,sessionId,runId:stream.run_id,callId,displayModelCalls:0,mobile:'not tested'},null,2));
      await handle.dispose();registration();
    },
  };
}
