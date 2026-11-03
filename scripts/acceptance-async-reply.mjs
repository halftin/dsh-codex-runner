// Explicit real-model acceptance; never included in offline verify.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolveCodexExe} from '../lib/executable.js';
import {runManaged} from '../lib/managed-run.js';
import {AppServerClient} from '../lib/app-server-client.js';
import {atomicJson,readJson} from '../lib/run-store.js';
import {readInteractions,answerControlMessage} from '../lib/interactions.js';
import {sendControl} from '../lib/run-control.js';
if(process.env.NODE_OPTIONS||process.env.CODEX_RUNNER_SCHEMA_OFFLINE||!process.env.CODEX_HOME)throw Error('Requires explicit CODEX_HOME and clean real-model environment');
const mode=process.argv[2]||'active';assert.ok(['active','next-turn'].includes(mode));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-async-reply-')),runId=randomUUID();
const dir=path.join(root,'.codex-runner/logs/runs',runId),record={runId,cwd:root,backend:'app-server',sessionId:randomUUID(),createdAt:new Date().toISOString()};
atomicJson(path.join(dir,'run.json'),record);
const version=execFileSync(resolveCodexExe(),['--version'],{encoding:'utf8',windowsHide:true}).trim();
const token='ANSWER_'+randomUUID().replaceAll('-',''),events=[],requests=[];
let ended=false,submission,question,continuedBeforeAnswer=false;
const prompt='Call request_user_input_async to ask exactly one question: Which marker should the final result contain? Do not substitute other tools or answer it yourself. After asking, emit commentary PROGRESS_BEFORE_ANSWER. '+
  (mode==='active'?'Then execute PowerShell Start-Sleep -Seconds 10 so the external answer can arrive during work.':'Then end this turn with WAITING_FOR_ANSWER. The answer will arrive in a later turn.')+
  ' When the user supplies the answer, respond with exactly that marker. Do not inspect or modify files, use network, or delegate.';
console.log('REAL-ASYNC '+version+' '+mode+' evidence='+root);
const completion=runManaged({cwd:root,logDir:dir,runId,prompt,model:'gpt-6.1-sol',effort:'low',sandbox:'read-only',config:{approval_policy:'never'},budgetMs:120000},opts=>{
  const client=new AppServerClient(opts),request=client.request.bind(client);
  client.request=(method,params,timeout)=>{requests.push({at:Date.now(),method,params});return request(method,params,timeout);};
  client.on('notification',(method,params)=>events.push({at:Date.now(),method,params}));return client;
}).finally(()=>{ended=true;});
try {
  while(!ended) {
    const q=readInteractions(dir,runId).interactions.find(q=>q.state==='pending');
    if(q&&!submission){
      continuedBeforeAnswer=events.some(e=>e.at>=q.receivedAt&&JSON.stringify(e.params).includes('PROGRESS_BEFORE_ANSWER'));
      const ready=mode==='active'?events.some(e=>e.method==='item/started'&&e.params.item?.type==='commandExecution'):
        readJson(path.join(dir,'result.meta.json'))?.turnState==='awaiting_async_answers';
      if(continuedBeforeAnswer&&ready){
        question=q;const response={answers:Object.fromEntries(q.params.questions.map(x=>[x.id,{answers:[token]}]))};
        submission=await sendControl(dir,record,'answer',answerControlMessage(dir,runId,q.interactionId,response,'user'));
      }
    }
    await new Promise(r=>setTimeout(r,50));
  }
  const result=await completion,interactions=readInteractions(dir,runId).interactions;
  const checks={continuedBeforeAnswer,correlatedMessage:!!requests.find(r=>JSON.stringify(r.params).includes('<send_user_message_question_reply>')),
    finalUsesAnswer:result.status==='ok'&&result.lastMessage.trim()===token,delivery:submission?.delivery};
  atomicJson(path.join(root,'acceptance.json'),{classification:'real-codex/test-answer/no-dsh',version,mode,checks,question,submission,result,interactions,requests,events});
  assert.ok(continuedBeforeAnswer);assert.ok(checks.correlatedMessage);assert.ok(checks.finalUsesAnswer,JSON.stringify(checks));
  assert.equal(submission.delivery,mode==='active'?'accepted_by_active_turn':'accepted_by_next_turn');
  assert.equal(interactions[0].requestId,null);assert.equal(interactions[0].state,'submitted');
  console.log('REAL-ASYNC-OK '+JSON.stringify(checks)+' evidence='+root);
}finally{if(!ended)atomicJson(path.join(dir,'cancel.json'),{runId});await completion;}
