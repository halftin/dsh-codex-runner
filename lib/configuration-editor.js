import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { BUNDLED_REGISTRY, DEFAULT_FIELD_REGISTRY, BUNDLED_RULES, compileFieldRegistry, validateFieldRules, resolveRegistryHome } from './codex-fields.js';
import { validateTable } from './catalog-i18n.js';
import { SETTINGS_SPEC, SETTINGS_DEFAULTS } from './core.js';
import { atomicJson } from './run-store.js';
import { settingFieldSpec } from './field-schema.js';

const translations=BUNDLED_REGISTRY.translations;
const groups=['models','efforts','tiers','settings'];
const empty=()=>({version:1,locale:'zh-CN',models:{},efforts:{},tiers:{},settings:{},meta:{}});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ranges={maxConcurrent:[1,8],statusPollingIntervalMinutes:[15,120],quotaWarningThreshold:[0,20],debugMaxBytes:[1,1073741824]};
// These are native concepts exposed through plugin profile aliases. The other
// profile fields implement the plugin's own orchestration and storage behavior.
const native={defaultModel:'model',defaultEffort:'model_reasoning_effort',serviceTier:'service_tier',sandboxMode:'sandbox_mode',approvalPolicy:'approval_policy',workspaceNetworkAccess:'sandbox_workspace_write.network_access','agents.interrupt_message':'agents.interrupt_message'};
export function configurationDefinitions(catalog) {
  return Object.fromEntries(Object.entries(SETTINGS_SPEC).map(([key,spec])=>{
    let schema=spec.schema||{type:({bool:'boolean',number:'integer',enum:'string',json:'object'})[spec.type]||spec.type};
    if(spec.values)schema={...schema,enum:spec.values};
    if(spec.type==='number'){const [minimum,maximum]=ranges[key]||[0,2147483647];schema={type:'integer',minimum,maximum};}
    if(key==='defaultModel')schema={type:'string',enum:catalog.models.map(model=>model.id)};
    if(['defaultEffort','maxEffortAllowed'].includes(key))schema={type:'string',enum:[...new Set(catalog.models.flatMap(model=>model.efforts.map(e=>e.id)))]};
    if(key==='serviceTier')schema={type:'string',enum:['off','flex','fast']};
    const field=catalog.configuration?.fields?.[native[key]];
    if(field?.schema&&['sandboxMode','approvalPolicy','workspaceNetworkAccess'].includes(key))schema=settingFieldSpec(key,field).schema;
    if(key==='agents.interrupt_message'&&field?.schema)schema=field.schema;
    return [key,{source:native[key]?'codex':'plugin',nativeKey:native[key]||null,schema,defaultValue:SETTINGS_DEFAULTS[key]??null}];
  }));
}

