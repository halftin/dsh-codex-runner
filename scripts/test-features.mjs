import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectWithEvidence } from '../lib/selection.js';
import { historyTools } from '../lib/history.js';
import { reserveRun, atomicJson, runDirectory, updateRecord } from '../lib/run-store.js';
import { buildToolDefinition, LOGS_REL } from '../lib/core.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-features-'));
fs.writeFileSync(path.join(root,'task.txt'),'task');fs.writeFileSync(path.join(root,'plan.md'),'Reviewed deterministic plan');
const evidence={files:['task.txt'],plan_file:'plan.md',acceptance:'Check expected output',uncertainty:'low'};
let pass=0;async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
await test('mechanical task uses verified plan; architecture escalates deterministically',()=>{
  const low=selectWithEvidence(root,evidence,'mechanical');assert.equal(low.model,'gpt-6-luna');assert.equal(low.effort,'low');assert.equal(low.facts.plan.sha256.length,64);
  const high=selectWithEvidence(root,{...evidence,architecture_decision:true},'mechanical');assert.equal(high.model,'gpt-6-astra');assert.equal(high.effort,'xhigh');
});
await test('unknown scope investigates; environment failure does not escalate',()=>{
  assert.equal(selectWithEvidence(root,{...evidence,files:[]},'implement').stage,'investigation');
  assert.equal(selectWithEvidence(root,{...evidence,failure_reason:'environment'},'rework').model,'gpt-6.1-sol');
});
await test('fictional paths, outside paths and malformed claims rejected',()=>{
  assert.throws(()=>selectWithEvidence(root,{...evidence,files:['missing']},'docs'));
  const outside=path.join(path.dirname(root),'outside-'+path.basename(root)+'.txt');fs.writeFileSync(outside,'outside');
  assert.throws(()=>selectWithEvidence(root,{...evidence,files:[outside]},'docs'),/inside this workspace/);
  assert.throws(()=>selectWithEvidence(root,{...evidence,security_risk:'false'},'docs'),/boolean/);
});
await test('enforced evidence overrides require reasons; off/audit do not; manual omissions reject',async()=>{
  const opts={defineTool:d=>d,resolveCwd:()=>root};
  const r=await buildToolDefinition({...opts,config:{autoModelAndEffort:true,selectionMode:'evidence',selectionPolicy:JSON.stringify({mode:'enforce'})}}).execute({label:'evidence',prompt_file:'task.txt',model:'gpt-6-luna',evidence},{});
  assert.equal(r.status,'error');assert.match(r.summary_text,/override_reason/);
  for(const mode of ['off','audit']){
    const result=await buildToolDefinition({...opts,config:{autoModelAndEffort:true,selectionMode:'evidence',selectionPolicy:JSON.stringify({mode})}})
      .execute({label:'evidence-'+mode,prompt_file:'missing.md',model:'gpt-6-luna',effort:'low',evidence},{});
    assert.match(result.summary_text,/提示词文件不存在/);
  }
  assert.equal((await buildToolDefinition({...opts,config:{autoModelAndEffort:true,selectionMode:'manual'}}).execute({label:'manual',prompt_file:'task.txt'},{})).status,'error');
});
const logs=path.join(root,LOGS_REL),record=reserveRun(logs,'history'),dir=runDirectory(logs,record);
updateRecord(logs,record,{cwd:root});atomicJson(path.join(dir,'result.meta.json'),{status:'ok',threadId:'fixture-thread',turnId:'turn-1',backend:'app-server',lastMessage:'legacy answer'});
fs.writeFileSync(path.join(dir,'answer.txt'),'中文🙂完整答复');fs.writeFileSync(path.join(dir,'events.jsonl'),'one\ntwo\n');
let serverCwd=root,calls=[];
const definitions=historyTools({defineTool:d=>d,resolveCwd:()=>root,connect:async fn=>fn({request:async(method,params)=>{
  calls.push(method);if(method==='thread/read')return {thread:{cwd:serverCwd}};
  assert.equal(params.itemsView,'full');return {data:[{id:'turn-1',items:[{type:'agentMessage',text:'中文🙂完整答复'}]}],nextCursor:'cursor-next'};
}})});
const tools=Object.fromEntries(definitions.map(t=>[t.name,t]));
await test('workspace listing and full answer character pagination',async()=>{
  const listing=await tools.codex_sessions.execute({},{});assert.equal(listing.sessions.length,1);
  let text='',offset=0;do{const r=await tools.codex_read.execute({run_id:record.runId,limit:3,offset},{});assert.equal(r.status,'ok');text+=r.text;offset=r.next_offset;}while(offset!==null);
  assert.equal(text,'中文🙂完整答复');
});
await test('turn pages do not resume model; native workspace mismatch rejected',async()=>{
  calls=[];const r=await tools.codex_read.execute({run_id:record.runId,source:'turns'},{});assert.equal(r.status,'ok');assert.equal(r.next_cursor,'cursor-next');assert.deepEqual(calls,['thread/read','thread/turns/list']);
  serverCwd=path.dirname(root);assert.equal((await tools.codex_read.execute({run_id:record.runId,source:'turns'},{})).status,'error');
});
await test('history invalid selectors and page bounds rejected',async()=>{
  assert.equal((await tools.codex_read.execute({run_id:'../../escape'},{})).status,'error');
  assert.equal((await tools.codex_read.execute({run_id:record.runId,limit:20001},{})).status,'error');
});
console.log('FEATURES-OK '+pass);
