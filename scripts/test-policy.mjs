import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SELECTION_POLICY, parsePolicy, comparePair, evaluateSelection } from '../lib/selection-policy.js';
import { FALLBACK_CATALOG } from '../lib/model-catalog.js';
import { buildToolDefinition, LOGS_REL } from '../lib/core.js';
import { reserveRun, atomicJson, runDirectory } from '../lib/run-store.js';
import { selectionTools } from '../lib/selection-audit.js';
import { managementTools } from '../lib/management.js';
import { historyTools } from '../lib/history.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-policy-'));
let pass=0;async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
const common={policy:parsePolicy({mode:'audit'}),taskKind:'architect',recommended:{model:'gpt-6-astra',effort:'xhigh'},
  actual:{model:'gpt-6-sol',effort:'high'},explicitModel:true,explicitEffort:true,overrideReason:'Reviewed smaller scope',downgradeReason:'scope-reduced'};
await test('enhancements default off; off/audit never alter selection or require reasons',()=>{
  assert.equal(DEFAULT_SELECTION_POLICY.mode,'off');
  for(const mode of ['off','audit']){
    const result=evaluateSelection({...common,policy:parsePolicy({mode}),explicitModel:false,explicitEffort:false,overrideReason:undefined});
    assert.equal(result.status,'ok');assert.equal(result.model,'gpt-6-sol');assert.equal(result.effort,'high');
    assert.equal(result.selection.review_required,false);
    assert.equal(evaluateSelection({...common,policy:parsePolicy({mode}),overrideReason:undefined}).status,'ok');
  }
  const enforced=evaluateSelection({...common,policy:parsePolicy({mode:'enforce'}),explicitModel:false,explicitEffort:false,overrideReason:undefined});
  assert.equal(enforced.model,'gpt-6-astra');assert.equal(enforced.effort,'xhigh');
  assert.equal(evaluateSelection({...common,policy:parsePolicy({mode:'enforce'}),overrideReason:undefined}).status,'error');
});
await test('off and audit do not run the enforcement quota gate or block dispatch',async()=>{
  for(const mode of ['off','audit']){
    let probes=0;const cwd=fs.mkdtempSync(path.join(root,'mode-'+mode+'-'));
    const run=buildToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd,config:{autoModelAndEffort:true,selectionPolicy:JSON.stringify({mode,quota:{action:'deny',below_percent:100}})},
      quotaView:{get:async()=>{probes++;return {status:'ok',windows:{five_hour:{remaining_percent:0}}};}}});
    const result=await run.execute({label:'mode-'+mode,prompt_file:'missing.md',model:'gpt-6-sol',effort:'high'},{});
    assert.match(result.summary_text,/提示词文件不存在/);assert.equal(probes,0);
  }
});
await test('floor equal, above, below and explicit override reason',()=>{
  assert.equal(comparePair(common.actual,common.recommended),-1);
  assert.equal(comparePair(common.recommended,common.recommended),0);
  assert.equal(comparePair({model:'gpt-6-astra',effort:'ultra'},common.recommended),1);
  const result=evaluateSelection(common);assert.equal(result.status,'ok');assert.equal(result.selection.downgrade,true);
  assert.equal(result.selection.recommended_model,'gpt-6-astra');assert.equal(result.selection.model,'gpt-6-sol');
  assert.equal(evaluateSelection({...common,overrideReason:undefined}).status,'ok','audit never requires an explanation');
  assert.equal(evaluateSelection({...common,actual:common.recommended}).selection.downgrade,false);
});
await test('enforce denies forbidden downgrade, invalid/missing reasons and returns approval_required',()=>{
  const policy=parsePolicy({mode:'enforce'});
  assert.equal(evaluateSelection({...common,policy}).status,'error');
  policy.downgrade.never_for=[];
  assert.equal(evaluateSelection({...common,policy,downgradeReason:'made-up'}).status,'error');
  assert.equal(evaluateSelection({...common,policy,downgradeReason:undefined}).status,'error');
  assert.equal(evaluateSelection({...common,policy}).status,'ok');
  policy.downgrade.require_approval=true;
  assert.equal(evaluateSelection({...common,policy}).status,'approval_required');
  assert.equal(evaluateSelection({...common,policy,approval:true}).status,'approval_required');
});
await test('evidence upgrades recommendation and unknown model order is explicit',()=>{
  const result=evaluateSelection({...common,taskKind:'implement',recommended:{model:'gpt-6.1-sol',effort:'high'},claims:{architecture_decision:true}});
  assert.equal(result.selection.recommended_model,'gpt-6-astra');assert.equal(result.selection.downgrade,true);
  const unknown=evaluateSelection({...common,actual:{model:'future-model',effort:'high'}});
  assert.equal(unknown.selection.comparison,'unknown');assert.equal(unknown.selection.downgrade,true);
});
await test('one profile policy is validated without project/global merge rules',()=>{
  const profile=parsePolicy({mode:'enforce',downgrade:{allowed:false}});
  assert.equal(profile.mode,'enforce');assert.equal(profile.downgrade.allowed,false);
  const replacement=parsePolicy({mode:'audit',floors:{architect:{model:'gpt-6-sol',effort:'high'}}});
  assert.equal(replacement.floors.architect.model,'gpt-6-sol');
  assert.throws(()=>parsePolicy('{bad'));
  assert.throws(()=>parsePolicy({floors:{unknown:{model:'x',effort:'high'}}}),/Invalid/);
  assert.throws(()=>parsePolicy({floors:{architect:{model:'missing',effort:'high'}}},FALLBACK_CATALOG),/catalog mismatch/);
});
await test('synthetic quota downgrade retains recommended astra/xhigh versus actual sol/high',()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/synthetic-selection.json',import.meta.url),'utf8'));
  const result=evaluateSelection({...common,actual:fixture,downgradeReason:'quota',overrideReason:fixture.override_reason,claims:fixture.caller_claims});
  assert.equal(result.selection.recommended_model,'gpt-6-astra');assert.equal(result.selection.recommended_effort,'xhigh');
  assert.equal(result.selection.model,'gpt-6-sol');assert.equal(result.selection.effort,'high');assert.equal(result.selection.downgrade_reason,'quota');
  console.log('SYNTHETIC-SELECTION '+JSON.stringify(result.selection));
});
await test('approval gate starts no driver; profile policy accessor hot reloads on next invocation',async()=>{
  const cwd=fs.mkdtempSync(path.join(root,'gate-'));let policy=parsePolicy({mode:'enforce',downgrade:{never_for:[],require_approval:true}}),spawns=0;
  const tool=buildToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd,config:{autoModelAndEffort:true,selectionPolicy:{get:()=>JSON.stringify(policy)}},onSpawn:()=>spawns++});
  const args={label:'gate',prompt_file:'missing.md',task_kind:'architect',model:'gpt-6-sol',effort:'high',override_reason:'Task scope reduced',downgrade_reason:'scope-reduced',unlock_effort:true};
  assert.equal((await tool.execute(args,{})).status,'approval_required');assert.equal(spawns,0);
  assert.equal(fs.existsSync(path.join(cwd,LOGS_REL,'runs')),false);
  policy.mode='audit';assert.match((await tool.execute(args,{})).summary_text,/提示词文件不存在/);assert.equal(spawns,0);
});
await test('quota policy action is enforced before dispatch',async()=>{
  for(const action of ['deny','pause','reduce-scope']){
    const cwd=fs.mkdtempSync(path.join(root,'quota-'+action+'-')),policy=parsePolicy({mode:'enforce',quota:{below_percent:10,action}}),spawns=0;
    const tool=buildToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd,config:{autoModelAndEffort:true,selectionPolicy:{get:()=>JSON.stringify(policy)}},
      quotaView:{get:async()=>({status:'ok',windows:{five_hour:{remaining_percent:3},seven_day:{remaining_percent:50}}})},onSpawn:()=>spawns++});
    const result=await tool.execute({label:'quota-'+action,prompt_file:'missing.md',task_kind:'implement'},{});
    assert.equal(result.status,'error',action);assert.match(result.summary_text,new RegExp('selectionPolicy\\.quota\\.action='+action));assert.equal(spawns,0);
    assert.equal(fs.existsSync(path.join(cwd,LOGS_REL,'runs')),false);
  }
});

