import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {runManaged} from '../lib/managed-run.js';
import {AppServerClient} from '../lib/app-server-client.js';
import {InteractionStore,readInteractions,answerControlMessage} from '../lib/interactions.js';
import {atomicJson,readJson} from '../lib/run-store.js';
import {sendControl} from '../lib/run-control.js';
import {QuestionBridge} from '../lib/question-bridge.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-async-test-')),runs=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let i=0;i<200;i++){const v=fn();if(v)return v;await pause(20);}throw Error('Async fixture timeout');}
function start(mode){
  const runId=randomUUID(),dir=path.join(root,'.codex-runner/logs/runs',runId),record={runId,backend:'app-server',cwd:root,sessionId:randomUUID(),label:'async-test',createdAt:new Date().toISOString()};
  atomicJson(path.join(dir,'run.json'),record);
  const completion=runManaged({cwd:root,logDir:dir,runId,prompt:mode,model:'fixture',effort:'low',budgetMs:10000},
    opts=>new AppServerClient({...opts,executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/async-question-server.mjs',import.meta.url))]}));
  const r={runId,dir,record,completion,state:()=>readInteractions(dir,runId).interactions};runs.push(r);return r;
}
const response=q=>({answers:Object.fromEntries(q.params.questions.map(p=>[p.id,{answers:['中文 <tag> "value"\n😀']}]))});
const answer=(r,q)=>sendControl(r.dir,r.record,'answer',answerControlMessage(r.dir,r.runId,q.interactionId,response(q),'model'));
try{
  for(const mode of ['active','next','race']){
    const r=start(mode);await wait(()=>r.state().length===2);const [first,second]=r.state();
    if(mode==='next')await wait(()=>readJson(path.join(r.dir,'result.meta.json'))?.turnState==='awaiting_async_answers');
    assert.equal(first.state,'pending');assert.equal(first.requestId,null);
    const message=answerControlMessage(r.dir,r.runId,second.interactionId,response(second),'model');
    const competing=await Promise.allSettled([sendControl(r.dir,r.record,'answer',message),sendControl(r.dir,r.record,'answer',{...message,source:'user'})]);
    assert.equal(competing.filter(v=>v.status==='fulfilled').length,1);
    await answer(r,first);const result=await r.completion;assert.equal(result.status,'ok');
    const replies=JSON.parse(result.lastMessage);assert.equal(replies.length,4);
    assert.equal(replies[0].questionItemId,JSON.stringify(['request_user_input_async','second',0]));
    assert.equal(replies[2].questionItemId,JSON.stringify(['request_user_input_async','first',0]));
    assert.ok(replies.every(x=>x.answer==='中文 <tag> "value"\n😀'));
    assert.ok(r.state().every(q=>q.state==='submitted'&&q.resolution===null));
    assert.throws(()=>answerControlMessage(r.dir,r.runId,first.interactionId,response(first),'user'),/not pending/);
    console.log('PASS async '+mode+' reverse order, multi-question, competing source and exact correlation');
  }
  for(const mode of ['disconnect','next']){
    const r=start(mode);await wait(()=>r.state().length===2);
    if(mode==='next'){await wait(()=>readJson(path.join(r.dir,'result.meta.json'))?.turnState==='awaiting_async_answers');await sendControl(r.dir,r.record,'interrupt');}
    await r.completion;assert.ok(r.state().every(q=>q.state==='invalidated'));
    console.log('PASS async '+mode+' invalidation');
  }
  {
    const r=start('active');let asks=0;
    const bridge=new QuestionBridge({lookupAgent:()=>({session:{id:r.record.sessionId,header:{cwd:root}}}),ask:async({questions})=>{asks++;return {answers:questions.map(q=>({id:q.id,custom:'native user',selected:[]}))};}});
    try{bridge.track({cwd:root,record:r.record});assert.equal((await r.completion).status,'ok');assert.equal(asks,2);assert.ok(r.state().every(q=>q.source==='user'));}finally{bridge.close();}
    console.log('PASS async native question bridge');
  }
  {
    const r=start('next');await wait(()=>r.state().length===2);
    for(const q of r.state())await sendControl(r.dir,r.record,'dismiss-question',{interactionId:q.interactionId,connectionId:q.connectionId,source:'user'});
    await r.completion;assert.ok(r.state().every(q=>q.state==='cancelled'&&q.submission==='not_sent'));
    console.log('PASS async local dismissal does not send a fabricated answer');
  }
  {
    const dir=path.join(root,randomUUID()),runId=randomUUID();let writes=0;
    const store=new InteractionStore({dir,runId,identity:()=>({threadId:'t',turnId:'turn'}),deliverAsync:async()=>{writes++;throw Error('RPC timeout');}});
    const p={threadId:'t',turnId:'turn',item:{id:'i',type:'agentMessage',delivery:'async',questions:[{title:'Q?'}]}};
    store.observeNotification('item/completed',p,'c');const q=store.records[0];
    const a={interactionId:q.interactionId,connectionId:'c',response:response(q),source:'user'};
    await assert.rejects(store.answer({...a,connectionId:'wrong'}),/connection/);
    await assert.rejects(store.answer(a),/uncertain/);await assert.rejects(store.answer(a),/closed/);assert.equal(writes,1);assert.equal(q.state,'submission_unknown');
    store.observeNotification('item/completed',{...p,item:{...p.item,id:'new'}},'c');
    const restored=new InteractionStore({dir,runId,identity:()=>({})});assert.equal(restored.records[1].reason,'owner-restarted');
    store.close('test-end');console.log('PASS async uncertain delivery, wrong identity and restart never replay');
  }
  console.log('ASYNC-QUESTIONS-OK; simulated backend/host only');
}finally{for(const r of runs)atomicJson(path.join(r.dir,'cancel.json'),{runId:r.runId});await Promise.all(runs.map(r=>r.completion));}
