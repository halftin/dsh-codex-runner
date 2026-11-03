// Offline interaction tests. Rendering and persistence are substitutes; optionally
// use an extracted installed SettingsFormModel via DSH_TEST_FORM_MODULE.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadEffectiveSettings } from '../lib/core.js';

const numberField=field=>({field,format:v=>v==null?'':String(v),parse:text=>{
  if(!text.trim())return {kind:'clear'};
  return Number.isFinite(Number(text))?{kind:'set',value:Number(text)}:undefined;
}});
class FormDouble {
  constructor(scope,specs){this.scope=scope;this.specs=new Map(specs.map(s=>[s.field,s]));this.staged=new Map();this.listeners=new Set();this.saving=false;this.failed=false;this.unsub=scope.subscribe(()=>this.publish());}
  bind(project){return {getSnapshot:project,subscribe:fn=>{this.listeners.add(fn);return ()=>this.listeners.delete(fn);}};}
  publish(){for(const fn of this.listeners)fn();}
  field(name){const entry=this.staged.get(name),snapshot=this.scope.getSnapshot();return {text:entry?.text??this.specs.get(name).format(snapshot.value[name]),overridden:entry?!entry.clear:Object.hasOwn(snapshot.user,name),invalid:!!entry&&!entry.clear&&!this.specs.get(name).parse(entry.text)};}
  shell(){return {available:true,writable:this.scope.getSnapshot().writable,dirty:this.staged.size>0,invalid:[...this.staged.keys()].some(k=>this.field(k).invalid),saving:this.saving,failed:this.failed};}
  actions(){return {edit:(name,text)=>{this.staged.set(name,{text});this.failed=false;this.publish();},resetField:name=>{this.staged.set(name,{text:this.specs.get(name).format(this.scope.getSnapshot().base[name]),clear:true});this.publish();},discard:()=>{this.staged.clear();this.failed=false;this.publish();},save:()=>{void this.save();}};}
  async save(){if(!this.staged.size||this.saving||this.shell().invalid||!this.shell().writable)return;this.saving=true;this.failed=false;this.publish();try{
    const ops=[...this.staged].map(([name,e])=>{const parsed=e.clear?{kind:'clear'}:this.specs.get(name).parse(e.text);return parsed.kind==='clear'?{op:'unset',path:[name]}:{op:'set',path:[name],value:parsed.value};});
    this.failed=!await this.scope.mutate(ops,this.scope.getSnapshot().revision);if(!this.failed)this.staged.clear();
  }catch{this.failed=true;}finally{this.saving=false;this.publish();}}
  dispose(){this.unsub();this.listeners.clear();}
}
const hostForm=process.env.DSH_TEST_FORM_MODULE?await import(pathToFileURL(process.env.DSH_TEST_FORM_MODULE).href):null;
const P={SettingsFormModel:hostForm?.SettingsFormModel||FormDouble,settingsNumberField:hostForm?.settingsNumberField||numberField};
for(const key of ['SettingsForm','Switch','Menu','Button','Input','Tag'])P[key]=props=>({type:key,props});
let loaded,hookState=[],cursor=0;
const effects=[];
globalThis.window={__ModuleLoader__:{load:value=>{loaded=value;}},confirm:()=>true,location:{href:'http://localhost/'}};
const jsx=(type,props,key)=>({type,props,key});
const React={useState:initial=>{const i=cursor++,state=hookState;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},useEffect:fn=>effects.push(fn),useRef:()=>({current:null}),useSyncExternalStore:(_,get)=>get()};
await import('../lib/client.js');
const mod=loaded.factory(name=>name==='react'?React:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:P);
const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
const render=(component,props,state=[])=>{hookState=state;cursor=0;return component(props);};
const t=key=>mod.DICTS.zh[key]||key;
const reports=[];
const passed=name=>{reports.push(name);console.log('PASS '+name);};
let entry,face,snapshot={status:'ready',writable:true,revision:'1',base:{},user:{},value:{}},writes=[],saveMode='ok',releaseSave;
const listeners=new Set(),disposers=[],services=new Map();
const scope={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},mutate:async(ops,revision)=>{
  writes.push({ops,revision});if(saveMode==='delayed')await new Promise(resolve=>{releaseSave=resolve;});
  if(saveMode==='reject')return false;if(saveMode==='throw')throw Error('storage unavailable');
  const user={...snapshot.user};for(const op of ops){if(op.op==='unset')delete user[op.path[0]];else user[op.path[0]]=op.value;}
  snapshot={...snapshot,user,value:{...snapshot.base,...user},revision:String(Number(snapshot.revision)+1)};for(const fn of listeners)fn();return true;
}};
const ctx={get:name=>services.get(name),locale:{bind:()=>t,register:()=>()=>{}},configForms:{get:()=>scope,whileServed:(_,fn)=>fn()},slots:{inject:(_,fn)=>fn(),register:(spec,component)=>{entry=component;face=spec.inject();return ()=>{};}},effect:fn=>{const off=fn();if(typeof off==='function')disposers.push(off);return off;}};
// Match Cordis property access: absent optional services MUST NOT use properties.
for(const name of ['codexRunner','connection'])Object.defineProperty(ctx,name,{get(){throw Error('cannot get property "'+name+'" without inject');}});
ctx.inject=()=>()=>{}; // This settings-only fixture has no uiConversation service.
mod.apply(ctx);
const runtimeConfig=Object.fromEntries(mod.ALL_FIELDS.map(name=>[name,{get:()=>snapshot.value[name]}]));
const runtimeDefaults=loadEffectiveSettings().settings;
const cardState=[];
const card=()=>render(entry,{t,view:'full',useCodexRunnerForm:select=>select(face.hooks.codexRunnerForm.getSnapshot()),...face},cardState);
const row=name=>{
  const tree=nodes(card());
  if(['quotaWarningThreshold','statusPollingIntervalMinutes'].includes(name)){
    const combined=tree.find(n=>n.key===(name==='quotaWarningThreshold'?'switch-quotaWarning':'switch-statusPollingEnabled'));
    return combined?{props:{...combined.props,control:combined.props.beforeControl}}:undefined;
  }
  if(['retentionDays','retentionMaxRuns'].includes(name)){
    const combined=tree.find(n=>n.key==='preset-number-retentionDays');
    return combined?{props:{...combined.props,control:combined.props.control.props.children.find(n=>n.props.name===name)}}:undefined;
  }
  if(name==='debugMaxBytes'){
    const combined=tree.find(n=>n.key==='switch-debugLogs');
    return combined?{props:{...combined.props,disabled:combined.props.beforeControl.props.disabled,control:combined.props.beforeControl}}:undefined;
  }
  return tree.find(n=>n.key===mod.ROWS.find(r=>r.name===name).control+'-'+name);
};
const click=(tree,label)=>{const button=nodes(tree).find(n=>n.type===P.Button&&n.props.children===t(label));assert.ok(button,label);assert.ok(!button.props.disabled,label+' enabled');return button.props.onClick();};
const field=name=>face.hooks.codexRunnerForm.getSnapshot()[name];
assert.equal(mod.ROWS.length,25,'25 rows before combining controls');
for(const name of ['streamOutputEnabled','supervisionEnabled'])assert.equal(row(name).props.control.props.checked,true,'Unset '+name+' must display its true default');
const samples={codexExecutable:process.execPath,codexHome:process.env.TEMP,statusPollingIntervalMinutes:30,debugMaxBytes:65536,maxConcurrent:2,retentionDays:7};
for(const spec of mod.ROWS.filter(row=>row.name!=='backend')){
  if(['selectionMode','maxEffortAllowed'].includes(spec.name)){face.edit('autoModelAndEffort','true');face.edit('selectionPolicy',JSON.stringify({version:1,mode:'audit'}));}
  if(['quotaWarning','quotaWarningThreshold'].includes(spec.name))face.edit('autoResumeAfterQuota','true');
  if(spec.name==='debugMaxBytes')face.edit('debugLogs','true');
  if(spec.name.startsWith('statusPolling')){face.edit('streamOutputEnabled','false');face.edit('supervisionEnabled','false');}
  const control=row(spec.name);assert.ok(control,spec.name);
  let expected;
  if(spec.control==='switch'){control.props.control.props.onChange(true);expected=spec.tier?'fast':true;assert.equal(field(spec.name).text,String(expected));control.props.control.props.onChange(false);expected=spec.tier?'off':false;}
  else if(spec.control==='select'){
    const menu=control.props.control.type(control.props.control.props);
    for(const option of menu.props.items){menu.props.onSelect(option.id);assert.equal(field(spec.name).text,option.id,spec.name+' '+option.id);}
    const selected=spec.options[0];menu.props.onSelect(selected);expected=spec.numeric?Number(selected):selected;
  }else if(spec.control==='preset-number'){
    const tree=render(mod.PresetNumber,control.props.control.props);
    const menu=nodes(tree).find(n=>n.type===P.Menu);
    for(const option of menu.props.items){menu.props.onSelect(option.id);assert.equal(field(spec.name).text,String(Number(option.id)*(spec.valueScale||1)));}
    const custom=spec.name==='debugMaxBytes'?2.5:spec.name==='pauseGraceMs'?1.001:spec.name==='retentionDays'?42:1234;
    expected=spec.name==='pauseGraceMs'?1001:custom*(spec.valueScale||1);
    nodes(tree).find(n=>n.type==='input').props.onChange({target:{value:String(custom)}});
  }else if(spec.control==='path'){
    expected=samples[spec.name];
    const input=nodes(control.props.control).find(node=>node.type===P.Input);
    assert.ok(input,spec.name+' uses the native Input');
    input.props.onChange({target:{value:expected}});
  }else if(spec.control==='slider'){
    face.edit(spec.name==='statusPollingIntervalMinutes'?'statusPollingEnabled':'quotaWarning','true');const range=row(spec.name).props.control;
    assert.equal(range.props.disabled,false);const input=range.type(range.props).props.children[0];
    for(const value of spec.name==='statusPollingIntervalMinutes'?['15','30','120']:['0','10','20']){input.props.onChange({target:{value}});assert.equal(field(spec.name).text,value);}
    expected=spec.name==='statusPollingIntervalMinutes'?120:20;
  }else{expected=samples[spec.name]??(spec.numeric?1000:'sample-value');control.props.onEdit(String(expected));}
  await face.save();assert.equal(face.getShell().failed,false,spec.name);assert.equal(snapshot.user[spec.name],expected,spec.name+' persisted');
  assert.deepEqual(loadEffectiveSettings({config:runtimeConfig}).settings[spec.name],expected,spec.name+' saved UI value used at runtime');
  assert.equal(face.getShell().dirty,false,spec.name+' clean after save');
  row(spec.name).props.onReset();await face.save();assert.equal(Object.hasOwn(snapshot.user,spec.name),false,spec.name+' reset');
  assert.deepEqual(loadEffectiveSettings({config:runtimeConfig}).settings[spec.name],runtimeDefaults[spec.name],spec.name+' reset restores code default at runtime');
  face.edit(spec.name,'discard-me');face.discard();assert.equal(field(spec.name).text,'',spec.name+' discard');
  snapshot={...snapshot,writable:false};for(const fn of listeners)fn();
  assert.equal(row(spec.name).props.disabled,true,spec.name+' read-only');
  snapshot={...snapshot,writable:true};for(const fn of listeners)fn();
  if(spec.numeric){face.edit(spec.name,'not-a-number');assert.equal(face.getShell().invalid,true,spec.name+' invalid');const count=writes.length;await face.save();assert.equal(writes.length,count);face.discard();}
  passed('row '+spec.name+' edit/options/save/reset/discard/read-only'+(spec.numeric?'/invalid':''));
}
// 主开关默认关闭：策略行仍然显示，但禁用；策略关闭时其下控件一律不渲染。
for(const name of ['autoModelAndEffort','selectionPolicy','selectionMode','maxEffortAllowed'])face.resetField(name);await face.save();
const policySection=()=>nodes(card()).find(n=>n.props?.['data-section']==='policy');
const policyModeRow=()=>nodes(card()).find(n=>n.key==='select-selectionPolicy');
const policyMenu=()=>policyModeRow().props.control.type(policyModeRow().props.control.props).props;
assert.equal(row('autoModelAndEffort').props.control.props.checked,false,'unset autonomy defaults to off');
assert.equal(mod.BUNDLED_EDITOR_STATE.definitions.autoModelAndEffort.defaultValue,false,'embedded configuration editor uses the same default');
assert.ok(policySection(),'policy row stays visible while autonomy is off');
assert.equal(policyModeRow().props.disabled,true,'policy row is disabled while autonomy is off');
assert.equal(policyModeRow().props.hint,t('policyNeedsAutonomy'));
assert.equal(row('selectionMode'),undefined,'selection method hidden while the policy is off');
assert.equal(row('maxEffortAllowed'),undefined,'effort cap hidden while the policy is off');
assert.equal(nodes(card()).some(n=>n.props?.children===t('editPolicy')),false,'policy editor hidden while the policy is off');
assert.equal(nodes(card()).some(n=>n.props?.children===t('refreshCatalog')),false,'catalog refresh hidden while the policy is off');
const policyModeBeforeEdit=field('selectionPolicy').text;
policyMenu().onSelect('enforce');
assert.equal(field('selectionPolicy').text,policyModeBeforeEdit,'disabled policy row ignores edits');