/** Fixed files only. Called from authenticated owner RPC, never from model tools. */
export function createConfigurationEditor({home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),builtIn=translations,registryCompiler=overrides=>compileFieldRegistry({overrides})}={}) {
  home=resolveRegistryHome(home);
  const root=path.join(home,'codex-runner'),rulesFile=path.join(root,'fields','overrides.json'),translationFile=path.join(root,'i18n','zh-CN.user.json');
  function check(file) {
    let current=home;
    for(const part of ['',...path.relative(home,file).split(path.sep)]){
      if(part)current=path.join(current,part);
      try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||(current===file?!stat.isFile():!stat.isDirectory()))throw Error('Invalid registry editor path');}catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  function read(file,fallback) {
    check(file);try{if(fs.statSync(file).size>1048576)throw Error('Registry editor file exceeds 1 MiB');const raw=fs.readFileSync(file,'utf8');return {raw,value:JSON.parse(raw)};}catch(error){if(error.code==='ENOENT')return {raw:null,value:fallback};throw error;}
  }
  function state(tolerant=false) {
    const errors=[];
    const load=(file,fallback,validate)=>{
      try{const result=read(file,fallback);validate(result.value);return result;}
      catch(error){if(!tolerant)throw error;errors.push(error.message);return {raw:null,value:structuredClone(fallback)};}
    };
    const rules=load(rulesFile,{version:1,fields:{}},validateFieldRules),user=load(translationFile,empty(),validateTable);
    const fields=Object.fromEntries([...new Set([...Object.keys(BUNDLED_RULES.fields),...Object.keys(rules.value.fields)])].map(key=>[key,{...BUNDLED_RULES.fields[key],...rules.value.fields[key]}]));
    const localized=empty();
    for(const group of groups)for(const id of new Set([...Object.keys(builtIn[group]||{}),...Object.keys(user.value[group]||{})])){
      // Empty user text means inherit. Never let an old blank override erase
      // newly bundled translations when the editor is reopened.
      const {_source,...entry}={...builtIn[group]?.[id],...Object.fromEntries(Object.entries(user.value[group]?.[id]||{}).filter(([key,value])=>key==='_source'||typeof value==='string'&&value.trim()))};localized[group][id]=entry;
    }
    return {rules,user,errors,document:{version:1,fields,translations:localized},revision:createHash('sha256').update(JSON.stringify([rules.raw,user.raw])).digest('hex')};
  }
  const metadata=catalog=>({codexVersion:catalog.configuration?.codexVersion??null,updatedAt:catalog.configuration?.updatedAt??null});
  function get(catalog) {
    const current=state(true),readOnly=current.errors.length>0;
    const configuration=readOnly?{...(catalog.configuration||DEFAULT_FIELD_REGISTRY),fallback:true,fallbackFile:'lib/codex-registry.json',error:current.errors.join('; ')}:catalog.configuration;
    return {document:{version:1,...metadata(catalog),fields:current.document.fields,translations:current.document.translations},revision:readOnly?null:current.revision,
      readOnly,definitions:configurationDefinitions({...catalog,configuration}),configuration};
  }
  function save(catalog,{document,revision,preview=false}={}) {
    if(Buffer.byteLength(JSON.stringify(document)||'')>1048576)throw Error('Registry document exceeds 1 MiB');
    const current=state();if(revision!==current.revision)throw Error('Registry changed on disk. Reopen the editor before saving.');
    if(!plain(document)||document.version!==1||Object.keys(document).some(key=>!['version','codexVersion','updatedAt','fields','translations'].includes(key)))throw Error('Invalid registry document');
    for(const [key,value] of Object.entries(metadata(catalog)))if(document[key]!==value)throw Error(key+' is generated by registry refresh. Refresh the registry to update its metadata.');
    validateFieldRules({version:1,fields:document.fields});validateTable(document.translations);
    const overrides={version:1,fields:{}};
    // Write only changes to bundled rules; unchanged defaults continue to update.
    for(const [key,rule] of Object.entries(document.fields)){
      const diff=Object.fromEntries(Object.entries(rule).filter(([name,value])=>!equal(value,BUNDLED_RULES.fields[key]?.[name])));
      if(Object.keys(diff).length)overrides.fields[key]=diff;
    }
    for(const key of Object.keys(BUNDLED_RULES.fields))if(!Object.hasOwn(document.fields,key))overrides.fields[key]={allow:false,used:false};
    const configuration={...catalog.configuration,...registryCompiler(overrides),...metadata(catalog)},user=structuredClone(current.user.value);
    for(const group of groups){
      user[group]||={};
      const desired=document.translations[group]||{},before=current.document.translations[group];
      for(const id of new Set([...Object.keys(before),...Object.keys(desired)])){
        for(const field of group==='models'||group==='efforts'?['description']:['name','description']){
          const value=desired[id]?.[field];if(equal(value,before[id]?.[field]))continue;
          if(typeof value==='string'&&value.trim()){
            user[group][id]||={};user[group][id][field]=value;
            if(user[group][id]._source)delete user[group][id]._source[field];
          }else if(user[group][id]){delete user[group][id][field];if(user[group][id]._source)delete user[group][id]._source[field];}
        }
      }
    }
    validateTable(user);
    for(const value of [overrides,user])if(Buffer.byteLength(JSON.stringify(value,null,2))>1048576)throw Error('Registry editor file exceeds 1 MiB');
    if(preview)return {configuration,definitions:configurationDefinitions({...catalog,configuration})};
    const changes=[[rulesFile,current.rules,overrides],[translationFile,current.user,user]].filter(([,before,value])=>!equal(before.value,value));
    const written=[];
    try{
      for(const [file,before,value] of changes){check(file);fs.mkdirSync(path.dirname(file),{recursive:true});atomicJson(file,value);written.push([file,before]);}
    }catch(error){
      for(const [file,before] of written.reverse()){if(before.raw===null)fs.unlinkSync(file);else atomicJson(file,before.value);}
      throw error;
    }
    return {...get({...catalog,configuration}),configuration};
  }
  return {get,save};
}
