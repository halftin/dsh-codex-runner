// Explicit real Codex acceptance; one short model turn for the selected backend.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {buildToolDefinition,buildStatusToolDefinition} from '../lib/core.js';
import {diagnoseCodex} from '../lib/executable.js';
import {getCatalog} from '../lib/model-catalog.js';
import {readOutput} from '../lib/output-stream.js';
import {atomicJson} from '../lib/run-store.js';

const backend=process.argv[2];if(!['exec','app-server'].includes(backend))throw Error('Use exec or app-server');
if(process.env.CODEX_RUNNER_SCHEMA_OFFLINE==='1'||process.env.NODE_OPTIONS)throw Error('Use a clean live environment');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-live-output-'));process.env.DSH_HOME=path.join(root,'host');
const report=await diagnoseCodex();assert.ok(report.authenticated&&report.app_server);
const catalog=await getCatalog({refresh:true});assert.equal(catalog.source,'app-server');assert.equal(catalog.stale,false);
const model=catalog.models.find(m=>m.isDefault&&!m.hidden)||catalog.models.find(m=>!m.hidden),effort=model.efforts.some(e=>e.id==='low')?'low':model.defaultReasoningEffort;
const prompt=path.join(root,'task.md');fs.writeFileSync(prompt,'Output a short commentary message containing LIVE_STREAM_PROGRESS. Then use the shell to wait 3 seconds (PowerShell Start-Sleep -Seconds 3). Do not inspect or change files, use network, or delegate. Finally respond exactly LIVE_STREAM_FINAL.');
const options={defineTool:d=>d,resolveCwd:()=>root,config:{backend,autoModelAndEffort:false,sandboxMode:'read-only',approvalPolicy:'never',workspaceNetworkAccess:false,debugLogs:false}};
const tool=buildToolDefinition(options),status=buildStatusToolDefinition(options);
console.log('Real '+backend+' output test; '+report.version+'; evidence='+root);
const started=await tool.execute({prompt_file:prompt,label:'stream-live',model:model.id,effort,detach:true,budget_ms:90000},{});
assert.ok(started.run_id,started.summary_text);const dir=path.join(root,'.codex-runner/logs/runs',started.run_id);
let result,seenWhileRunning=false;const events=[];let cursor=0;
try {
  for(let i=0;i<2000;i++){
    result=await status.execute({run_id:started.run_id},{});
    const batch=readOutput(dir,started.run_id,{after:cursor});events.push(...batch.events);cursor=batch.next_cursor;
    if(result.running&&batch.events.some(e=>/agentMessage|agent_message/.test(JSON.stringify(e))&&JSON.stringify(e).includes('LIVE_STREAM_PROGRESS')))seenWhileRunning=true;
    if(!result.running&&!batch.has_more)break;await new Promise(r=>setTimeout(r,50));
  }
  atomicJson(path.join(root,'acceptance.json'),{classification:'real-codex-model',backend,codexVersion:report.version,model:model.id,effort,seenWhileRunning,result,events});
  assert.equal(result.status,'ok',result.summary_text);assert.equal(result.answer.trim(),'LIVE_STREAM_FINAL');assert.equal(seenWhileRunning,true,'Must observe actual model content before terminal state');
  assert.equal(fs.existsSync(path.join(dir,'events.jsonl')),false,'debugLogs must remain off');
  console.log('LIVE-OUTPUT-OK '+backend+'; evidence='+root);
} finally {if(result?.running)atomicJson(path.join(dir,'cancel.json'),{runId:started.run_id});}