// 打开主开关但策略仍关闭：策略行可编辑，控件继续隐藏。
row('autoModelAndEffort').props.control.props.onChange(true);await face.save();
assert.equal(policyModeRow().props.disabled,false);
assert.equal(row('selectionMode'),undefined,'policy off still hides its controls');

const customPolicy=mod.parseClientPolicy('');customPolicy.floors.implement.effort='medium';
face.edit('selectionPolicy',JSON.stringify(customPolicy));
for(const mode of ['audit','enforce','off']){
  policyMenu().onSelect(mode);await face.save();
  assert.equal(JSON.parse(snapshot.user.selectionPolicy).mode,mode);
  assert.equal(JSON.parse(snapshot.user.selectionPolicy).floors.implement.effort,'medium');
  assert.equal(loadEffectiveSettings({config:runtimeConfig}).settings.selectionPolicy.mode,mode);
  assert.equal(!!row('selectionMode'),mode!=='off','selection method only renders while the policy is on');
  assert.equal(!!row('maxEffortAllowed'),mode!=='off','effort cap only renders while the policy is on');
}
policyModeRow().props.onReset();await face.save();assert.equal(Object.hasOwn(snapshot.user,'selectionPolicy'),false);
assert.equal(policyMenu().selectedId,'off');
passed('visible policy mode shares JSON data, hides its controls when off, preserves detailed rules and resets to off');

