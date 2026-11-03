// Actual Codex protocol/effect check; this is not a real DSH-model decision test.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildToolDefinition,buildStatusToolDefinition,buildSayToolDefinition} from '../lib/core.js';
import {diagnoseCodex} from '../lib/executable.js';
import {getCatalog} from '../lib/model-catalog.js';
import {readOutput} from '../lib/output-stream.js';
import {atomicJson} from '../lib/run-store.js';

const action=process.argv[2];if(!['steer','queue','interrupt'].includes(action))throw Error('Use steer, queue or interrupt');
if(process.env.CODEX_RUNNER_SCHEMA_OFFLINE==='1'||process.env.NODE_OPTIONS)throw Error('Use a clean live environment');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-live-control-'));process.env.DSH_HOME=path.join(root,'host');
const report=await diagnoseCodex();assert.ok(report.authenticated&&report.app_server);
const catalog=await getCatalog({refresh:true});assert.equal(catalog.source,'app-server');assert.equal(catalog.stale,false);
const model=catalog.models.find(m=>m.isDefault&&!m.hidden)||catalog.models.find(m=>!m.hidden),effort=model.efforts.some(e=>e.id==='low')?'low':model.defaultReasoningEffort;
const prompt=path.join(root,'task.md'),marker='CONTROL_'+randomUUID();
fs.writeFileSync(prompt,'Output commentary containing CONTROL_READY. Then run PowerShell Start-Sleep -Seconds 8. Do not inspect or change files, use network, or delegate. Finally answer ORIGINAL_DONE, unless an additional user instruction changes the answer.');
const options={defineTool:d=>d,resolveCwd:()=>root,config:{backend:'app-server',autoModelAndEffort:false,sandboxMode:'read-only',approvalPolicy:'never',workspaceNetworkAccess:false,debugLogs:false}};
const runner=buildToolDefinition(options),status=buildStatusToolDefinition(options),say=buildSayToolDefinition(options);
console.log('Real Codex '+action+'; '+report.version+'; evidence='+root);
const started=await runner.execute({prompt_file:prompt,label:'control-live',model:model.id,effort,detach:true,budget_ms:120000},{});assert.ok(started.run_id,started.summary_text);
const dir=path.join(root,'.codex-runner/logs/runs',started.run_id);let result,receipt,cursor=0;
try{
  for(let i=0;i<2600;i++){
    result=await status.execute({run_id:started.run_id},{});
    const batch=readOutput(dir,started.run_id,{after:cursor});cursor=batch.next_cursor;
    if(!receipt&&result.running&&batch.events.some(e=>/agentMessage/.test(JSON.stringify(e))&&JSON.stringify(e).includes('CONTROL_READY'))){
      receipt=await say.execute({run_id:started.run_id,action,message:'The authorized acceptance marker is '+marker+'. Reply exactly with this marker as your final answer. Do not run more commands.'},{});
      assert.equal(receipt.status,'ok',receipt.summary_text);
    }
    if(!result.running&&!batch.has_more)break;await new Promise(r=>setTimeout(r,50));
  }
  atomicJson(path.join(root,'acceptance.json'),{classification:'real-codex/scripted-controller',action,codexVersion:report.version,model:model.id,effort,receipt,result,marker});
  assert.ok(receipt,'No active progress available for control');
  if(action==='interrupt')assert.equal(result.status,'interrupted');else{assert.equal(result.status,'ok',result.summary_text);assert.equal(result.answer.trim(),marker);}
  console.log('LIVE-CONTROL-OK '+action+'; evidence='+root);
}finally{if(result?.running)atomicJson(path.join(dir,'cancel.json'),{runId:started.run_id});}
