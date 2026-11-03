import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ActiveSupervisor} from '../lib/active-supervisor.js';
import {OutputWriter} from '../lib/output-stream.js';
import {atomicJson} from '../lib/run-store.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-supervisor-'));
let clock=100000,enabled=true,supervisor;
const sessionId=randomUUID(),delivered=[];
const inbox={nextTurn:[],nextStep:[],remove(id){for(const key of ['nextTurn','nextStep']){const i=this[key].findIndex(m=>m.id===id);if(i>=0){this[key].splice(i,1);return true;}}return false;}};
const agent={session:{id:sessionId,header:{cwd:root}},status:'running',inbox,
  steer(m){inbox.nextStep.push(m);delivered.push(m);},followup(m){inbox.nextTurn.push(m);delivered.push(m);}};
const create=()=>new ActiveSupervisor({lookupAgent:id=>id===sessionId?agent:null,createMessage:(text,source)=>({id:randomUUID(),text,source}),settings:()=>({supervisionEnabled:enabled}),now:()=>clock});
function run(backend='app-server'){
  const record={runId:randomUUID(),sessionId,backend,label:'supervision',createdAt:new Date().toISOString()};
  const dir=path.join(root,'.codex-runner/logs/runs',record.runId),writer=new OutputWriter({dir,runId:record.runId,backend});
  atomicJson(path.join(dir,'run.json'),record);atomicJson(path.join(dir,'result.meta.json'),{runId:record.runId,driverPid:process.pid});
  supervisor.track({cwd:root,record});return {record,dir,writer,get state(){return supervisor.runs.get(record.runId).state;}};
}
function consume(r){const m=delivered.at(-1);assert.ok(inbox.remove(m.id));supervisor.observeSessionEvent(sessionId,{type:'user/message',data:m});assert.equal(r.state.pending.state,'context_admitted');supervisor.observeRequest([m]);return m;}
try{
  supervisor=create();const first=run();
  first.writer.append('thread/started',{thread:{id:'native'}});supervisor.check();assert.equal(first.state.readCursor,1);assert.equal(first.state.modelCursor,0);assert.equal(delivered.length,0);
  first.writer.append('item/completed',{item:{type:'agentMessage',text:'progress'}});supervisor.check();assert.equal(delivered.length,0);
  clock+=1500;supervisor.check();assert.equal(delivered.length,1);assert.equal(first.state.modelCursor,0);assert.equal(first.state.pending.state,'queued');
  supervisor.check();assert.equal(delivered.length,1);consume(first);assert.equal(first.state.modelCursor,2);assert.equal(first.state.pending,null);
  for(let i=0;i<10;i++){clock+=5000;supervisor.check();}assert.equal(delivered.length,1,'No new output must not cause another model decision');
  first.writer.append('item/completed',{item:{type:'agentMessage',text:'next'}});supervisor.check();assert.equal(delivered.length,1);clock+=1500;supervisor.check();assert.equal(delivered.length,2);
  enabled=false;supervisor.check();assert.equal(first.state.lastDelivery.state,'withdrawn');assert.equal(first.state.modelCursor,2);assert.equal(inbox.nextStep.length,0);
  enabled=true;clock+=5000;supervisor.check();assert.equal(delivered.length,3);consume(first);assert.equal(first.state.modelCursor,3);
  // Question bypasses batching/decision delay; it remains distinct from output.
  const q={interactionId:randomUUID(),state:'pending',method:'item/tool/requestUserInput',params:{questions:[{id:'q',question:'Need a choice',header:'Choice',options:null}]}};
  atomicJson(path.join(first.dir,'interactions.json'),{runId:first.record.runId,interactions:[q]});supervisor.check();assert.equal(delivered.length,4);assert.ok(delivered.at(-1).text.includes(q.interactionId));consume(first);supervisor.check();assert.equal(delivered.length,4);
  first.writer.append('error',{message:'action needed'});supervisor.check();assert.equal(delivered.length,5);consume(first);
  // Commands below the preview budget must retain their complete output; larger
  // outputs retain both ends and explicitly advertise truncation on both backends.
  for(const type of ['commandExecution','command_execution'])for(const length of [0,320,321,400,520,521]) {
    const output='中'.repeat(Math.max(0,length-1))+(length?'!':'');
    const before=delivered.length;
    first.writer.append(type==='commandExecution'?'item/completed':'item.completed',
      {item:{type,command:'echo test',aggregatedOutput:output,exitCode:0}});
    clock+=5000;supervisor.check();assert.equal(delivered.length,before+1);
    const summary=JSON.parse(delivered.at(-1).text.split('\n').at(-1)).events[0];
    assert.equal(summary.outputBytes,Buffer.byteLength(output));
    assert.equal(summary.truncated,length>520);
    assert.equal(summary.outputPreview,length>520?output.slice(0,320)+'\n…\n'+output.slice(-200):output);
    consume(first);
  }
  const other=run('exec');other.writer.append('item.completed',{item:{text:'exec progress'}});clock+=5000;agent.status='idle';supervisor.check();assert.equal(inbox.nextTurn.length,1);assert.equal(other.state.modelCursor,0);consume(other);assert.equal(other.state.modelCursor,1);
  first.writer.append('item/completed',{item:{text:'large'.repeat(40000)}});clock+=5000;supervisor.check();assert.ok(Buffer.byteLength(delivered.at(-1).text)<50000);assert.ok(delivered.at(-1).text.includes('resource_directory'));consume(first);
  // A consumed but unobserved input is uncertain; disabling cannot resend it.
  first.writer.append('error',{message:'uncertain'});supervisor.check();inbox.remove(delivered.at(-1).id);enabled=false;supervisor.check();assert.equal(first.state.pending.state,'delivery_unknown');enabled=true;const count=delivered.length;clock+=5000;supervisor.check();assert.equal(delivered.length,count);
  supervisor.close();supervisor=create();supervisor.track({cwd:root,record:first.record});assert.match(first.state.error,/replay is disabled/);supervisor.check();assert.equal(delivered.length,count,'Restart must not replay uncertain input');
  atomicJson(path.join(first.dir,'result.meta.json'),{runId:first.record.runId,status:'ok'});supervisor.check();assert.equal(first.state.status,'terminal');
  const foreign=run();agent.session.header.cwd=path.join(root,'different');foreign.writer.append('error',{message:'wrong workspace'});supervisor.check();assert.equal(foreign.state.status,'host-unavailable');assert.equal(delivered.length,count);agent.session.header.cwd=root;
  console.log('SUPERVISOR-OK batching, real request cursor, no repeated decisions, priority, both inbox states, bounded resources, disable, uncertainty, restart and workspace binding');
}finally{supervisor?.close();assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