face.edit('selectionPolicy',JSON.stringify({...customPolicy,mode:'audit'}));
face.edit('selectionMode','evidence');face.edit('maxEffortAllowed','max');await face.save();
assert.ok(policySection(),'policy section stays in place');
assert.ok(row('selectionMode'));assert.ok(row('maxEffortAllowed'));
assert.equal(nodes(card()).some(n=>n.props?.children===t('editPolicy')),true);
assert.equal(nodes(card()).some(n=>n.props?.children===t('refreshCatalog')),true);
const savedPolicy=snapshot.user.selectionPolicy;
// 主开关关闭：策略行禁用、其下控件立即隐藏，已保存的策略值保留。
row('autoModelAndEffort').props.control.props.onChange(false);
assert.equal(policyModeRow().props.disabled,true);
assert.equal(policyModeRow().props.hint,t('policyNeedsAutonomy'));
assert.equal(row('selectionMode'),undefined);
assert.equal(row('maxEffortAllowed'),undefined);
assert.equal(nodes(card()).some(n=>n.props?.children===t('editPolicy')),false);
assert.equal(nodes(card()).some(n=>n.props?.children===t('refreshCatalog')),false);
assert.equal(field('selectionPolicy').text,savedPolicy);
await face.save();assert.equal(snapshot.user.autoModelAndEffort,false);
assert.equal(snapshot.user.selectionPolicy,savedPolicy);
assert.equal(snapshot.user.selectionMode,'evidence');assert.equal(snapshot.user.maxEffortAllowed,'max');
// 再次开启主开关并选择 audit：控件恢复显示，保存的值仍在。
row('autoModelAndEffort').props.control.props.onChange(true);
policyMenu().onSelect('audit');await face.save();
assert.ok(row('selectionMode'));assert.ok(row('maxEffortAllowed'));
assert.equal(field('selectionMode').text,'evidence');assert.equal(field('maxEffortAllowed').text,'max');
// 策略切回关闭：控件隐藏，值保留。
policyMenu().onSelect('off');await face.save();
assert.equal(row('selectionMode'),undefined);
assert.equal(snapshot.user.selectionMode,'evidence');
// 恢复默认：清掉主开关与策略覆盖。
policyMenu().onSelect('audit');
row('autoModelAndEffort').props.onReset();await face.save();
assert.equal(Object.hasOwn(snapshot.user,'autoModelAndEffort'),false);
for(const name of ['selectionPolicy','selectionMode','maxEffortAllowed'])face.resetField(name);await face.save();
passed('preset policy controls follow the main switch and the policy mode across save');

// The sticky save entry must follow the real form lifecycle, including failed and delayed writes.
const saveBar=()=>{const widget=nodes(card()).find(n=>n.type===mod.SaveBar);assert.ok(widget);return render(mod.SaveBar,widget.props);};
const saveButton=()=>nodes(saveBar()).find(n=>n.type===P.Button);
face.discard();assert.equal(saveButton().props.disabled,true);
face.edit('serviceTier','fast');assert.equal(saveButton().props.disabled,false);
assert.ok(nodes(saveBar()).some(n=>n.props?.children===t('unsavedSettings')));
saveMode='delayed';const pendingBarSave=saveButton().props.onClick();assert.equal(saveButton().props.disabled,true);
assert.ok(nodes(saveBar()).some(n=>n.props?.children===t('saving')));releaseSave();await pendingBarSave;
assert.equal(snapshot.user.serviceTier,'fast');assert.equal(saveButton().props.disabled,true);
face.edit('serviceTier','off');saveMode='reject';await saveButton().props.onClick();
assert.equal(snapshot.user.serviceTier,'fast');assert.equal(field('serviceTier').text,'off');
assert.equal(saveButton().props.disabled,false);assert.ok(nodes(saveBar()).some(n=>n.props?.role==='alert'&&n.props.children===t('saveFailed')));
saveMode='ok';await saveButton().props.onClick();assert.equal(snapshot.user.serviceTier,'off');assert.equal(saveButton().props.disabled,true);
face.edit('maxConcurrent','not-a-number');assert.equal(saveButton().props.disabled,true);
assert.ok(nodes(saveBar()).some(n=>n.props?.children===t('fixSettings')));face.discard();
snapshot={...snapshot,writable:false};for(const fn of listeners)fn();assert.equal(saveButton().props.disabled,true);
snapshot={...snapshot,writable:true};for(const fn of listeners)fn();
passed('sticky save bar: unsaved, delayed save, failure retention, retry, validation and read-only');

for(const name of ['retentionDays','retentionMaxRuns']){
  const state=[],widget=()=>render(mod.PresetNumber,row(name).props.control.props,state);
  assert.equal(nodes(widget()).find(n=>n.type==='input').props.value,'0','empty config shows unlimited retention default');
  nodes(widget()).find(n=>n.type===P.Menu).props.onSelect('0');
  assert.equal(nodes(widget()).find(n=>n.type==='input').props.value,'0','zero is displayed without falling back to default');
  await face.save();assert.equal(snapshot.user[name],0,'zero remains numeric after persistence');
  for(const value of ['-1','1.5','NaN','1e3','2147483648']){
    row(name).props.control.props.onChange(value);assert.equal(field(name).invalid,true);
    const count=writes.length;await face.save();assert.equal(writes.length,count,'invalid retention never saves');face.discard();
  }
  for(const value of [0,42,1234])assert.doesNotThrow(()=>mod.parseFullConfig(JSON.stringify({[name]:value})));
  for(const value of [-1,0.5,'42',true,2147483648])assert.throws(()=>mod.parseFullConfig(JSON.stringify({[name]:value})));
}
const retentionRow=nodes(card()).find(n=>n.key==='preset-number-retentionDays');
assert.equal(retentionRow.props.control.props.children.length,2);
assert.equal(nodes(card()).some(n=>n.key==='preset-number-retentionMaxRuns'),false,'retention has one combined row');
retentionRow.props.onReset();await face.save();
for(const name of ['retentionDays','retentionMaxRuns']){
  assert.equal(Object.hasOwn(snapshot.user,name),false,'combined reset clears both overrides');
  const tree=render(mod.PresetNumber,row(name).props.control.props);
  assert.equal(nodes(tree).find(n=>n.type==='input').props.value,'0','reset displays zero for both retention limits');
}
passed('retention presets and custom numbers, concrete defaults, zero semantics, validation and combined reset');

assert.equal(row('debugLogs').props.control.props.disabled,false,'debug switch remains available while off');
assert.equal(row('debugMaxBytes').props.control.props.disabled,true,'debug limit disabled while logging is off');
assert.equal(nodes(render(mod.PresetNumber,row('debugMaxBytes').props.control.props)).find(n=>n.type==='input').props.value,'2','default debug limit displays 2 MiB');
row('debugLogs').props.control.props.onChange(true);
assert.equal(row('debugMaxBytes').props.control.props.disabled,false,'enabling debug unlocks capacity');
row('debugMaxBytes').props.control.props.onChange('0.5');await face.save();
assert.equal(snapshot.user.debugMaxBytes,524288,'MiB input persists as integer bytes');
row('debugLogs').props.control.props.onChange(false);await face.save();
assert.equal(row('debugMaxBytes').props.control.props.disabled,true);
assert.equal(snapshot.user.debugMaxBytes,524288,'disabling debug retains configured capacity');
assert.equal(nodes(render(mod.PresetNumber,row('debugMaxBytes').props.control.props)).find(n=>n.type==='input').props.value,'0.5');
row('debugLogs').props.control.props.onChange(true);
for(const invalid of ['0','-1','1025','NaN','0.0000001']){
  row('debugMaxBytes').props.control.props.onChange(invalid);assert.equal(field('debugMaxBytes').invalid,true,'invalid capacity '+invalid);face.discard();
}
row('debugLogs').props.onReset();await face.save();
assert.equal(Object.hasOwn(snapshot.user,'debugLogs'),false);
assert.equal(Object.hasOwn(snapshot.user,'debugMaxBytes'),false);
assert.equal(row('debugMaxBytes').props.control.props.disabled,true);
assert.equal(nodes(render(mod.PresetNumber,row('debugMaxBytes').props.control.props)).find(n=>n.type==='input').props.value,'2');
passed('combined debug controls: enable/disable, MiB/byte conversion, retained capacity, validation and reset');

const pauseWidget=()=>render(mod.PresetNumber,row('pauseGraceMs').props.control.props);
assert.equal(nodes(pauseWidget()).find(n=>n.type==='input').props.value,'0');
assert.equal(nodes(pauseWidget()).find(n=>n.type===P.Menu).props.items[0].label,'0（不限等待）');
nodes(pauseWidget()).find(n=>n.type===P.Menu).props.onSelect('60');await face.save();
assert.equal(snapshot.user.pauseGraceMs,60000,'seconds preset persists as milliseconds');
for(const [seconds,millis] of [['1.001',1001],['0.001',1],['1.0010',1001],['2147483.647',2147483647]]){
  row('pauseGraceMs').props.control.props.onChange(seconds);await face.save();
  assert.equal(snapshot.user.pauseGraceMs,millis,'exact millisecond conversion for '+seconds);
}
for(const invalid of ['-1','0.0001','2147483.648','NaN']){
  row('pauseGraceMs').props.control.props.onChange(invalid);assert.equal(field('pauseGraceMs').invalid,true,'invalid pause wait '+invalid);face.discard();
}
face.edit('pauseGraceMs','1500');await face.save();
assert.equal(nodes(pauseWidget()).find(n=>n.type==='input').props.value,'1.5','existing millisecond setting displays seconds');
assert.equal(new Map(mod.parseFullConfig('{"pauseGraceMs":1500}')).get('pauseGraceMs'),'1500','JSON continues to use milliseconds');
row('pauseGraceMs').props.onReset();await face.save();
assert.equal(Object.hasOwn(snapshot.user,'pauseGraceMs'),false);
assert.equal(nodes(pauseWidget()).find(n=>n.type==='input').props.value,'0');
passed('pause wait: second presets, exact milliseconds, bounds, JSON units and reset');

