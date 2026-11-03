// Explicit live acceptance: one real Codex model turn per selected mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runManaged} from '../lib/managed-run.js';
import {AppServerClient} from '../lib/app-server-client.js';
import {diagnoseCodex} from '../lib/executable.js';
import {getCatalog} from '../lib/model-catalog.js';
import {atomicJson} from '../lib/run-store.js';
import {readInteractions,answerControlMessage} from '../lib/interactions.js';
import {sendControl} from '../lib/run-control.js';

if(process.env.CODEX_RUNNER_SCHEMA_OFFLINE==='1'||/fake-catalog-cli/.test(process.env.NODE_OPTIONS||''))throw Error('Live questions refuse offline fixtures');
const mode=process.argv[2]||'blocking';if(!['blocking','async','nonblocking'].includes(mode))throw Error('Use blocking, async or nonblocking');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-live-questions-'));process.env.DSH_HOME=path.join(root,'host');
const report=await diagnoseCodex();assert.ok(report.authenticated&&report.app_server);
const catalog=await getCatalog({refresh:true});assert.equal(catalog.source,'app-server');assert.equal(catalog.stale,false);
const model=catalog.models.find(m=>m.isDefault&&!m.hidden)||catalog.models.find(m=>!m.hidden);
const effort=model.efforts.some(e=>e.id==='low')?'low':model.defaultReasoningEffort||model.efforts[0].id;
const runId=randomUUID(),dir=path.join(root,'.codex-runner/logs/runs',runId),record={runId,cwd:root,backend:'app-server',sessionId:randomUUID(),label:'live-questions',createdAt:new Date().toISOString()};
atomicJson(path.join(dir,'run.json'),record);
const token='ANSWER_'+randomUUID().replaceAll('-',''),events=[],serverRequests=[];
const prompt=mode==='nonblocking'
  ? 'This is an exact protocol test. Call request_user_input, NOT request_user_input_async, to ask one structured question: what marker should the final result contain? Include Alpha and Beta and allow free text. If the tool allows you to continue before its answer arrives, emit commentary containing PROGRESS_BEFORE_ANSWER and run PowerShell Start-Sleep -Seconds 10. Do not answer your own question. After the actual user response arrives, reply exactly with its marker. Do not inspect or modify files, use network, or delegate.'
  :mode==='blocking'
  ? 'This is a structured question integration test. Use request_user_input to ask one short question: what marker should the final result contain? Include two choices, Alpha and Beta, and allow a free text answer. Do not answer your own question or ask in plain text. After the user response arrives, reply exactly with the marker from that response. Do not read files or call any other tools.'
  : 'This is an asynchronous question integration test. Use request_user_input_async to ask one short question: what marker should the final result contain? Do not answer your own question or ask in plain text. After submitting the question, continue with a short progress message and a harmless shell wait of 10 seconds. After the user response arrives, reply exactly with the marker from that response. Do not inspect or modify files, access network, or perform other work.';
console.log('Starting real '+mode+' question test; Codex '+report.version+'; '+model.id+'/'+effort+'; evidence='+root);
let ended=false,submission,submittedQuestion,unsupportedAt,continuedBeforeAnswer=false;
// This flag exists in the live experimentalFeature/list catalog. A per-thread
// acceptance override does not change the user's config or product defaults.
const config={approval_policy:'never',...(mode==='nonblocking'?{'features.default_mode_request_user_input':true}:{})};
const completion=runManaged({cwd:root,logDir:dir,runId,prompt,model:model.id,effort,sandbox:'read-only',config,budgetMs:120000},opts=>{
  const client=new AppServerClient(opts);
  if(process.env.DSH_ACCEPT_RAW_ITEMS==='1'){
    const request=client.request.bind(client);
    client.request=(method,params,timeout)=>request(method,method==='thread/start'?{...params,experimentalRawEvents:true}:params,timeout);
  }
  const defer=client.deferRequest.bind(client);
  client.deferRequest=message=>{serverRequests.push(message);return defer(message);};
  // Codex 0.160.1 exposes blocking request_user_input only in Plan mode.
  // collaborationMode is present in its --experimental TurnStartParams export;
  // this is an explicit acceptance fixture override, not a new plugin setting.
  if(mode==='blocking') {
    const request=client.request.bind(client);
    client.request=(method,params,timeout)=>request(method,method==='turn/start'?{...params,collaborationMode:{mode:'plan',settings:{model:model.id,reasoning_effort:effort}}}:params,timeout);
  }
  client.on('notification',(method,params)=>events.push({time:Date.now(),method,turnId:params.turnId||params.turn?.id||null,
    ...(/^(item\/|serverRequest\/|rawResponseItem\/)/.test(method)?{params}:{})}));return client;
}).finally(()=>{ended=true;});
try {
  while(!ended) {
    const current=readInteractions(dir,runId).interactions;
    if(current.some(item=>item.kind==='async-message'&&item.state==='unsupported')){
      unsupportedAt??=Date.now();
      if(Date.now()-unsupportedAt>5000)atomicJson(path.join(dir,'cancel.json'),{runId});
    }
    const q=current.find(item=>item.state==='pending');
    if(q&&!submission) {
      if(mode==='nonblocking'){
        continuedBeforeAnswer=events.some(e=>e.time>=q.receivedAt&&JSON.stringify(e.params||{}).includes('PROGRESS_BEFORE_ANSWER'));
        if(!continuedBeforeAnswer&&Date.now()-q.receivedAt<8000){await new Promise(resolve=>setTimeout(resolve,50));continue;}
      }
      submittedQuestion=q;
      const response={answers:Object.fromEntries(q.params.questions.map(question=>[question.id,{answers:[token]}]))};
      submission=await sendControl(dir,record,'answer',answerControlMessage(dir,runId,q.interactionId,response,'user'));
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const result=await completion,interactions=readInteractions(dir,runId).interactions;
  const evidence={classification:'real-codex-model/manual-test-answer',mode,collaborationMode:mode==='blocking'?'plan':'default',configOverrides:config,codexVersion:report.version,model:model.id,effort,runId,continuedBeforeAnswer,
    checks:{originalResponseSubmitted:!!submission,finalUsesAnswer:result.status==='ok'&&result.lastMessage.trim()===token,continuedBeforeAnswer,observationWindowMs:mode==='nonblocking'?8000:null},
    events,serverRequests,interactions,submission,result};
  atomicJson(path.join(root,'acceptance.json'),evidence);
  assert.ok(submission,'The real model did not emit a supported structured request; this mode is NOT accepted');
  assert.equal(submittedQuestion.params.isBlocking,mode==='blocking','Requested mode must match the native protocol');
  if(mode==='nonblocking')assert.equal(continuedBeforeAnswer,true,'Codex must continue emitting progress before the original answer is submitted');
  assert.equal(result.status,'ok',result.error||result.status);
  assert.equal(result.lastMessage.trim(),token,'Final result must demonstrate the submitted answer was used');
  console.log('LIVE-QUESTIONS-OK '+mode+'; original RPC response used by actual model; evidence='+root);
} finally {
  if(!ended)atomicJson(path.join(dir,'cancel.json'),{runId});await completion;
}
