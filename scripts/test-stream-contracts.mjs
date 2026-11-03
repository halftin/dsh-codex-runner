import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SETTINGS_DEFAULTS, loadEffectiveSettings, validateSetting, derivedCodexPairs,buildSayToolDefinition } from '../lib/core.js';
import { configurationDefinitions } from '../lib/configuration-editor.js';
import { FALLBACK_CATALOG } from '../lib/model-catalog.js';
import { supervisionTools } from '../lib/supervision.js';
import { atomicJson } from '../lib/run-store.js';

for (const key of ['streamOutputEnabled', 'supervisionEnabled','autoAnswerQuestions']) {
  assert.equal(SETTINGS_DEFAULTS[key], true);
  assert.equal(loadEffectiveSettings().settings[key], true);
  assert.equal(loadEffectiveSettings({config:{[key]:false}}).settings[key], false);
  for (const bad of [0, 'true', null, {}, []]) assert.equal(validateSetting(key, bad).ok, false);
  const definition = configurationDefinitions(FALLBACK_CATALOG)[key];
  assert.deepEqual(definition, {source:'plugin',nativeKey:null,schema:{type:'boolean'},defaultValue:true});
  assert.equal(derivedCodexPairs({[key]:true}).pairs.some(([name]) => name === key), false);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-contracts-'));
try {
  const id = randomUUID(), sessionId = randomUUID(), dir = path.join(root, '.codex-runner/logs/runs', id);
  const record = {runId:id,label:'contracts',backend:'app-server',sessionId,createdAt:new Date().toISOString()};
  atomicJson(path.join(dir,'run.json'),record);
  const tools = Object.fromEntries(supervisionTools({defineTool:d=>d,resolveCwd:()=>root}).map(t=>[t.name,t]));
  const context = {agent:{session:{id:sessionId}}};
  const call = (name,args={},exec=context) => tools[name].execute({run_id:id,...args},exec);
  assert.equal((await call('codex_capabilities')).status,'ok');
  const say=buildSayToolDefinition({defineTool:d=>d,resolveCwd:()=>root});
  for(const action of ['steer','queue','interrupt'])assert.match((await say.execute({run_id:id,action,message:'wrong session'},{agent:{session:{id:randomUUID()}}})).summary_text,/different or unavailable session/);
  for (const name of ['codex_stream','codex_questions','codex_answer']) {
    const args = name === 'codex_answer' ? {interaction_id:randomUUID(),response:{answers:{}}} : {};
    assert.equal((await call(name,args)).status,name==='codex_stream'?'unavailable':name==='codex_questions'?'ok':'error');
    assert.equal((await call(name,args,{agent:{session:{id:randomUUID()}}})).status,'error');
  }
  for (const args of [{after:-1},{after:0.5},{limit:0},{limit:201},{run_id:randomUUID()},{cwd:root}])
    assert.equal((await call('codex_stream',args)).status,'error');
  assert.equal((await call('codex_answer',{interaction_id:randomUUID(),response:'yes'})).status,'error');
  assert.equal((await call('codex_capabilities',{},{})).status,'error');
  atomicJson(path.join(dir,'run.json'),{...record,backend:'exec'});
  assert.equal((await call('codex_questions')).status,'unsupported');
  assert.deepEqual((await call('codex_capabilities')).capabilities.control,['queue']);
  atomicJson(path.join(dir,'run.json'),{...record,backend:'invented'});
  assert.equal((await call('codex_capabilities')).status,'error');
  console.log('STREAM-CONTRACTS-OK defaults, plugin sources, validation, session binding, placeholders and backend limits');
} finally {
  assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));
  fs.rmSync(root,{recursive:true,force:true});
}