for(const value of ['-1','21','1.5','NaN']){face.edit('quotaWarningThreshold',value);assert.equal(field('quotaWarningThreshold').invalid,true);face.discard();}
for(const value of ['15','30','60','120']){face.edit('statusPollingIntervalMinutes',value);assert.equal(field('statusPollingIntervalMinutes').invalid,false,'poll interval boundary');face.discard();}
for(const value of ['14','121','30.5','NaN']){face.edit('statusPollingIntervalMinutes',value);assert.equal(field('statusPollingIntervalMinutes').invalid,true,'poll invalid interval');face.discard();}
face.edit('quotaWarning','false');assert.equal(row('quotaWarningThreshold').props.control.props.disabled,true);face.discard();
for(const resume of [false,true]){
  row('autoResumeAfterQuota').props.control.props.onChange(resume);
  assert.equal(row('quotaWarning').props.disabled,false);
  assert.equal(row('quotaWarning').props.control.props.disabled,false);
  row('quotaWarning').props.control.props.onChange(true);
  assert.equal(row('quotaWarningThreshold').props.control.props.disabled,false);
  row('autoResumeAfterQuota').props.control.props.onChange(!resume);
  assert.equal(row('quotaWarning').props.control.props.checked,true);
  assert.equal(row('quotaWarningThreshold').props.control.props.disabled,false);
  row('quotaWarning').props.control.props.onChange(false);
  assert.equal(row('quotaWarningThreshold').props.control.props.disabled,true);
}
const coreSection=nodes(card()).find(n=>n.props?.['data-section']==='core');
const coreKeys=coreSection.props.children.filter(Boolean).map(n=>n.key);
assert.equal(coreKeys.indexOf('switch-quotaWarning'),coreKeys.indexOf('switch-autoResumeAfterQuota')-1);
face.discard();
face.edit('streamOutputEnabled','false');face.edit('supervisionEnabled','false');
face.edit('statusPollingEnabled','false');
assert.equal(row('statusPollingIntervalMinutes').props.control.props.disabled,true);
assert.equal(row('statusPollingIntervalMinutes').props.control.props.value,30);
row('statusPollingEnabled').props.control.props.onChange(true);
assert.equal(row('statusPollingIntervalMinutes').props.control.props.disabled,false);
assert.equal(row('statusPollingIntervalMinutes').props.control.props.unit,' '+t('minutes'));
assert.ok(coreKeys.includes('switch-statusPollingEnabled'));
face.discard();
for(const stream of ['','false','true'])for(const supervision of ['','false','true']){
  face.edit('streamOutputEnabled',stream);face.edit('supervisionEnabled',supervision);
  face.edit('statusPollingEnabled','true');face.edit('statusPollingIntervalMinutes','60');
  const suspended=stream!=='false'||supervision!=='false';
  assert.equal(row('statusPollingEnabled').props.control.props.disabled,suspended);
  assert.equal(row('statusPollingIntervalMinutes').props.control.props.disabled,suspended);
  if(suspended){
    assert.equal(row('statusPollingEnabled').props.hint,t('pollingSuspended'));
    row('statusPollingEnabled').props.control.props.onChange(false);row('statusPollingEnabled').props.onReset();
    row('statusPollingIntervalMinutes').props.control.props.onChange('15');
    assert.equal(field('statusPollingEnabled').text,'true');assert.equal(field('statusPollingIntervalMinutes').text,'60');
  }
}
face.discard();
passed('quota and polling sliders: boundaries, units and independent switches');
face.edit('autoModelAndEffort','true');face.edit('selectionPolicy',JSON.stringify({version:1,mode:'audit'}));
for(const [name,expected] of [['defaultModel','gpt-6.1-sol'],['defaultEffort','high'],['selectionMode','legacy'],['maxEffortAllowed','xhigh'],['sandboxMode','workspace-write'],['approvalPolicy','never']]){
  face.edit(name,'');
  const menu=row(name).props.control.type(row(name).props.control.props);
  assert.equal(menu.props.selectedId,expected);
  assert.equal(menu.props.items.some(item=>item.id===''),false);
}

const emptySelects=Object.fromEntries(['defaultModel','defaultEffort','selectionMode','maxEffortAllowed','sandboxMode','approvalPolicy'].map(name=>[name,'']));
const cleared=new Map(mod.parseFullConfig(JSON.stringify(emptySelects)));
for(const name of Object.keys(emptySelects))assert.equal(cleared.get(name),'');
assert.equal(cleared.get('defaultModel'),'');assert.equal(cleared.get('defaultEffort'),'');
face.discard();
passed('six dropdowns show concrete defaults; empty JSON clears overrides');

for(const value of ['codex.exe','relative/path.exe',process.execPath+'.cmd',process.execPath+'.bat',process.execPath+'.ps1']){
  face.edit('codexExecutable',value);assert.equal(field('codexExecutable').invalid,true,'installation UI rejects shim/relative');
  assert.ok(nodes(row('codexExecutable').props.control).some(node=>node.props?.role==='alert'),'invalid path displays its explanation');face.discard();
}
for(const name of ['codexExecutable','codexHome']){
  face.edit(name,'');assert.equal(field(name).invalid,false,'installation UI blank inherits');face.discard();
  const input=nodes(row(name).props.control).find(node=>node.type===P.Input);
  assert.equal(input.props.value,'');assert.ok(input.props.placeholder);
  assert.equal(input.props['aria-describedby'],row(name).props.hintId);
}
passed('installation paths and blank inheritance');

face.edit('autoModelAndEffort','true');face.edit('selectionPolicy',JSON.stringify({version:1,mode:'audit'}));await face.save();
await face.refreshCatalog();await face.refreshQuota('fresh');
assert.equal(face.views.getSnapshot().error,'Service unavailable');assert.equal(face.views.getSnapshot().quotaError,'Service unavailable');
const catalog=structuredClone(face.views.getSnapshot().catalog),rpc=[];
const quota={scope:'account-wide',windows:{five_hour:{remaining_percent:25},seven_day:{remaining_percent:80}},stale:false};
let rpcError=false,holdQuota;
services.set('connection',{rpc:{call:async(channel,method,args)=>{rpc.push({channel,method,args});if(holdQuota&&method==='getQuota')await holdQuota;
  return rpcError?{ok:false,error:{message:'Owner access required'}}:{ok:true,value:method==='getQuota'?quota:catalog};}}});
