import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { BUNDLED_REGISTRY,compileFieldRegistry,createFieldRegistryStore,registryConfigPairs,DEFAULT_FIELD_REGISTRY,fieldRegistryDiff,BUNDLED_FIELDS } from '../lib/codex-fields.js';
import { flattenConfigSchema,validateFieldValue,tomlValue,stringEnumSpec } from '../lib/field-schema.js';
import { codexConfigPairs,derivedCodexPairs,validateSetting,buildToolDefinition,buildConfigToolDefinition,LOGS_REL } from '../lib/core.js';
import { createCatalogI18n } from '../lib/catalog-i18n.js';
import { atomicJson,readJson } from '../lib/run-store.js';
import { FALLBACK_CATALOG,catalogTools } from '../lib/model-catalog.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-fields-'));
let passed=0;async function test(name,fn){await fn();console.log('PASS fields '+name);passed++;}
const schema={type:'object',definitions:{Mode:{type:'string',enum:['one','two']}},properties:{
  feature:{type:'object',properties:{mode:{$ref:'#/definitions/Mode'},enabled:{type:'boolean'}}},
  nullable:{anyOf:[{type:'integer',minimum:1},{type:'null'}]},
}};

await test('complete reference stays cached while the daily registry contains only plugin usage',()=>{
  assert.ok(Object.keys(BUNDLED_FIELDS.fields).length>1000);
  assert.equal(DEFAULT_FIELD_REGISTRY.referenceFieldCount,21);
  assert.equal(Object.keys(DEFAULT_FIELD_REGISTRY.fields).length,21);
  assert.equal(Object.keys(DEFAULT_FIELD_REGISTRY.config).length,14);
  assert.equal(DEFAULT_FIELD_REGISTRY.referenceMatched,false);
  assert.ok(DEFAULT_FIELD_REGISTRY.fields['approval_policy']);
  assert.equal(DEFAULT_FIELD_REGISTRY.config.approval_policy,undefined);
  assert.equal(DEFAULT_FIELD_REGISTRY.fields['tui.theme'],undefined);
  assert.ok(BUNDLED_FIELDS.fields['tui.theme']);
  assert.equal(DEFAULT_FIELD_REGISTRY.protocol,undefined,'full protocol index stays in the snapshot');
});
await test('one bundled registry works without upstream reference, external cache or installed CLI',async()=>{
  const isolated=path.join(root,'self-contained');fs.mkdirSync(isolated);
  for(const entry of fs.readdirSync(new URL('../lib/',import.meta.url)))if(entry.endsWith('.js'))fs.copyFileSync(new URL('../lib/'+entry,import.meta.url),path.join(isolated,entry));
  fs.copyFileSync(new URL('../lib/codex-registry.json',import.meta.url),path.join(isolated,'codex-registry.json'));
  fs.writeFileSync(path.join(isolated,'package.json'),'{"type":"module"}');
  const standalone=await import(pathToFileURL(path.join(isolated,'codex-fields.js')).href);
  assert.equal(standalone.BUNDLED_FIELDS.source,'bundled-registry');
  assert.deepEqual(Object.keys(standalone.BUNDLED_REGISTRY.fields).sort(),Object.keys(standalone.BUNDLED_REGISTRY.definitions).sort());
  assert.deepEqual(standalone.BUNDLED_REGISTRY.translations,BUNDLED_REGISTRY.translations);
  const store=standalone.createFieldRegistryStore({home:path.join(isolated,'data'),identify:async()=>{throw Error('CLI unavailable');}});
  const fallback=await store.get({refresh:true});assert.equal(fallback.fallback,true);assert.equal(fallback.fallbackFile,'lib/codex-registry.json');
  assert.equal(Object.keys(fallback.fields).length,21);assert.equal(Object.keys(fallback.config).length,14);
  assert.equal(fallback.updatedAt,null);assert.equal(fallback.codexVersion,null);assert.match(fallback.error,/CLI unavailable/);
  assert.deepEqual(stringEnumSpec(fallback.fields.approval_policy).values,['never','on-request']);
  assert.deepEqual(standalone.registryConfigPairs({web_search:'live'},fallback).problems,[]);
});
await test('flatten nested refs, enum and nullable definitions without guessing types',()=>{
  const fields=flattenConfigSchema(schema);
  assert.deepEqual(fields['feature.mode'].schema.enum,['one','two']);
  assert.equal(validateFieldValue('two',fields['feature.mode'].schema),true);
  assert.equal(validateFieldValue('three',fields['feature.mode'].schema),false);
  assert.equal(validateFieldValue(null,fields.nullable.schema),true);
  assert.equal(validateFieldValue(0,fields.nullable.schema),false);
});
await test('typed schema constraints include arrays, objects and unsupported recursive refs',()=>{
  const s={type:'object',required:['items'],additionalProperties:false,properties:{items:{type:'array',minItems:1,items:{type:'integer',minimum:2}}}};
  assert.equal(validateFieldValue({items:[2]},s),true);
  for(const value of [{},{items:[]},{items:['2']},{items:[1]},{items:[2],extra:1}])assert.equal(validateFieldValue(value,s),false);
  const recursive=flattenConfigSchema({properties:{cycle:{$ref:'#/definitions/Cycle'}},definitions:{Cycle:{$ref:'#/definitions/Cycle'}}});
  assert.equal(validateFieldValue({},recursive.cycle.schema),false);
});
await test('editing a compatibility table admits a new enum and alias without plugin code changes',()=>{
  const registry=compileFieldRegistry({reference:{fields:flattenConfigSchema(schema)},overrides:{version:1,fields:{
    'feature.mode':{allow:true},'old_mode':{allow:true,aliasOf:'feature.mode',deprecated:true},
  }}});
  assert.deepEqual(registryConfigPairs({old_mode:'two'},registry),{pairs:[['feature.mode','"two"']],problems:[]});
  assert.ok(registryConfigPairs({old_mode:'three'},registry).problems.length);
  assert.ok(registryConfigPairs({old_mode:'one','feature.mode':'two'},registry).problems.length);
  assert.equal(codexConfigPairs({},['old_mode=two'],registry).pairs[0][0],'feature.mode');
});
await test('installed definitions take precedence over an unmatched latest reference',()=>{
  const registry=compileFieldRegistry({codexVersion:'1.0.0',reference:{codexVersion:null,fields:{'agents.interrupt_message':{schema:{type:'string'}}}},
    localFields:{'agents.interrupt_message':{schema:{type:'boolean'}}}});
  assert.equal(registry.config['agents.interrupt_message'].type,'bool');
  assert.equal(registryConfigPairs({'agents.interrupt_message':false},registry).problems.length,0);
  assert.equal(registry.referenceMatched,false);
  assert.equal(validateSetting('agents.interrupt_message',false,registry).ok,true);
});
await test('approval strings follow local schemas and table overrides while retired values remain excluded',()=>{
  assert.deepEqual(stringEnumSpec(DEFAULT_FIELD_REGISTRY.fields.approval_policy).values,['never','on-request']);
  for(const value of ['never','on-request'])assert.equal(validateSetting('approvalPolicy',value).ok,true);
  const registry=compileFieldRegistry({codexVersion:'1.0.0',localFields:{approval_policy:{schema:{allOf:[{oneOf:[
    {type:'string',enum:['never','on-request','untrusted','on-failure','future-review']},
    {type:'object',properties:{granular:{type:'string',enum:['nested-only']}}},
  ]}]}}}});
  assert.deepEqual(stringEnumSpec(registry.fields.approval_policy).values,['never','on-request','future-review']);
  assert.equal(validateSetting('approvalPolicy','future-review',registry).ok,true);
  assert.deepEqual(derivedCodexPairs({approvalPolicy:'future-review'},registry),{pairs:[['approval_policy','future-review']],problems:[]});
  for(const value of ['untrusted','on-failure','nested-only','unknown',{granular:'nested-only'},1]) {
    assert.equal(validateSetting('approvalPolicy',value,registry).ok,false);
    assert.ok(derivedCodexPairs({approvalPolicy:value},registry).problems.length);
  }
  const overridden=compileFieldRegistry({overrides:{version:1,fields:{approval_policy:{schema:{type:'string',enum:['on-request']}}}}});
  assert.equal(validateSetting('approvalPolicy','never',overridden).ok,false);
  assert.equal(derivedCodexPairs({approvalPolicy:'never'},overridden).pairs.length,0);
  assert.ok(codexConfigPairs({approval_policy:'never'},[],registry).problems.length);
  assert.deepEqual(stringEnumSpec(undefined).values,[]);
  assert.throws(()=>compileFieldRegistry({overrides:{version:1,fields:{approval_policy:{excludedValues:'never'}}}}));
});
await test('sandbox choices follow installed definitions and explicit rules instead of a second whitelist',()=>{
  for(const value of ['workspace-write','read-only','danger-full-access'])assert.equal(validateSetting('sandboxMode',value).ok,true);
  const registry=compileFieldRegistry({codexVersion:'1.0.0',localFields:{sandbox_mode:{schema:{type:'string',enum:['read-only','future-sandbox']}}}});
  assert.deepEqual(stringEnumSpec(registry.fields.sandbox_mode).values,['read-only','future-sandbox']);
  for(const value of ['read-only','future-sandbox'])assert.equal(validateSetting('sandboxMode',value,registry).ok,true);
  for(const value of ['workspace-write','danger-full-access','unknown',1,{},true])assert.equal(validateSetting('sandboxMode',value,registry).ok,false);
  const overridden=compileFieldRegistry({overrides:{version:1,fields:{sandbox_mode:{schema:{type:'string',enum:['workspace-write']}}}}});
  assert.equal(validateSetting('sandboxMode','read-only',overridden).ok,false);
  assert.equal(validateSetting('sandboxMode','workspace-write',overridden).ok,true);
  assert.ok(codexConfigPairs({sandbox_mode:'danger-full-access'},[],registry).problems.length);
  assert.equal(validateSetting('sandboxMode','workspace-write',{fields:{}}).ok,false);
});
await test('sandbox network uses registry constraints and sends explicit boolean permission values',()=>{
  const key='sandbox_workspace_write.network_access';
  for(const value of [true,false]){
    assert.equal(validateSetting('workspaceNetworkAccess',value).ok,true);
    assert.deepEqual(derivedCodexPairs({workspaceNetworkAccess:value}),{pairs:[[key,JSON.stringify(value)]],problems:[]});
  }
  assert.deepEqual(derivedCodexPairs({workspaceNetworkAccess:null}).pairs,[]);
  assert.deepEqual(derivedCodexPairs({}).pairs,[]);
  for(const value of ['true','false',1,{},[]]){
    assert.equal(validateSetting('workspaceNetworkAccess',value).ok,false);
    assert.ok(derivedCodexPairs({workspaceNetworkAccess:value}).problems.length);
  }
  const registry=compileFieldRegistry({codexVersion:'1.0.0',localFields:{[key]:{schema:{type:'boolean',const:false}}}});
  assert.equal(validateSetting('workspaceNetworkAccess',false,registry).ok,true);
  assert.equal(validateSetting('workspaceNetworkAccess',true,registry).ok,false);
  assert.ok(derivedCodexPairs({workspaceNetworkAccess:true},registry).problems.length);
  const changed=compileFieldRegistry({overrides:{version:1,fields:{[key]:{schema:{type:'string'}}}}});
  for(const value of [true,false,'true'])assert.equal(validateSetting('workspaceNetworkAccess',value,changed).ok,false);
  assert.equal(validateSetting('workspaceNetworkAccess',false,{fields:{}}).ok,false);
  assert.ok(codexConfigPairs({[key]:true},[],registry).problems.length);
  assert.equal(validateSetting('allowFullAccess',true,changed).ok,false);
  assert.equal(DEFAULT_FIELD_REGISTRY.fields.allowFullAccess,undefined);
});
await test('version ranges and forbidden aliases cannot bypass existing run controls',()=>{
  const fields={version:1,fields:{new_flag:{allow:true,schema:{type:'boolean'},minVersion:'2.0.0'},approval_policy:{allow:true,schema:{type:'string'}},alias:{allow:true,aliasOf:'sandbox_mode',schema:{type:'string'}}}};
  const old=compileFieldRegistry({codexVersion:'1.0.0',overrides:fields});assert.equal(old.config.new_flag,undefined);
  const next=compileFieldRegistry({codexVersion:'2.0.0',overrides:fields});assert.equal(next.config.new_flag.type,'bool');
  assert.equal(next.config.approval_policy,undefined);assert.equal(next.config.alias,undefined);
  assert.throws(()=>compileFieldRegistry({overrides:{version:1,fields:{a:{allow:true,aliasOf:'b'},b:{allow:true,aliasOf:'a'}}}}));
});
await test('JSON config values retain types and encode valid TOML containers',()=>{
  const value={text:'true',nested:[false,3,{name:'x'}]};
  const registry=compileFieldRegistry({overrides:{version:1,fields:{payload:{allow:true,schema:{type:'object'}}}}});
  const pair=codexConfigPairs({payload:value},[],registry).pairs[0];assert.deepEqual(JSON.parse(pair[1]),value);
  assert.equal(tomlValue(value),'{ "text" = "true", "nested" = [false, 3, { "name" = "x" }] }');
  assert.ok(registryConfigPairs({payload:{nested:null}},registry).problems.length,'TOML has no null literal');
});
await test('initialization updates and caches exact local schema with independent latest reference',async()=>{
  const home=path.join(root,'store');let exports=0,fetches=0,clock=Date.now(),version='1.0.0';
  const options={home,now:()=>clock,ttlMs:1000,identify:async()=>({key:JSON.stringify(['fixture',version]),version}),
    exportProtocol:async()=>{exports++;return {fields:flattenConfigSchema(schema),protocol:[{name:'v2/ConfigReadResponse.json',sha256:'fixture'}]};},
    fetchSchema:async()=>{fetches++;return schema;}};
  const store=createFieldRegistryStore(options),first=await store.get();
  assert.equal(first.codexVersion,'1.0.0');assert.equal(first.fields['feature.enabled'],undefined);assert.equal(exports,1);assert.equal(fetches,1);
  const snapshot=readJson(first.paths.snapshot);assert.ok(snapshot.reference.fields['feature.enabled']);assert.ok(snapshot.localFields['feature.enabled']);
  assert.equal(snapshot.protocol.length,1);assert.equal(first.protocolSchemaCount,1);
  atomicJson(first.paths.overrides,{version:1,fields:{'feature.enabled':{allow:true}}});
  assert.ok(store.view().fields['feature.enabled']);assert.equal(store.view().config['feature.enabled'].type,'bool');
  await store.get();assert.equal(exports,1);
  const restarted=createFieldRegistryStore(options);await restarted.get();assert.equal(exports,1,'restart uses matching cached schema');
  version='2.0.0';clock+=2000;await restarted.get();assert.equal(exports,2,'changed version regenerates local protocol');
  assert.equal(readJson(path.join(home,'codex-runner/fields/index.json')).codexVersion,'2.0.0');
  assert.equal(fs.existsSync(first.paths.overrides),true);
});
await test('failed update preserves a matching snapshot, a different identity cannot reuse it',async()=>{
  const home=path.join(root,'offline');let version='1.0.0',offline=false;
  const options={home,identify:async()=>({key:version,version}),exportProtocol:async()=>{if(offline)throw Error('export unavailable');return {fields:flattenConfigSchema(schema),protocol:[]};},fetchSchema:async()=>schema};
  const store=createFieldRegistryStore(options);await store.get();offline=true;
  const first=await store.get();atomicJson(first.paths.overrides,{version:1,fields:{'feature.enabled':{allow:true}}});
  const cached=await store.get({refresh:true});assert.ok(cached.config['feature.enabled']);assert.match(cached.error,/unavailable/);
  version='2.0.0';const other=await store.get({refresh:true});assert.equal(other.config['feature.enabled'],undefined);assert.match(other.error,/unavailable/);
});
await test('manual rule edits hot reload, corrupted rules stay diagnosed and translations are untouched',async()=>{
  const home=path.join(root,'hot'),store=createFieldRegistryStore({home,identify:async()=>({key:'hot',version:'1.0.0'}),exportProtocol:async()=>({fields:{},protocol:[]}),fetchSchema:async()=>schema});
  const initial=await store.get(),translations=path.join(home,'codex-runner/i18n/zh-CN.user.json');atomicJson(translations,{keep:'用户文本'});
  atomicJson(initial.paths.overrides,{version:1,fields:{extra:{allow:true,schema:{type:'boolean'}}}});
  assert.equal(store.view().config.extra.type,'bool');
  fs.writeFileSync(initial.paths.overrides,'{bad');assert.ok(store.view().error);assert.equal(store.view().config.extra,undefined);
  assert.deepEqual(readJson(translations),{keep:'用户文本'});
});
await test('registry field differences identify additions, removals and type changes',()=>{
  assert.deepEqual(fieldRegistryDiff({old:{schema:{type:'string'}},same:{schema:{type:'boolean'}}},{next:{schema:{type:'string'}},same:{schema:{type:'string'}}}),{added:['next'],removed:['old'],changed:['same']});
});
await test('corrupt version snapshot falls back without breaking initialization or inspection',async()=>{
  const home=path.join(root,'corrupt'),options={home,identify:async()=>({key:'fixture',version:'1.0.0'}),
    exportProtocol:async()=>({fields:{},protocol:[]}),fetchSchema:async()=>schema};
  const first=await createFieldRegistryStore(options).get();
  atomicJson(first.paths.snapshot,{identity:'fixture',codexVersion:'1.0.0',reference:null,updatedAt:new Date().toISOString()});
  const store=createFieldRegistryStore({...options,exportProtocol:async()=>{throw Error('export failed');}});
  const fallback=await store.get();assert.ok(fallback.fields['agents.interrupt_message']);assert.match(fallback.error,/failed/);
  assert.doesNotThrow(()=>store.view());
});
await test('normal model discovery returns registry summary instead of the full field corpus',async()=>{
  const tool=catalogTools({defineTool:d=>d,catalog:async()=>({...FALLBACK_CATALOG,configuration:DEFAULT_FIELD_REGISTRY,settings:[{private:'large catalog text'}]})})[0];
  const result=await tool.execute({});
  assert.equal(result.configuration,undefined);assert.equal(result.settings,undefined);
  assert.equal(result.field_registry.field_count,21);assert.equal(result.field_registry.reference_field_count,21);assert.ok(JSON.stringify(result).length<20000);
});
await test('only plugin usage and enabled extensions enter localization by native key',()=>{
  const reference={fields:{'future.setting':{key:'future.setting',name:'Future setting',description:'A future feature',schema:{type:'boolean'}}}};
  const configuration=compileFieldRegistry({reference});
  const store=createCatalogI18n({home:path.join(root,'i18n')});
  const catalog={...FALLBACK_CATALOG,configuration};
  assert.equal(store.decorate(catalog).settings.some(row=>row.id==='future.setting'),false);
  const enabled=compileFieldRegistry({reference,overrides:{version:1,fields:{'future.setting':{allow:true}}}});
  assert.ok(store.decorate({...catalog,configuration:enabled}).settings.some(row=>row.id==='future.setting'));
});
await test('inactive translations stay on disk and are reused when a field is enabled',()=>{
  const store=createCatalogI18n({home:path.join(root,'hidden-translations')}),key='tui.theme';
  const catalog={...FALLBACK_CATALOG,configuration:DEFAULT_FIELD_REGISTRY};
  atomicJson(store.paths.userFile,{version:1,locale:'zh-CN',settings:{[key]:{name:'终端主题',description:'终端配色。',_source:{description:'old-metadata'}}}});
  const saved=fs.readFileSync(store.paths.userFile,'utf8');
  assert.equal(store.decorate(catalog).settings.some(row=>row.id===key),false);
  const enabled=compileFieldRegistry({overrides:{version:1,fields:{[key]:{allow:true,schema:{type:'string'}}}}});
  assert.equal(store.decorate({...catalog,configuration:enabled}).settings.find(row=>row.id===key).localized.name,'终端主题');
  const disabled=compileFieldRegistry({overrides:{version:1,fields:{[key]:{allow:false,schema:{type:'string'}}}}});
  assert.equal(store.decorate({...catalog,configuration:disabled}).settings.some(row=>row.id===key),false);
  assert.equal(fs.readFileSync(store.paths.userFile,'utf8'),saved);
});
await test('reference updates keep irrelevant changes out of daily field differences',async()=>{
  const store=createFieldRegistryStore({home:path.join(root,'reference-diff'),identify:async()=>({key:'diff',version:'1.0.0'}),
    exportProtocol:async()=>({fields:{unrelated:{schema:{type:'boolean'}}},protocol:[{name:'other.json',sha256:'fixture'}]}),
    fetchSchema:async()=>({type:'object',properties:{unrelated:{type:'boolean'},model_verbosity:{type:'string',enum:['low','high']}}})});
  const current=await store.get();
  assert.equal(current.fields.unrelated,undefined);
  for(const keys of Object.values(current.diff))assert.ok(keys.every(key=>Object.hasOwn(current.fields,key)));
  assert.ok(readJson(current.paths.snapshot).diff.added.includes('unrelated'),'full reference differences stay in snapshot');
  assert.equal(current.protocol,undefined);assert.equal(readJson(current.paths.snapshot).protocol.length,1);
});
await test('core driver receives new table-defined fields and rewritten aliases',async()=>{
  const cwd=fs.mkdtempSync(path.join(root,'dispatch-')),driver=path.join(cwd,'driver.mjs');fs.writeFileSync(path.join(cwd,'task.md'),'original task');
  fs.writeFileSync(driver,`import fs from 'node:fs';import path from 'node:path';const dir=process.argv[process.argv.indexOf('--log-dir')+1];fs.writeFileSync(path.join(dir,'received.json'),JSON.stringify(process.argv));fs.writeFileSync(path.join(dir,'result.meta.json'),JSON.stringify({status:'ok',lastMessage:'done'}));`);
  const configuration=compileFieldRegistry({overrides:{version:1,fields:{new_key:{allow:true,schema:{type:'boolean'}},old_key:{allow:true,aliasOf:'new_key',schema:{type:'boolean'}},approval_policy:{schema:{type:'string',enum:['future-review']}},sandbox_mode:{schema:{type:'string',enum:['future-sandbox','danger-full-access']}}}}});
  const options={defineTool:d=>d,resolveCwd:()=>cwd,catalog:async()=>({...FALLBACK_CATALOG,configuration})};
  const full=await buildToolDefinition({...options,config:{backend:'exec',driverPath:driver,autoModelAndEffort:true,approvalPolicy:'future-review',sandboxMode:'danger-full-access'}}).execute({label:'full',model:'gpt-6.1-sol',effort:'high',prompt_file:'task.md'},{});
  assert.equal(full.status,'ok',full.summary_text);
  const fullArgs=readJson(path.join(cwd,LOGS_REL,'runs',full.run_id,'received.json'));
  assert.equal(fullArgs[fullArgs.indexOf('--sandbox')+1],'danger-full-access');
  assert.equal(fullArgs.includes('--bypass'),false);
  assert.ok(fullArgs.includes('approval_policy=future-review'));
  assert.equal(full.full_access,true);
  const result=await buildToolDefinition({...options,config:{backend:'exec',driverPath:driver,autoModelAndEffort:true,approvalPolicy:'future-review',sandboxMode:'future-sandbox',workspaceNetworkAccess:false,codexConfig:{old_key:false}}}).execute({label:'table',model:'gpt-6.1-sol',effort:'high',prompt_file:'task.md'},{});
  assert.equal(result.status,'ok',result.summary_text);
  const args=readJson(path.join(cwd,LOGS_REL,'runs',result.run_id,'received.json'));assert.ok(args.includes('new_key=false'));assert.equal(args.some(s=>s.startsWith('old_key=')),false);
  assert.ok(args.includes('approval_policy=future-review'));
  assert.equal(args[args.indexOf('--sandbox')+1],'future-sandbox');
  assert.equal(result.sandbox_mode,'future-sandbox');
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
});
console.log('FIELD-REGISTRY-OK '+passed);
