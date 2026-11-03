import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runManaged} from '../lib/managed-run.js';
import {AppServerClient,DEFER_SERVER_RESPONSE} from '../lib/app-server-client.js';
import {InteractionStore,readInteractions,answerControlMessage,validateQuestionResponse} from '../lib/interactions.js';
import {sendControl} from '../lib/run-control.js';
import {atomicJson,readJson} from '../lib/run-store.js';
import {QuestionBridge} from '../lib/question-bridge.js';
import {readOutput} from '../lib/output-stream.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-questions-'));
const fixture=fileURLToPath(new URL('./fixtures/question-server.mjs',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(fn){for(let i=0;i<150;i++){const result=fn();if(result)return result;await pause(20);}throw Error('Question fixture timed out');}
const response={answers:{color:{answers:['Purple','Blue']},name:{answers:['中文 name']}}};
const runs=[];
function start(mode='blocking') {
  const runId=randomUUID(),dir=path.join(root,'.codex-runner/logs/runs',runId),sessionId=randomUUID();
  const record={runId,sessionId,cwd:root,backend:'app-server',label:'q-'+runId,createdAt:new Date().toISOString()};
  atomicJson(path.join(dir,'run.json'),record);
  const completion=runManaged({cwd:root,logDir:dir,runId,prompt:mode,model:'fixture',effort:'low',budgetMs:7000},
    opts=>new AppServerClient({...opts,executable:process.execPath,args:[fixture]}));
  const state=()=>readInteractions(dir,runId).interactions;
  const r={runId,dir,record,completion,state,ready:()=>waitFor(()=>state().some(q=>q.state==='pending')&&state()),
    answer:(q,value=response,source='model')=>sendControl(dir,record,'answer',answerControlMessage(dir,runId,q.interactionId,value,source))};
  runs.push(r);return r;
}
let passed=0;
async function test(name,fn){await fn();console.log('PASS questions '+name);passed++;}
try {
  for(const mode of ['blocking','async'])await test(mode+' multi-question/free text original RPC round trip',async()=>{
    const run=start(mode),[q]=await run.ready();assert.equal(q.params.isBlocking,mode==='blocking');
    await pause(130);assert.equal(run.state()[0].state,'pending','Deprecated autoResolutionMs must not invent an expiry');
    await waitFor(()=>readJson(path.join(run.dir,'result.hb.json'))?.lastEventType==='item/agentMessage/delta');
    assert.ok(readOutput(run.dir,run.runId).events.some(event=>event.method==='item/agentMessage/delta'),'Output must be readable before the question and run finish');
    assert.throws(()=>answerControlMessage(run.dir,run.runId,q.interactionId,{answers:{}},'model'),/every question/);
    const result=await run.answer(q);assert.equal(result.delivery,'written_to_connection');assert.equal(result.accepted,false);
    const meta=await run.completion;assert.equal(meta.status,'ok');
    const replies=JSON.parse(meta.lastMessage);assert.equal(replies[0].id,41);assert.deepEqual(replies[0].result,response);
    assert.equal(run.state()[0].resolution,'server_resolved');assert.throws(()=>answerControlMessage(run.dir,run.runId,q.interactionId,response,'model'),/not pending/);
  });
  await test('multiple outstanding requests and competing model/user answers',async()=>{
    const run=start('multiple');await run.ready();const questions=await waitFor(()=>run.state().length===2&&run.state());
    const message=answerControlMessage(run.dir,run.runId,questions[0].interactionId,response,'model');
    const results=await Promise.allSettled([sendControl(run.dir,run.record,'answer',message),sendControl(run.dir,run.record,'answer',{...message,source:'user'})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    await run.answer(questions[1],{answers:{second:{answers:['second value']}}},'user');
    const replies=JSON.parse((await run.completion).lastMessage);assert.equal(replies.length,2);assert.equal(replies[1].id,'second');
  });
  for(const mode of ['resolve','disconnect'])await test(mode+' closes the request without claiming an accepted answer',async()=>{
    const run=start(mode);await run.ready();await run.completion;
    const q=run.state()[0];assert.ok(['resolved','invalidated'].includes(q.state));assert.equal(q.submission,'none');
    assert.throws(()=>answerControlMessage(run.dir,run.runId,q.interactionId,response,'user'),/not pending/);
  });
  await test('interrupt invalidates live questions',async()=>{
    const run=start();await run.ready();await sendControl(run.dir,run.record,'interrupt');
    assert.equal((await run.completion).status,'interrupted');assert.equal(run.state()[0].state,'invalidated');
  });
  await test('unsupported approvals fail explicitly and never auto-approve',async()=>{
    const run=start('approval');assert.equal((await run.completion).lastMessage,'approval denied');
    assert.equal(run.state()[0].state,'unsupported');assert.match(run.state()[0].reason,/Unsupported interactive/);
  });
  await test('native user bridge ignores switches and replies over original connection',async()=>{
    const run=start();let asks=0;
    const bridge=new QuestionBridge({lookupAgent:()=>({session:{id:run.record.sessionId,header:{cwd:root}}}),ask:async request=>{
      asks++;assert.equal(request.questions.length,2);return {answers:[{id:'color',selected:['Blue']},{id:'name',selected:[],custom:'user name'}]};
    }});
    try {bridge.track({cwd:root,record:run.record});assert.equal((await run.completion).status,'ok');assert.equal(asks,1);assert.equal(run.state()[0].source,'user');}
    finally {bridge.close();}
  });
  await test('native user cancellation closes the original RPC with an error',async()=>{
    const run=start(),bridge=new QuestionBridge({lookupAgent:()=>({session:{id:run.record.sessionId,header:{cwd:root}}}),ask:async()=>{throw Object.assign(Error('cancelled'),{code:'ASK_CANCELLED'});}});
    try {bridge.track({cwd:root,record:run.record});const meta=await run.completion;assert.equal(JSON.parse(meta.lastMessage)[0].error.code,-32800);}
    finally {bridge.close();}
  });
  await test('restart invalidation, wrong identity and uncertain write cannot resend',async()=>{
    const runId=randomUUID(),dir=path.join(root,runId),identity=()=>({threadId:'t',turnId:'turn'});
    const store=new InteractionStore({dir,runId,identity}),abort=new AbortController();let writes=0;
    const context={id:7,connectionId:randomUUID(),signal:abort.signal,invalidate:reason=>abort.abort(Error(reason)),respond:async()=>{writes++;throw Error('pipe broke');}};
    const params={threadId:'t',turnId:'turn',itemId:'i',isBlocking:false,questions:[{id:'q',header:'Q',question:'Q?'}]};
    assert.equal(store.request('item/tool/requestUserInput',params,context),DEFER_SERVER_RESPONSE);
    const q=readJson(path.join(dir,'interactions.json')).interactions[0],answer={interactionId:q.interactionId,connectionId:q.connectionId,response:{answers:{q:{answers:['x']}}},source:'model'};
    await assert.rejects(store.answer({...answer,connectionId:randomUUID()}),/connection/);
    await assert.rejects(store.answer(answer),/uncertain/);await assert.rejects(store.answer(answer),/closed/);assert.equal(writes,1);
    assert.equal(readJson(path.join(dir,'interactions.json')).interactions[0].state,'submission_unknown');
    store.request('item/tool/requestUserInput',params,{...context,id:'new',signal:new AbortController().signal});
    const restarted=new InteractionStore({dir,runId,identity});restarted.persist();
    assert.equal(readJson(path.join(dir,'interactions.json')).interactions[1].reason,'owner-restarted');
    assert.throws(()=>validateQuestionResponse(params,{answers:{q:{answers:[]}}}));store.close('test-end');
  });
  await test('request already resolved before its deferred handler never becomes pending',async()=>{
    const runId=randomUUID(),dir=path.join(root,runId),abort=new AbortController();abort.abort(Error('Server request resolved'));
    const store=new InteractionStore({dir,runId,identity:()=>({threadId:'t',turnId:'turn'})});
    store.request('item/tool/requestUserInput',{threadId:'t',turnId:'turn',itemId:'i',isBlocking:false,questions:[{id:'q',header:'Q',question:'Q?'}]},
      {id:1,connectionId:randomUUID(),signal:abort.signal});
    assert.equal(store.pending.size,0);assert.equal(readJson(path.join(dir,'interactions.json')).interactions[0].state,'invalidated');
  });
  await test('native async message questions are preserved without inventing an RPC response',async()=>{
    const runId=randomUUID(),dir=path.join(root,runId),store=new InteractionStore({dir,runId,identity:()=>({})});
    const params={threadId:'t',turnId:'turn',item:{id:'async',type:'agentMessage',text:'Choose?',questions:[{title:'Choose?',options:['A','B']}]}};
    store.observeNotification('item/started',params,'connection');store.observeNotification('item/completed',params,'connection');
    const records=readJson(path.join(dir,'interactions.json')).interactions;
    assert.equal(records.length,1);assert.equal(records[0].requestId,null);assert.equal(records[0].state,'unsupported');assert.deepEqual(records[0].rawParams,params);
  });
  console.log('QUESTIONS-OK '+passed+'; simulated Codex and native-answerer doubles, not model/phone acceptance');
} finally {
  for(const run of runs)atomicJson(path.join(run.dir,'cancel.json'),{runId:run.runId});
  await Promise.all(runs.map(run=>run.completion));
  assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});
}
