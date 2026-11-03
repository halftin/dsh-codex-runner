// Opt-in real Codex probe. No DSH model; all artifacts stay in a fresh temp workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildToolDefinition} from '../lib/core.js';
const backend=process.argv[2]||'app-server';
assert.ok(['app-server','exec'].includes(backend));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-real-conversation-'));
const marker='HISTORY_'+randomUUID().replaceAll('-',''),results=[];
const run=buildToolDefinition({defineTool:d=>d,resolveCwd:()=>root,config:{backend,
  codexHome:process.env.CODEX_HOME,supervisionEnabled:false,autoAnswerQuestions:false,
  sandboxMode:'read-only',debugLogs:true}});
const turns=[['gpt-6.1-sol','low','Remember this conversation marker: '+marker+'. Reply exactly with the marker.'],
  ['gpt-6-luna','low','Return exactly the conversation marker from the previous user message.'],
  ['gpt-6.1-sol','medium','Return exactly the original conversation marker again.']];
console.log('REAL-CONVERSATION '+backend+' evidence='+root);
try {
  for(const [i,[model,effort,message]] of turns.entries()){
    const prompt=path.join(root,'turn-'+i+'.md');fs.writeFileSync(prompt,message+' Do not use tools, files, network or subagents.');
    const result=await run.execute({label:'turn-'+i,prompt_file:prompt,model,effort,budget_ms:90000,
      ...(i?{continue_run_id:results.at(-1).run_id}:{})},{});
    if(result.run_id){
      const dir=path.join(root,'.codex-runner/logs/runs',result.run_id);
      try {const meta=JSON.parse(fs.readFileSync(path.join(dir,'result.meta.json'),'utf8'));
        const events=backend==='app-server'?fs.readFileSync(path.join(dir,'output.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
        result.cache_observation={kind:backend==='app-server'?'last-turn':'reported-total',usage:backend==='app-server'?events.filter(e=>e.method==='thread/tokenUsage/updated'&&e.params.turnId===meta.turnId).at(-1)?.params.tokenUsage.last:meta.usage};
      }catch(error){result.cache_observation={unavailable:error.message};}
    }
    results.push(result);fs.writeFileSync(path.join(root,'acceptance.json'),JSON.stringify({classification:'real-codex/no-dsh-model',backend,results,cache:'observed usage is not a cross-model cache guarantee'},null,2));
    assert.equal(result.status,'ok',result.summary_text);assert.equal(result.answer.trim(),marker);
    assert.equal(result.model,model);assert.equal(result.effort,effort);
    if(i)assert.equal(result.thread_id,results[0].thread_id);
    console.log('PASS turn '+i+' '+model+'/'+effort+' '+result.thread_action);
  }
  console.log('REAL-CONVERSATION-OK; history retention verified; cache observations do not guarantee cross-model reuse');
} catch(error){console.error(error.message);process.exitCode=1;}
