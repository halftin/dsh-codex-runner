import { DEFAULT_FIELD_REGISTRY, BUNDLED_REGISTRY } from './codex-fields.js';
import { fieldSpec } from './field-schema.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicJson } from './run-store.js';

const bundled=BUNDLED_REGISTRY.translations;
const groups={models:['description'],efforts:['description'],tiers:['name','description'],settings:['name','description']};
const settingTexts=catalog=>catalog.configuration?.fields || DEFAULT_FIELD_REGISTRY.fields;
const empty=()=>({version:1,locale:'zh-CN',models:{},efforts:{},tiers:{},settings:{},meta:{}});
function plain(value) {return typeof value==='string'&&value.length<=200&&!/[<>\r\n\u0000-\u001f\u007f\u2028\u2029]/.test(value);}
export function validateTable(value) {
  if(!value || value.version!==1 || value.locale!=='zh-CN')throw Error('Invalid translation table version/locale');
  for(const [type,fields] of Object.entries(groups)) {
    const rows=value[type]||{};
    if(!rows||typeof rows!=='object'||Array.isArray(rows))throw Error('Invalid translation group');
    for(const [id,entry] of Object.entries(rows)) {
      if(['__proto__','constructor','prototype'].includes(id)||!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid translation entry');
      for(const field of Object.keys(entry))if(!fields.includes(field)&&field!=='_source')throw Error('Invalid translation field');
      for(const field of fields)if(entry[field]!==undefined&&!plain(entry[field]))throw Error('Translation values must be bounded plain text');
      if(entry._source!==undefined&&(!entry._source||typeof entry._source!=='object'||Object.keys(entry._source).some(field=>!fields.includes(field)||typeof entry._source[field]!=='string')))throw Error('Invalid translation source');
    }
  }
  return value;
}
// Read-only presentation layer. Registry editor owns manual translation writes.
export function createCatalogI18n({home,builtIn=bundled}={}) {
  if(typeof home!=='string'||!path.isAbsolute(home))throw Error('Translation home must be absolute');
  const dir=path.join(home,'codex-runner','i18n'),defaultFile=path.join(dir,'zh-CN.default.json'),userFile=path.join(dir,'zh-CN.user.json');
  function checkPaths() {
    for(const file of [path.join(home,'codex-runner'),dir,defaultFile,userFile]) {
      try {
        const stat=fs.lstatSync(file);
        if(stat.isSymbolicLink() || ([defaultFile,userFile].includes(file)?!stat.isFile():!stat.isDirectory()))throw Error('Translation path redirect or invalid entry');
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  try {
    checkPaths();fs.mkdirSync(dir,{recursive:true});
    const expected=JSON.stringify(builtIn,null,2);
    if(!fs.existsSync(defaultFile)||fs.readFileSync(defaultFile,'utf8')!==expected)atomicJson(defaultFile,builtIn);
  }catch{} // The bundled table remains usable if its generated cache cannot be written.
  function read(file,fallback) {
    try {if(fs.statSync(file).size>1048576)throw Error('Translation table exceeds 1 MiB');return validateTable(JSON.parse(fs.readFileSync(file,'utf8')));}
    catch{return fallback;}
  }
  function decorate(catalog) {
    checkPaths();const defaults=read(defaultFile,builtIn),user=read(userFile,empty());
    const localized=(type,id,original)=>{
      const text={},sources={};
      for(const field of groups[type]) {
        const nonempty=value=>typeof value==='string'&&value.trim()?value:null;
        const userValue=nonempty(user[type]?.[id]?.[field]),defaultValue=nonempty(defaults[type]?.[id]?.[field]);
        text[field]=userValue||defaultValue||original[field]||'';
        sources[field]=userValue?'user':defaultValue?'default':'fallback';
      }
      return {...text,source:sources};
    };
    return {...catalog,settings:Object.entries(settingTexts(catalog)).map(([id,setting])=>({id,name:setting.name,description:setting.description,type:fieldSpec(setting.schema||{}).type,
      localized:localized('settings',id,{...BUNDLED_REGISTRY.definitions[id],...Object.fromEntries(Object.entries(setting).filter(([,value])=>value!==''&&value!==undefined))})})),
      models:catalog.models.map(model=>({...model,localized:localized('models',model.id,model),efforts:model.efforts.map(e=>({...e,localized:localized('efforts',e.id,e)})),serviceTiers:model.serviceTiers.map(t=>({...t,localized:localized('tiers',t.id,t)}))}))};
  }
  return {decorate,paths:{userFile,defaultFile}};
}
const stores=new Map();
export function getCatalogI18n() {
  const home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh');
  if(!stores.has(home))stores.set(home,createCatalogI18n({home}));return stores.get(home);
}
