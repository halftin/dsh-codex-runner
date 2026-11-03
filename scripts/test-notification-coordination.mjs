import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ActiveSupervisor} from '../lib/active-supervisor.js';
import {RunNotifier} from '../lib/run-notifier.js';
import {OutputWriter} from '../lib/output-stream.js';
import {atomicJson,readJson} from '../lib/run-store.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-notice-coordination-'));
function fixture(){
  const cwd=fs.mkdtempSync(path.join(root,'case-')),runId=randomUUID(),sessionId=randomUUID();
  const record={runId,sessionId,cwd,backend:'app-server',createdAt:new Date().toISOString(),detached:true};
  const dir=path.join(cwd,'.codex-runner/logs/runs',runId),file=name=>path.join(dir,name);
  const writer=new OutputWriter({dir,runId,backend:'app-server'});
  atomicJson(file('run.json'),record);atomicJson(file('result.meta.json'),{runId,driverPid:process.pid,turnId:'turn'});
  const messages=[],inbox={nextStep:[],nextTurn:[],remove(id){const i=this.nextStep.findIndex(m=>m.id===id);if(i<0)return false;this.nextStep.splice(i,1);return true;}};
  const agent={session:{header:{cwd}},status:'running',inbox,steer(m){messages.push(m);inbox.nextStep.push(m);},followup(m){this.steer(m);}};
  const supervisor=new ActiveSupervisor({lookupAgent:()=>agent,createMessage:(text,source)=>({id:randomUUID(),text,source}),settings:()=>({supervisionEnabled:true}),batchMs:0,decisionMs:0});
  supervisor.track({cwd,record});
  const calls=[],entries=[],schedule={async list(){return entries;},async create(sessionId,request){const entry={id:randomUUID(),sessionId,...request};calls.push(entry);entries.push(entry);return entry;}};
  const notifier=new RunNotifier({home:path.join(cwd,'host'),schedule,prepareNotice:(id,notice)=>supervisor.prepareNotice(id,notice)});
  const send=(target=notifier,kind='reply')=>target.deliver({record,dir,file,cancelled:()=>false,payload:{turn_id:'turn',answer_preview:'reply'},kind});
  const emit=()=>{writer.append('item/completed',{item:{type:'agentMessage',text:'progress'}});supervisor.check();};
  const consume=()=>{const m=messages.at(-1);inbox.remove(m.id);supervisor.observeRequest([m]);};
  const end=()=>atomicJson(file('result.meta.json'),{runId,status:'ok',turnId:'turn',lastMessage:'reply',killVerified:true,end:new Date().toISOString()});
  return {record,supervisor,notifier,writer,messages,inbox,calls,schedule,file,send,emit,consume,end,
    get run(){return supervisor.runs.get(runId);},async close(){supervisor.close();await notifier.close();}};
}
try{
  for(const consumption of ['queued','provider','unknown']){
    const f=fixture();try{
      f.emit();assert.equal(f.messages.length,1);
      if(consumption==='provider')f.consume();
      if(consumption==='unknown')f.inbox.remove(f.messages[0].id);
      f.end();await f.send();await f.send();
      assert.equal(f.calls.length,1);assert.equal(f.inbox.nextStep.length,0);
      const data=JSON.parse(f.calls[0].prompt.split('\n').at(-1));
      assert.equal(data.delivery_context.semantic_handling_confirmed,false);
      assert.equal(data.delivery_context.previous_input,{queued:'withdrawn',provider:'provider_request_started',unknown:'delivery_unknown'}[consumption]);
      assert.equal(data.delivery_context.model_output_cursor,consumption==='provider'?1:0);
      const restarted=new RunNotifier({home:path.join(f.record.cwd,'host'),schedule:f.schedule});
      try{await f.send(restarted);assert.equal(f.calls.length,1);}finally{await restarted.close();}
    }finally{await f.close();}
  }
  const f=fixture();try{
    atomicJson(f.file('interactions.json'),{runId:f.record.runId,interactions:[{interactionId:'question',state:'pending',method:'item/tool/requestUserInput',params:{questions:[]}}]});
    f.supervisor.check();assert.equal(f.messages.length,1);
    await f.send();assert.equal(f.calls.length,0,'normal turn notice waits for pending question input');
    assert.equal(readJson(f.file('interactions.json')).interactions[0].state,'pending');
    assert.equal(f.run.noticeWaiting,true);
    f.consume();f.emit();assert.equal(f.messages.length,1,'waiting notice takes priority over new progress');
    const create=f.schedule.create;f.schedule.create=async(...args)=>{f.emit();assert.equal(f.messages.length,1,'no parallel batch during asynchronous schedule RPC');return create(...args);};
    await f.send();assert.equal(f.calls.length,1);assert.equal(f.run.noticeWaiting,false);
    f.supervisor.check();assert.equal(f.messages.length,2,'progress resumes after notice delivery');
  }finally{await f.close();}
  const urgent=fixture();try{
    urgent.emit();await urgent.send(urgent.notifier,'failure');
    assert.equal(urgent.calls.length,1,'health/failure notices cannot wait indefinitely on an unconsumed input');
    assert.equal(urgent.inbox.nextStep.length,1,'a live run does not invalidate questions solely because of a health notice');
    assert.equal(urgent.run.noticeWaiting,false);
  }finally{await urgent.close();}
  const g=fixture();try{
    g.schedule.create=async()=>{throw Error('uncertain RPC');};await g.send();assert.equal(g.run.noticeWaiting,false);
    assert.ok(readJson(g.file('notify-intent.json')));await g.send();assert.equal(g.calls.length,0,'unknown delivery never replayed');
    g.emit();assert.equal(g.messages.length,1,'failed notification cannot permanently lock supervision');
  }finally{await g.close();}
  console.log('NOTIFICATION-COORDINATION-OK terminal withdrawal, consumed/unknown inputs, normal-turn questions, priority, async RPC, restart and uncertain delivery');
}finally{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
