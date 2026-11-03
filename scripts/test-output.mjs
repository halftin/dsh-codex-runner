import './offline-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {OutputWriter,readOutput,readOutputResource} from '../lib/output-stream.js';
import {createOutputView} from '../lib/output-view.js';
import {atomicJson} from '../lib/run-store.js';
import {isFinalAnswerItem} from '../lib/run-data.js';

let definition;globalThis.window={__ModuleLoader__:{load:value=>{definition=value;}}};await import('../lib/client.js');
const {streamRows}=definition.factory(()=>({}));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-output-')),runId=randomUUID(),sessionId=randomUUID(),callId='call_exact';
const dir=path.join(root,'.codex-runner/logs/runs',runId),writer=new OutputWriter({dir,runId,backend:'app-server'});
atomicJson(path.join(dir,'run.json'),{runId,sessionId,callId,backend:'app-server',label:'output',createdAt:new Date().toISOString()});
try {
  writer.append('item/started',{threadId:'t',turnId:'turn',item:{id:'m',type:'agentMessage',text:''}});
  writer.append('item/agentMessage/delta',{threadId:'t',turnId:'turn',itemId:'m',delta:'中文'});
  const first=readOutput(dir,runId);assert.equal(first.events.length,2);assert.equal(first.next_cursor,2);
  assert.equal(streamRows(first.events)[0].text,'中文');
  writer.append('item/agentMessage/delta',{threadId:'t',turnId:'turn',itemId:'m',delta:' output'});
  writer.append('item/completed',{threadId:'t',turnId:'turn',item:{id:'m',type:'agentMessage',text:'中文 output',phase:'final_answer'}});
  const next=readOutput(dir,runId,{after:2}),projected=streamRows(next.events,streamRows(first.events));
  assert.equal(projected.length,1);assert.equal(projected[0].text,'中文 output');assert.equal(projected[0].complete,true);
  assert.deepEqual(readOutput(dir,runId,{after:4}).events,[]);assert.throws(()=>readOutput(dir,runId,{after:5}));
  const raw={item:{id:'large',type:'unrecognized_resource',text:'中文🧪'.repeat(30000),resource:{url:'https://example.invalid/media',mimeType:'audio/example'}}};
  writer.append('item/completed',raw);const large=readOutput(dir,runId,{after:4}).events[0];assert.equal(large.payload.complete,true);assert.equal(large.payload.previewTruncated,true);
  let offset=0;const chunks=[];for(;;){const part=readOutputResource(dir,runId,{sequence:5,offset,limit:32767});chunks.push(Buffer.from(part.data,'base64'));offset=part.next_offset;if(!part.has_more)break;}
  const bytes=Buffer.concat(chunks);assert.deepEqual(JSON.parse(bytes.toString()),raw);assert.equal(createHash('sha256').update(bytes).digest('hex'),large.payload.sha256);
  const restored=new OutputWriter({dir,runId,backend:'app-server'});restored.append('unknown',{future:['preserved']});assert.equal(readOutput(dir,runId,{after:5}).events[0].sequence,6);
  let enabled=true;const view=createOutputView({lookupSession:id=>id===sessionId?{header:{cwd:root}}:null,settings:()=>({streamOutputEnabled:enabled})});
  assert.equal(view.read({sessionId,callId}).events.length,6);enabled=false;assert.equal(view.read({sessionId,callId}).status,'disabled');assert.throws(()=>view.resource({sessionId,callId,sequence:5}),/disabled/);
  assert.equal(readOutput(dir,runId).events.length,6,'Display setting must not delete capture or model access');
  assert.throws(()=>view.read({sessionId,callId,after:-1}),/cursor/,'Disabled display still validates the cursor');
  assert.throws(()=>view.read({sessionId:randomUUID(),callId}));assert.throws(()=>view.read({sessionId,callId:'wrong'}));
  assert.equal(isFinalAnswerItem({type:'agentMessage',phase:'final_answer',delivery:'async',questions:[{title:'Q'}]}),false);
  // A concurrently appended, not-yet-indexed tail cannot leak or break a reader.
  fs.appendFileSync(path.join(dir,'output.jsonl'),'partial');assert.equal(readOutput(dir,runId).events.length,6);
  assert.throws(()=>new OutputWriter({dir,runId,backend:'app-server'}),/tail/);
  assert.throws(()=>readOutput(dir,randomUUID()),/mismatch/);
  console.log('OUTPUT-OK ordering, live delta/snapshot replacement, resource integrity, restart, partial tail, scoped display and independent capture');
} finally {assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
