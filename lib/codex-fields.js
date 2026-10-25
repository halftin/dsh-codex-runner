import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCodexExe,codexEnvironment } from './executable.js';
import { atomicJson,readJson } from './run-store.js';
import { flattenConfigSchema,fieldSpec,validateFieldValue,tomlValue } from './field-schema.js';

export const FIELD_SCHEMA_URL='https://developers.openai.com/codex/config-schema.json';
export const BUNDLED_REGISTRY=JSON.parse(fs.readFileSync(new URL('./codex-registry.json',import.meta.url),'utf8'));
export const BUNDLED_RULES={version:BUNDLED_REGISTRY.version,fields:BUNDLED_REGISTRY.fields};
const bundledReference={version:1,source:'bundled-registry',codexVersion:BUNDLED_REGISTRY.codexVersion,fields:BUNDLED_REGISTRY.definitions};
// The large upstream reference is supplementary. The compact registry remains
// usable on its own if the reference file is unavailable or malformed.
export const BUNDLED_FIELDS=(()=>{try{const value=JSON.parse(fs.readFileSync(new URL('./codex-fields.default.json',import.meta.url),'utf8'));if(!value.fields||typeof value.fields!=='object')throw Error('Invalid bundled reference');return value;}catch{return bundledReference;}})();
export const SETTING_FIELD_KEYS={approvalPolicy:'approval_policy',sandboxMode:'sandbox_mode',workspaceNetworkAccess:'sandbox_workspace_write.network_access'};
const run=promisify(execFile),digest=value=>createHash('sha256').update(value).digest('hex');
const forbidden=key=>['approval_policy','sandbox_mode','sandbox_workspace_write','model','model_reasoning_effort','service_tier'].some(root=>key===root||key.startsWith(root+'.'));
const safeKey=key=>typeof key==='string'&&/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(key)&&!key.split('.').some(part=>['__proto__','constructor','prototype'].includes(part));
const validSnapshot=value=>value&&typeof value.identity==='string'&&typeof value.codexVersion==='string'
  &&value.reference?.fields&&typeof value.reference.fields==='object'&&!Array.isArray(value.reference.fields)
  &&value.localFields&&typeof value.localFields==='object'&&!Array.isArray(value.localFields)&&Array.isArray(value.protocol);