await click(card(),'refreshCatalog');
await face.refreshQuota('fresh');assert.deepEqual(face.views.getSnapshot().quota,quota);assert.equal(face.views.getSnapshot().error,null);
assert.ok(rpc.every(c=>c.channel==='/codex-runner'));assert.deepEqual(rpc.find(c=>c.method==='getQuota').args,{probe:'fresh'});
const q=nodes(card()).find(n=>n.type===mod.QuotaBar);assert.equal(nodes(mod.QuotaBar(q.props)).filter(n=>n.type==='progress').length,2);
let releaseQuota;holdQuota=new Promise(resolve=>{releaseQuota=resolve;});const pendingQuota=face.refreshQuota('fresh');assert.equal(face.views.getSnapshot().quotaLoading,true);releaseQuota();await pendingQuota;holdQuota=null;
rpcError=true;await face.refreshCatalog();await face.refreshQuota();assert.equal(face.views.getSnapshot().quotaError,'Owner access required');assert.equal(face.views.getSnapshot().error,'Owner access required');rpcError=false;
services.delete('connection');await face.refreshQuota();assert.equal(face.views.getSnapshot().quotaError,'Service unavailable');
passed('strict optional-service lookup, RPC success/denial/disconnection, refresh/loading');
const bundledFallback=await face.loadRegistry({refresh:true});
assert.equal(bundledFallback.readOnly,true);assert.equal(bundledFallback.configuration.fallback,true);
assert.equal(Object.keys(bundledFallback.document.fields).length,21);assert.equal(Object.keys(bundledFallback.configuration.config).length,14);
assert.match(bundledFallback.configuration.error,/Service unavailable/);
assert.deepEqual(bundledFallback.document,mod.BUNDLED_EDITOR_STATE.document);
services.set('codexRunner',{getEditorRegistry:async()=>({broken:true})});
const malformedRegistry=await face.loadRegistry();assert.equal(malformedRegistry.readOnly,true);assert.match(malformedRegistry.configuration.error,/Invalid registry response/);
services.delete('codexRunner');
const fallbackModalState=[],fallbackModal=()=>render(mod.FullConfigModal,{t,initial:'{}',disabled:false,catalog,registryInitial:bundledFallback,onClose:()=>{},onSave:async()=>{}},fallbackModalState);
assert.equal(nodes(fallbackModal()).some(n=>n.props?.role==='status'&&String(n.props.children).includes('codex-registry.json')),true);
nodes(fallbackModal()).find(n=>n.props?.role==='tab'&&n.props.id==='codex-editor-tab-registry').props.onClick();
let fallbackText=nodes(fallbackModal()).find(n=>n.type==='textarea');assert.equal(fallbackText.props.readOnly,true);assert.equal(Object.keys(JSON.parse(fallbackText.props.value).fields).length,21);
nodes(fallbackModal()).find(n=>n.props?.role==='tab'&&n.props.id==='codex-editor-tab-config').props.onClick();
fallbackText=nodes(fallbackModal()).find(n=>n.type==='textarea');assert.equal(!!fallbackText.props.readOnly,false);
passed('missing registry service uses the embedded copy of codex-registry.json, with read-only registry and editable profile configuration');

click(card(),'editPolicy');let modal=nodes(card()).find(n=>n.type===mod.PolicyModal);assert.ok(modal);
const state=[],modalTree=()=>render(mod.PolicyModal,modal.props,state);
for(const preset of ['strict','economy','balanced']){click(modalTree(),'preset.'+preset);assert.deepEqual(mod.parseClientPolicy(state[0]),mod.policyPreset(preset));}
for(const tab of ['tasks','evidence','downgrade','quota','json']){
  click(modalTree(),'tab.'+tab);const panel=nodes(modalTree()).find(n=>n.props?.role==='tabpanel');assert.equal(panel.props.id,'codex-panel-'+tab);
  for(let index=0;index<nodes(panel).filter(n=>['select','input'].includes(n.type)).length;index++){
    const input=nodes(nodes(modalTree()).find(n=>n.props?.role==='tabpanel')).filter(n=>['select','input'].includes(n.type))[index];
    const p=input.props;input.props.onChange({target:{value:p.value,checked:p.checked}});assert.ok(mod.parseClientPolicy(state[0]));
  }
}
nodes(modalTree()).find(n=>n.type==='textarea').props.onChange({target:{value:'{bad'}});assert.equal(nodes(modalTree()).find(n=>n.props?.children===t('save')).props.disabled,true);click(modalTree(),'restorePolicy');
saveMode='delayed';let complete=false;const saving=modal.props.onSave(mod.policyPreset('strict')).then(()=>{complete=true;});await Promise.resolve();assert.equal(complete,false,'dialog must wait for actual mutation');assert.equal(row('defaultModel').props.disabled,true);releaseSave();await saving;assert.equal(nodes(card()).some(n=>n.type===mod.PolicyModal),false);assert.equal(JSON.parse(snapshot.user.selectionPolicy).mode,'enforce');
click(card(),'editPolicy');modal=nodes(card()).find(n=>n.type===mod.PolicyModal);saveMode='reject';await assert.rejects(modal.props.onSave(mod.policyPreset('balanced')),{message:t('saveFailed')});assert.equal(nodes(card()).some(n=>n.type===mod.PolicyModal),true);assert.equal(face.getShell().failed,true);
saveMode='throw';await assert.rejects(modal.props.onSave(mod.policyPreset('economy')),{message:t('saveFailed')});
saveMode='ok';face.discard();modal.props.onClose();passed('policy five tabs, presets, invalid JSON, delayed save, rejected/throwing save stays open');

// Full JSON editor must validate before staging any field and retain failures.
const {SETTINGS_SPEC,SETTINGS_DEFAULTS,CODEX_CONFIG_WHITELIST}=await import('../lib/core.js');
assert.deepEqual([...mod.ALL_FIELDS].sort(),Object.keys(SETTINGS_SPEC).sort());
assert.equal(mod.ROWS.some(row=>row.name==='autoAnswerQuestions'),false);
assert.equal(SETTINGS_DEFAULTS.autoAnswerQuestions,true);
assert.equal(mod.parseFullConfig('{"autoAnswerQuestions":false}').find(([k])=>k==='autoAnswerQuestions')[1],'false');
assert.throws(()=>mod.parseFullConfig('{"autoAnswerQuestions":"false"}'));
for(const key of ['stallMs','agents.max_threads','agents.max_depth','allowFullAccess','channelBudgetMs','detachedBudgetMs','defaultTimeoutMs','answerChars','agents.enabled','agents.max_concurrent_threads_per_session','agents.default_subagent_model','agents.default_subagent_reasoning_effort']) {
  assert.equal(mod.ROWS.some(row=>row.name===key),false);
  assert.equal(mod.ALL_FIELDS.includes(key),false);
  for(const lang of ['zh','en'])for(const prefix of ['f.','h.'])assert.equal(Object.hasOwn(mod.DICTS[lang],prefix+key),false);
  for(const config of [{[key]:1},{codexConfig:{[key]:1}},{extraCodexConfig:[key+'=1']}])assert.throws(()=>mod.parseFullConfig(JSON.stringify(config)));
}
assert.equal(SETTINGS_DEFAULTS.backend,'app-server');
assert.deepEqual(mod.CONFIG_WHITELIST,CODEX_CONFIG_WHITELIST);
assert.throws(()=>mod.parseFullConfig(JSON.stringify({codexConfig:{sandbox_mode:'danger-full-access'}})));
assert.throws(()=>mod.parseFullConfig(JSON.stringify({extraCodexConfig:['approval_policy=never']})));
assert.equal(row('backend'),undefined);
click(card(),'editConfig');let full=nodes(card()).find(n=>n.type===mod.FullConfigModal);assert.ok(full);
const fullState=[],fullTree=()=>render(mod.FullConfigModal,full.props,fullState);
assert.equal(nodes(fullTree()).filter(n=>n.props?.role==='tab').length,3);
assert.equal(nodes(fullTree()).filter(n=>n.type==='table').length,1);
assert.equal(nodes(fullTree()).filter(n=>n.props?.['data-editor-row']?.startsWith('config:')).length,Object.keys(SETTINGS_SPEC).length-1);
assert.equal(nodes(fullTree()).some(n=>n.props?.['data-editor-row']==='config:autoAnswerQuestions'),false);
nodes(fullTree()).find(n=>n.props?.role==='tab'&&n.props.children===t('editor.config')).props.onClick();
assert.equal(nodes(fullTree()).filter(n=>n.type==='textarea').length,1);
assert.equal(nodes(fullTree()).find(n=>n.props?.role==='dialog').props.style.fontSize,'13px');
assert.equal(nodes(fullTree()).find(n=>n.type==='textarea').props.style.fontSize,'13px');
assert.equal(nodes(fullTree()).filter(n=>n.type===P.Button).length,2);
click(fullTree(),'cancel');
assert.equal(nodes(card()).some(n=>n.type===mod.FullConfigModal),false);
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
const config=JSON.parse(full.props.initial);assert.equal(Object.keys(config).length,Object.keys(SETTINGS_SPEC).length);
for(const invalid of ['{bad','[]','{"unknown":true}','{"backend":"bad"}','{"autoModelAndEffort":"false"}','{"maxConcurrent":9}'])assert.throws(()=>mod.parseFullConfig(invalid));
let before=writes.length;await assert.rejects(full.props.onSave('{bad'));assert.equal(writes.length,before);
config.backend='app-server';config.codexConfig={};config.extraCodexConfig=[];
await full.props.onSave(JSON.stringify(config));assert.equal(snapshot.user.backend,'app-server');assert.deepEqual(snapshot.user.codexConfig,{});
assert.equal(nodes(card()).some(n=>n.type===mod.FullConfigModal),false);
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
saveMode='reject';await assert.rejects(full.props.onSave('{"backend":"exec"}'));assert.ok(nodes(card()).some(n=>n.type===mod.FullConfigModal));
saveMode='ok';face.discard();full.props.onClose();
passed('full JSON: all configuration fields, hidden backend, types, atomic validation, persistence and failed save');

