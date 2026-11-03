import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function probeSpecialQuestions({ctx,root,workspace,packageDir}){
  const {QuestionBridge}=await import(pathToFileURL(path.join(packageDir,'lib/question-bridge.js')));
  const {atomicJson,readJson}=await import(pathToFileURL(path.join(packageDir,'lib/run-store.js')));
  const handle=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:workspace}});
  const records=[],sent=[],presented=[];
  const off=ctx.on('user-questions/request',request=>{
    if(request.agent!==handle.agent)return;
    presented.push(request.questions);
    return {answers:request.questions.map(q=>({id:q.id,selected:[],custom:'中文🧪 free text'}))};
  },{prepend:true});
  const bridge=new QuestionBridge({lookupAgent:()=>handle.agent,ask:request=>ctx.get('userQuestions').ask(request),
    send:async(_dir,_record,action,message)=>{sent.push({action,message});}});
  try{
    for(const secret of [false,true]){
      const runId=randomUUID(),dir=path.join(workspace,'.codex-runner/logs/runs',runId);
      const record={runId,sessionId:handle.agent.session.id,cwd:workspace,backend:'app-server',label:'special-question',createdAt:new Date().toISOString()};
      const interaction={interactionId:randomUUID(),connectionId:randomUUID(),requestId:1,runId,state:'pending',method:'item/tool/requestUserInput',
        params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-item',isBlocking:true,questions:[
          {id:'first',header:'First',question:'Choose a Unicode value',isOther:true,isSecret:secret,options:[{label:'Alpha',description:'Choice'}]},
          {id:'second',header:'Second',question:'Free text',options:null}]}};
      atomicJson(path.join(dir,'run.json'),record);atomicJson(path.join(dir,'interactions.json'),{version:1,runId,interactions:[interaction]});
      atomicJson(path.join(dir,'result.meta.json'),{runId,driverPid:process.pid});
      records.push({dir,record,interaction});bridge.track({cwd:workspace,record});
    }
    for(let i=0;i<30&&!sent.length;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal(presented.length,1,'Secret-marked question must never reach an unmasked native composer');
    assert.equal(presented[0].length,2);assert.equal(sent.length,1);assert.equal(sent[0].message.source,'user');
    assert.deepEqual(sent[0].message.response.answers,{first:{answers:['中文🧪 free text']},second:{answers:['中文🧪 free text']}});
    const diagnostic=readJson(path.join(records[1].dir,'question-bridge.json'));
    assert.equal(diagnostic.code,'secret-question-renderer-unavailable');
    fs.writeFileSync(path.join(root,'special-questions.json'),JSON.stringify({classification:'real-host/native-question-service/synthetic-request-and-answerer',
      unicodeMultiQuestion:'passed',secretPresentation:'withheld-with-diagnostic',secretAnswering:'unsupported',diagnostic},null,2));
    console.log('SPECIAL-QUESTIONS-OK native multi-question/free text; secret renderer explicitly unavailable');
  }finally{
    bridge.close();off();
    for(const {dir,record,interaction}of records){atomicJson(path.join(dir,'interactions.json'),{version:1,runId:record.runId,interactions:[{...interaction,state:'invalidated',reason:'acceptance-complete'}]});atomicJson(path.join(dir,'result.meta.json'),{status:'cancelled'});}
    await handle.dispose();
  }
}
