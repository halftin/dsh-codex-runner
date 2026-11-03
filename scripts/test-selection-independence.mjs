import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToolDefinition, LOGS_REL } from '../lib/core.js';
import { FALLBACK_CATALOG } from '../lib/model-catalog.js';

const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'runner-selection-independent-'));
fs.writeFileSync(path.join(cwd,'task.md'),'Task goal supplied by DSH');
const driver=path.join(cwd,'driver.mjs');
fs.writeFileSync(driver,`import fs from 'node:fs';import path from 'node:path';
const dir=process.argv[process.argv.indexOf('--log-dir')+1];
fs.writeFileSync(path.join(dir,'received.json'),JSON.stringify(process.argv));
fs.writeFileSync(path.join(dir,'result.meta.json'),JSON.stringify({status:'ok',lastMessage:'done'}));`);
let sequence=0,spawns=0,quotaProbes=0;
const tool=(config={})=>buildToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd,
  catalog:async()=>FALLBACK_CATALOG,onSpawn:()=>spawns++,
  quotaView:{get:async()=>{quotaProbes++;return {status:'ok',windows:{five_hour:{remaining_percent:0}}};}},
  config:{backend:'exec',driverPath:driver,defaultModel:'gpt-6-astra',defaultEffort:'xhigh',...config}});
const call=(run,args={})=>run.execute({label:'selection-'+(++sequence),prompt_file:'task.md',...args},{});
const pair={model:'gpt-6.1-sol',effort:'medium'};

// 主开关关闭（默认）＝固定默认档位：DSH 不参与，任务规则、证据与预设策略都不参与。
for(const selectionPolicy of [undefined,{mode:'audit'},{mode:'enforce'}])for(const selectionMode of ['legacy','manual','evidence']){
  const run=tool({selectionPolicy,selectionMode});
  const result=await call(run,{task_kind:'architect',evidence:{files:['missing.md'],architecture_decision:true}});
  assert.equal(result.status,'ok',result.summary_text);
  assert.equal(result.model,'gpt-6-astra');assert.equal(result.effort,'xhigh');
  assert.equal(result.model_source,'default');assert.equal(result.effort_source,'default');
  assert.equal(result.recommended_model,'gpt-6-astra');assert.equal(result.recommended_effort,'xhigh');
  assert.equal(result.downgrade,false);
  const argv=JSON.parse(fs.readFileSync(path.join(cwd,LOGS_REL,'runs',result.run_id,'received.json'),'utf8'));
  assert.equal(argv[argv.indexOf('--model')+1],'gpt-6-astra');assert.equal(argv[argv.indexOf('--effort')+1],'xhigh');
  for(const explicit of [{model:pair.model},{effort:pair.effort},{...pair}]){
    const before=spawns;
    const rejected=await call(run,explicit);
    assert.equal(rejected.status,'error',rejected.summary_text);
    assert.match(rejected.summary_text,/不接受 model\/effort/);
    assert.equal(spawns,before,'Explicit selection must not dispatch while the main switch is off');
  }
}
assert.equal(quotaProbes,0,'Default mode must not consult quota to choose a tier');
console.log('PASS main switch off: fixed defaults, no quota probe, explicit model/effort rejected in every policy/mode combination');

// 主开关开启且策略关闭：DSH 必须显式给出模型与强度，规则和默认值都不补全。
for(const selectionMode of ['legacy','manual','evidence'])for(const missing of [{},{model:pair.model},{effort:pair.effort}]){
  const run=tool({autoModelAndEffort:true,selectionMode});
  const before=spawns;
  const result=await call(run,{...missing,task_kind:'architect',evidence:{files:['missing.md']}});
  assert.equal(result.status,'error');
  assert.match(result.summary_text,/Selection policy is off/);
  assert.equal(spawns,before);
}
const explicit=await call(tool({autoModelAndEffort:true}),{...pair,task_kind:'architect',evidence:{files:['missing.md'],architecture_decision:true}});
assert.equal(explicit.status,'ok',explicit.summary_text);
assert.equal(explicit.model,pair.model);assert.equal(explicit.effort,pair.effort);
assert.equal(explicit.model_source,'explicit');assert.equal(explicit.effort_source,'explicit');
console.log('PASS main switch on with policy off requires an explicit pair and bypasses task rules, evidence and defaults');

// 主开关开启且策略开启：规则/证据补全才生效。
const auditFill=await call(tool({autoModelAndEffort:true,selectionPolicy:{mode:'audit'}}),{task_kind:'architect'});
assert.equal(auditFill.status,'ok',auditFill.summary_text);
assert.equal(auditFill.model,'gpt-6-astra');assert.equal(auditFill.effort,'xhigh');
assert.equal(auditFill.model_source,'task_kind');assert.equal(auditFill.effort_source,'task_kind');
const hiddenPolicy=await call(tool({autoModelAndEffort:false,selectionPolicy:{mode:'enforce'}}),{task_kind:'architect'});
assert.equal(hiddenPolicy.model,'gpt-6-astra');
assert.equal(hiddenPolicy.model_source,'default','Preset rules must not run while the main switch is off');
console.log('PASS preset rules fill only when both the main switch and the policy are enabled');

for(const mode of ['off','audit','enforce'])for(const reason of ['quota','time','cost','latency','budget','convenience',' QUOTA ']){
  const before=spawns;
  const result=await call(tool({autoModelAndEffort:true,selectionPolicy:{mode}}),{...pair,downgrade_reason:reason});
  assert.equal(result.status,'error');assert.match(result.summary_text,/cannot justify/);assert.equal(spawns,before);
}
console.log('PASS non-task downgrade categories reject before dispatch in every mode');

for(const args of [{model:'unavailable',effort:'medium'},{model:'gpt-6-luna',effort:'ultra'},{model:'gpt-6.1-sol',effort:'max'}]){
  const before=spawns,result=await call(tool({autoModelAndEffort:true}),args);
  assert.equal(result.status,'error');assert.equal(spawns,before,'Unsupported or capped selections must not silently fall back');
}
for(const action of ['pause','deny','reduce-scope','allow-downgrade']){
  const before=spawns;
  const result=await call(tool({autoModelAndEffort:true,selectionPolicy:{mode:'enforce',quota:{action}}}),{...pair,override_reason:'Assessed task scope'});
  assert.equal(result.status,'error');assert.match(result.summary_text,/当前剩余 0%/);assert.equal(spawns,before);
}
console.log('PASS unavailable/capped choices and exhausted quota stop without weaker substitution, including legacy quota action');
console.log('SELECTION-INDEPENDENCE-OK; simulated driver/catalog/quota only');
