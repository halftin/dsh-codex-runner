// Explicit opt-in only. This entry never imports offline-env or a fake CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildToolDefinition, killTree} from '../lib/core.js';
import {diagnoseCodex} from '../lib/executable.js';
import {getCatalog, validateCatalogSelection} from '../lib/model-catalog.js';

export async function runLive({argv=process.argv.slice(2),env=process.env,diagnose=diagnoseCodex,catalog=getCatalog,build=buildToolDefinition,output=console.log}={}) {
  const options={};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(flag==='--check'){options.check=true;continue;}
    if(!['--model','--effort'].includes(flag)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Usage: npm run test:live -- [--check] [--model MODEL] [--effort EFFORT]');
    options[flag.slice(2)]=argv[++i];
  }
  if(env.CODEX_RUNNER_SCHEMA_OFFLINE==='1'||/fake-catalog-cli/.test(env.NODE_OPTIONS||'')||env.CODEX_EXE&&path.resolve(env.CODEX_EXE)===process.execPath)
    throw Error('Live verification refuses the offline/fake CLI environment; start from a clean terminal');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-live-')),previousHome=process.env.DSH_HOME,live=new Set();
  process.env.DSH_HOME=path.join(root,'host');
  try {
    const report=await diagnose({});
    assert.ok(report.authenticated&&report.app_server,'Codex login and App Server handshake must pass');
    assert.ok(report.executable&&path.resolve(report.executable)!==process.execPath,'Live verification requires the real Codex executable');
    const config={backend:'app-server',autoModelAndEffort:false,codexExecutable:report.executable,codexHome:report.CODEX_HOME,
      sandboxMode:'read-only',approvalPolicy:'never',workspaceNetworkAccess:false,defaultBudgetMs:120000};
    const view=await catalog({refresh:true,settings:config});
    assert.ok(view.source==='app-server'&&!view.stale,'Live verification requires a fresh native model catalog, not fallback data');
    const model=options.model||view.models.find(m=>m.isDefault&&!m.hidden)?.id||view.models.find(m=>!m.hidden)?.id;
    const capability=view.models.find(m=>m.id===model);
    const effort=options.effort||(capability?.efforts.some(e=>e.id==='low')?'low':capability?.defaultReasoningEffort||capability?.efforts[0]?.id);
    const problem=validateCatalogSelection(view,model,effort,'off');assert.equal(problem,null,problem||'Model and effort must be available');
    output('Codex '+report.version+'; model='+model+'; effort='+effort);
    if(options.check){output('LIVE-PREFLIGHT-OK (no model turn started)');return {mode:'check',model,effort};}
    output('Starting one real model turn; this consumes Codex quota. Evidence: '+root);
    const prompt=path.join(root,'task.md');fs.writeFileSync(prompt,'Do not use tools. Reply with exactly CODEX_RUNNER_LIVE_OK.');
    const tool=build({defineTool:d=>d,resolveCwd:()=>root,config,onSpawn:c=>live.add(c),onClose:c=>live.delete(c)});
    const result=await tool.execute({prompt_file:prompt,label:'live-verification',model,effort,budget_ms:120000},
      {agent:{session:{header:{cwd:root}}}});
    assert.equal(result.status,'ok',result.summary_text);
    assert.equal(result.turn_status,'completed');assert.equal(result.process_status,'terminal');
    assert.ok(result.run_id&&result.thread_id&&result.has_final_answer,'Run identity and a completed answer are required');
    assert.equal(result.answer?.trim(),'CODEX_RUNNER_LIVE_OK');
    assert.ok(result.meta_file&&fs.existsSync(result.meta_file),'Persisted execution evidence is required');
    assert.equal(live.size,0,'No owned driver may remain alive');
    output('LIVE-TURN-OK run_id='+result.run_id);return {mode:'live',root,result};
  } finally {
    for(const child of live)if(child.stop)await child.stop();else killTree(child);
    if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  runLive().catch(error=>{console.error(error.message);process.exitCode=1;});
