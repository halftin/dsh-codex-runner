// Verify the opt-in entry's control flow without contacting Codex or a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {runLive} from './test-live.mjs';
import {FALLBACK_CATALOG} from '../lib/model-catalog.js';

let diagnoses=0,builds=0,invocation;
const messages=[],catalog=async()=>({...structuredClone(FALLBACK_CATALOG),source:'app-server',stale:false});
const diagnose=async()=>{diagnoses++;return {authenticated:true,app_server:true,executable:path.join(os.tmpdir(),'live-entry-fixture','codex.exe'),CODEX_HOME:path.join(os.tmpdir(),'live-entry-fixture','auth'),version:'fixture'};};
const build=options=>{builds++;return {execute:async(args,exec)=>{
  invocation={options,args,exec};const meta=path.join(options.resolveCwd(),'result.meta.json');fs.writeFileSync(meta,'{}');
  return {status:'ok',turn_status:'completed',process_status:'terminal',run_id:'fixture-run',thread_id:'fixture-thread',has_final_answer:true,answer:'CODEX_RUNNER_LIVE_OK',meta_file:meta};
}};};
const opts={env:{},diagnose,catalog,build,output:message=>messages.push(message)};
for(const env of [{CODEX_RUNNER_SCHEMA_OFFLINE:'1'},{NODE_OPTIONS:'--import=fake-catalog-cli.mjs'},{CODEX_EXE:process.execPath}])
  await assert.rejects(runLive({...opts,argv:[],env}),/refuses the offline/);
assert.equal(diagnoses,0);assert.equal(builds,0);
await assert.rejects(runLive({...opts,argv:['--unknown']}),/Usage:/);
await assert.rejects(runLive({...opts,argv:['--model']}),/Usage:/);
const previousHome=process.env.DSH_HOME;
const checked=await runLive({...opts,argv:['--check']});assert.equal(checked.mode,'check');assert.equal(builds,0);
assert.ok(messages.some(m=>m.startsWith('LIVE-PREFLIGHT-OK')));assert.equal(process.env.DSH_HOME,previousHome);
await assert.rejects(runLive({...opts,argv:['--check'],diagnose:async()=>({authenticated:false,app_server:true})}),/login/);
await assert.rejects(runLive({...opts,argv:['--check'],catalog:async()=>({...FALLBACK_CATALOG,source:'fallback',stale:true})}),/fresh native/);
const model=FALLBACK_CATALOG.models.find(m=>m.isDefault).id;
await runLive({...opts,argv:['--model',model,'--effort','low']});
assert.equal(invocation.args.model,model);assert.equal(invocation.args.effort,'low');assert.equal(invocation.options.config.autoModelAndEffort,false);
assert.equal(invocation.options.config.sandboxMode,'read-only');assert.equal(invocation.args.budget_ms,120000);
assert.ok(invocation.options.resolveCwd().startsWith(os.tmpdir()));assert.notEqual(invocation.options.resolveCwd(),process.cwd());
assert.equal(process.env.DSH_HOME,previousHome);
const count=messages.filter(m=>m.startsWith('LIVE-TURN-OK')).length;
await assert.rejects(runLive({...opts,argv:[],build:()=>({execute:async()=>({status:'error',summary_text:'model turn failed'})})}),/model turn failed/);
assert.equal(messages.filter(m=>m.startsWith('LIVE-TURN-OK')).length,count);
assert.equal(process.env.DSH_HOME,previousHome);
console.log('LIVE-ENTRY-OK (offline contamination rejected; preflight has no turn; explicit selection, evidence, failure and isolated home checked with doubles)');
