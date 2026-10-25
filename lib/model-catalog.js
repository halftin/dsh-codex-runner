import { getFieldRegistry } from './codex-fields.js';
import { getCatalogI18n } from './catalog-i18n.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withAppServer } from './app-server-client.js';
import { resolveCodexExe, codexEnvironment } from './executable.js';
import { accountFingerprint } from './quota-policy.js';
import { atomicJson, readJson } from './run-store.js';

export const FALLBACK_CATALOG = JSON.parse(fs.readFileSync(new URL('./model-catalog.fallback.json', import.meta.url), 'utf8'));
export const REASONING_ORDER = ['low','medium','high','xhigh','max','ultra'];
const digest = value => createHash('sha256').update(value).digest('hex');
const bounded = value => typeof value === 'string' ? value.slice(0, 4000) : '';
export function normalizeModels(data) {
  if (!Array.isArray(data)) throw Error('Invalid model/list data');
  const models = data.map(raw => {
    const id = raw.model || raw.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id)) throw Error('Invalid catalog model ID');
    const efforts = (raw.supportedReasoningEfforts || raw.efforts || []).map(e => ({id:e.reasoningEffort || e.id,description:bounded(e.description)}));
    if (!efforts.length || efforts.some(e => typeof e.id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(e.id))) throw Error('Invalid model reasoning efforts');
    const tiers = (raw.serviceTiers || []).map(t => ({id:t.id,name:bounded(t.name || t.id),description:bounded(t.description)}));
    if (tiers.some(t => typeof t.id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(t.id))) throw Error('Invalid model service tiers');
    return { id,model:id,displayName:bounded(raw.displayName || id),description:bounded(raw.description),
      hidden:raw.hidden===true,isDefault:raw.isDefault===true,defaultReasoningEffort:raw.defaultReasoningEffort || efforts[0].id,
      efforts,serviceTiers:tiers,inputModalities:raw.inputModalities || [],multiAgentVersion:raw.multiAgentVersion || null };
  });
  if (!models.length || new Set(models.map(m=>m.id)).size !== models.length) throw Error('Empty or duplicate model catalog');
  return models;
}
export async function fetchCatalog({timeoutMs=15000,connect=withAppServer,executable,cwd,env}={}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('Invalid catalog timeout');
  return connect(async client => {
    let cursor,models=[],pages=0;const seen=new Set();
    do {
      if (++pages>50 || (cursor && seen.has(cursor))) throw Error('Invalid catalog pagination');
      if(cursor)seen.add(cursor);
      const page=await client.request('model/list',{limit:100,...(cursor?{cursor}:{})},timeoutMs);
      if(!Array.isArray(page.data))throw Error('Invalid model/list page');
      models.push(...page.data);cursor=page.nextCursor || null;
    } while(cursor);
    let fingerprint=null;
    try { fingerprint=accountFingerprint(await client.request('account/read',{refreshToken:false},timeoutMs)); } catch {}
    return { models:normalizeModels(models),accountFingerprint:fingerprint,fetchedAt:new Date().toISOString(),source:'app-server',stale:false };
  },{executable,cwd,timeoutMs,env});
}
export function createCatalogStore({cacheFile,identity,fetcher=fetchCatalog,now=Date.now,ttlMs=86400000,onCatalog=()=>{}}) {
  let memory=null,pending=null,lastFailure=0;
  return {
    async get({refresh=false,timeoutMs=15000}={}) {
      const identityKey=await identity();
      if(memory?.identityKey!==identityKey)memory=null;
      if(!memory) {
        const disk=readJson(cacheFile);
        if(disk?.identityKey===identityKey)try { memory={...disk,models:normalizeModels(disk.models)}; }catch{}
      }
      const expired=!memory || now()-Date.parse(memory.fetchedAt)>=ttlMs;
      if(!refresh && memory && !expired) {onCatalog(memory);return {...structuredClone(memory),cached:true};}
      if(!refresh && lastFailure && now()-lastFailure<60000) {
        const fallback=memory || {models:structuredClone(FALLBACK_CATALOG.models),source:'fallback',fetchedAt:null};
        onCatalog(fallback);return {...structuredClone(fallback),stale:true,cached:!!memory};
      }
      if(!pending)pending=(async()=>{
        try {
          const fresh=await fetcher({timeoutMs});
          const models=normalizeModels(fresh.models);
          memory={...fresh,models,identityKey,cacheKey:digest(identityKey+':'+(fresh.accountFingerprint||'anonymous'))};
          lastFailure=0;
          try {atomicJson(cacheFile,memory);}catch(error){memory.cacheError=error.message;}
          onCatalog(memory);return {...structuredClone(memory),cached:false};
        } catch(error) {
          lastFailure=now();
          const fallback=memory || {models:structuredClone(FALLBACK_CATALOG.models),source:'fallback',fetchedAt:null};
          onCatalog(fallback);return {...structuredClone(fallback),cached:!!memory,stale:true,error:String(error.message).slice(0,1000)};
        } finally {pending=null;}
      })();
      return pending;
    },
  };
}
let current={models:structuredClone(FALLBACK_CATALOG.models),source:'fallback',stale:true,fetchedAt:null};
const listeners=new Set();
export function onCatalog(listener) {listeners.add(listener);return ()=>listeners.delete(listener);}
const stores=new Map(),versions=new Map();
export function peekCatalog() {return structuredClone(current);}
export async function getCatalog(options={}) {
  const settings=options.settings||{},env=codexEnvironment(settings);
  const home=process.env.DSH_HOME || path.join(os.homedir(),'.dsh');
  const codexHome=env.CODEX_HOME || path.join(os.homedir(),'.codex');
  let executable;
  let discoveryError;
  try {executable=resolveCodexExe(settings,{env});}catch(error){discoveryError=error;}
  const storeId=JSON.stringify([home,codexHome,executable,process.env.NODE_OPTIONS||'']);
  if(!stores.has(storeId))stores.set(storeId,createCatalogStore({
    cacheFile:path.join(home,'codex-runner','cache','model-catalog.json'),
    identity:()=>{
      let version='unavailable',auth='anonymous';
      if(executable)try {
        const stat=fs.statSync(executable),key=executable+':'+stat.mtimeMs+':'+stat.size;
        if(!versions.has(key))versions.set(key,execFileSync(executable,['--version'],{env,encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']}).trim());
        version=versions.get(key);
      }catch{}
      try {auth=digest(fs.readFileSync(path.join(codexHome,'auth.json')));}catch{}
      return digest(JSON.stringify({executable,version,codexHome,auth}));
    },
    fetcher:args=>{if(discoveryError)throw discoveryError;return fetchCatalog({...args,executable,env});},onCatalog:value=>{current=value;for(const listener of listeners)listener(value);},
  }));
  const [view,configuration]=await Promise.all([stores.get(storeId).get(options),getFieldRegistry({settings,refresh:options.refresh===true})]);
  view.configuration=configuration;
  try{return getCatalogI18n().decorate(view);}catch(error){return {...view,i18n_error:error.message};}
}
export function validateCatalogSelection(catalog,model,effort,tier='off') {
  const item=catalog.models.find(m=>m.id===model || m.model===model);
  if(!item)return 'Requested model is not in the catalog; see codex_models: '+model;
  if(!item.efforts.some(e=>e.id===effort))return 'Requested effort is not supported by '+model+': '+effort;
  const mapped=tier==='fast'?'priority':tier;
  if(mapped && mapped!=='off' && !item.serviceTiers.some(t=>t.id===mapped))return 'Requested service tier is not advertised for '+model+': '+mapped;
  return null;
}
export function catalogTools({defineTool,catalog=getCatalog}) {
  return [defineTool({name:'codex_models',description:'Read available models, reasoning efforts and service tiers. No model turn is started.',
    parameters:{refresh:{type:'boolean'},include_hidden:{type:'boolean'}},output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:v.summary_text}]},
    isConcurrencySafe:()=>true,presentCall:()=>({card:'generic',title:'Codex models',kind:'read'}),
    async execute(args={}) {const view=await catalog({refresh:args.refresh===true});const models=view.models.filter(m=>args.include_hidden || !m.hidden);
      // Full registry data belongs to the local table / settings RPC, not every
      // DSH model-list result. Keep ordinary orchestration token use bounded.
      const {configuration,settings,...metadata}=view;
      const field_registry=configuration?{codex_version:configuration.codexVersion,source:configuration.source,field_count:Object.keys(configuration.fields).length,
        reference_field_count:configuration.referenceFieldCount,local_schema_field_count:configuration.localFieldCount,
        protocol_schema_count:configuration.protocolSchemaCount,reference_matched:configuration.referenceMatched,paths:configuration.paths,error:configuration.error}:null;
      return {...metadata,models,field_registry,status:'ok',fetched_at:view.fetchedAt,summary_text:models.map(m=>m.id+' ['+m.efforts.map(e=>e.id).join('/')+']'+(m.localized?.description?' '+m.localized.description:'')).join('\n')+'\nsource='+view.source+' stale='+view.stale};},
  })];
}