const versionParts=value=>typeof value==='string'&&value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)?.slice(1).map(Number);
function compare(a,b){for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
function applicable(rule,version) {
  const v=versionParts(version);if((rule.minVersion||rule.maxVersion)&&!v)return false;
  return !(rule.minVersion&&compare(v,versionParts(rule.minVersion))<0||rule.maxVersion&&compare(v,versionParts(rule.maxVersion))>0);
}
export function validateFieldRules(value) {
  if(!value||value.version!==1||!value.fields||typeof value.fields!=='object'||Array.isArray(value.fields))throw Error('Invalid field compatibility table');
  for(const [key,rule] of Object.entries(value.fields)) {
    if(!safeKey(key)||!rule||typeof rule!=='object'||Array.isArray(rule))throw Error('Invalid field rule');
    const allowed=['allow','used','aliasOf','schema','fallbackSchema','profile','name','description','deprecated','minVersion','maxVersion','excludedValues'];
    if(Object.keys(rule).some(k=>!allowed.includes(k)))throw Error('Unknown field rule property: '+key);
    for(const name of ['allow','used','profile','deprecated'])if(rule[name]!==undefined&&typeof rule[name]!=='boolean')throw Error('Expected boolean rule: '+name);
    if(rule.excludedValues!==undefined&&(!Array.isArray(rule.excludedValues)||rule.excludedValues.length>200||rule.excludedValues.some(value=>typeof value!=='string')))throw Error('Invalid excluded enum values');
    if(rule.aliasOf!==undefined&&!safeKey(rule.aliasOf))throw Error('Invalid field alias');
    for(const name of ['minVersion','maxVersion'])if(rule[name]!==undefined&&!versionParts(rule[name]))throw Error('Invalid field rule version');
    for(const name of ['schema','fallbackSchema'])if(rule[name]!==undefined&&(!rule[name]||typeof rule[name]!=='object'||Array.isArray(rule[name])))throw Error('Invalid field schema rule');
    for(const name of ['name','description'])if(rule[name]!==undefined&&(typeof rule[name]!=='string'||rule[name].length>4000))throw Error('Invalid field text');
  }
  return value;
}
export function compileFieldRegistry({reference=bundledReference,localFields={},rules=BUNDLED_RULES,overrides={version:1,fields:{}},codexVersion=null,source='bundled',error=null,protocol=[]}={}) {
  validateFieldRules(rules);validateFieldRules(overrides);
  const merged=Object.fromEntries([...new Set([...Object.keys(rules.fields),...Object.keys(overrides.fields)])].map(key=>[key,{...rules.fields[key],...overrides.fields[key]}]));
  // Full upstream definitions remain in the snapshot. Only explicit plugin
  // usage and enabled extensions enter the everyday registry and localization.
  const referenceFields=reference.fields||{};
  const lookup=(key,explicitExtension=false)=>{
    const field=referenceFields[key]||(explicitExtension&&reference===bundledReference?BUNDLED_FIELDS.fields[key]:null);
    return localFields[key]?{...localFields[key],source:'installed-protocol',codexVersion,availability:'declared-by-installed-protocol'}
      :field?{...field,source:reference.source||'reference',codexVersion:reference.codexVersion||null,availability:'reference-only'}:null;
  };
  const fields={},config={};
  for(const [key,rule] of Object.entries(merged)) {
    if(!applicable(rule,codexVersion)||!(rule.allow===true||rule.used===true))continue;
    const target=rule.aliasOf||key;
    if(rule.aliasOf&&merged[target]?.aliasOf)throw Error('Chained/cyclic field aliases are not supported');
    const discovered=lookup(target,overrides.fields[key]?.allow===true)||lookup(key,overrides.fields[key]?.allow===true);
    const schema=rule.schema||localFields[target]?.schema
      || (reference.codexVersion&&reference.codexVersion===codexVersion?discovered?.schema:null)
      || rule.fallbackSchema || (overrides.fields[key]?.allow===true?discovered?.schema:null);
    fields[key]={...discovered,key,name:rule.name||discovered?.name||key,description:rule.description||discovered?.description||'',
      schema:schema||discovered?.schema,referenceSchema:discovered?.schema||null,source:localFields[target]?'installed-protocol':reference.source||'reference',deprecated:rule.deprecated===true,
      aliasOf:rule.aliasOf||null,allowed:rule.allow===true&&!forbidden(key)&&!forbidden(target),...(rule.excludedValues?{excludedValues:rule.excludedValues}:{})};
    if(!schema||rule.allow!==true||forbidden(key)||forbidden(target))continue;
    config[key]={...fieldSpec(schema),target,...(rule.deprecated?{deprecated:true}:{})};
  }
  return {version:1,codexVersion,source,referenceSource:reference.source,referenceVersion:reference.codexVersion||null,
    referenceMatched:!!codexVersion&&reference.codexVersion===codexVersion,
    referenceFieldCount:Object.keys(referenceFields).length,localFieldCount:Object.keys(localFields).length,
    protocolSchemaCount:protocol.length,fields,config,error,...(source==='bundled'?{fallback:true,fallbackFile:'lib/codex-registry.json'}:{})};
}
export const DEFAULT_FIELD_REGISTRY=compileFieldRegistry();
// DSH_HOME itself is an explicitly chosen storage root and may be a Windows
// junction. Pin its real location before checking redirects inside that root.
export function resolveRegistryHome(home) {
  if(typeof home!=='string'||!path.isAbsolute(home))throw Error('Field registry home must be absolute');
  try{return fs.realpathSync.native(home);}catch(error){if(error.code==='ENOENT')return path.resolve(home);throw error;}
}
export function registryConfigPairs(values,registry=DEFAULT_FIELD_REGISTRY) {
  const pairs=[],problems=[],targets=new Map();
  for(const [key,value] of Object.entries(values||{})) {
    const spec=Object.hasOwn(registry.config,key)&&registry.config[key];
    if(!spec){problems.push('Unsupported Codex configuration: '+key);continue;}
    if(!validateFieldValue(value,spec.schema)){problems.push('Invalid Codex configuration value: '+key);continue;}
    try {tomlValue(value);}catch{problems.push('Value is not representable in Codex TOML configuration: '+key);continue;}
    const target=spec.target||key;
    if(targets.has(target)){problems.push('Conflicting Codex configuration aliases: '+key+' / '+targets.get(target));continue;}
    targets.set(target,key);pairs.push([target,JSON.stringify(value)]);
  }
  return {pairs,problems};
}
function safeFile(file,root) {
  const rel=path.relative(path.resolve(root),path.resolve(file));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Field registry path escaped');
  let current=path.resolve(root);
  for(const part of ['',...rel.split(path.sep)]) {
    if(part)current=path.join(current,part);
    try {const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw Error('Field registry redirect');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return file;
}
export function fieldRegistryDiff(before={},after={}) {
  return {added:Object.keys(after).filter(k=>!Object.hasOwn(before,k)),removed:Object.keys(before).filter(k=>!Object.hasOwn(after,k)),
    changed:Object.keys(after).filter(k=>Object.hasOwn(before,k)&&JSON.stringify(before[k].schema)!==JSON.stringify(after[k].schema))};
}
export function createFieldRegistryStore({home,identify,exportProtocol,fetchSchema=async()=>{
  const response=await fetch(FIELD_SCHEMA_URL,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('Official field schema HTTP '+response.status);
  const text=await response.text();if(text.length>4*1024*1024)throw Error('Official field schema too large');return JSON.parse(text);
},now=Date.now,ttlMs=86400000,identityHint=null}={}) {
  home=resolveRegistryHome(home);
  const root=path.join(home,'codex-runner','fields'),overrideFile=path.join(root,'overrides.json');
  let active=null,pending=null,lastAttempt=0;
  const file=name=>safeFile(path.join(root,name),home);
  try {const index=readJson(file('index.json'));if(index?.snapshot&&path.basename(index.snapshot)===index.snapshot){
    const saved=readJson(file(index.snapshot)),parts=saved?.identity&&JSON.parse(saved.identity);
    if(validSnapshot(saved)&&(!identityHint||identityHint.every((part,i)=>part===parts?.[i])))active={...saved,snapshotFile:file(index.snapshot),source:'cache'};
  }}catch{}

  function view() {
    let overrides={version:1,fields:{}},error=active?.error||null;
    try {const target=file('overrides.json');if(fs.existsSync(target)) {if(fs.statSync(target).size>1024*1024)throw Error('Field overrides exceed 1 MiB');overrides=validateFieldRules(JSON.parse(fs.readFileSync(target,'utf8')));}}catch(e){error=e.message;overrides={version:1,fields:{}};}
    try {
      const registry=compileFieldRegistry({...active,overrides,error});
      const relevant=changes=>Object.fromEntries(['added','removed','changed'].map(kind=>[kind,(changes?.[kind]||[]).filter(key=>Object.hasOwn(registry.fields,key))]));
      return {...registry,...(!active?.reference?{fallback:true,fallbackFile:'lib/codex-registry.json'}:{}),updatedAt:active?.updatedAt||null,
      stale:!active?.updatedAt||now()-Date.parse(active.updatedAt)>ttlMs,
      paths:{overrides:overrideFile,snapshot:active?.snapshotFile||null},diff:relevant(active?.diff)};}
    catch(e){return {...compileFieldRegistry({codexVersion:active?.codexVersion||null,error:e.message}),paths:{overrides:overrideFile,snapshot:active?.snapshotFile||null}};}
  }
  return {view,preview:overrides=>compileFieldRegistry({...active,overrides}),async get({refresh=false}={}) {
    if(pending)return pending;
    if(active&&!refresh&&now()-lastAttempt<ttlMs)return view();
    lastAttempt=now();
    pending=(async()=>{
      let identity;
      try {
        const overrides=file('overrides.json');if(!fs.existsSync(overrides))atomicJson(overrides,{version:1,fields:{}});
        identity=await identify();
        if(!identity?.version||!identity?.key)throw Error('Installed Codex version could not be identified');
        const key=digest(identity.key),snapshotFile=file(key+'.json'),cached=readJson(snapshotFile);
        if(validSnapshot(cached)&&cached.codexVersion===identity.version&&cached.identity===identity.key)active={...cached,snapshotFile,source:'cache'};
        if(active?.identity===identity.key&&!refresh&&now()-Date.parse(active.updatedAt)<ttlMs)return view();
        const local=await exportProtocol(identity,file('protocol-'+key+'-'+randomUUID()));
        let reference=active?.reference||BUNDLED_FIELDS,referenceError=null;
        try {const schema=await fetchSchema();reference={version:1,source:FIELD_SCHEMA_URL,codexVersion:null,fields:flattenConfigSchema(schema)};}
        catch(e){referenceError='Official reference update failed: '+e.message;}
        const previous=active?.reference?.fields||BUNDLED_FIELDS.fields;
        const next={identity:identity.key,codexVersion:identity.version,source:'installed-protocol',updatedAt:new Date(now()).toISOString(),
          reference,localFields:local.fields,protocol:local.protocol,diff:fieldRegistryDiff(previous,reference.fields),error:referenceError};
        compileFieldRegistry(next);atomicJson(snapshotFile,next);active={...next,snapshotFile};
        atomicJson(file('index.json'),{version:1,codexVersion:identity.version,snapshot:path.basename(snapshotFile),overrides:'overrides.json',
          protocolDirectory:local.directory||null,updatedAt:next.updatedAt,diff:next.diff});
      }catch(error) {
        // Never carry a previous executable's definitions across identities.
        if(identity?.key&&active?.identity!==identity.key)active=null;
        active={...active,codexVersion:identity?.version||active?.codexVersion||null,error:error.message,source:active?'cache':'bundled'};
      }finally{pending=null;}
      return view();
    })();
    return pending;
  }};
}
const stores=new Map();
function defaultStore(settings={}) {
  // The native export callback must share the store's canonical storage root.
  // Comparing resolved exports to the original junction alias falsely reports escape.
  const home=resolveRegistryHome(process.env.DSH_HOME||path.join(os.homedir(),'.dsh')),env=codexEnvironment(settings);
  const executable=resolveCodexExe(settings,{env});
  const identityHint=[executable,fs.statSync(executable).mtimeMs,fs.statSync(executable).size];
  const id=JSON.stringify([home,...identityHint,env.CODEX_HOME,env.NODE_OPTIONS]);
  if(!stores.has(id))stores.set(id,createFieldRegistryStore({home,identityHint,identify:async()=>{
    const {stdout}=await run(executable,['--version'],{env,windowsHide:true,timeout:5000,maxBuffer:65536});
    const version=stdout.match(/codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)?.[1];
    const stat=fs.statSync(executable);return {version,key:JSON.stringify([executable,stat.mtimeMs,stat.size,version])};
  },exportProtocol:async(identity,dir)=>{
    await run(executable,['app-server','generate-json-schema','--out',dir],{env,windowsHide:true,timeout:20000,maxBuffer:1048576});
    const protocol=[];let fields={};
    for(const item of fs.readdirSync(dir,{recursive:true})) {
      if(typeof item!=='string'||!item.endsWith('.json'))continue;
      const target=safeFile(path.join(dir,item),home),stat=fs.statSync(target);if(!stat.isFile()||stat.size>8*1024*1024)continue;
      const content=fs.readFileSync(target,'utf8');protocol.push({name:item.replaceAll('\\','/'),sha256:digest(content)});
      if(item.replaceAll('\\','/').endsWith('ConfigReadResponse.json')) {
        const schema=JSON.parse(content),node=schema.definitions?.Config;
        if(node)fields=flattenConfigSchema(schema,node);
      }
    }
    if(!protocol.length)throw Error('Installed Codex exported no protocol definitions');
    return {fields,protocol,directory:path.basename(dir)};
  }}));
  return stores.get(id);
}
export function getFieldRegistrySync({settings={}}={}) {
  try{return defaultStore(settings).view();}catch(error){return {...DEFAULT_FIELD_REGISTRY,error:error.message};}
}
export function previewFieldRegistry(overrides,{settings={}}={}) {
  validateFieldRules(overrides);
  try{return defaultStore(settings).preview(overrides);}catch{return compileFieldRegistry({overrides});}
}
export async function getFieldRegistry({settings={},refresh=false}={}) {
  try {const store=defaultStore(settings);return process.env.CODEX_RUNNER_SCHEMA_OFFLINE==='1'?store.view():await store.get({refresh});}
  catch(error){return {...DEFAULT_FIELD_REGISTRY,error:error.message};}
}
