import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ActiveSupervisor} from '../lib/active-supervisor.js';
import {OutputWriter} from '../lib/output-stream.js';
import {atomicJson} from '../lib/run-store.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-question-notices-'));
const sessionId=randomUUID(),messages=[],inbox={nextStep:[],nextTurn:[],remove(id){for(const list of [this.nextStep,this.nextTurn]){const i=list.findIndex(m=>m.id===id);if(i>=0){list.splice(i,1);return true;}}return false;}};
const agent={status:'idle',session:{id:sessionId,header:{cwd:root}},inbox,steer:m=>{inbox.nextStep.push(m);messages.push(m);},followup:m=>{inbox.nextTurn.push(m);messages.push(m);}};
let settings={supervisionEnabled:false,autoAnswerQuestions:true},now=100000;
const supervisor=new ActiveSupervisor({lookupAgent:()=>agent,createMessage:(text,source)=>({id:randomUUID(),text,source}),settings:()=>settings,now:()=>now});
function run(){const record={runId:randomUUID(),sessionId,backend:'app-server'},dir=path.join(root,'.codex-runner/logs/runs',record.runId);
 atomicJson(path.join(dir,'result.meta.json'),{runId:record.runId,driverPid:process.pid});supervisor.track({cwd:root,record});
 const writer=new OutputWriter({dir,runId:record.runId,backend:'app-server'});
 const questions=[{interactionId:randomUUID(),kind:'async-message',state:'pending',params:{questions:[{id:'q',question:'Choose?'}]}}];
 const save=()=>atomicJson(path.join(dir,'interactions.json'),{runId:record.runId,interactions:questions});
 return {record,dir,writer,questions,save,get state(){return supervisor.runs.get(record.runId).state;}};
}
try{
 const r=run();for(let i=0;i<80;i++)r.writer.append('item/agentMessage/delta',{delta:'ordinary progress'});
 now+=100000;supervisor.check();assert.equal(messages.length,0);assert.equal(r.state.modelCursor,0);
 r.save();supervisor.check();assert.equal(messages.length,1);assert.equal(messages[0].source.kind,'codex-runner-questions');
 const payload=JSON.parse(messages[0].text.split('\n').slice(1).join('\n'));assert.deepEqual(payload.events,[]);assert.equal(payload.questions.length,1);
 supervisor.check();assert.equal(messages.length,1);
 inbox.remove(messages[0].id);supervisor.observeRequest([messages[0]]);assert.equal(r.state.modelCursor,0);assert.equal(r.state.questionsRead.length,1);
 supervisor.check();assert.equal(messages.length,1);
 settings.supervisionEnabled=true;now+=100000;
 for(let i=0;i<3;i++)supervisor.check();
 assert.equal(messages.length,1,'Raw deltas must not wake supervision after a mode change');
 assert.equal(r.state.readCursor,80);assert.equal(r.state.modelCursor,0);
 r.writer.append('item/completed',{item:{type:'agentMessage',text:'ordinary progress'}});
 now+=5000;supervisor.check();assert.equal(messages.length,2);
 const progress=JSON.parse(messages[1].text.split('\n').at(-1));
 assert.equal(progress.questions.length,0,'Mode change must not repeat the same question');
 assert.equal(progress.events[0].text,'ordinary progress');
 settings.supervisionEnabled=false;supervisor.check();assert.equal(inbox.nextTurn.length,0);
 settings.autoAnswerQuestions=false;
 const off=run();off.save();supervisor.check();assert.equal(messages.length,2);
 settings.autoAnswerQuestions=true;supervisor.check();assert.equal(messages.length,3);
 // Interruption arrives while the question notification is still in the inbox.
 off.questions[0].state='invalidated';off.save();supervisor.check();assert.equal(inbox.nextTurn.length,0);assert.equal(off.state.lastDelivery.reason,'questions-closed');
 atomicJson(path.join(off.dir,'result.meta.json'),{runId:off.record.runId,status:'interrupted'});supervisor.check();assert.equal(off.state.status,'terminal');assert.equal(messages.length,3);
 // Terminal status takes precedence even when the interaction file is stale.
 const simultaneous=run();simultaneous.save();atomicJson(path.join(simultaneous.dir,'result.meta.json'),{runId:simultaneous.record.runId,status:'interrupted'});
 supervisor.check();assert.equal(messages.length,3);assert.equal(simultaneous.state.status,'terminal');
 // If already consumed, retain uncertainty and never replay into the ended run.
 const consumed=run();consumed.save();supervisor.check();assert.equal(messages.length,4);inbox.remove(messages[3].id);
 atomicJson(path.join(consumed.dir,'result.meta.json'),{runId:consumed.record.runId,status:'interrupted'});supervisor.check();
 assert.equal(consumed.state.pending.state,'delivery_unknown');assert.equal(consumed.state.status,'terminal');supervisor.check();assert.equal(messages.length,4);
 console.log('QUESTION-NOTIFICATIONS-OK no progress reads, on-demand wake, configuration, dedup and interruption precedence/withdrawal/uncertainty');
}finally{supervisor.close();}
