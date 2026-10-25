import { REASONING_ORDER, validateCatalogSelection } from './model-catalog.js';

const kinds=['mechanical','docs','review','implement','architect','rework'];
const evidenceKeys=['architecture','interface','concurrency','security','design_failure'];
// User policy ordering, not a claim that the catalog reports benchmark strength.
const modelOrder=['gpt-6-luna','gpt-6-sol','gpt-6.1-sol','gpt-6-astra'];
const pair=(model,effort)=>({model,effort});
export const DEFAULT_SELECTION_POLICY={version:1,mode:'off',floors:{
  mechanical:pair('gpt-6-luna','low'),docs:pair('gpt-6-luna','low'),review:pair('gpt-6.1-sol','medium'),
  implement:pair('gpt-6.1-sol','high'),architect:pair('gpt-6-astra','xhigh'),rework:pair('gpt-6-astra','xhigh'),
},evidence:Object.fromEntries(evidenceKeys.map(key=>[key,pair('gpt-6-astra','xhigh')])),unknown_scope:'investigation',
  downgrade:{allowed:true,require_reason:true,require_approval:false,reason_categories:['quota','scope-reduced','already-reviewed','time'],never_for:['architect']},
  quota:{below_percent:10,action:'pause'},review:{require_for_architect:true,model:'gpt-6-astra',effort:'xhigh'}};
