import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCatalogI18n, validateTable } from '../lib/catalog-i18n.js';
import { createConfigurationEditor } from '../lib/configuration-editor.js';
import { FALLBACK_CATALOG } from '../lib/model-catalog.js';
import { atomicJson, readJson } from '../lib/run-store.js';
import { BUNDLED_REGISTRY, DEFAULT_FIELD_REGISTRY } from '../lib/codex-fields.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-i18n-'));
const catalog={...structuredClone(FALLBACK_CATALOG),configuration:DEFAULT_FIELD_REGISTRY};
catalog.models[0].description='Lightweight work';
catalog.models.push({id:'future-model',model:'future-model',displayName:'Future',description:'Untranslated source text',efforts:[{id:'high',description:'Deep reasoning'}],serviceTiers:[]});
const store=createCatalogI18n({home:root});
let pass=0;async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
try{
await test('all bundled settings have complete Chinese text and English source fallbacks',()=>{
  const bundled=BUNDLED_REGISTRY.translations.settings;
  assert.equal(Object.keys(bundled).length,21);
  for(const [key,field] of Object.entries(DEFAULT_FIELD_REGISTRY.fields))for(const name of ['name','description']){
    assert.match(bundled[key][name],/[\u3400-\u9fff]/,key+' '+name);
    assert.ok(bundled[key][name].length<=200);assert.ok(field[name].trim());
  }
  const sparse={...catalog,configuration:{...DEFAULT_FIELD_REGISTRY,fields:structuredClone(DEFAULT_FIELD_REGISTRY.fields)}};
  sparse.configuration.fields.log_dir.description='';
  assert.equal(store.decorate(sparse).settings.find(row=>row.id==='log_dir').localized.description,bundled.log_dir.description);
});
await test('native IDs, names, source text and types stay unchanged while descriptions are localized',()=>{
  const view=store.decorate(catalog),setting=view.settings.find(row=>row.id==='agents.interrupt_message');
  assert.equal(view.models[0].id,'gpt-6-luna');assert.equal(view.models[0].description,'Lightweight work');
  assert.equal(view.models[0].localized.displayName,undefined);assert.equal(view.models[0].localized.description,'机械任务与轻量工作');
  assert.equal(view.models[0].efforts[0].localized.name,undefined);
  assert.equal(view.models.at(-1).localized.description,'Untranslated source text');
  assert.equal(setting.type,'bool');assert.equal(setting.localized.name,'记录原生中断消息');
  assert.equal(fs.existsSync(store.paths.userFile),false,'reading never creates user overrides');
});
await test('registry editor manual preview, save, hot reload and clear retain translation behavior',()=>{
  const editor=createConfigurationEditor({home:root}),before=editor.get(catalog),document=structuredClone(before.document);
  document.translations.models['gpt-6-luna'].description='用户的轻量任务说明';
  document.translations.settings.log_dir.name='我的日志目录';
  editor.save(catalog,{document,revision:before.revision,preview:true});assert.equal(fs.existsSync(store.paths.userFile),false);
  editor.save(catalog,{document,revision:before.revision});
  assert.equal(store.decorate(catalog).models[0].localized.description,'用户的轻量任务说明');
  assert.equal(store.decorate(catalog).settings.find(row=>row.id==='log_dir').localized.name,'我的日志目录');
  const saved=readJson(store.paths.userFile);assert.equal(saved.models['gpt-6-luna']._source,undefined,'manual edits no longer generate unused source tracking');
  saved.models['gpt-6-luna'].description='直接编辑的用户说明';atomicJson(store.paths.userFile,saved);
  assert.equal(store.decorate(catalog).models[0].localized.description,'直接编辑的用户说明');
  const reopen=editor.get(catalog);delete reopen.document.translations.models['gpt-6-luna'];
  editor.save(catalog,{document:reopen.document,revision:reopen.revision});
  assert.equal(store.decorate(catalog).models[0].localized.description,'机械任务与轻量工作');
});
await test('blank overrides inherit defaults and legacy metadata remains readable without rewriting user data',()=>{
  const table=readJson(store.paths.userFile);table.settings.log_dir={name:'',description:'   ',_source:{name:'old-source'}};
  table.models['removed-model']={description:'保留的旧模型说明'};atomicJson(store.paths.userFile,table);
  const original=fs.readFileSync(store.paths.userFile,'utf8');
  assert.equal(store.decorate(catalog).settings.find(row=>row.id==='log_dir').localized.name,'Codex 日志目录');
  assert.equal(fs.readFileSync(store.paths.userFile,'utf8'),original);
});
await test('manual translation input validation rejects HTML, controls, oversized strings and renamed native identifiers',()=>{
  for(const value of ['<b>HTML</b>','line\ninjection','a'.repeat(201)])assert.throws(()=>validateTable({version:1,locale:'zh-CN',models:{sample:{description:value}}}));
  assert.throws(()=>validateTable({version:1,locale:'zh-CN',models:{sample:{displayName:'renamed'}}}));
  assert.throws(()=>validateTable({version:1,locale:'zh-CN',efforts:{high:{name:'renamed'}}}));
});
await test('corrupt user/default caches fall back without damaging files; editor refuses invalid user writes',()=>{
  const saved=fs.readFileSync(store.paths.userFile,'utf8');fs.writeFileSync(store.paths.userFile,'{bad');
  assert.equal(store.decorate(catalog).models[0].localized.description,'机械任务与轻量工作');
  const editor=createConfigurationEditor({home:root}),view=editor.get(catalog);assert.equal(view.readOnly,true);
  assert.throws(()=>editor.save(catalog,{document:view.document,revision:view.revision}));
  assert.equal(fs.readFileSync(store.paths.userFile,'utf8'),'{bad');
  fs.writeFileSync(store.paths.userFile,saved);fs.writeFileSync(store.paths.defaultFile,'{bad');
  assert.equal(store.decorate(catalog).models[0].localized.description,'机械任务与轻量工作');
});
console.log('I18N-OK '+pass);
}finally{fs.rmSync(root,{recursive:true,force:true});}
