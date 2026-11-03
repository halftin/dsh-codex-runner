import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createSubagentTracker, boundedSubagents } from '../lib/subagent-view.js';
import { codexConfigPairs, derivedCodexPairs, validateSetting, buildToolDefinition, buildStatusToolDefinition, NATIVE_AGENT_KEYS, SETTINGS_SPEC, CODEX_CONFIG_WHITELIST, LOGS_REL, loadEffectiveSettings } from '../lib/core.js';
import { reserveRun, updateRecord, atomicJson, runDirectory } from '../lib/run-store.js';
import { processStartedAt } from '../lib/process-evidence.js';
import { runManaged } from '../lib/managed-run.js';
import { FALLBACK_CATALOG } from '../lib/model-catalog.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-subagents-'));
let pass=0;async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
const settings={'agents.interrupt_message':true};
const inheritedKeys=['agents.enabled','agents.max_concurrent_threads_per_session','agents.default_subagent_model','agents.default_subagent_reasoning_effort'];
await test('subagent settings stay inherited and cannot enter the default plugin configuration',()=>{
  for(const key of [...inheritedKeys,'agents.max_threads','agents.max_depth']) {
    assert.equal(Object.hasOwn(SETTINGS_SPEC,key),false);
    assert.equal(Object.hasOwn(CODEX_CONFIG_WHITELIST,key),false);
    assert.equal(NATIVE_AGENT_KEYS.includes(key),false);
    assert.equal(validateSetting(key,1).ok,false);
    assert.ok(codexConfigPairs({[key]:1},[]).problems.length);
    assert.ok(codexConfigPairs({},[key+'=1']).problems.length);
    assert.equal(derivedCodexPairs({[key]:1}).pairs.some(([name])=>name===key),false);
  }
});
await test('interrupt message boolean reaches every config path; text is rejected and unset stays inherited',()=>{
  const key='agents.interrupt_message';
  for(const value of [true,false]) {
    assert.equal(validateSetting(key,value).ok,true);
    for(const result of [derivedCodexPairs({[key]:value}),codexConfigPairs({[key]:value},[]),codexConfigPairs({},[key+'='+value])]) {
      assert.deepEqual(result.problems,[]);assert.equal(JSON.parse(Object.fromEntries(result.pairs)[key]),value);
    }
  }
  for(const value of ['true','false','[1]','custom message',0,{}]) {
    assert.equal(validateSetting(key,value).ok,false);
    assert.ok(derivedCodexPairs({[key]:value}).problems.length);
    assert.ok(codexConfigPairs({[key]:value},[]).problems.length);
  }
  assert.ok(codexConfigPairs({},[key+'=custom message']).problems.length);
  const effective=config=>loadEffectiveSettings({config}).settings;
  assert.equal(effective({})[key],undefined);
  assert.equal(effective({[key]:null})[key],undefined);
  assert.equal(effective({[key]:{get:()=>null}})[key],undefined);
  for(const value of [true,false])assert.equal(effective({[key]:{get:()=>value}})[key],value);
  const inherited=effective({[key]:null});assert.equal(inherited[key],undefined);
  assert.equal(derivedCodexPairs(inherited).pairs.some(([name])=>name===key),false,'no override sent to Codex');
});
const items=[
  {type:'collabAgentToolCall',id:'spawn',tool:'spawnAgent',status:'completed',receiverThreadIds:['child-a'],agentsStates:{'child-a':{status:'running',message:'private child message'}}},
  {type:'SubAgentActivityThreadItem',agentId:'child-a',status:'completed'},
  {type:'CollabAgentToolCallThreadItem',tool:'wait',receiverThreadIds:['child-b'],agentsStates:{'child-b':{status:'errored'}}},
];
await test('native child states deduplicate across item variants; parent tool completion is not child completion',()=>{
  const tracker=createSubagentTracker();tracker.observe(items[0]);assert.equal(tracker.snapshot().running,1);assert.equal(tracker.snapshot().completed,0);
  for(const item of items)tracker.observe(item);tracker.observe(items[1]);tracker.observe({type:'future-item'});
  const result=tracker.snapshot();assert.equal(result.count,2);assert.equal(result.completed,1);assert.equal(result.failed,1);
  assert.equal(JSON.stringify(result).includes('private child message'),false);
  const unknown=createSubagentTracker();unknown.observe({type:'collab_agent_tool_call',status:'completed',receiverThreadIds:['unknown-child']});assert.equal(unknown.snapshot().unknown,1);
});
await test('subagent activity is bounded and malformed old metadata stays readable',()=>{
  const tracker=createSubagentTracker();for(let i=0;i<40;i++)tracker.observe({type:'subAgentActivity',agentId:'child-'+i,status:'completed'});
  const result=tracker.snapshot();assert.equal(result.count,40);assert.equal(result.items.length,32);assert.equal(result.truncated,true);
  assert.equal(boundedSubagents({items:[null]}).items[0].id,null);
});
await test('managed driver passes native config and records activity fixtures without plugin fan-out',async()=>{
  class Fake extends EventEmitter {
    async initialize(){}
    async request(method,params) {
      if(method==='model/list')return {data:FALLBACK_CATALOG.models};
      if(method==='thread/start'){for(const key of inheritedKeys)assert.equal(Object.hasOwn(params.config,key),false,key+' stays inherited');assert.equal(params.config['agents.interrupt_message'],true);return {thread:{id:'parent'}};}
      if(method==='turn/start'){setTimeout(()=>{for(const item of items)this.emit('notification','item/completed',{threadId:'parent',item});this.emit('notification','turn/completed',{threadId:'parent',turn:{id:'turn',status:'completed'}});},20);return {turn:{id:'turn'}};}
      throw Error('Unexpected method '+method);
    }
    async close(){}
  }
  const runId=randomUUID(),meta=await runManaged({cwd:root,logDir:path.join(root,runId),runId,prompt:'fixture',model:'gpt-6.1-sol',effort:'high',config:settings,budgetMs:0},()=>new Fake());
  assert.equal(meta.status,'ok');assert.equal(meta.subagents.count,2);assert.equal(meta.subagents.failed,1);
});
await test('codex_status prefers the latest active heartbeat activity summary',async()=>{
  const cwd=fs.mkdtempSync(path.join(root,'status-')),logs=path.join(cwd,LOGS_REL),record=reserveRun(logs,'native'),dir=runDirectory(logs,record);
  updateRecord(logs,record,{state:'running',driverPid:process.pid,driverStartedAt:processStartedAt()});
  const tracker=createSubagentTracker();for(const item of items)tracker.observe(item);
  atomicJson(path.join(dir,'result.meta.json'),{subagents:boundedSubagents(null)});
  atomicJson(path.join(dir,'result.hb.json'),{runId:record.runId,ts:new Date().toISOString(),subagents:tracker.snapshot()});
  const status=await buildStatusToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd}).execute({run_id:record.runId},{});
  assert.equal(status.subagents.count,2);assert.equal(status.subagents.completed,1);
});
console.log('SUBAGENTS-OK '+pass);
