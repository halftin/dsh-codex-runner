/**
 * 客户端 bundle 的离线冒烟（随包发布；**不依赖宿主、不需要重启 DSH**）。
 *
 * 做法：伪造 `window.__ModuleLoader__.load` → 取 factory → 用桩 `require` 装配 →
 * 跑 `apply(ctx)` → 断言槽位注册/`whileServed` → 渲染整表 →
 * **验行顺序与每个控件的交互口径**（开关 / 下拉 / 文本框）。
 *
 * 运行：`node scripts/client-smoke.mjs`（退出码 0 = 通过）
 * 路径全部派生（`import.meta.url` + `os.tmpdir()`），不含任何机器特定内容。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { parsePolicy as parseHostPolicy } from '../lib/selection-policy.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = pathToFileURL(path.join(ROOT, 'lib', 'client.js')).href;

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };

const jx = (type, props, key) => ({ type, props, key });
const FormModel = class {
  constructor(scope, specs) { this._spec = new Map(specs.map((s) => [s.field, s])); }
  shell() { return { available: true, writable: true, dirty: true, invalid: false, saving: false, failed: false }; }
  // 与官方实现同形：{ text, overridden, invalid }
  field(name) { return { text: String(this._spec.get(name).format(sample[name])), overridden: true, invalid: false }; }
  bind(projection) { return { getSnapshot: () => projection(), subscribe: () => () => {} }; }
  actions() {
    return {
      save: () => { saved = true; },
      discard: () => {},
      edit: (name, text) => {
        edits.push(name + '=' + text);
        const parsed = this._spec.get(name).parse(text);
        if (parsed && parsed.kind === 'set') sample[name] = parsed.value;
        else if (parsed && parsed.kind === 'clear') delete sample[name];
      },
      resetField: (name) => { resets.push(name); },
    };
  }
  dispose() { disposed = true; }
};
const sample = {
  backend:'app-server',autoResumeAfterQuota:false,quotaWarning:false,quotaWarningThreshold:5,selectionMode:'evidence',
  autoModelAndEffort: true, serviceTier: 'fast', workspaceNetworkAccess: false,
  selectionPolicy: JSON.stringify({version:1,mode:'audit'}),
  defaultModel: 'gpt-6.1-sol', defaultEffort: 'high', maxEffortAllowed: 'xhigh',
  sandboxMode: 'workspace-write', approvalPolicy: 'never',
  defaultBudgetMs: 0,
  driverPath: '/fake/drive-codex.mjs',
};
let saved = false, disposed = false; const edits = []; const resets = [];

const primitives = {
  SettingsFormModel: FormModel,
  SettingsForm: (props) => ({ type: 'SettingsForm', props }),
  Switch: (props) => ({ type: 'Switch', props }),
  Menu: (props) => ({ type: 'Menu', props }),
  Button: (props) => ({ type: 'Button', props }),
  Input: (props) => ({ type: 'Input', props }),
  Tag: (props) => ({ type: 'Tag', props }),
  settingsTextField: (field) => ({ field, format: (v) => (v == null ? '' : String(v)), parse: (x) => ({ kind: 'set', value: x }) }),
  settingsNumberField: (field) => ({ field, format: (v) => (v == null ? '' : String(v)), parse: (x) => ({ kind: 'set', value: Number(x) }) }),
};
let hookState=null,hookCursor=0;
function renderWithHooks(component,props,state=[]) {hookState=state;hookCursor=0;try{return component(props);}finally{hookState=null;}}
const requireStub = (id) => {
  if (id === 'react') return {
    useState: init=>{if(!hookState)return [typeof init==='function'?init():init,()=>{}];const state=hookState,index=hookCursor++;if(!(index in state))state[index]=typeof init==='function'?init():init;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];},
    useEffect:()=>{},useRef:()=>({current:null}),useSyncExternalStore:(_subscribe,snapshot)=>snapshot(),
  };
  if (id === 'react/jsx-runtime') return { jsx: jx, jsxs: jx, Fragment: 'Fragment' };
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require: ' + id);
};

await import(CLIENT);
const mod = captured.factory(requireStub);

const registered = []; const localeRegistered = []; let whileServedNs = null;
const ctx = {
  inject: () => () => {}, // Optional conversation service is absent in this settings fixture.
  locale: { bind: () => (k) => k, register: (ns, dict) => { localeRegistered.push(ns + ':' + Object.keys(dict).length); return () => {}; } },
  configForms: {
    get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', writable: true, value: {} }) }),
    whileServed: (nsList, fn) => { whileServedNs = nsList; fn(); return () => {}; },
  },
  slots: {
    inject: (name, fn) => { fn(); return () => {}; },
    register: (spec, comp) => { registered.push({ spec, comp }); return () => {}; },
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
};
mod.apply(ctx);

const out = [];
const check = (label, cond, extra) => out.push((cond ? 'OK   ' : 'FAIL ') + label + (extra ? '  ' + extra : ''));
check('inject = slots,locale,configForms', mod.inject.join(',') === 'slots,locale,configForms');
check('槽位 plugins.bundle.config(key=dsh-codex-runner)',
  registered.some(row=>row.spec.name === 'plugins.bundle.config' && row.spec.key === 'dsh-codex-runner'));
check('原生 codex_run 实时输出卡片',registered.some(row=>row.spec.name==='tool.call.toolview'&&row.spec.key==='codex_run'));
check('whileServed = [dsh-codex-runner]', String(whileServedNs) === 'dsh-codex-runner');
check('词典注册（zh+en）', localeRegistered.length === 1 && localeRegistered[0].endsWith(':2'), localeRegistered.join('|'));

const configEntry=registered.find(row=>row.spec.name==='plugins.bundle.config');
const card = configEntry.comp;
const face = configEntry.spec.inject();
check('summary 渲染', card({ t: (k) => k, view: 'summary' }) === 'description');
const dictZh = mod.DICTS.zh;
const tStub = (k) => dictZh[k] || k;
const cardProps={t:tStub,view:'full',useCodexRunnerForm:sel=>sel(face.hooks.codexRunnerForm.getSnapshot()),...face};
const cardHooks=[];
const tree=renderWithHooks(card,cardProps,cardHooks);
const isPageSection=el=>el?.type===mod.Section||!!el?.props?.['data-section'];
const sections=tree.props.children.filter(isPageSection);
const children=sections.flatMap(el=>el.props.children).filter(el=>el&&/^(switch|select|value|slider|preset-number|path)-/.test(String(el.key)));

const switches = children.filter((el) => String(el.key).indexOf('switch-') === 0);
const selects = children.filter((el) => String(el.key).indexOf('select-') === 0);
const values = children.filter((el) => String(el.key).indexOf('value-') === 0);
const paths = children.filter(el=>String(el.key).startsWith('path-'));
const sliders = children.filter((el) => String(el.key).indexOf('slider-') === 0);
const order = children.map((el) => String(el.key).replace(/^(switch|select|value|slider|preset-number|path)-/, ''));

check('21 行：流式开关与增强选档模式直接可见', children.length === 21, String(children.length));
check('开关 9 / 下拉 8 / 文本 0 / 路径 2 / 保留策略 1 / 暂停等待 1 / 独立滑块行 0',
  switches.length === 9 && selects.length === 8 && values.length === 0 && paths.length === 2 && children.filter(row=>row.key==='preset-number-retentionDays').length===1 && sliders.length === 0,
  switches.length + '/' + selects.length + '/' + values.length + '/' + sliders.length);
check('行顺序（模型→强度→上限→加速档→额度告警→阈值→沙箱模式→沙箱网络→审批→自动模型→自动强度→三项数值→三项路径）',
  order.join(',') === 'defaultModel,defaultEffort,serviceTier,streamOutputEnabled,supervisionEnabled,quotaWarning,autoResumeAfterQuota,statusPollingEnabled,autoModelAndEffort,selectionPolicy,selectionMode,maxEffortAllowed,sandboxMode,approvalPolicy,workspaceNetworkAccess,debugLogs,maxConcurrent,retentionDays,codexExecutable,codexHome,pauseGraceMs',
  order.join(','));
check('沙箱模式在审批策略的上一行',
  order.indexOf('sandboxMode') === order.indexOf('approvalPolicy') - 1,
  'sandboxMode@' + order.indexOf('sandboxMode') + ' approvalPolicy@' + order.indexOf('approvalPolicy'));
check('每行「标题+说明」与控件同行',
  switches.concat(selects, sliders, paths).every((r) => r.props.label && r.props.hint !== undefined && r.props.control));
check('开关用官方 Switch；下拉用官方 Menu（锚点 Button）',
  switches.every((r) => r.props.control.type(r.props.control.props).type === 'Switch') &&
  selects.every((r) => {
    const rendered = r.props.control.type(r.props.control.props);
    return rendered.type === primitives.Menu && rendered.props.anchor.type === primitives.Button;
  }));

const sw = {};
for (const r of switches) sw[String(r.key).replace('switch-', '')] = r.props.control.props;
check('开关初值来自快照（autoModelAndEffort=true / serviceTier=fast→checked）',
  sw.autoModelAndEffort.checked === true && sw.serviceTier.checked === true);
sw.autoModelAndEffort.onChange(true); sw.serviceTier.onChange(false);
check('开关写回 autoModelAndEffort=true / serviceTier=off',
  edits.slice(-2).join(' ') === 'autoModelAndEffort=true serviceTier=off', edits.slice(-3).join(' '));

const sliderRow = {props:{control:switches.find(r=>r.key==='switch-quotaWarning').props.beforeControl}};
const sliderRendered = sliderRow.props.control.type(sliderRow.props.control.props);
check('额度告警滑块：初值 5% 且开关关闭时禁用',
  sliderRendered.props.children[0].props.type === 'range' && sliderRendered.props.children[0].props.value === '5' &&
  sliderRendered.props.children[0].props.disabled === true);
face.edit('autoResumeAfterQuota','true');
const enabledWarning=card({t:tStub,view:'full',useCodexRunnerForm:sel=>sel(face.hooks.codexRunnerForm.getSnapshot()),...face}).props.children.filter(isPageSection).flatMap(el=>el.props.children).find(el=>el?.key==='switch-quotaWarning');
enabledWarning.props.control.props.onChange(true);
const rerendered = card({ t: tStub, view: 'full', useCodexRunnerForm: (sel) => sel(face.hooks.codexRunnerForm.getSnapshot()), ...face });
const rerenderedSlider=rerendered.props.children.filter(isPageSection).flatMap(el=>el.props.children).find(el=>el?.key==='switch-quotaWarning');
const sliderRendered2=rerenderedSlider.props.beforeControl.type(rerenderedSlider.props.beforeControl.props);
check('打开额度告警后滑块可用', sliderRendered2.props.children[0].props.disabled === false);
sliderRendered2.props.children[0].props.onChange({ target: { value: '10' } });
check('滑块写回 quotaWarningThreshold=10',
  edits[edits.length - 1] === 'quotaWarningThreshold=10', edits[edits.length - 1]);

const dd = {};
for (const r of selects) dd[String(r.key).replace('select-', '')] = r.props.control.type(r.props.control.props).props;
check('新设置读取与保存',sw.autoResumeAfterQuota.checked===false && !dd.backend && sample.backend==='app-server' && dd.selectionMode.selectedId==='evidence');
sw.autoResumeAfterQuota.onChange(true);face.edit('backend','exec');dd.selectionMode.onSelect('manual');
check('额度/驱动/选档写回',edits.slice(-3).join(' ')==='autoResumeAfterQuota=true backend=exec selectionMode=manual');
check('defaultModel 下拉 selectedId 与选项（4 模型）',
  dd.defaultModel.selectedId === 'gpt-6.1-sol' &&
  dd.defaultModel.items.map((i) => i.id).join(',') === 'gpt-6.1-sol,gpt-6-astra,gpt-6-sol,gpt-6-luna');
check('未翻译选项回落原始值 / 已翻译选项用词典',
  dd.defaultModel.items[0].label === 'gpt-6.1-sol' &&
  dd.sandboxMode.items.filter((i) => i.id === 'read-only')[0].label === dictZh['o.read-only']);
check('sandboxMode 下拉含 danger-full-access', dd.sandboxMode.items.some((i) => i.id === 'danger-full-access'));
check('approvalPolicy 两个选项的词典文案都带括号说明',
  ['o.never', 'o.on-request'].every((k) => /[（(].+[）)]/.test(dictZh[k] || '')),
  ['o.never', 'o.on-request'].map((k) => k + '→' + dictZh[k]).join(' | '));
check('approvalPolicy 渲染出的标签就是词典文案',
  dd.approvalPolicy.items.filter((i) => i.id).map((i) => i.label).join('|') ===
  ['o.never', 'o.on-request'].map((k) => dictZh[k]).join('|'));
dd.defaultModel.onSelect('gpt-6-astra'); dd.sandboxMode.onSelect('danger-full-access');
check('下拉写回 defaultModel=gpt-6-astra / sandboxMode=danger-full-access',
  edits.slice(-2).join(' ') === 'defaultModel=gpt-6-astra sandboxMode=danger-full-access', edits.slice(-2).join(' '));

face.save(); face.discard();
check('save/discard 已接线', saved === true);


// U3 assertions keep the original controls and exercise the new IA and policy flow.
check('IA 顺序 quota/core/policy/advanced',sections.map(s=>s.props.section?.id||s.props['data-section']).join(',')==='quota,core,policy,advanced');
check('高级设置默认折叠',mod.Section(sections.find(s=>s.props.section?.id==='advanced').props).props.open===false);
const allNodes=node=>!node||typeof node!=='object'?[]:[node,...(Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).flatMap(allNodes)];
// 自定义 Row 的排版必须与官方 SettingsValueField（label 13px/500、hint 12px）一致，
// 否则同一页会出现“大字/小字”两套字体（--dsw-font-* 是 font 简写，不能当 font-size 用）。
const rowNodes=allNodes(mod.Row({t:tStub,label:dictZh['f.workspaceNetworkAccess'],hint:dictZh['h.workspaceNetworkAccess'],onReset:()=>{},control:null}));
const styleOf=text=>rowNodes.find(n=>n.props?.children===text)?.props?.style||{};
const rowLabel=styleOf(dictZh['f.workspaceNetworkAccess']);
check('自定义行标题 13px/500（与官方字段同字号）',rowLabel.fontSize==='13px'&&rowLabel.fontWeight===500);
check('自定义行说明 12px（与官方字段 hint 同字号）',styleOf(dictZh['h.workspaceNetworkAccess']).fontSize==='12px');
check('恢复默认 12px',styleOf(dictZh.reset).fontSize==='12px');
const policyRow=children.find(row=>row.key==='select-selectionPolicy');
const policyBadge=allNodes(mod.Row(policyRow.props)).find(node=>node.type===primitives.Tag);
check('选档策略使用独立的原生灰色 beta 标签',policyBadge?.props.tone==='neutral'&&policyBadge.props.children==='beta'&&!policyRow.props.label.includes('Beta')&&children.filter(row=>row.props.badge).length===1&&!switches.some(row=>row.props.badge));
const policyButton=allNodes(tree).find(n=>n.props?.children===dictZh.editPolicy&&n.type===primitives.Button);
check('选档策略按钮存在',!!policyButton);policyButton.props.onClick();
const openedPolicy=allNodes(renderWithHooks(card,cardProps,cardHooks)).find(n=>n.type===mod.PolicyModal);
check('按钮打开策略 modal',!!openedPolicy);
await openedPolicy.props.onSave(mod.policyPreset('balanced'));
check('真实弹窗保存接入 configForms',!!sample.selectionPolicy&&parseHostPolicy(JSON.parse(sample.selectionPolicy)).mode==='audit'&&saved);

// 渐进披露：预设策略从属于主开关；策略关闭时其下控件一律不渲染。
face.edit('selectionPolicy',JSON.stringify({version:1,mode:'off'}));
const policyClosedTree=renderWithHooks(card,cardProps,[]);
check('策略关闭：选档方式与强度上限不再渲染',!allNodes(policyClosedTree).some(n=>n.key==='select-selectionMode'||n.key==='select-maxEffortAllowed'));
check('策略关闭：隐藏策略编辑器、刷新目录与目录来源',
  !allNodes(policyClosedTree).some(n=>n.type===primitives.Button&&n.props?.children===dictZh.editPolicy)&&
  !allNodes(policyClosedTree).some(n=>n.props?.children===dictZh.refreshCatalog)&&
  !allNodes(policyClosedTree).some(n=>typeof n.props?.children==='string'&&n.props.children.startsWith(dictZh.catalogSource)));
face.edit('autoModelAndEffort','false');
const autonomyClosedTree=renderWithHooks(card,cardProps,[]);
const closedPolicyRow=allNodes(autonomyClosedTree).find(n=>n.key==='select-selectionPolicy');
check('主开关关闭：策略行禁用并给出前置提示',closedPolicyRow?.props.disabled===true&&closedPolicyRow?.props.hint===dictZh.policyNeedsAutonomy);
check('主开关关闭：策略下控件仍全部隐藏',!allNodes(autonomyClosedTree).some(n=>n.key==='select-selectionMode'||n.key==='select-maxEffortAllowed'||(n.type===primitives.Button&&n.props?.children===dictZh.editPolicy)));
face.edit('autoModelAndEffort','true');face.edit('selectionPolicy',JSON.stringify({version:1,mode:'audit'}));

await face.refreshCatalog();check('服务缺失保留 fallback',face.views.getSnapshot().catalog.models.length===4&&!!face.views.getSnapshot().error);
let rpcCall;const api=mod.connectionApi({rpc:{call:async(...args)=>{rpcCall=args;return {ok:true,value:{models:[{id:'future'}]}};}}});
check('只读目录使用认证 Connection', (await api.getCatalog({refresh:true})).models[0].id==='future'&&rpcCall[0]==='/codex-runner'&&rpcCall[1]==='getCatalog');
let applied=null,closed=false;const modalHooks=[];
const modalProps={t:tStub,initial:'',catalog:face.views.getSnapshot().catalog,disabled:false,onSave:async value=>{applied=value;},onClose:()=>{closed=true;}};
let modal=renderWithHooks(mod.PolicyModal,modalProps,modalHooks);
const policyDialog=allNodes(modal).find(n=>n.props?.role==='dialog');
check('策略弹窗字号 13px',policyDialog?.props.style.fontSize==='13px');
check('策略弹窗原生控件继承字号',allNodes(modal).find(n=>n.type==='select')?.props.style.font==='inherit');
check('策略 modal 五个 tab',allNodes(modal).filter(n=>n.props?.role==='tab').length===5);
check('预览含推荐/实际/降级',allNodes(modal).find(n=>n.props?.['data-policy-preview'])?.props.children.includes('gpt-6-astra/xhigh'));
allNodes(modal).find(n=>n.props?.children===dictZh['preset.strict']).props.onClick();
modal=renderWithHooks(mod.PolicyModal,modalProps,modalHooks);
check('严格预设生效',mod.parseClientPolicy(modalHooks[0]).mode==='enforce');
allNodes(modal).find(n=>n.props?.children===dictZh['tab.json']).props.onClick();modal=renderWithHooks(mod.PolicyModal,modalProps,modalHooks);
const jsonDraft=allNodes(modal).find(n=>n.type==='textarea').props;
check('高级 JSON 保留缩进换行',jsonDraft.value.includes('\n  "version"')&&jsonDraft.value.split('\n').length>10);
check('高级 JSON 关闭拼写检查',jsonDraft.spellCheck===false);
allNodes(modal).find(n=>n.type==='textarea').props.onChange({target:{value:'{bad'}});modal=renderWithHooks(mod.PolicyModal,modalProps,modalHooks);
check('非法 JSON 阻止保存',allNodes(modal).find(n=>n.props?.children===dictZh.save).props.disabled===true&&allNodes(modal).some(n=>n.props?.role==='alert'));
allNodes(modal).find(n=>n.props?.children===dictZh['preset.balanced']).props.onClick();modal=renderWithHooks(mod.PolicyModal,modalProps,modalHooks);
await allNodes(modal).find(n=>n.props?.children===dictZh.save).props.onClick();
check('保存给 configForms 的值通过 host 校验',parseHostPolicy(applied).mode==='audit');
assert.deepEqual(mod.parseClientPolicy(JSON.stringify(mod.policyPreset('economy'))),parseHostPolicy(mod.policyPreset('economy')));
allNodes(modal).find(n=>n.props?.children===dictZh['preset.strict']).props.onClick();modal=renderWithHooks(mod.PolicyModal,modalProps,modalHooks);
window.confirm=()=>false;allNodes(modal).find(n=>n.props?.children===dictZh.cancel).props.onClick();check('未保存关闭需确认',closed===false);
window.confirm=()=>true;allNodes(modal).find(n=>n.props?.children===dictZh.cancel).props.onClick();check('确认后关闭',closed===true);



// U5: quota bar and terminal invalidation use the same read-only service data.
const quotaFixture={scope:'account-wide',status:'ok',source:'app-server',sampled_at:new Date().toISOString(),stale:false,windows:{five_hour:{remaining_percent:5,reset_in_sec:3600,resets_at:new Date(Date.now()+3600000).toISOString()},seven_day:{remaining_percent:80,reset_in_sec:86400,resets_at:new Date(Date.now()+86400000).toISOString()}},warning:{enabled:true,threshold:5,triggered:true},recovery:{phase:'wake_scheduled',resume_at:'sample'}};
let quotaRequests=0;ctx.codexRunner={getQuota:async()=>{quotaRequests++;return quotaFixture;}};
await face.refreshQuota('fresh');
check('额度工具与 UI 使用共享服务',face.views.getSnapshot().quota===quotaFixture&&quotaRequests===1);
const bar=mod.QuotaBar({t:tStub,quota:face.views.getSnapshot().quota,onRefresh:()=>face.refreshQuota('fresh')});
check('额度条字号 13px',bar.props.style.fontSize==='13px');
check('额度条有 5h/7d 进度与阈值线',allNodes(bar).filter(n=>n.type==='progress').length===2&&allNodes(bar).some(n=>n.props?.['aria-label']===dictZh.warningLine+' 5%'));
check('额度恢复态可见',allNodes(bar).some(n=>typeof n.props?.children==='string'&&n.props.children.includes('wake_scheduled')));
let eventSource;globalThis.EventSource=class{constructor(){eventSource=this;}close(){this.closed=true;}};window.location={href:'http://localhost/'};
const endSubscription=face.subscribeRunEnds(()=>{void face.refreshQuota('fresh');});eventSource.onmessage({data:JSON.stringify({run_id:'fixture-run',status:'ok'})});await Promise.resolve();
check('run 终态事件刷新，无轮询',quotaRequests===2);endSubscription();check('页面卸载关闭事件流',eventSource.closed===true);delete globalThis.EventSource;delete ctx.codexRunner;


// U6: native config and advanced controls retain all prior field capabilities.
check('并发上限：同行下拉 1–8，空配置显示 1',dd.maxConcurrent.selectedId==='1'&&dd.maxConcurrent.items.map(item=>item.id).join(',')==='1,2,3,4,5,6,7,8');
check('原生子 agent 配置和分组已移除，中断消息仅保留 JSON',!mod.ROWS.some(row=>row.name.startsWith('agents.'))&&!allNodes(tree).some(node=>node.props?.['data-native-agent-group'])&&mod.ALL_FIELDS.includes('agents.interrupt_message'));
check('暂停等待的强制中断说明明确',dictZh['h.pauseGraceMs'].includes('强制中断'));

if(process.env.CODEX_UI_PREVIEW_DIR) {
  const target=path.resolve(process.env.CODEX_UI_PREVIEW_DIR);
  const relative=path.relative(os.tmpdir(),target);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Preview output must be in os.tmpdir()');
  fs.mkdirSync(target,{recursive:true});
  const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const style=value=>Object.entries(value||{}).map(([key,value])=>key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+':'+(typeof value==='number'&&!['fontWeight','lineHeight','zIndex','flex','opacity'].includes(key)?value+'px':value)).join(';');
  function html(node) {
    if(node==null||node===false)return '';if(Array.isArray(node))return node.map(html).join('');if(typeof node!=='object')return escape(node);
    const {type,props={}}=node;
    if(type===primitives.SettingsForm)return '<main>'+html(props.children)+'<footer><button>保存</button> <button>取消修改</button></footer></main>';
    if(type===primitives.Switch)return '<input type="checkbox" aria-label="'+escape(props.label||'')+'" '+(props.checked?'checked':'')+'>';
    if(type===primitives.Button)return '<button '+(props.disabled?'disabled':'')+'>'+html(props.children)+'</button>';
    if(type===primitives.Menu)return html(props.anchor);
    if(type===primitives.Input)return html({type:'input',props});
    if(typeof type==='function')return html(type(props));
    const attrs=Object.entries(props).filter(([key,value])=>!['children','ref','key'].includes(key)&&!key.startsWith('on')&&value!==undefined&&value!==false&&value!==null).map(([key,value])=>value===true?' '+key:' '+key+'="'+escape(key==='style'?style(value):value)+'"').join('');
    return '<'+type+attrs+'>'+(['input','br','hr'].includes(type)?'':html(props.children)+'</'+type+'>');
  }
  const page=content=>'<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><style>:root{color-scheme:light dark;font:14px/1.5 system-ui}body{margin:0;padding:16px}main{max-width:800px;margin:auto}button,input,select,textarea{font:inherit;max-width:100%;box-sizing:border-box}button{padding:8px 12px;cursor:pointer}small{display:block;font-size:12px;max-width:50ch;opacity:.75}summary{cursor:pointer}.preview-field{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid GrayText}.preview-field input{width:200px}footer{padding:24px 0}</style><body>'+content+'</body></html>';
  fs.writeFileSync(path.join(target,'settings.html'),page(html(renderWithHooks(card,cardProps,[]))));
  fs.writeFileSync(path.join(target,'policy.html'),page(html(renderWithHooks(mod.PolicyModal,modalProps,[]))));
}

console.log('--- 结果 ---');
for (const line of out) console.log('  ' + line);
const failed = out.filter((l) => l.startsWith('FAIL'));
console.log(failed.length === 0 ? 'CLIENT-SMOKE-OK' : 'CLIENT-SMOKE-FAIL=' + failed.length);
process.exit(failed.length === 0 ? 0 : 1);