const clone=value=>structuredClone(value);
function object(value,label,keys) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)))throw Error('Invalid '+label+' fields');
}
function merged(base,patch) {
  const out=clone(base);
  for(const [key,value] of Object.entries(patch)) {
    if(['__proto__','prototype','constructor'].includes(key))throw Error('Invalid policy property');
    out[key]=value && typeof value==='object' && !Array.isArray(value) && base[key] && typeof base[key]==='object'
      ? merged(base[key],value) : clone(value);
  }
  return out;
}
export function parsePolicy(value,catalog) {
  if(typeof value==='string') {if(value.length>65536)throw Error('selectionPolicy exceeds 64 KiB');value=JSON.parse(value);}
  value ??={};
  object(value,'selectionPolicy',Object.keys(DEFAULT_SELECTION_POLICY));
  const policy=merged(DEFAULT_SELECTION_POLICY,value);
  if(policy.version!==1 || !['off','audit','enforce'].includes(policy.mode))throw Error('Invalid policy version/mode');
  for(const [key,keys] of [['floors',kinds],['evidence',evidenceKeys]]) {
    object(policy[key],key,keys);
    for(const entry of Object.values(policy[key])) {
      object(entry,'floor',['model','effort']);
      if(typeof entry.model!=='string'||typeof entry.effort!=='string')throw Error('Invalid floor');
      if(catalog) {const error=validateCatalogSelection(catalog,entry.model,entry.effort);if(error)throw Error('Policy catalog mismatch: '+error);}
    }
  }
  object(policy.downgrade,'downgrade',['allowed','require_reason','require_approval','reason_categories','never_for']);
  for(const key of ['allowed','require_reason','require_approval'])if(typeof policy.downgrade[key]!=='boolean')throw Error('Invalid downgrade '+key);
  if(!Array.isArray(policy.downgrade.reason_categories)||policy.downgrade.reason_categories.length>20||policy.downgrade.reason_categories.some(s=>typeof s!=='string'||!/^[a-z][a-z0-9-]{0,59}$/.test(s)))throw Error('Invalid downgrade reason categories');
  if(!Array.isArray(policy.downgrade.never_for)||policy.downgrade.never_for.some(k=>!kinds.includes(k)))throw Error('Invalid never_for');
  if(!['investigation','deny'].includes(policy.unknown_scope))throw Error('Invalid unknown_scope');
  object(policy.quota,'quota',['below_percent','action']);
  if(!Number.isInteger(policy.quota.below_percent)||policy.quota.below_percent<0||policy.quota.below_percent>100||!['pause','allow-downgrade','reduce-scope','deny'].includes(policy.quota.action))throw Error('Invalid quota policy');
  object(policy.review,'review',['require_for_architect','model','effort']);
  if(typeof policy.review.require_for_architect!=='boolean'||typeof policy.review.model!=='string'||typeof policy.review.effort!=='string')throw Error('Invalid review policy');
  if(catalog){const error=validateCatalogSelection(catalog,policy.review.model,policy.review.effort);if(error)throw Error('Review policy catalog mismatch: '+error);}
  return policy;
}
export function comparePair(actual,floor) {
  if(actual.model!==floor.model && (!modelOrder.includes(actual.model)||!modelOrder.includes(floor.model)))return null;
  const effortA=REASONING_ORDER.indexOf(actual.effort),effortB=REASONING_ORDER.indexOf(floor.effort);
  if(effortA<0||effortB<0)return actual.model===floor.model && actual.effort===floor.effort?0:null;
  if(actual.model!==floor.model && modelOrder.indexOf(actual.model)<modelOrder.indexOf(floor.model))return -1;
  if(effortA<effortB)return -1;
  return actual.model===floor.model && effortA===effortB?0:1;
}
function stricterPair(left,right) {
  const comparison=comparePair(left,right);
  if(comparison===null)throw Error('Policy model ordering is unknown; use the same model or a known policy role');
  return pair(modelOrder.indexOf(left.model)>=modelOrder.indexOf(right.model)?left.model:right.model,
    REASONING_ORDER[Math.max(REASONING_ORDER.indexOf(left.effort),REASONING_ORDER.indexOf(right.effort))]);
}
export function evaluateSelection({policy,taskKind,recommended,actual,explicitModel,explicitEffort,overrideReason,downgradeReason,claims={},stage}) {
  policy=parsePolicy(policy);
  if(policy.mode==='off')return {status:'ok',model:actual.model,effort:actual.effort,selection:{
    policy_version:policy.version,policy_mode:'off',recommended_model:recommended.model,recommended_effort:recommended.effort,
    model:actual.model,effort:actual.effort,downgrade:false,downgrade_reason:null,override_reason:null,approval:null,
    comparison:'known',review_required:false}};
  let floor=policy.floors[taskKind] || null;
  const flags={architecture:claims.architecture_decision,interface:claims.interface_change,concurrency:claims.concurrency_risk,security:claims.security_risk,design_failure:claims.failure_reason==='design'};
  for(const key of evidenceKeys)if(flags[key])floor=floor?stricterPair(floor,policy.evidence[key]):policy.evidence[key];
  const recommendation=floor?stricterPair(recommended,floor):recommended;
  const selected=clone(actual);
  if(policy.mode==='enforce' && floor) {
    if(!explicitModel)selected.model=recommendation.model;
    if(!explicitEffort)selected.effort=recommendation.effort;
  }
  const comparison=floor?comparePair(selected,floor):1;
  const downgrade=policy.mode!=='off' && !!floor && (comparison===null||comparison<0);
  const audit={policy_version:policy.version,policy_mode:policy.mode,recommended_model:recommendation.model,recommended_effort:recommendation.effort,
    model:selected.model,effort:selected.effort,downgrade,downgrade_reason:downgradeReason||null,override_reason:overrideReason||null,approval:null,
    comparison:comparison===null?'unknown':'known',review_required:policy.mode==='enforce'&&taskKind==='architect'&&policy.review.require_for_architect};
  const result={status:'ok',selection:audit,model:selected.model,effort:selected.effort};
  const reject=(status,error)=>({...result,status,error});
  if(policy.mode==='enforce' && (explicitModel||explicitEffort) && (typeof overrideReason!=='string'||!overrideReason.trim()||overrideReason.length>1000))return reject('error','Explicit model/effort overrides require override_reason under enforced selection policy');
  if(stage==='investigation' && policy.unknown_scope==='deny' && policy.mode==='enforce')return reject('error','Policy denies unknown scope');
  if(downgrade && policy.mode==='enforce') {
    if(comparison===null)return reject('error','Unknown model ordering cannot satisfy an enforced floor');
    if(!policy.downgrade.allowed||policy.downgrade.never_for.includes(taskKind))return reject('error','Policy forbids downgrade for this task');
    if(policy.downgrade.require_reason && !downgradeReason)return reject('error','downgrade_reason is required');
    if(downgradeReason && !policy.downgrade.reason_categories.includes(downgradeReason))return reject('error','Invalid downgrade_reason category');
    if(policy.downgrade.require_approval)return reject('approval_required','User approval is required; no Codex task was started');
  }
  return result;
}