// The three views share one draft. A rejected registry write keeps both drafts.
const {createConfigurationEditor}=await import('../lib/configuration-editor.js');
const {DEFAULT_FIELD_REGISTRY:editorFields}=await import('../lib/codex-fields.js');
const {FALLBACK_CATALOG:editorCatalog}=await import('../lib/model-catalog.js');
const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
const editorHome=fs.mkdtempSync(path.join(os.tmpdir(),'client-registry-'));
try{
  const registry=createConfigurationEditor({home:editorHome}).get({...editorCatalog,configuration:editorFields});
  registry.document.codexVersion='1.0.0';registry.document.updatedAt='2026-01-01T00:00:00.000Z';
  const modalState=[],submissions=[];
  const modalProps={t,initial:JSON.stringify({maxConcurrent:2}),catalog:editorCatalog,registryInitial:registry,disabled:false,onClose:()=>{},onSave:async(...args)=>{submissions.push(args);}};
  const editorTree=()=>render(mod.FullConfigModal,modalProps,modalState);
  const tab=id=>nodes(editorTree()).find(node=>node.props?.role==='tab'&&node.props.id==='codex-editor-tab-'+id).props.onClick();
  const input=label=>nodes(editorTree()).find(node=>node.type==='textarea'&&node.props['aria-label']===label);
  assert.deepEqual(nodes(editorTree()).filter(node=>node.type==='th').map(node=>node.props.children),['来源','键','值','值范围','说明与翻译']);
  input('maxConcurrent 值').props.onChange({target:{value:'4'}});
  tab('config');assert.equal(JSON.parse(input(t('editor.config')).props.value).maxConcurrent,4);
  input(t('editor.config')).props.onChange({target:{value:JSON.stringify({maxConcurrent:5,retentionDays:0})}});
  tab('table');assert.equal(input('maxConcurrent 值').props.value,'5');
  const webName=input('web_search 名称翻译');assert.ok(webName);webName.props.onChange({target:{value:'联网检索'}});
  tab('registry');assert.equal(JSON.parse(input(t('editor.registry')).props.value).translations.settings.web_search.name,'联网检索');
  const registryValue=JSON.parse(input(t('editor.registry')).props.value);registryValue.translations.settings.web_search.description='选择检索方式';
  input(t('editor.registry')).props.onChange({target:{value:JSON.stringify(registryValue)}});
  tab('table');assert.equal(input('web_search 说明翻译').props.value,'选择检索方式');
  assert.equal(nodes(editorTree()).find(n=>n.props?.['data-registry-version']!==undefined).props.children,'1.0.0');
  const refreshArgs=[],fresh=structuredClone(registry);fresh.document.codexVersion='2.0.0';fresh.document.updatedAt='2026-01-02T00:00:00.000Z';
  fresh.document.translations.efforts.low.description='刷新得到的低强度说明';
  fresh.document.fields.web_search.fallbackSchema.enum.push('new-remote-choice');
  modalProps.loadRegistry=async args=>{refreshArgs.push(args);return fresh;};
  input('maxConcurrent 值').props.onChange({target:{value:'6'}});
  await click(editorTree(),'editor.refreshRegistry');assert.deepEqual(refreshArgs,[{refresh:true}]);
  assert.equal(nodes(editorTree()).find(n=>n.props?.['data-registry-version']!==undefined).props.children,'2.0.0');
  assert.equal(nodes(editorTree()).find(n=>n.props?.['data-registry-updated']!==undefined).props.dateTime,fresh.document.updatedAt);
  assert.equal(input('maxConcurrent 值').props.value,'6','refresh preserves pending config cell input');
  assert.equal(input('web_search 名称翻译').props.value,'联网检索');assert.equal(input('web_search 说明翻译').props.value,'选择检索方式');
  tab('registry');const refreshedDraft=JSON.parse(input(t('editor.registry')).props.value);
  assert.equal(refreshedDraft.codexVersion,'2.0.0');assert.equal(refreshedDraft.updatedAt,fresh.document.updatedAt);
  assert.equal(refreshedDraft.translations.efforts.low.description,'刷新得到的低强度说明');
  assert.ok(refreshedDraft.fields.web_search.fallbackSchema.enum.includes('new-remote-choice'));
  tab('table');assert.equal(nodes(editorTree()).filter(n=>n.props?.['data-editor-row']?.startsWith('metadata:')).length,2);
  modalProps.loadRegistry=async()=>{throw Error('simulated refresh failure');};await click(editorTree(),'editor.refreshRegistry');
  assert.equal(nodes(editorTree()).find(n=>n.props?.['data-registry-updated']!==undefined).props.dateTime,fresh.document.updatedAt);
  assert.equal(input('web_search 名称翻译').props.value,'联网检索');
  modalProps.loadRegistry=async()=>structuredClone(mod.BUNDLED_EDITOR_STATE);await click(editorTree(),'editor.refreshRegistry');
  assert.equal(input('web_search 名称翻译').props.value,'联网检索','connection fallback preserves pending registry edits');
  assert.equal(input('web_search 名称翻译').props.readOnly,true);
  modalProps.loadRegistry=async()=>fresh;await click(editorTree(),'editor.refreshRegistry');
  assert.equal(input('web_search 名称翻译').props.value,'联网检索','reconnecting preserves the same draft');
  assert.equal(!!input('web_search 名称翻译').props.readOnly,false);
  input('maxConcurrent 值').props.onChange({target:{value:'invalid'}});
  tab('config');assert.ok(nodes(editorTree()).some(node=>node.props?.role==='alert'));
  assert.equal(nodes(editorTree()).find(node=>node.props?.role==='tab'&&node.props['aria-selected']).props.id,'codex-editor-tab-table');
  input('maxConcurrent 值').props.onChange({target:{value:'6'}});
  await click(editorTree(),'save');assert.equal(JSON.parse(submissions[0][0]).maxConcurrent,6);assert.equal(submissions[0][1].document.translations.settings.web_search.name,'联网检索');
  modalProps.onSave=async()=>{throw Error('Registry changed on disk');};await click(editorTree(),'save');
  assert.ok(nodes(editorTree()).some(node=>node.props?.role==='alert'&&node.props.children.includes('changed on disk')));
  assert.equal(input('web_search 说明翻译').props.value,'选择检索方式');
  tab('registry');input(t('editor.registry')).props.onChange({target:{value:'{"version":1,"fields":null}'}});
  modalProps.loadRegistry=async args=>{refreshArgs.push(args);return fresh;};await click(editorTree(),'editor.refreshRegistry');
  assert.equal(refreshArgs.length,1,'invalid JSON is retained and blocks refresh rather than discarding edits');
  tab('table');assert.equal(nodes(editorTree()).find(node=>node.props?.role==='tab'&&node.props['aria-selected']).props.id,'codex-editor-tab-registry');
  const tableRows=mod.configurationTableRows({maxConcurrent:2},registry,editorCatalog,t);
  assert.equal(tableRows.filter(row=>row.kind==='config').length,Object.keys(SETTINGS_SPEC).length-1);
  assert.equal(tableRows.filter(row=>row.kind==='metadata').length,2);
  assert.equal(tableRows.find(row=>row.key==='maxConcurrent').source,'插件内置');
  assert.equal(tableRows.find(row=>row.key==='defaultModel').source,'codex');
  assert.equal(tableRows.find(row=>row.key==='maxConcurrent').range,'1–8 (整数)');
  const tEn=key=>mod.DICTS.en[key]||key;
  const englishRows=mod.configurationTableRows({},registry,editorCatalog,tEn);
  for(const localizedRow of tableRows.filter(row=>['registry','translation'].includes(row.kind))){
    assert.match(localizedRow.description,/[\u3400-\u9fff]/,localizedRow.id+' Chinese explanation');
    const englishRow=englishRows.find(row=>row.id===localizedRow.id);
    assert.ok(englishRow.description.trim(),englishRow.id+' English explanation');
    assert.doesNotMatch(englishRow.description,/[\u3400-\u9fff]/,englishRow.id+' never displays Chinese translations');
  }
  assert.match(tableRows.find(row=>row.id==='registry:log_dir').description,/Codex 日志目录/);
  assert.match(englishRows.find(row=>row.id==='registry:log_dir').description,/Directory for log files/);
  const future=structuredClone(registry);future.document.fields['future.key']={allow:true};
  future.configuration.fields['future.key']={description:'Unknown future English description'};
  assert.equal(mod.configurationTableRows({},future,editorCatalog,t).find(row=>row.key==='future.key').description,t('editor.missingDescription'));
  const englishState=[],englishProps={...modalProps,t:tEn,registryInitial:registry};
  const englishTree=()=>render(mod.FullConfigModal,englishProps,englishState);
  assert.equal(nodes(englishTree()).filter(node=>node.type==='textarea').length,Object.keys(SETTINGS_SPEC).length-1,'English table edits configuration only, not Chinese translations');
  const englishText=nodes(englishTree()).map(node=>typeof node.props?.children==='string'?node.props.children:'').join(' ');
  assert.doesNotMatch(englishText,/[\u3400-\u9fff]/,'English visible text is English');
  englishProps.t=t;
  assert.ok(nodes(englishTree()).some(node=>node.props?.['aria-label']==='log_dir 说明翻译'),'switching locale restores Chinese editors in the same dialog');
  assert.equal(nodes(englishTree()).find(node=>node.props?.['aria-label']==='log_dir 说明翻译').props.value,registry.document.translations.settings.log_dir.description);
  const offlineRows=mod.configurationTableRows({},null,editorCatalog,t);
  assert.equal(offlineRows.find(row=>row.key==='quotaWarningThreshold').range,'0–20 (整数)');
  assert.equal(mod.parseFullConfig('{"quotaWarningThreshold":5}').find(([key])=>key==='quotaWarningThreshold')[1],'5');
  for(const lang of ['zh','en'])for(const key of mod.ALL_FIELDS){assert.ok(mod.DICTS[lang]['f.'+key],key);assert.ok(mod.DICTS[lang]['h.'+key],key);}
  passed('registry editor: five columns, all config fields, source/ranges, three synchronized tabs, table value/translation edits, invalid input and failure retention');
}finally{fs.rmSync(editorHome,{recursive:true,force:true});}

