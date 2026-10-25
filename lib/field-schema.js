// Pure JSON-Schema validation shared with the generated browser fallback.
// Unsupported schema constructs remain catalogued, but cannot admit values.
export function validateFieldValue(value, schema) {
  function check(v,s,depth) {
    if(depth>48 || s===false || !s || s.unsupported)return false;
    if(s===true)return true;
    if(s.$ref || s.not || s.if || s.patternProperties || s.dependencies)return false;
    if(s.allOf&&!s.allOf.every(part=>check(v,part,depth+1)))return false;
    if(s.anyOf&&!s.anyOf.some(part=>check(v,part,depth+1)))return false;
    if(s.oneOf&&s.oneOf.filter(part=>check(v,part,depth+1)).length!==1)return false;
    if(Object.hasOwn(s,'const')&&JSON.stringify(s.const)!==JSON.stringify(v))return false;
    if(s.enum&&!s.enum.some(item=>JSON.stringify(item)===JSON.stringify(v)))return false;
    if(s.type) {
      const kinds=Array.isArray(s.type)?s.type:[s.type];
      if(!kinds.some(kind=>kind==='null'?v===null:kind==='array'?Array.isArray(v):kind==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):kind==='integer'?Number.isSafeInteger(v):kind==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===kind))return false;
    }
    if(typeof v==='number'&&(!Number.isFinite(v)||s.minimum!==undefined&&v<s.minimum||s.maximum!==undefined&&v>s.maximum
      ||s.exclusiveMinimum!==undefined&&v<=s.exclusiveMinimum||s.exclusiveMaximum!==undefined&&v>=s.exclusiveMaximum))return false;
    if(typeof v==='string') {
      if(v.includes('\0')||s.minLength!==undefined&&v.length<s.minLength||s.maxLength!==undefined&&v.length>s.maxLength)return false;
      if(s.pattern) {if(s.pattern.length>200)return false;try{if(!new RegExp(s.pattern,'u').test(v))return false;}catch{return false;}}
    }
    if(Array.isArray(v)) {
      if(v.length>10000||s.minItems!==undefined&&v.length<s.minItems||s.maxItems!==undefined&&v.length>s.maxItems)return false;
      if(s.uniqueItems&&new Set(v.map(item=>JSON.stringify(item))).size!==v.length)return false;
      if(s.items&&!v.every((item,index)=>check(item,Array.isArray(s.items)?s.items[index]||false:s.items,depth+1)))return false;
    } else if(v!==null&&typeof v==='object') {
      if(Object.keys(v).length>10000||(s.required||[]).some(key=>!Object.hasOwn(v,key)))return false;
      for(const [key,item] of Object.entries(v)) {
        if(['__proto__','prototype','constructor'].includes(key))return false;
        const child=Object.hasOwn(s.properties||{},key)?s.properties[key]:s.additionalProperties;
        if(child===false||child&&typeof child==='object'&&!check(item,child,depth+1))return false;
        if(s.properties&&Object.hasOwn(s.properties,key)&&!check(item,s.properties[key],depth+1))return false;
      }
    }
    return true;
  }
  return check(value,schema,0);
}

export function expandSchema(node,root,seen=new Set()) {
  if(typeof node==='boolean')return node;
  if(!node||typeof node!=='object')return {unsupported:'missing schema'};
  if(node.$ref) {
    if(!node.$ref.startsWith('#/')||seen.has(node.$ref)||seen.size>40)return {unsupported:'external or recursive reference'};
    const next=new Set(seen).add(node.$ref);
    const target=node.$ref.slice(2).split('/').reduce((value,key)=>value?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],root);
    const {$ref,...rest}=node;
    return {...expandSchema(target,root,next),...expandSchema(rest,root,next)};
  }
  const result={};
  for(const [key,value] of Object.entries(node)) {
    if(['definitions','$defs','$schema','$id'].includes(key))continue;
    if(['anyOf','oneOf','allOf'].includes(key))result[key]=value.map(part=>expandSchema(part,root,seen));
    else if(key==='properties')result[key]=Object.fromEntries(Object.entries(value).map(([name,child])=>[name,expandSchema(child,root,seen)]));
    else if(['items','additionalProperties'].includes(key))result[key]=typeof value==='boolean'?value:expandSchema(value,root,seen);
    else result[key]=value;
  }
  return result;
}

export function flattenConfigSchema(root,node=root,prefix='',out={}) {
  const schema=expandSchema(node,root);
  if(prefix)out[prefix]={key:prefix,schema,description:schema.description||'',name:prefix};
  const branches=[schema,...(schema.anyOf||schema.oneOf||schema.allOf||[])];
  for(const branch of branches) {
    for(const [key,child] of Object.entries(branch.properties||{})) {
      if(['__proto__','prototype','constructor'].includes(key))continue;
      flattenConfigSchema(root,child,prefix?prefix+'.'+key:key,out);
    }
    if(branch.additionalProperties&&typeof branch.additionalProperties==='object'&&prefix&&!prefix.split('.').includes('*'))
      flattenConfigSchema(root,branch.additionalProperties,prefix+'.*',out);
    if(branch.items&&typeof branch.items==='object'&&prefix&&!prefix.includes('[]'))flattenConfigSchema(root,branch.items,prefix+'[]',out);
  }
  return out;
}

export function fieldSpec(schema) {
  const variants=(schema.anyOf||schema.oneOf||schema.allOf||[]).filter(s=>s.type!=='null');
  if(!schema.type&&!schema.enum&&variants.length===1)schema={...variants[0],...schema};
  let type=Array.isArray(schema.type)?schema.type.filter(t=>t!=='null')[0]:schema.type;
  let values=schema.enum;
  if(!values&&variants.length&&variants.every(s=>Array.isArray(s.enum)))values=variants.flatMap(s=>s.enum);
  if(values&&values.every(v=>typeof v==='string'))return {type:'enum',values,schema};
  if(type==='boolean')type='bool';else if(type==='integer')type='number';
  return {type:type||'json',schema};
}

// Select controls expose only the schema's string variants, never enums nested
// inside object properties. Validate candidates against the whole union.
export function stringEnumSpec(field) {
  const candidates=new Set();
  function collect(schema,depth=0) {
    if(!schema||depth>48)return;
    for(const value of schema.enum||[])if(typeof value==='string')candidates.add(value);
    if(typeof schema.const==='string')candidates.add(schema.const);
    for(const key of ['anyOf','oneOf','allOf'])for(const part of schema[key]||[])collect(part,depth+1);
  }
  collect(field?.schema);
  const values=[...candidates].filter(value=>!field.excludedValues?.includes(value)&&validateFieldValue(value,field.schema));
  return {type:'enum',values,schema:{type:'string',enum:values}};
}

export function settingFieldSpec(name,field) {
  // Network permissions remain boolean because both drivers interpret true/false.
  // A changed native schema must still validate, rather than silently changing
  // the meaning of the switch.
  return name==='workspaceNetworkAccess'
    ? {type:'bool',schema:{type:'boolean',allOf:[field?.schema||{unsupported:true}]}}
    : stringEnumSpec(field);
}

export function tomlValue(value) {
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return String(value);
  if(Array.isArray(value))return '['+value.map(tomlValue).join(', ')+']';
  if(value&&typeof value==='object')return '{ '+Object.entries(value).map(([key,item])=>JSON.stringify(key)+' = '+tomlValue(item)).join(', ')+' }';
  throw Error('Cannot encode null or unsupported Codex configuration value');
}
