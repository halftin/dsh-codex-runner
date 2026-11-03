import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function probeConversation({ctx,root,workspace,hostRequire,provider,model,codexVersion}){
  const {createUserMessage,isAgentLoopRequest}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  const token='CONVERSATION_'+randomUUID(),sessionId=randomUUID(),requests=[];
  fs.writeFileSync(path.join(workspace,'conversation-first.md'),'Remember this marker: '+token+'. Reply exactly with it. Do not use tools, files, network or subagents.');
  fs.writeFileSync(path.join(workspace,'conversation-second.md'),'Reply exactly with the marker from our previous conversation. Do not use tools, files, network or subagents.');
  const settings=ctx.get('settings');await settings.mutate('dsh-codex-runner',[
    {op:'set',path:['supervisionEnabled'],value:false},{op:'set',path:['autoAnswerQuestions'],value:false},
    {op:'set',path:['selectionPolicy'],value:JSON.stringify({mode:'off'})}],settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  const handle=await ctx.get('agents').create({sessionId,meta:{cwd:workspace},agentOptions:{provider,model,reasoningEffort:'low'}});
  const off=ctx.on('llm/stream',async function*(options,next){
    if(isAgentLoopRequest(options)&&options.messages.some(m=>JSON.stringify(m.content).includes('conversation-first.md'))){
      requests.push({at:Date.now()});if(requests.length>12)throw Error('Conversation acceptance step limit reached');
    }
    yield* next();
  });
  const records=()=>fs.readdirSync(path.join(workspace,'.codex-runner/logs/runs')).map(id=>{
    const dir=path.join(workspace,'.codex-runner/logs/runs',id);
    try{return {record:JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8')),meta:JSON.parse(fs.readFileSync(path.join(dir,'result.meta.json'),'utf8'))};}catch{return null;}
  }).filter(r=>r?.record.sessionId===sessionId);
  let error;
  const ask=async text=>{
    handle.agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
    let timer;try{await Promise.race([handle.agent.whenIdle(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Real DSH conversation timeout')),180000);})]);}finally{clearTimeout(timer);}
  };
  try{
    await ask('Run the existing conversation-first.md with Codex, label conversation-first, gpt-6.1-sol/low. Use synchronous codex_run, budget_ms=90000 and notify_on_complete=off. Do not read files or use unrelated tools. Return its answer.');
    const first=records();assert.equal(first.length,1);assert.equal(first[0].meta.status,'ok');assert.equal(first[0].meta.lastMessage.trim(),token);
    // Intentionally do not name continue_run_id: the DSH model must discover the operation from the tool contract.
    await ask('Follow up with that same Codex conversation using the existing conversation-second.md, label conversation-second, and switch this round to gpt-6-luna/low. Keep synchronous execution, budget_ms=90000 and notify_on_complete=off. Do not copy the marker into a new prompt, read files or use unrelated tools. Return its answer.');
    const all=records();assert.equal(all.length,2);const second=all.find(r=>r.record.runId!==first[0].record.runId);
    assert.equal(second.meta.status,'ok');assert.equal(second.meta.threadId,first[0].meta.threadId);
    assert.equal(second.meta.model,'gpt-6-luna');assert.equal(second.meta.lastMessage.trim(),token);
    assert.equal(second.record.resumeThread,first[0].meta.threadId,'DSH selected the original conversation');
    await ask('Continue that same conversation once more using codex_run with continue_run_id="'+second.record.runId+'", conversation-second.md, label conversation-third, gpt-6.1-sol/medium, budget_ms=90000 and notify_on_complete=off. Do not use unrelated tools; return the answer.');
    const final=records();assert.equal(final.length,3);const third=final.find(r=>r.record.runId!==first[0].record.runId&&r.record.runId!==second.record.runId);
    assert.equal(third.meta.status,'ok');assert.equal(third.meta.threadId,first[0].meta.threadId);
    assert.equal(third.meta.model,'gpt-6.1-sol');assert.equal(third.meta.effort,'medium');
    assert.equal(third.meta.lastMessage.trim(),token);assert.equal(third.record.continuationOf,second.record.runId);
    console.log('REAL-DSH-CONVERSATION-OK '+provider+'/'+model+'; evidence='+root);return requests.length;
  }catch(e){error=e.message;throw e;}finally{
    fs.writeFileSync(path.join(root,'real-dsh-conversation.json'),JSON.stringify({classification:'real-host/real-dsh-model/real-codex',provider,model,codexVersion,requests,records:records(),error,cache:'not a guarantee'},null,2));
    off();await handle.dispose();
  }
}