await test('selection read/list/audit filters and legacy null without a selection artifact',async()=>{
  const cwd=fs.mkdtempSync(path.join(root,'audit-')),logs=path.join(cwd,LOGS_REL),record=reserveRun(logs,'audit'),dir=runDirectory(logs,record);
  const selection=evaluateSelection(common).selection;
  atomicJson(path.join(dir,'selection.json'),selection);atomicJson(path.join(dir,'result.meta.json'),{status:'ok'});
  const opts={defineTool:d=>d,resolveCwd:()=>cwd};
  const listing=await managementTools(opts).find(t=>t.name==='codex_list').execute({},{});assert.equal(listing.runs[0].downgrade,true);assert.equal(listing.runs[0].model,'gpt-6-sol');
  const read=historyTools(opts).find(t=>t.name==='codex_read');assert.equal((await read.execute({run_id:record.runId,source:'selection'},{})).selection.downgrade,true);
  const audit=selectionTools({...opts,logsRelative:LOGS_REL})[0];assert.equal((await audit.execute({downgrade:true},{})).entries.length,1);assert.equal((await audit.execute({model:'other'},{})).entries.length,0);
  fs.unlinkSync(path.join(dir,'selection.json'));assert.equal((await read.execute({run_id:record.runId,source:'selection'},{})).selection,null);
});
console.log('POLICY-OK '+pass);