assert.equal(mod.ROWS.some(spec=>spec.name==='driverPath'),false);
assert.equal(nodes(card()).some(node=>node.key==='value-driverPath'),false);
const customDriver=process.execPath+'.driver.mjs';
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
await full.props.onSave(JSON.stringify({...JSON.parse(full.props.initial),driverPath:customDriver}));
assert.equal(snapshot.user.driverPath,customDriver);
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
assert.equal(JSON.parse(full.props.initial).driverPath,customDriver);full.props.onClose();
face.edit('debugLogs','true');await face.save();assert.equal(snapshot.user.driverPath,customDriver,'other settings preserve the hidden driver path');
for(const value of [42,true,{}])assert.throws(()=>mod.parseFullConfig(JSON.stringify({driverPath:value})));
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
await full.props.onSave(JSON.stringify({...JSON.parse(full.props.initial),driverPath:null}));
assert.equal(Object.hasOwn(snapshot.user,'driverPath'),false,'clearing JSON driver path restores the bundled driver');
passed('JSON-only driver path retains save/reopen, unrelated edits, validation and clear');

const budgetKey='defaultBudgetMs';
assert.equal(mod.ROWS.some(row=>row.name===budgetKey),false);
assert.equal(nodes(card()).some(node=>node.key==='value-'+budgetKey),false);
assert.equal(mod.ALL_FIELDS.includes(budgetKey),true);
assert.equal(SETTINGS_DEFAULTS[budgetKey],0);
for(const lang of ['zh','en'])for(const prefix of ['f.','h.'])assert.equal(Object.hasOwn(mod.DICTS[lang],prefix+budgetKey),true);
for(const value of [0,600000,2147483647]){
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  await full.props.onSave(JSON.stringify({...JSON.parse(full.props.initial),[budgetKey]:value}));
  assert.equal(snapshot.user[budgetKey],value);
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  assert.equal(JSON.parse(full.props.initial)[budgetKey],value,'hidden budget remains numeric on reopen');
  for(const invalid of [-1,0.5,'600000',true,2147483648]){
    before=writes.length;await assert.rejects(full.props.onSave(JSON.stringify({[budgetKey]:invalid})));
    assert.equal(writes.length,before,'invalid hidden budget never saves');
  }
  full.props.onClose();
  face.edit('debugMaxBytes','1000');await face.save();assert.equal(snapshot.user[budgetKey],value,'other settings retain the hidden budget');
}
for(const config of [{[budgetKey]:null},{}]){
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  await full.props.onSave(JSON.stringify(config));assert.equal(Object.hasOwn(snapshot.user,budgetKey),false);
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  assert.equal(JSON.parse(full.props.initial)[budgetKey],null);full.props.onClose();
}
passed('JSON-only shared run budget retains numeric save/reopen, validation, clear/inherit and unrelated edits');

const interruptKey='agents.interrupt_message';
assert.equal(mod.ROWS.some(row=>row.name===interruptKey),false);
assert.equal(nodes(card()).some(node=>node.key==='value-'+interruptKey || node.key==='switch-'+interruptKey),false);
for(const lang of ['zh','en'])for(const prefix of ['f.','h.'])assert.equal(Object.hasOwn(mod.DICTS[lang],prefix+interruptKey),true);
assert.equal(mod.ALL_FIELDS.includes(interruptKey),true);
for(const value of [true,false]) {
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  await full.props.onSave(JSON.stringify({...JSON.parse(full.props.initial),[interruptKey]:value}));
  assert.equal(snapshot.user[interruptKey],value,'saved as boolean');
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  assert.equal(JSON.parse(full.props.initial)[interruptKey],value,'snapshot retains boolean type');
  before=writes.length;
  await assert.rejects(full.props.onSave(JSON.stringify({[interruptKey]:String(value)})));
  assert.equal(writes.length,before,'invalid string never stages or saves');
  full.props.onClose();
}
for(const invalid of [{[interruptKey]:'custom message'},{codexConfig:{[interruptKey]:'false'}},{extraCodexConfig:[interruptKey+'=message']}])assert.throws(()=>mod.parseFullConfig(JSON.stringify(invalid)));
assert.doesNotThrow(()=>mod.parseFullConfig(JSON.stringify({codexConfig:{[interruptKey]:false}})));
assert.doesNotThrow(()=>mod.parseFullConfig(JSON.stringify({extraCodexConfig:[interruptKey+'=true']})));
for(const clear of [{[interruptKey]:null},{}]) {
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  await full.props.onSave(JSON.stringify(clear));assert.equal(Object.hasOwn(snapshot.user,interruptKey),false);
  click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
  assert.equal(JSON.parse(full.props.initial)[interruptKey],null);full.props.onClose();
}
passed('JSON-only interrupt message: hidden row and translations, boolean save/reopen, invalid text rejection, null/omitted inheritance');

const fallbackFields=structuredClone(mod.CONFIG_WHITELIST);
const {compileFieldRegistry,DEFAULT_FIELD_REGISTRY}=await import('../lib/codex-fields.js');
for(const value of ['untrusted','on-failure']) {
  assert.throws(()=>mod.parseFullConfig(JSON.stringify({approvalPolicy:value})));
  face.edit('approvalPolicy',value);assert.equal(field('approvalPolicy').invalid,true);face.discard();
}
for(const lang of ['zh','en'])assert.equal(Object.hasOwn(mod.DICTS[lang],'o.untrusted'),false);
const dynamicFields=compileFieldRegistry({overrides:{version:1,fields:{
  approval_policy:{schema:{oneOf:[{type:'string',enum:['on-request','future-review','untrusted']},{type:'object',properties:{nested:{enum:['nested-only']}}}]}},
  sandbox_mode:{schema:{type:'string',enum:['read-only','future-sandbox']}},
  'sandbox_workspace_write.network_access':{schema:{type:'boolean',const:false}},
  'future.flag':{allow:true,schema:{type:'boolean'}},
  'future.options':{allow:true,schema:{type:'object',required:['mode'],additionalProperties:false,properties:{mode:{type:'string',enum:['fast','steady']}}}},
  'agents.interrupt_message':{allow:true,schema:{type:'string',enum:['record','silent']}},
}}});
mod.updateFieldRegistry({configuration:dynamicFields});
assert.throws(()=>mod.parseFullConfig('{"workspaceNetworkAccess":true}'));
for(const value of ['true','false',1])assert.throws(()=>mod.parseFullConfig(JSON.stringify({workspaceNetworkAccess:value})));
const networkControl=row('workspaceNetworkAccess').props.control;
networkControl.props.onChange(true);assert.equal(field('workspaceNetworkAccess').invalid,true);face.discard();
networkControl.props.onChange(false);assert.equal(field('workspaceNetworkAccess').invalid,false);
await face.save();assert.equal(snapshot.user.workspaceNetworkAccess,false);
assert.equal(new Map(mod.parseFullConfig('{"workspaceNetworkAccess":false}')).get('workspaceNetworkAccess'),'false');
const sandboxMenu=row('sandboxMode').props.control.type(row('sandboxMode').props.control.props);
assert.deepEqual(sandboxMenu.props.items.map(item=>item.id),['read-only','future-sandbox']);
assert.equal(sandboxMenu.props.items.find(item=>item.id==='future-sandbox').label,'future-sandbox');
for(const value of ['workspace-write','danger-full-access','unknown']) {
  assert.throws(()=>mod.parseFullConfig(JSON.stringify({sandboxMode:value})));
  face.edit('sandboxMode',value);assert.equal(field('sandboxMode').invalid,true);face.discard();
}
sandboxMenu.props.onSelect('read-only');assert.equal(field('sandboxMode').invalid,false);
await face.save();assert.equal(snapshot.user.sandboxMode,'read-only');
assert.doesNotThrow(()=>mod.parseFullConfig('{"sandboxMode":"future-sandbox"}'));
const approvalMenu=row('approvalPolicy').props.control.type(row('approvalPolicy').props.control.props);
assert.deepEqual(approvalMenu.props.items.map(item=>item.id),['on-request','future-review']);
assert.equal(approvalMenu.props.items.find(item=>item.id==='future-review').label,'future-review');
assert.throws(()=>mod.parseFullConfig('{"approvalPolicy":"never"}'));
assert.throws(()=>mod.parseFullConfig('{"approvalPolicy":"untrusted"}'));
approvalMenu.props.onSelect('future-review');assert.equal(field('approvalPolicy').invalid,false);
await face.save();assert.equal(snapshot.user.approvalPolicy,'future-review');
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
assert.equal(JSON.parse(full.props.initial).approvalPolicy,'future-review');full.props.onClose();
assert.equal(JSON.parse(full.props.initial).sandboxMode,'read-only');
assert.equal(JSON.parse(full.props.initial).workspaceNetworkAccess,false);
assert.doesNotThrow(()=>mod.parseFullConfig('{"approvalPolicy":"future-review"}'));
assert.doesNotThrow(()=>mod.parseFullConfig(JSON.stringify({codexConfig:{'future.flag':false,'future.options':{mode:'fast'}}})));
for(const invalid of [{'future.flag':'false'},{'future.options':{mode:'unknown'}},{'future.options':{mode:'fast',extra:true}}])assert.throws(()=>mod.parseFullConfig(JSON.stringify({codexConfig:invalid})));
assert.doesNotThrow(()=>mod.parseFullConfig(JSON.stringify({'agents.interrupt_message':'record'})));
assert.throws(()=>mod.parseFullConfig(JSON.stringify({'agents.interrupt_message':true})));
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
await full.props.onSave(JSON.stringify({'agents.interrupt_message':'record'}));assert.equal(snapshot.user['agents.interrupt_message'],'record');
click(card(),'editConfig');full=nodes(card()).find(n=>n.type===mod.FullConfigModal);
assert.equal(JSON.parse(full.props.initial)['agents.interrupt_message'],'record');
await full.props.onSave('{}');mod.updateFieldRegistry({configuration:{config:fallbackFields,fields:DEFAULT_FIELD_REGISTRY.fields}});
assert.deepEqual(row('approvalPolicy').props.control.type(row('approvalPolicy').props.control.props).props.items.map(item=>item.id),['never','on-request']);
assert.deepEqual(row('sandboxMode').props.control.type(row('sandboxMode').props.control.props).props.items.map(item=>item.id),['workspace-write','read-only','danger-full-access']);
passed('runtime registry updates approval and sandbox menus, form and JSON validation, native types and saved values');
const changedNetwork=structuredClone(DEFAULT_FIELD_REGISTRY);changedNetwork.fields['sandbox_workspace_write.network_access'].schema={type:'string'};
mod.updateFieldRegistry({configuration:changedNetwork});
for(const value of [true,false,'true'])assert.throws(()=>mod.parseFullConfig(JSON.stringify({workspaceNetworkAccess:value})));
mod.updateFieldRegistry({configuration:DEFAULT_FIELD_REGISTRY});
passed('network schema changes cannot silently change the boolean switch semantics');

assert.deepEqual(nodes(card()).filter(n=>n.type===mod.Section).map(n=>n.props.section.id),['advanced']);
assert.deepEqual(nodes(card()).filter(n=>n.type==='div'&&n.props?.['data-section']).map(n=>n.props['data-section']),['quota','core','policy']);
assert.equal(mod.ALL_FIELDS.includes('uiLayout'),false);
assert.throws(()=>mod.parseFullConfig('{"uiLayout":{"version":1}}'));
for(const lang of ['zh','en'])for(const spec of mod.ROWS.filter(row=>row.name!=='backend')){assert.ok(mod.DICTS[lang][spec.label],lang+' '+spec.label);assert.ok(mod.DICTS[lang][spec.hint],lang+' '+spec.hint);}
passed('fixed page sections and bilingual labels');
let source;globalThis.EventSource=class{constructor(url){this.url=url;source=this;}close(){this.closed=true;}};
let events=0;const off=face.subscribeRunEnds(()=>events++);source.onmessage({data:'bad-json'});source.onmessage({data:'{}'});source.onmessage({data:JSON.stringify({run_id:'sample',status:'failed'})});assert.equal(events,1);off();assert.equal(source.closed,true);delete globalThis.EventSource;
for(const dispose of disposers.reverse())dispose();assert.equal(listeners.size,0);passed('terminal event validation and subscription disposal');
console.log('CLIENT-CONTROLS-OK '+reports.length+' groups; 21 visible rows + full JSON; '+(hostForm?'installed host form model':'contract doubles')+'; no live host acceptance');
