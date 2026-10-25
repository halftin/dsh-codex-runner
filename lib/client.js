/**
 * dsh-codex-runner —— 浏览器半边：**插件页里的设置表单**（P3-2，2026-10-10 改版）。
 *
 * 形态与官方设置页一致（参考 @deepseek-ai/dsh-client-ui-settings-web-search 与 bridge-next）：
 *   - bundle 是 `window.__ModuleLoader__.load({ id, factory: (require) => … })` 形式的 CJS 模块，
 *     externals 只有 `react` / `react/jsx-runtime` 与官方包 —— **不需要打包器**。
 *   - 注册进 `plugins.bundle.config`（key = 我们的包名）→ 点开插件详情页即见设置表单。
 *   - 表单数据面用官方 `configForms` 服务 + `SettingsFormModel`：作用域按**插件 profile 入口 id**
 *     （`dsh-codex-runner`）寻址，保存写进当前 profile 的 Cordis patch（保留注释），即时应用。
 *
 * 布局：
 *   · `ROWS` 定义控件，`PAGE_LAYOUT` 统一维护分组和显示顺序
 *   · 两选项（布尔）→ 官方 `Switch`，与标题/说明**同一行**
 *   · 多选项（枚举）→ 下拉框（官方 `Menu` + `Button`），与标题/说明**同一行**
 *   · 路径 → 官方 `Input`；数字 → 预设菜单与可编辑输入框；各行保留恢复默认
 *   · 沙箱相关按语义排序：由「沙箱模式」直接决定权限
 *
 * 字段快照形状由官方 `SettingsFormModel.field()` 决定，只有 `{ text, overridden, invalid }`；
 * `text` 由**我们自己的 spec.format()** 决定，所以开关/下拉都能直接从它读当前值。
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-runner',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    /** 我们的 profile 入口 id（= 设置作用域名；与 cordis.patch.yml 的 - id 一致）。 */
    const ENTRY_ID = 'dsh-codex-runner';
    /** 本页自己的词典命名空间。 */
    const NS = 'settings.codexRunner';

    /* ------------------------------ 文案 ------------------------------ */
    const en = {
      'f.backend': 'Codex driver',
      'h.backend': 'App Server enables current-turn steering and quota recovery. It inherits Codex user configuration; explicit run permissions still apply',
      'f.autoResumeAfterQuota': 'Resume automatically after quota recovery',
      'h.autoResumeAfterQuota': "Off by default. Requires App Server and DSH scheduling/storage. When recovery triggers, it wakes DSH to recheck quota and resumes Codex, using model tokens on both sides",
      'f.quotaWarning': "Save progress and pause at low quota",
      'h.quotaWarning': "Off by default. At the threshold, asks Codex to save progress and end the turn; this uses extra Codex model tokens",
      'f.quotaWarningThreshold': 'Quota warning threshold',
      'h.quotaWarningThreshold': 'Send the warning when remaining quota is below this value',
      'f.selectionMode': 'Model selection policy',
      'h.selectionMode': "Task-type rules run in code. Evidence mode needs file scope and acceptance information from DSH and may use extra DSH model tokens",
      'o.exec': 'CLI exec (compatibility)', 'o.app-server': 'App Server (interactive)',
      'o.legacy': 'Task-kind rules', 'o.manual': 'Explicit model and effort', 'o.evidence': 'Verified evidence and declared risks',
      description: 'Controls and the full JSON editor share the same DSH profile settings. Save changes to apply them to subsequent tasks; supported per-task parameters can override them for one invocation',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct',
      readOnly: 'These settings are read-only in this deployment',
      reset: 'Reset',
      beta: 'beta',
      invalid: 'Enter a valid value, or leave blank to use the default',
      inheritCodex: 'Inherit Codex configuration',
      'f.defaultModel': 'Default model',
      'h.defaultModel': "Choose the default model for Codex tasks; affects Codex quota usage",
      'f.defaultEffort': 'Default effort',
      'h.defaultEffort': "Choose the default reasoning effort for Codex tasks; affects Codex token usage",
      'f.maxEffortAllowed': 'Effort ceiling (autonomy cap)',
      'h.maxEffortAllowed': "Caps the reasoning effort available to Codex tasks and affects their token usage. Explicit unlock_effort can allow a higher effort",
      'f.serviceTier': 'Fast lane (service tier)',
      'h.serviceTier': 'On = fast: runs faster and consumes more quota',
      'f.sandboxMode': 'Sandbox mode',
      'h.sandboxMode': 'Decides the actual permission. danger-full-access lets Codex write anywhere outside the workspace',
      'f.approvalPolicy': 'Approval policy',
      'h.approvalPolicy': 'never is right for non-interactive runs',
      'f.workspaceNetworkAccess': 'Network inside sandbox',
      'h.workspaceNetworkAccess': 'Allow outbound network while sandboxed',
      'f.autoModelAndEffort': 'Automatically fill model and reasoning effort',
      'h.autoModelAndEffort': "Uses supplied parameters, task-type rules or defaults; the plugin makes no separate model request to select them. Off requires both through parameters or a task type",
      'o.flex': 'flex',
      'o.fast': 'fast (more quota)',
      'o.workspace-write': 'workspace-write (workspace only)',
      'o.read-only': 'read-only',
      'o.danger-full-access': 'danger-full-access (unrestricted)',
      'o.never': 'never (never asks; non-interactive)',
      'o.on-request': 'on-request (the model decides when to ask)',
      'o.low': 'low',
      'o.medium': 'medium',
      'o.high': 'high',
      'o.xhigh': 'xhigh',
      'o.max': 'max',
      'o.ultra': 'ultra',
    };
    const zh = {
      'f.backend': 'Codex 驱动方式',
      'h.backend': 'App Server 支持当前轮插话及额度恢复。它继承 Codex 用户配置；运行权限仍由显式设置限定',
      'f.autoResumeAfterQuota': '额度恢复后自动继续',
      'h.autoResumeAfterQuota': "根据codex的恢复时间设置定时任务，向codex发送续跑消息，有少量token消耗",
      'f.quotaWarning': "低额度时保存进度并暂停",
      'h.quotaWarning': "到达设定阈值时将向codex发送暂停消息，让codex自己暂停，会在codex侧产生少量token消耗",
      'f.quotaWarningThreshold': '额度警告阈值',
      'h.quotaWarningThreshold': '额度低于此值时发送警告',
      'f.selectionMode': '模型选档方式',
      'h.selectionMode': "任务类型规则由代码执行；证据模式需要 DSH 提供文件范围和验收信息，可能增加 DSH 的模型 token 开销",
      'o.exec': 'CLI exec（兼容模式）', 'o.app-server': 'App Server（可插话）',
      'o.legacy': '任务类型规则', 'o.manual': '明确指定模型与强度', 'o.evidence': '文件证据与声明风险',
      description: '设置控件与完整 JSON 编辑器共用同一份 DSH 配置，保存后用于后续任务；单次调用参数只影响该次任务',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改',
      readOnly: '本部署的设置为只读',
      reset: '恢复默认',
      beta: 'beta',
      invalid: '请填合法值；留空表示使用默认值',
      inheritCodex: '继承 Codex 配置',
      'f.defaultModel': '默认模型档',
      'h.defaultModel': "设置 Codex 默认使用的模型，会影响 Codex 的额度消耗",
      'f.defaultEffort': '默认推理强度',
      'h.defaultEffort': "设置 Codex 默认使用的思考强度，会影响 Codex 的 token 用量",
      'f.maxEffortAllowed': '强度自治上限',
      'h.maxEffortAllowed': "限制 Codex 任务可用的最高思考强度，影响任务本身的 token 用量；单次 unlock_effort 可明确放行更高强度",
      'f.serviceTier': '加速通道（服务档）',
      'h.serviceTier': '打开 = fast：更快，但更耗额度',
      'f.sandboxMode': '沙箱模式',
      'h.sandboxMode': '**决定实际权限**：danger-full-access 时 Codex 不再受工作目录限制（可读写工作目录之外）',
      'f.approvalPolicy': '审批策略',
      'h.approvalPolicy': '非交互运行用 never',
      'f.workspaceNetworkAccess': '沙箱内网络',
      'h.workspaceNetworkAccess': '允许沙箱内访问外网',
      'f.autoModelAndEffort': '自动补全模型和思考强度',
      'h.autoModelAndEffort': "按调用参数、任务类型或配置默认值选档，插件不单独调用模型。关闭后需通过参数或任务类型提供模型和强度",
      'o.flex': 'flex',
      'o.fast': 'fast（更耗额度）',
      'o.workspace-write': 'workspace-write（仅工作目录）',
      'o.read-only': 'read-only（只读）',
      'o.danger-full-access': 'danger-full-access（不受限）',
      'o.never': 'never（从不询问，非交互运行）',
      'o.on-request': 'on-request（模型决定何时询问）',
      'o.low': 'low',
      'o.medium': 'medium',
      'o.high': 'high',
      'o.xhigh': 'xhigh',
      'o.max': 'max',
      'o.ultra': 'ultra',
    };

    /* ------------------------------ 字段表（顺序 = 表单顺序） ------------------------------ */
    // control: switch / select / slider / path / preset-number
    // tier: true → 该开关的"开"表示 fast、"关"表示 off（serviceTier 的两种表现）
    const ROWS = [
      { name: 'backend', control: 'select', label: 'f.backend', hint: 'h.backend', options: ['exec','app-server'] },
      { name: 'autoResumeAfterQuota', control: 'switch', label: 'f.autoResumeAfterQuota', hint: 'h.autoResumeAfterQuota' },
      { name: 'quotaWarning', control: 'switch', label: 'f.quotaWarning', hint: 'h.quotaWarning' },
      { name: 'quotaWarningThreshold', control: 'slider', numeric:true, min: 0, max: 20, step: 1, label: 'f.quotaWarningThreshold', hint: 'h.quotaWarningThreshold' },
      { name: 'selectionMode', control: 'select', label: 'f.selectionMode', hint: 'h.selectionMode', options: ['legacy','manual','evidence'] },
      { name: 'defaultModel', control: 'select', label: 'f.defaultModel', hint: 'h.defaultModel', options: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'] },
      { name: 'defaultEffort', control: 'select', label: 'f.defaultEffort', hint: 'h.defaultEffort', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { name: 'maxEffortAllowed', control: 'select', label: 'f.maxEffortAllowed', hint: 'h.maxEffortAllowed', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { name: 'serviceTier', control: 'switch', tier: true, label: 'f.serviceTier', hint: 'h.serviceTier' },
      // —— 沙箱：模式决定权限 ——
      { name: 'sandboxMode', control: 'select', label: 'f.sandboxMode', hint: 'h.sandboxMode', options: [] },
      { name: 'workspaceNetworkAccess', control: 'switch', label: 'f.workspaceNetworkAccess', hint: 'h.workspaceNetworkAccess' },
      { name: 'approvalPolicy', control: 'select', label: 'f.approvalPolicy', hint: 'h.approvalPolicy', options: [] },
      { name: 'autoModelAndEffort', control: 'switch', label: 'f.autoModelAndEffort', hint: 'h.autoModelAndEffort', experimental: true },
      { name: 'codexExecutable', control: 'path', label: 'f.codexExecutable', hint: 'h.codexExecutable', placeholder:'p.codexExecutable', error:'invalidExecutable' },
      { name: 'codexHome', control: 'path', label: 'f.codexHome', hint: 'h.codexHome', placeholder:'p.codexHome', error:'invalidHome' },
    ];
    ROWS.push(
      {name:'statusPollingEnabled',control:'switch',label:'f.statusPollingEnabled',hint:'h.statusPollingEnabled'},
      {name:'statusPollingIntervalMinutes',control:'slider',numeric:true,min:15,max:120,step:1,defaultValue:30,unitKey:'minutes',label:'f.statusPollingIntervalMinutes',hint:'h.statusPollingIntervalMinutes'},
      {name:'maxConcurrent',control:'select',numeric:true,label:'f.maxConcurrent',hint:'h.maxConcurrent',options:['1','2','3','4','5','6','7','8']},
      {name:'retentionDays',control:'preset-number',numeric:true,defaultValue:0,presets:[0,30,90,365],prefix:'retentionKeep',unit:'days',label:'f.retentionDays',hint:'h.retentionDays'},
      {name:'retentionMaxRuns',control:'preset-number',numeric:true,defaultValue:0,presets:[0,100,500,1000,2000,5000],prefix:'retentionMax',unit:'runs',label:'f.retentionMaxRuns',hint:'h.retentionMaxRuns'},
      {name:'debugLogs',control:'switch',label:'f.debugLogs',hint:'h.debugLogs'},
      {name:'debugMaxBytes',control:'preset-number',numeric:true,defaultValue:2,presets:[1,2,5,10],valueScale:1048576,prefix:'debugLimit',unit:'mebibytes',label:'f.debugMaxBytes',hint:'h.debugMaxBytes'},
      {name:'pauseGraceMs',control:'preset-number',numeric:true,defaultValue:0,presets:[0,30,60,120,300],valueScale:1000,decimalPlaces:3,prefix:'pauseRound',unit:'seconds',zeroLabel:'noPauseTimeout',label:'f.pauseGraceMs',hint:'h.pauseGraceMs'},
    );
    Object.assign(zh,{'f.statusPollingEnabled':'定时查询 Codex 状态','h.statusPollingEnabled':'让DSH 将定期查询Codex 情况并报告 ，会消耗 DSH 的模型 token',
      'f.statusPollingIntervalMinutes':'查询间隔（分钟）','h.statusPollingIntervalMinutes':'15–120，默认 30；同会话合并查询，结束后删除，不自动继续'});
    Object.assign(en,{'f.statusPollingEnabled':'Query Codex status periodically','h.statusPollingEnabled':'Off by default. Queries active runs and reports using DSH model tokens',
      'f.statusPollingIntervalMinutes':'Query interval (minutes)','h.statusPollingIntervalMinutes':'15–120, default 30. One query per session; removed when idle. Never continues tasks'});
    const SELECT_DEFAULTS={defaultModel:'gpt-6.1-sol',defaultEffort:'high',selectionMode:'legacy',maxEffortAllowed:'xhigh',sandboxMode:'workspace-write',approvalPolicy:'never',maxConcurrent:'1'};
    const JSON_ONLY_BOOL_FIELDS = ['agents.interrupt_message'];
    const JSON_ONLY_NUMBER_FIELDS = ['defaultBudgetMs'];
    const JSON_ONLY_TEXT_FIELDS = ['driverPath'];
    const ALL_FIELDS = ROWS.map((row) => row.name).concat(JSON_ONLY_BOOL_FIELDS,JSON_ONLY_NUMBER_FIELDS,JSON_ONLY_TEXT_FIELDS,['selectionPolicy','codexConfig','extraCodexConfig']);
    Object.assign(en,{'f.codexExecutable':'Codex executable','h.codexExecutable':'Leave blank to find Codex automatically. Set the absolute path to a native codex.exe if discovery fails or to choose a version',
      'p.codexExecutable':'Find Codex automatically','invalidExecutable':'Enter an absolute path to a native codex.exe, or leave blank. .cmd/.bat/.ps1 are unsupported',
      'f.codexHome':'Codex home','h.codexHome':'Contains Codex configuration, authentication and session history. Leave blank to inherit CODEX_HOME or the default .codex directory; specify it if login states differ',
      'p.codexHome':'Use the existing Codex home','invalidHome':'Enter an absolute directory path, or leave blank to inherit the existing home'});
    Object.assign(zh,{'f.codexExecutable':'Codex 可执行文件','h.codexExecutable':'留空自动查找 Codex；找不到程序或需指定版本时，填写原生 codex.exe 的绝对路径',
      'p.codexExecutable':'留空自动查找 Codex','invalidExecutable':'请填写原生 codex.exe 的绝对路径，或留空自动查找；不支持 .cmd/.bat/.ps1',
      'f.codexHome':'Codex 主目录','h.codexHome':'存放 Codex 配置、登录信息和会话历史；留空继承 CODEX_HOME 或默认的用户 .codex 目录。登录状态不一致时可手动指定',
      'p.codexHome':'留空使用现有 Codex 主目录','invalidHome':'请填写目录的绝对路径，或留空继承现有设置'});
    // tier 开关的取值是字符串（off/fast），**不能**走布尔 spec；其余开关才是布尔。
    const BOOL_NAMES = ROWS.filter((r) => r.control === 'switch' && !r.tier).map((r) => r.name).concat(JSON_ONLY_BOOL_FIELDS);
    const NUM_NAMES = ROWS.filter((r) => r.numeric).map((r) => r.name).concat(JSON_ONLY_NUMBER_FIELDS);
    const RETENTION_NAMES = ['retentionDays','retentionMaxRuns'];
    Object.assign(zh,{debugLimit:'上限',mebibytes:'MiB',pauseRound:'每轮',seconds:'秒',noPauseTimeout:'0（不限等待）'});
    Object.assign(en,{debugLimit:'Limit',mebibytes:'MiB',pauseRound:'Per round',seconds:'seconds',noPauseTimeout:'0 (wait indefinitely)'});
    Object.assign(zh,{retentionPolicy:'运行记录保留策略',retentionHint:'超出任一限制后清理；0 天不按时间清理，0 条不限数量。运行中、待通知或待恢复的记录保留',
      retentionKeep:'保留',retentionMax:'最多',days:'天',runs:'条',yearPreset:'1 年（365 天）',presets:'预设值',noAgeLimit:'0（不按时间清理）',noCountLimit:'0（不限数量）',
      'f.retentionDays':'保留天数','h.retentionDays':'默认 0，不按时间清理','f.retentionMaxRuns':'保留条数上限','h.retentionMaxRuns':'默认 0，不设条数上限'});
    Object.assign(en,{retentionPolicy:'Run history retention',retentionHint:'Clean up when either limit is exceeded. 0 days disables age-based cleanup; 0 runs removes the count limit. Preserve active runs and pending notifications or recovery',
      retentionKeep:'Keep',retentionMax:'Up to',days:'days',runs:'runs',yearPreset:'1 year (365 days)',presets:'Presets',noAgeLimit:'0 (no age limit)',noCountLimit:'0 (no count limit)',
      'f.retentionDays':'Retention days','h.retentionDays':'Default 0: no age-based cleanup','f.retentionMaxRuns':'Run count limit','h.retentionMaxRuns':'Default 0: no count limit'});


    /* UI constraint brief (Refactoring UI §§2.1, 2.8, 3.6):
     * Primary content: editable core run settings; one primary Save action.
     * Secondary: policy entry and quota snapshot.
     * Tertiary: diagnostic paths and collapsed advanced JSON.
     * Keep the existing DSH controls/theme variables; 8/16/24px spacing,
     * 14px body, 600 section labels, 1.5 line height; wrap controls on narrow screens.
     */
    const REASONING_ORDER=['low','medium','high','xhigh','max','ultra'];
function validateCatalogSelection(catalog,model,effort,tier='off') {
  const item=catalog.models.find(m=>m.id===model || m.model===model);
  if(!item)return 'Requested model is not in the catalog; see codex_models: '+model;
  if(!item.efforts.some(e=>e.id===effort))return 'Requested effort is not supported by '+model+': '+effort;
  const mapped=tier==='fast'?'priority':tier;
  if(mapped && mapped!=='off' && !item.serviceTiers.some(t=>t.id===mapped))return 'Requested service tier is not advertised for '+model+': '+mapped;
  return null;
}

const kinds=['mechanical','docs','review','implement','architect','rework'];
const evidenceKeys=['architecture','interface','concurrency','security','design_failure'];
// User policy ordering, not a claim that the catalog reports benchmark strength.
const modelOrder=['gpt-6-luna','gpt-6-sol','gpt-6.1-sol','gpt-6-astra'];
const pair=(model,effort)=>({model,effort});
const DEFAULT_SELECTION_POLICY={version:1,mode:'off',floors:{
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
function parsePolicy(value,catalog) {
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
function comparePair(actual,floor) {
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
function evaluateSelection({policy,taskKind,recommended,actual,explicitModel,explicitEffort,overrideReason,downgradeReason,claims={},stage}) {
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

    const FALLBACK_VIEW={"version":1,"models":[{"id":"gpt-6-luna","model":"gpt-6-luna","displayName":"gpt-6-luna","description":"","hidden":false,"isDefault":false,"defaultReasoningEffort":"high","efforts":[{"id":"low","description":""},{"id":"medium","description":""},{"id":"high","description":""},{"id":"xhigh","description":""},{"id":"max","description":""}],"serviceTiers":[{"id":"priority","name":"priority","description":""},{"id":"flex","name":"flex","description":""}]},{"id":"gpt-6-sol","model":"gpt-6-sol","displayName":"gpt-6-sol","description":"","hidden":false,"isDefault":false,"defaultReasoningEffort":"high","efforts":[{"id":"low","description":""},{"id":"medium","description":""},{"id":"high","description":""},{"id":"xhigh","description":""},{"id":"max","description":""},{"id":"ultra","description":""}],"serviceTiers":[{"id":"priority","name":"priority","description":""},{"id":"flex","name":"flex","description":""}]},{"id":"gpt-6.1-sol","model":"gpt-6.1-sol","displayName":"gpt-6.1-sol","description":"","hidden":false,"isDefault":true,"defaultReasoningEffort":"high","efforts":[{"id":"low","description":""},{"id":"medium","description":""},{"id":"high","description":""},{"id":"xhigh","description":""},{"id":"max","description":""},{"id":"ultra","description":""}],"serviceTiers":[{"id":"priority","name":"priority","description":""},{"id":"flex","name":"flex","description":""}]},{"id":"gpt-6-astra","model":"gpt-6-astra","displayName":"gpt-6-astra","description":"","hidden":false,"isDefault":false,"defaultReasoningEffort":"high","efforts":[{"id":"low","description":""},{"id":"medium","description":""},{"id":"high","description":""},{"id":"xhigh","description":""},{"id":"max","description":""},{"id":"ultra","description":""}],"serviceTiers":[{"id":"priority","name":"priority","description":""},{"id":"flex","name":"flex","description":""}]}]};

    const PAGE_LAYOUT={sections:[{id:'quota'},{id:'core'},{id:'policy'},{id:'advanced',collapsed:true}],rows:{
      core:['defaultModel','defaultEffort','serviceTier','quotaWarning','quotaWarningThreshold','autoResumeAfterQuota','statusPollingEnabled','statusPollingIntervalMinutes','autoModelAndEffort'],
      policy:['selectionMode','maxEffortAllowed'],
      advanced:['sandboxMode','approvalPolicy','workspaceNetworkAccess','debugLogs','maxConcurrent','retentionDays','codexExecutable','codexHome','pauseGraceMs'],
      quota:[],
    }};
    const editorStyle={width:'100%',minHeight:'96px',boxSizing:'border-box',font:'inherit',fontSize:'13px',lineHeight:1.5,padding:'8px',color:'var(--dsw-alias-label-primary, inherit)',background:'var(--dsw-alias-bg-base, Canvas)',border:'1px solid var(--dsw-alias-border-l2, GrayText)',borderRadius:'var(--dsw-radius-md, 8px)'};
    const actionStyle={display:'flex',alignItems:'center',flexWrap:'wrap',gap:'8px',margin:'8px 0'};
    /* 排版单一来源：与官方 SettingsValueField 对齐（13px/500 标题、12px 说明）。
     * 主表单行、策略弹窗、完整配置弹窗、额度条都从这里取字号，避免再漏出 16px。 */
    const TYPE_LABEL = { fontSize: '13px', fontWeight: 500, lineHeight: 1.5 };
    const TYPE_BODY = { fontSize: '13px', lineHeight: 1.5 };
    const TYPE_HINT = { fontSize: '12px', lineHeight: 1.5 };
    function parseClientPolicy(text,catalog) {return parsePolicy(text && String(text).trim()?text:{},catalog);}
    function policyPreset(name) {
      const policy=structuredClone(DEFAULT_SELECTION_POLICY);
      if(name==='strict') {policy.mode='enforce';policy.downgrade.allowed=false;policy.downgrade.require_approval=true;}
      if(name==='balanced')policy.mode='audit';
      if(name==='economy') {policy.mode='enforce';policy.floors.implement.effort='medium';policy.floors.review.model='gpt-6-sol';}
      return policy;
    }
    function createViewStore() {
      let state={catalog:{...FALLBACK_VIEW,source:'fallback',stale:true},loading:false,error:null};const listeners=new Set();
      return {getSnapshot:()=>state,subscribe:listener=>{listeners.add(listener);return ()=>listeners.delete(listener);},
        update:patch=>{state={...state,...patch};for(const fn of listeners)fn();}};
    }
    function connectionApi(connection) {
      if(!connection?.rpc?.call)return null;
      const call=async(method,args={})=>{
        let response;
        try{response=await connection.rpc.call('/codex-runner',method,args);}
        catch(error){
          // Some carriers expose only the shared /api surface. Never retry an
          // auth error or a service error; only a missing dedicated POST route.
          if(!/HTTP 405\b/.test(String(error?.message)))throw error;
          response=await connection.rpc.call('/api','codex-runner/'+method,args);
        }
        if(!response.ok)throw Error(response.error?.message||'Service unavailable');return response.value;
      };
      const editorCall=async(method,args)=>{try{return await call(method,args);}catch(error){if(/HTTP 404\b/.test(String(error?.message)))error.code='codex-runner/editor-endpoint-unavailable';throw error;}};
      return {getCatalog:args=>call('getCatalog',args),refreshCatalog:()=>call('refreshCatalog'),getQuota:args=>call('getQuota',args),getSubagents:runId=>call('getSubagents',{runId}),getEditorRegistry:args=>editorCall('getEditorRegistry',args),saveEditorRegistry:args=>editorCall('saveEditorRegistry',args)};
    }
    function QuotaBar({t,quota,error,loading,onRefresh}) {
      const buckets=[['five_hour','5h'],['seven_day','7d']];
      return jsxs('div',{style:{...TYPE_BODY},children:[
        ...buckets.map(([key,label],index)=>{const window=quota?.windows?.[key];return jsxs('div',{'data-quota-window':key,style:{margin:index===0?'0 0 16px':'16px 0'},children:[
          jsx('div',{children:label+' · '+(window?window.remaining_percent+'% '+t('remaining'):t('quotaUnknown'))}),
          window?jsxs('div',{style:{position:'relative',maxWidth:'480px'},children:[jsx('progress',{'aria-label':label+' '+t('remaining'),max:100,value:window.remaining_percent,style:{width:'100%',height:'8px'}}),
            quota.warning?.enabled?jsx('span',{'aria-label':t('warningLine')+' '+quota.warning.threshold+'%',style:{position:'absolute',left:quota.warning.threshold+'%',top:0,bottom:0,borderLeft:'2px solid var(--dsw-alias-label-primary, currentColor)'}}):null]}):null,
          window?jsx('time',{dateTime:window.resets_at||undefined,style:hintStyle,children:t('resetAfter')+': '+(window.reset_in_sec===null?'—':Math.ceil(window.reset_in_sec/60)+' '+t('minutes'))+(window.resets_at?' · '+new Date(window.resets_at).toLocaleString():'')}):null,
        ]},key);}),
        quota?jsx('p',{style:hintStyle,children:t('catalogSource')+': '+quota.source+' · '+(quota.stale?t('lastKnown'):t('sampled'))+' · '+(quota.sampled_at||'—')}):null,
        quota?.warning?.triggered?jsx('p',{role:'status',children:'⚠ '+t('quotaTriggered')+' '+quota.warning.threshold+'%'}):null,
        quota?.recovery?jsx('p',{children:t('recovery')+': '+quota.recovery.phase+' · '+(quota.recovery.resume_at||'—')}):null,
        error||quota?.error?jsx('p',{role:'status',style:hintStyle,children:error||quota.error}):null,
        jsx(P.Button,{variant:'outline',size:'sm',disabled:loading,onClick:onRefresh,children:loading?t('loading'):t('refreshQuota')}),
      ]});
    }
    function Section({section,title,children}) {
      const [open,setOpen]=react.useState(!section.collapsed);
      react.useEffect(()=>setOpen(!section.collapsed),[section.collapsed]);
      // §3.2/§3.6：保留折叠分组之间的一份 8px 间距。
      return jsxs('details',{'data-section':section.id,open,onToggle:event=>setOpen(event.currentTarget.open),
        style:{margin:'8px 0 0',minWidth:0},children:[jsx('summary',{style:{fontWeight:600,cursor:'pointer',padding:'8px 0'},children:title}),...children]});
    }
    Object.assign(zh,{fullConfig:'编辑完整配置与注册表',editConfig:'编辑完整配置与注册表',unsavedConfig:'存在未保存的配置或注册表修改，放弃修改并关闭？',
      'editor.table':'表格','editor.registry':'注册表 JSON','editor.config':'配置 JSON',
      'editor.source':'来源','editor.key':'键','editor.value':'值','editor.range':'值范围','editor.description':'说明与翻译',
      'editor.plugin':'插件内置','editor.translations':'目录翻译',
      'editor.hint':'表格与两个 JSON 页签同步。清空配置值或设为 null 使用默认值；注册表不保存任务配置值。手动编辑不调用模型',
      'editor.registryHint':'fields 维护字段规则，translations 维护中文翻译；版本和更新时间由刷新自动更新',
      'editor.inherited':'默认 / 继承','editor.codexInherited':'继承 Codex 配置','editor.text':'文本','editor.integer':'整数','editor.object':'JSON 对象','editor.array':'JSON 数组',
      'editor.name':'名称翻译','editor.meaning':'说明翻译','editor.filter':'搜索键、来源或说明',
      'editor.missingDescription':'此字段暂无中文说明，可在下方补充翻译',
      'editor.unavailable':'注册表加载失败；配置 JSON 仍可编辑','editor.retry':'重新加载注册表',
      'editor.endpointUnavailable':'当前 DSH 后端未提供注册表编辑接口（HTTP 404）。更新插件后，请完全退出并重新启动 DSH；仅刷新设置页面不会重新加载后端代码',
      'editor.codexVersion':'Codex 版本','editor.refreshRegistry':'刷新注册表','editor.lastUpdated':'最后更新时间','editor.versionUnknown':'未获取','editor.neverUpdated':'尚未刷新',
      'editor.versionRange':'版本字符串 | null','editor.timeRange':'ISO 8601 时间 | null',
      'editor.versionDescription':'注册表对应的本地 Codex 版本；由代码读取，不能手动修改',
      'editor.timeDescription':'注册表最近一次成功更新的时间；由代码记录，刷新失败时保留原值',
      'editor.refreshIssue':'注册表更新提示：',
      'editor.bundledFallback':'正在使用插件内置注册表（codex-registry.json）',
      'editor.bundledReadOnly':'外部注册表或服务不可用，注册表暂为只读；配置 JSON 仍可编辑',
      'editor.partial':'配置已保存，但注册表未保存。请保留此窗口并重试：',
      'editor.noMatches':'没有匹配的字段','editor.configScope':'配置 JSON','editor.registryScope':'注册表',
      'f.defaultBudgetMs':'任务运行预算','h.defaultBudgetMs':'毫秒；0 不限时。到达预算后结束运行',
      'f.driverPath':'自定义 driver 路径','h.driverPath':'留空使用插件内置 driver；否则填写绝对路径',
      'f.codexConfig':'原生 Codex 配置','h.codexConfig':'键为已允许的 Codex 注册表字段，值须符合该字段的类型与范围',
      'f.extraCodexConfig':'额外原生配置','h.extraCodexConfig':'key=value 字符串数组，同键覆盖 codexConfig；仍受注册表校验',
      'f.agents.interrupt_message':'原生中断消息','h.agents.interrupt_message':'布尔值；是否让 Codex 将中断信息写入模型上下文，null 继承 Codex 设置'});
    Object.assign(en,{fullConfig:'Edit full configuration and registry',editConfig:'Edit full configuration and registry',unsavedConfig:'Discard unsaved configuration or registry changes?',
      'editor.table':'Table','editor.registry':'Registry JSON','editor.config':'Configuration JSON',
      'editor.source':'Source','editor.key':'Key','editor.value':'Value','editor.range':'Allowed values','editor.description':'Description',
      'editor.plugin':'Built into plugin','editor.translations':'Catalog translations',
      'editor.hint':'The table and JSON tabs stay in sync. Clear a configuration value or use null for defaults. The registry does not store task settings. Manual edits make no model calls',
      'editor.registryHint':'fields defines compatibility rules; translations defines Chinese text. Version and update time are maintained by registry refresh',
      'editor.inherited':'Default / inherited','editor.codexInherited':'Inherit Codex configuration','editor.text':'Text','editor.integer':'Integer','editor.object':'JSON object','editor.array':'JSON array',
      'editor.name':'Name translation','editor.meaning':'Description translation','editor.filter':'Search keys, sources or descriptions',
      'editor.missingDescription':'No description supplied by Codex',
      'editor.unavailable':'Registry could not load; configuration JSON is still editable','editor.retry':'Reload registry',
      'editor.endpointUnavailable':'The current DSH backend does not provide the registry editor endpoint (HTTP 404). Fully quit and restart DSH after updating the plugin; refreshing the settings page does not reload backend code',
      'editor.codexVersion':'Codex version','editor.refreshRegistry':'Refresh registry','editor.lastUpdated':'Last updated','editor.versionUnknown':'Not available','editor.neverUpdated':'Not refreshed yet',
      'editor.versionRange':'Version string | null','editor.timeRange':'ISO 8601 timestamp | null',
      'editor.versionDescription':'Local Codex version associated with the registry. Read by code; not manually editable',
      'editor.timeDescription':'Last successful registry update, recorded by code. A failed refresh preserves the previous timestamp',
      'editor.refreshIssue':'Registry update notice: ',
      'editor.bundledFallback':'Using the bundled registry (codex-registry.json)',
      'editor.bundledReadOnly':'External registry data or service is unavailable. The registry is read-only; configuration JSON remains editable',
      'editor.partial':'Configuration saved, but registry was not saved. Keep this window open and retry: ',
      'editor.noMatches':'No matching fields','editor.configScope':'Configuration JSON','editor.registryScope':'Registry',
      'f.defaultBudgetMs':'Task time budget','h.defaultBudgetMs':'Milliseconds; 0 is unlimited. A finite budget ends the run when reached',
      'f.driverPath':'Custom driver path','h.driverPath':'Leave blank for the bundled driver; otherwise use an absolute path',
      'f.codexConfig':'Native Codex configuration','h.codexConfig':'Allowed registry keys with values matching their schemas',
      'f.extraCodexConfig':'Extra native configuration','h.extraCodexConfig':'An array of key=value strings overriding codexConfig; registry validation still applies',
      'f.agents.interrupt_message':'Native interruption messages','h.agents.interrupt_message':'Boolean: whether Codex records interruptions in model context. null inherits Codex configuration'});
    Object.assign(zh,{unsavedSettings:'有未保存的修改',settingsClean:'修改设置后，请点击保存',fixSettings:'请先修正无效的设置'});
    Object.assign(en,{unsavedSettings:'You have unsaved changes',settingsClean:'Click Save after changing settings',fixSettings:'Correct invalid settings before saving'});
    /* field-registry:start */
    const CONFIG_WHITELIST={"model_reasoning_summary":{"type":"enum","values":["none","auto","concise","detailed"],"schema":{"type":"string","enum":["none","auto","concise","detailed"]},"target":"model_reasoning_summary"},"model_verbosity":{"type":"enum","values":["low","medium","high"],"schema":{"type":"string","enum":["low","medium","high"]},"target":"model_verbosity"},"web_search":{"type":"enum","values":["disabled","cached","live"],"schema":{"type":"string","enum":["disabled","cached","live"]},"target":"web_search"},"model_context_window":{"type":"number","schema":{"type":"integer","minimum":0,"maximum":2147483647},"target":"model_context_window"},"model_auto_compact_token_limit":{"type":"number","schema":{"type":"integer","minimum":0,"maximum":2147483647},"target":"model_auto_compact_token_limit"},"agents.interrupt_message":{"type":"bool","schema":{"type":"boolean"},"target":"agents.interrupt_message"},"features.memories":{"type":"bool","schema":{"type":"boolean"},"target":"features.memories"},"features.apps":{"type":"bool","schema":{"type":"boolean"},"target":"features.apps"},"features.browser_use":{"type":"bool","schema":{"type":"boolean"},"target":"features.browser_use"},"features.computer_use":{"type":"bool","schema":{"type":"boolean"},"target":"features.computer_use"},"analytics.enabled":{"type":"bool","schema":{"type":"boolean"},"target":"analytics.enabled"},"check_for_update_on_startup":{"type":"bool","schema":{"type":"boolean"},"target":"check_for_update_on_startup"},"log_dir":{"type":"string","schema":{"type":"string"},"target":"log_dir"},"sqlite_home":{"type":"string","schema":{"type":"string"},"target":"sqlite_home"}};
    const SETTING_FIELD_KEYS={"approvalPolicy":"approval_policy","sandboxMode":"sandbox_mode","workspaceNetworkAccess":"sandbox_workspace_write.network_access"};
    const SETTING_FIELDS={"approvalPolicy":{"schema":{"type":"string","enum":["never","on-request"]},"excludedValues":["untrusted","on-failure"]},"sandboxMode":{"schema":{"type":"string","enum":["workspace-write","read-only","danger-full-access"]}},"workspaceNetworkAccess":{"schema":{"type":"boolean","default":false}}};
    const BUNDLED_EDITOR_STATE={"document":{"version":1,"codexVersion":null,"updatedAt":null,"fields":{"model_reasoning_summary":{"allow":true,"fallbackSchema":{"type":"string","enum":["none","auto","concise","detailed"]}},"model_verbosity":{"allow":true,"fallbackSchema":{"type":"string","enum":["low","medium","high"]}},"web_search":{"allow":true,"fallbackSchema":{"type":"string","enum":["disabled","cached","live"]}},"model_context_window":{"allow":true,"fallbackSchema":{"type":"integer","minimum":0,"maximum":2147483647}},"model_auto_compact_token_limit":{"allow":true,"fallbackSchema":{"type":"integer","minimum":0,"maximum":2147483647}},"agents.interrupt_message":{"allow":true,"fallbackSchema":{"type":"boolean"},"profile":true,"name":"Record native interruption messages","description":"Record a model-visible message when an agent turn is interrupted. Unset inherits Codex configuration; the Codex default is true."},"features.memories":{"allow":true,"fallbackSchema":{"type":"boolean"}},"features.apps":{"allow":true,"fallbackSchema":{"type":"boolean"}},"features.browser_use":{"allow":true,"fallbackSchema":{"type":"boolean"}},"features.computer_use":{"allow":true,"fallbackSchema":{"type":"boolean"}},"analytics.enabled":{"allow":true,"fallbackSchema":{"type":"boolean"}},"check_for_update_on_startup":{"allow":true,"fallbackSchema":{"type":"boolean"}},"log_dir":{"allow":true,"fallbackSchema":{"type":"string"}},"sqlite_home":{"allow":true,"fallbackSchema":{"type":"string"}},"model":{"used":true,"allow":false},"model_reasoning_effort":{"used":true,"allow":false},"service_tier":{"used":true,"allow":false},"sandbox_mode":{"used":true,"allow":false,"fallbackSchema":{"type":"string","enum":["workspace-write","read-only","danger-full-access"]}},"sandbox_workspace_write":{"used":true,"allow":false},"sandbox_workspace_write.network_access":{"used":true,"allow":false,"fallbackSchema":{"type":"boolean","default":false}},"approval_policy":{"used":true,"allow":false,"fallbackSchema":{"type":"string","enum":["never","on-request"]},"excludedValues":["untrusted","on-failure"]}},"translations":{"version":1,"locale":"zh-CN","models":{"gpt-6-luna":{"description":"机械任务与轻量工作"},"gpt-6-sol":{"description":"编码与日常工作"},"gpt-6.1-sol":{"description":"编码与日常工作的主力模型"},"gpt-6-astra":{"description":"复杂任务与深入推理"}},"efforts":{"low":{"description":"较轻推理"},"medium":{"description":"中等推理"},"high":{"description":"较深入推理"},"xhigh":{"description":"进一步推理"},"max":{"description":"最高推理档"},"ultra":{"description":"极高推理档"}},"tiers":{"priority":{"name":"Fast","description":"优先服务档，具体用量以 Codex 为准"},"flex":{"name":"Flex","description":"灵活服务档，具体可用性以目录为准"}},"settings":{"model_reasoning_summary":{"name":"推理摘要","description":"控制 Codex 提供的推理摘要：none 不提供，auto 自动，concise 简洁，detailed 详细。仅对支持此参数的模型生效；不是完整的内部思考过程。"},"model_verbosity":{"name":"回答详细程度","description":"控制支持此参数的模型的回答篇幅：low 简短，medium 适中，high 详细。可能影响输出 token 数量，不改变推理强度。"},"web_search":{"name":"网页搜索方式","description":"控制网页搜索：disabled 禁用，cached 使用缓存结果，live 实时检索。实际可用选项以当前 Codex 版本和注册表范围为准。"},"model_context_window":{"name":"模型上下文窗口","description":"以 token 为单位声明模型的上下文容量，供 Codex 管理上下文使用；填写此值不会增加模型实际支持的容量。留空继承 Codex 配置。"},"model_auto_compact_token_limit":{"name":"自动压缩上下文阈值","description":"上下文达到指定 token 数量时触发 Codex 自动压缩。压缩由 Codex 处理，可能产生模型 token 消耗；留空使用 Codex 的默认策略。"},"agents.interrupt_message":{"name":"记录原生中断消息","description":"agent 回合被中断时，记录一条模型可见的消息；未配置时继承 Codex 配置，Codex 默认开启。"},"features.memories":{"name":"原生记忆功能","description":"控制 Codex 的 memories 功能开关。具体行为及可用性由安装的 Codex 版本决定；插件仅传递配置，不另外调用模型生成记忆。"},"features.apps":{"name":"原生应用连接功能","description":"控制 Codex 的 apps 功能开关。具体行为、可用连接及权限由 Codex 管理；插件仅传递配置。"},"features.browser_use":{"name":"原生浏览器操作功能","description":"控制 Codex 的 browser_use 功能开关。实际支持情况及浏览器操作权限由安装的 Codex 版本决定；插件仅传递配置。"},"features.computer_use":{"name":"原生计算机操作功能","description":"控制 Codex 的 computer_use 功能开关。实际支持情况及计算机操作权限由安装的 Codex 版本决定；插件仅传递配置。"},"analytics.enabled":{"name":"OpenAI 使用情况分析","description":"设为 false 可关闭向 OpenAI 发送使用情况分析。不会关闭用户自行配置的 OTLP 指标导出；如需关闭后者，应另行配置 otel.metrics_exporter。"},"check_for_update_on_startup":{"name":"启动时检查更新","description":"控制 Codex 启动时是否检查并提示更新，Codex 默认开启。若更新由组织统一管理，可关闭检查。"},"log_dir":{"name":"Codex 日志目录","description":"指定 Codex 日志目录。显式设置还会将 SQLite 日志写入此目录并启用终端文本日志；留空时文本日志使用 $CODEX_HOME/log，SQLite 日志使用 sqlite_home。已有数据库不会自动迁移；受管理的 sqlite_home 要求优先。"},"sqlite_home":{"name":"Codex 状态数据库目录","description":"指定 Codex SQLite 状态数据库的存放目录。未设置时，优先使用 CODEX_SQLITE_HOME 环境变量，否则使用 CODEX_HOME。与插件的项目运行记录目录相互独立。"},"model":{"name":"运行模型","description":"指定 Codex 使用的模型标识。插件通过默认模型或单次任务参数管理此值，不开放通用配置覆盖；可选模型以当前目录为准。"},"model_reasoning_effort":{"name":"模型推理强度","description":"指定模型使用的推理强度，必须是当前模型支持的档位。插件通过默认推理强度或单次任务参数管理；更高强度可能消耗更多模型 token。"},"service_tier":{"name":"服务档位","description":"指定 Codex 请求的服务档位，例如 priority 或 flex。插件通过服务档位设置映射传递；实际可用性、用量与计费以 Codex 为准。"},"sandbox_mode":{"name":"沙箱模式","description":"控制运行权限：read-only 只读，workspace-write 允许写入工作区，danger-full-access 完整访问。由插件的沙箱设置管理，不开放通用配置覆盖。"},"sandbox_workspace_write":{"name":"工作区写入沙箱配置","description":"workspace-write 模式的沙箱配置对象，包括额外可写目录、网络访问和临时目录处理规则。插件通过专用权限逻辑管理，不开放整个对象的通用覆盖。"},"sandbox_workspace_write.network_access":{"name":"沙箱内网络","description":"控制 workspace-write 沙箱能否访问网络。true 允许，false 禁止；其他沙箱模式遵循各自权限。由插件的沙箱内网络开关管理。"},"approval_policy":{"name":"命令审批策略","description":"控制 Codex 何时请求命令审批：never 不请求，on-request 由模型按需请求。由插件的审批设置管理；当前插件不提供已弃用的 untrusted 和 on-failure 选项。"}},"meta":{"source":"default"}}},"configuration":{"version":1,"codexVersion":null,"source":"bundled","referenceSource":"bundled-registry","referenceVersion":null,"referenceMatched":false,"referenceFieldCount":21,"localFieldCount":0,"protocolSchemaCount":0,"fields":{"model_reasoning_summary":{"key":"model_reasoning_summary","name":"model_reasoning_summary","description":"A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process. See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries","schema":{"type":"string","enum":["none","auto","concise","detailed"]},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"string","enum":["none","auto","concise","detailed"]},"deprecated":false,"aliasOf":null,"allowed":true},"model_verbosity":{"key":"model_verbosity","name":"model_verbosity","description":"Optional verbosity control for GPT-5 models (Responses API `text.verbosity`).","schema":{"type":"string","enum":["low","medium","high"]},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"string","enum":["low","medium","high"]},"deprecated":false,"aliasOf":null,"allowed":true},"web_search":{"key":"web_search","name":"web_search","description":"Controls the web search tool mode: disabled, cached, indexed, or live.","schema":{"type":"string","enum":["disabled","cached","live"]},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"string","enum":["disabled","cached","live"]},"deprecated":false,"aliasOf":null,"allowed":true},"model_context_window":{"key":"model_context_window","name":"model_context_window","description":"Size of the context window for the model, in tokens.","schema":{"type":"integer","minimum":0,"maximum":2147483647},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"integer","minimum":0,"maximum":2147483647},"deprecated":false,"aliasOf":null,"allowed":true},"model_auto_compact_token_limit":{"key":"model_auto_compact_token_limit","name":"model_auto_compact_token_limit","description":"Token usage threshold triggering auto-compaction of conversation history.","schema":{"type":"integer","minimum":0,"maximum":2147483647},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"integer","minimum":0,"maximum":2147483647},"deprecated":false,"aliasOf":null,"allowed":true},"agents.interrupt_message":{"key":"agents.interrupt_message","name":"Record native interruption messages","description":"Record a model-visible message when an agent turn is interrupted. Unset inherits Codex configuration; the Codex default is true.","schema":{"type":"boolean"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean"},"deprecated":false,"aliasOf":null,"allowed":true},"features.memories":{"key":"features.memories","name":"features.memories","description":"Controls the native memories feature flag. Behavior and availability depend on the installed Codex version.","schema":{"type":"boolean"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean"},"deprecated":false,"aliasOf":null,"allowed":true},"features.apps":{"key":"features.apps","name":"features.apps","description":"Controls the native apps feature flag. Behavior and availability depend on the installed Codex version.","schema":{"type":"boolean"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean"},"deprecated":false,"aliasOf":null,"allowed":true},"features.browser_use":{"key":"features.browser_use","name":"features.browser_use","description":"Controls the native browser_use feature flag. Behavior and availability depend on the installed Codex version.","schema":{"type":"boolean"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean"},"deprecated":false,"aliasOf":null,"allowed":true},"features.computer_use":{"key":"features.computer_use","name":"features.computer_use","description":"Controls the native computer_use feature flag. Behavior and availability depend on the installed Codex version.","schema":{"type":"boolean"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean"},"deprecated":false,"aliasOf":null,"allowed":true},"analytics.enabled":{"key":"analytics.enabled","name":"analytics.enabled","description":"When `false`, disables OpenAI analytics across Codex product surfaces in this profile. Custom OTLP metrics exporters remain enabled; set `otel.metrics_exporter = \"none\"` to disable them.","schema":{"type":"boolean"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean"},"deprecated":false,"aliasOf":null,"allowed":true},"check_for_update_on_startup":{"key":"check_for_update_on_startup","name":"check_for_update_on_startup","description":"When `true`, checks for Codex updates on startup and surfaces update prompts. Set to `false` only if your Codex updates are centrally managed. Defaults to `true`.","schema":{"type":"boolean"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean"},"deprecated":false,"aliasOf":null,"allowed":true},"log_dir":{"key":"log_dir","name":"log_dir","description":"Directory for log files. Setting this value explicitly also routes the SQLite logs database here and enables the TUI text log in this directory. When unset, log files use `$CODEX_HOME/log` and SQLite logs use `sqlite_home`. Existing SQLite logs in `sqlite_home` are not migrated automatically. A managed `sqlite_home` requirement keeps SQLite logs in that required directory.","schema":{"type":"string"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"string"},"deprecated":false,"aliasOf":null,"allowed":true},"sqlite_home":{"key":"sqlite_home","name":"sqlite_home","description":"Directory where Codex stores the SQLite state DB. Defaults to `$CODEX_SQLITE_HOME` when set. Otherwise uses `$CODEX_HOME`.","schema":{"type":"string"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"string"},"deprecated":false,"aliasOf":null,"allowed":true},"model":{"key":"model","name":"model","description":"Optional override of model selection.","schema":{"description":"Optional override of model selection.","type":"string"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"description":"Optional override of model selection.","type":"string"},"deprecated":false,"aliasOf":null,"allowed":false},"model_reasoning_effort":{"key":"model_reasoning_effort","name":"model_reasoning_effort","description":"A non-empty reasoning effort value advertised by the model.","schema":{"description":"A non-empty reasoning effort value advertised by the model.","minLength":1,"type":"string"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"description":"A non-empty reasoning effort value advertised by the model.","minLength":1,"type":"string"},"deprecated":false,"aliasOf":null,"allowed":false},"service_tier":{"key":"service_tier","name":"service_tier","description":"Optional explicit service tier request id for new turns (for example `default`, `priority`, or `flex`; legacy `fast` also works).","schema":{"description":"Optional explicit service tier request id for new turns (for example `default`, `priority`, or `flex`; legacy `fast` also works).","type":"string"},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"description":"Optional explicit service tier request id for new turns (for example `default`, `priority`, or `flex`; legacy `fast` also works).","type":"string"},"deprecated":false,"aliasOf":null,"allowed":false},"sandbox_mode":{"key":"sandbox_mode","name":"sandbox_mode","description":"Sandbox mode to use.","schema":{"type":"string","enum":["workspace-write","read-only","danger-full-access"]},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"string","enum":["workspace-write","read-only","danger-full-access"]},"deprecated":false,"aliasOf":null,"allowed":false},"sandbox_workspace_write":{"key":"sandbox_workspace_write","name":"sandbox_workspace_write","description":"Sandbox configuration to apply if `sandbox` is `WorkspaceWrite`.","schema":{"allOf":[{"additionalProperties":false,"properties":{"exclude_slash_tmp":{"default":false,"type":"boolean"},"exclude_tmpdir_env_var":{"default":false,"type":"boolean"},"network_access":{"default":false,"type":"boolean"},"writable_roots":{"default":[],"items":{"description":"A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).\n\nIMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.","type":"string"},"type":"array"}},"type":"object"}],"description":"Sandbox configuration to apply if `sandbox` is `WorkspaceWrite`."},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"allOf":[{"additionalProperties":false,"properties":{"exclude_slash_tmp":{"default":false,"type":"boolean"},"exclude_tmpdir_env_var":{"default":false,"type":"boolean"},"network_access":{"default":false,"type":"boolean"},"writable_roots":{"default":[],"items":{"description":"A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).\n\nIMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.","type":"string"},"type":"array"}},"type":"object"}],"description":"Sandbox configuration to apply if `sandbox` is `WorkspaceWrite`."},"deprecated":false,"aliasOf":null,"allowed":false},"sandbox_workspace_write.network_access":{"key":"sandbox_workspace_write.network_access","name":"sandbox_workspace_write.network_access","description":"Whether the workspace-write sandbox permits network access. Other sandbox modes keep their own permission semantics.","schema":{"type":"boolean","default":false},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"boolean","default":false},"deprecated":false,"aliasOf":null,"allowed":false},"approval_policy":{"key":"approval_policy","name":"approval_policy","description":"Default approval policy for executing commands.","schema":{"type":"string","enum":["never","on-request"]},"source":"bundled-registry","codexVersion":null,"availability":"reference-only","referenceSchema":{"type":"string","enum":["never","on-request"]},"deprecated":false,"aliasOf":null,"allowed":false,"excludedValues":["untrusted","on-failure"]}},"config":{"model_reasoning_summary":{"type":"enum","values":["none","auto","concise","detailed"],"schema":{"type":"string","enum":["none","auto","concise","detailed"]},"target":"model_reasoning_summary"},"model_verbosity":{"type":"enum","values":["low","medium","high"],"schema":{"type":"string","enum":["low","medium","high"]},"target":"model_verbosity"},"web_search":{"type":"enum","values":["disabled","cached","live"],"schema":{"type":"string","enum":["disabled","cached","live"]},"target":"web_search"},"model_context_window":{"type":"number","schema":{"type":"integer","minimum":0,"maximum":2147483647},"target":"model_context_window"},"model_auto_compact_token_limit":{"type":"number","schema":{"type":"integer","minimum":0,"maximum":2147483647},"target":"model_auto_compact_token_limit"},"agents.interrupt_message":{"type":"bool","schema":{"type":"boolean"},"target":"agents.interrupt_message"},"features.memories":{"type":"bool","schema":{"type":"boolean"},"target":"features.memories"},"features.apps":{"type":"bool","schema":{"type":"boolean"},"target":"features.apps"},"features.browser_use":{"type":"bool","schema":{"type":"boolean"},"target":"features.browser_use"},"features.computer_use":{"type":"bool","schema":{"type":"boolean"},"target":"features.computer_use"},"analytics.enabled":{"type":"bool","schema":{"type":"boolean"},"target":"analytics.enabled"},"check_for_update_on_startup":{"type":"bool","schema":{"type":"boolean"},"target":"check_for_update_on_startup"},"log_dir":{"type":"string","schema":{"type":"string"},"target":"log_dir"},"sqlite_home":{"type":"string","schema":{"type":"string"},"target":"sqlite_home"}},"error":null,"fallback":true,"fallbackFile":"lib/codex-registry.json"},"definitions":{"agents.interrupt_message":{"source":"codex","nativeKey":"agents.interrupt_message","schema":{"type":"boolean"},"defaultValue":null},"backend":{"source":"plugin","nativeKey":null,"schema":{"type":"string","enum":["exec","app-server"]},"defaultValue":"app-server"},"autoResumeAfterQuota":{"source":"plugin","nativeKey":null,"schema":{"type":"boolean"},"defaultValue":false},"statusPollingEnabled":{"source":"plugin","nativeKey":null,"schema":{"type":"boolean"},"defaultValue":false},"statusPollingIntervalMinutes":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":15,"maximum":120},"defaultValue":30},"quotaWarning":{"source":"plugin","nativeKey":null,"schema":{"type":"boolean"},"defaultValue":false},"quotaWarningThreshold":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":0,"maximum":20},"defaultValue":5},"selectionPolicy":{"source":"plugin","nativeKey":null,"schema":{"type":"object"},"defaultValue":{"version":1,"mode":"off","floors":{"mechanical":{"model":"gpt-6-luna","effort":"low"},"docs":{"model":"gpt-6-luna","effort":"low"},"review":{"model":"gpt-6.1-sol","effort":"medium"},"implement":{"model":"gpt-6.1-sol","effort":"high"},"architect":{"model":"gpt-6-astra","effort":"xhigh"},"rework":{"model":"gpt-6-astra","effort":"xhigh"}},"evidence":{"architecture":{"model":"gpt-6-astra","effort":"xhigh"},"interface":{"model":"gpt-6-astra","effort":"xhigh"},"concurrency":{"model":"gpt-6-astra","effort":"xhigh"},"security":{"model":"gpt-6-astra","effort":"xhigh"},"design_failure":{"model":"gpt-6-astra","effort":"xhigh"}},"unknown_scope":"investigation","downgrade":{"allowed":true,"require_reason":true,"require_approval":false,"reason_categories":["quota","scope-reduced","already-reviewed","time"],"never_for":["architect"]},"quota":{"below_percent":10,"action":"pause"},"review":{"require_for_architect":true,"model":"gpt-6-astra","effort":"xhigh"}}},"selectionMode":{"source":"plugin","nativeKey":null,"schema":{"type":"string","enum":["legacy","manual","evidence"]},"defaultValue":"legacy"},"defaultModel":{"source":"codex","nativeKey":"model","schema":{"type":"string","enum":["gpt-6-luna","gpt-6-sol","gpt-6.1-sol","gpt-6-astra"]},"defaultValue":"gpt-6.1-sol"},"autoModelAndEffort":{"source":"plugin","nativeKey":null,"schema":{"type":"boolean"},"defaultValue":false},"defaultEffort":{"source":"codex","nativeKey":"model_reasoning_effort","schema":{"type":"string","enum":["low","medium","high","xhigh","max","ultra"]},"defaultValue":"high"},"maxEffortAllowed":{"source":"plugin","nativeKey":null,"schema":{"type":"string","enum":["low","medium","high","xhigh","max","ultra"]},"defaultValue":"xhigh"},"defaultBudgetMs":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":0,"maximum":2147483647},"defaultValue":0},"driverPath":{"source":"plugin","nativeKey":null,"schema":{"type":"string"},"defaultValue":null},"codexExecutable":{"source":"plugin","nativeKey":null,"schema":{"type":"string"},"defaultValue":""},"codexHome":{"source":"plugin","nativeKey":null,"schema":{"type":"string"},"defaultValue":""},"serviceTier":{"source":"codex","nativeKey":"service_tier","schema":{"type":"string","enum":["off","flex","fast"]},"defaultValue":"off"},"sandboxMode":{"source":"codex","nativeKey":"sandbox_mode","schema":{"type":"string","enum":["workspace-write","read-only","danger-full-access"]},"defaultValue":"workspace-write"},"approvalPolicy":{"source":"codex","nativeKey":"approval_policy","schema":{"type":"string","enum":["never","on-request"]},"defaultValue":"never"},"workspaceNetworkAccess":{"source":"codex","nativeKey":"sandbox_workspace_write.network_access","schema":{"type":"boolean","allOf":[{"type":"boolean","default":false}]},"defaultValue":false},"codexConfig":{"source":"plugin","nativeKey":null,"schema":{"type":"object"},"defaultValue":{}},"extraCodexConfig":{"source":"plugin","nativeKey":null,"schema":{"type":"array"},"defaultValue":[]},"pauseGraceMs":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":0,"maximum":2147483647},"defaultValue":0},"maxConcurrent":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":1,"maximum":8},"defaultValue":1},"retentionDays":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":0,"maximum":2147483647},"defaultValue":0},"retentionMaxRuns":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":0,"maximum":2147483647},"defaultValue":0},"debugLogs":{"source":"plugin","nativeKey":null,"schema":{"type":"boolean"},"defaultValue":false},"debugMaxBytes":{"source":"plugin","nativeKey":null,"schema":{"type":"integer","minimum":1,"maximum":1073741824},"defaultValue":2097152}},"revision":null,"readOnly":true};
    function validateFieldValue(value, schema) {
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
    function stringEnumSpec(field) {
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
    function settingFieldSpec(name,field) {
  // Network permissions remain boolean because both drivers interpret true/false.
  // A changed native schema must still validate, rather than silently changing
  // the meaning of the switch.
  return name==='workspaceNetworkAccess'
    ? {type:'bool',schema:{type:'boolean',allOf:[field?.schema||{unsupported:true}]}}
    : stringEnumSpec(field);
}
    /* field-registry:end */
    function updateSettingOptions() {
      for(const name of Object.keys(SETTING_FIELD_KEYS)){
        const row=ROWS.find(row=>row.name===name),spec=settingFieldSpec(name,SETTING_FIELDS[name]);
        if(row.control==='select')row.options=spec.values;
      }
    }
    updateSettingOptions();
    function updateFieldRegistry(catalog) {
      const configuration=catalog?.configuration,config=configuration?.config;
      if(config){for(const key of Object.keys(CONFIG_WHITELIST))delete CONFIG_WHITELIST[key];Object.assign(CONFIG_WHITELIST,config);}
      if(configuration?.fields){for(const [name,key] of Object.entries(SETTING_FIELD_KEYS))SETTING_FIELDS[name]=configuration.fields[key];updateSettingOptions();}
    }
    const JSON_FIELDS=['selectionPolicy','codexConfig','extraCodexConfig'];
    function configSnapshot(fieldOf) {
      return JSON.stringify(Object.fromEntries(ALL_FIELDS.map(name=>{
        const text=fieldOf(name).text;
        if(text==null||!String(text).trim())return [name,null];
        if(JSON_FIELDS.includes(name)) {try{return [name,JSON.parse(text)];}catch{return [name,text];}}
        if(name.startsWith('agents.')&&CONFIG_WHITELIST[name]){const spec=CONFIG_WHITELIST[name];if(['string','enum'].includes(spec.type))return [name,text];try{return [name,JSON.parse(text)];}catch{return [name,text];}}
        if(BOOL_NAMES.includes(name))return [name,text==='true'];
        if(NUM_NAMES.includes(name))return [name,Number(text)];
        return [name,text];
      })),null,2);
    }
    function parseFullConfig(text) {
      const value=JSON.parse(text);
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('JSON must be an object');
      for(const key of Object.keys(value))if(!ALL_FIELDS.includes(key))throw Error('Unknown field: '+key);
      const checkNative=(key,v)=>{
        const spec=Object.hasOwn(CONFIG_WHITELIST,key)&&CONFIG_WHITELIST[key];
        if(!spec)throw Error('Unsupported Codex configuration: '+key);
        if(!validateFieldValue(v,spec.schema))throw Error(key+': invalid registry value');
      };
      if(value.codexConfig!=null){if(typeof value.codexConfig!=='object'||Array.isArray(value.codexConfig))throw Error('codexConfig: expected object');for(const [key,v] of Object.entries(value.codexConfig))checkNative(key,v);}
      if(value.extraCodexConfig!=null){if(!Array.isArray(value.extraCodexConfig))throw Error('extraCodexConfig: expected array');for(const item of value.extraCodexConfig){if(typeof item!=='string'||item.indexOf('=')<1)throw Error('extraCodexConfig: expected key=value');const index=item.indexOf('='),key=item.slice(0,index).trim(),spec=CONFIG_WHITELIST[key];let v=item.slice(index+1);if(spec&&!['string','enum'].includes(spec.type))try{v=JSON.parse(v);}catch{}checkNative(key,v);}}
      const specs=new Map(formSpecs().map(spec=>[spec.field,spec]));
      return ALL_FIELDS.map(name=>{
        const v=value[name];
        if(v==null || Object.hasOwn(SELECT_DEFAULTS,name)&&typeof v==='string'&&!v.trim())return [name,''];
        if(name.startsWith('agents.')){checkNative(name,v);const spec=CONFIG_WHITELIST[name],formatted=['string','enum'].includes(spec.type)?String(v):JSON.stringify(v);if(!specs.get(name).parse(formatted))throw Error(name+': invalid value');return [name,formatted];}
        const row=ROWS.find(row=>row.name===name);
        const numeric=NUM_NAMES.includes(name);
        if(BOOL_NAMES.includes(name)&&typeof v!=='boolean')throw Error(name+': expected boolean');
        if(numeric&&(!Number.isSafeInteger(v)||v<0||v>2147483647))throw Error(name+': invalid integer');
        if(!numeric&&!BOOL_NAMES.includes(name)&&!JSON_FIELDS.includes(name)&&typeof v!=='string')throw Error(name+': expected string');
        if(row?.control==='select'&&name!=='defaultModel'&&!row.options.includes(String(v)))throw Error(name+': unsupported value');
        if(name==='serviceTier'&&!['off','flex','fast'].includes(v))throw Error(name+': unsupported value');
        if(name==='maxConcurrent'&&(v<1||v>8)||name==='debugMaxBytes'&&(v<1||v>1073741824))throw Error(name+': out of range');
        const formatted=JSON_FIELDS.includes(name)?JSON.stringify(v):String(v);
        if(!specs.get(name).parse(formatted))throw Error(name+': invalid value');
        return [name,formatted];
      });
    }
    function schemaRange(schema,t) {
      if(!schema)return t('editor.codexInherited');
      if(schema.enum)return schema.enum.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' | ');
      if(Object.hasOwn(schema,'const'))return JSON.stringify(schema.const);
      if(schema.anyOf||schema.oneOf)return (schema.anyOf||schema.oneOf).map(part=>schemaRange(part,t)).join(' | ');
      if(Array.isArray(schema.type))return schema.type.map(type=>schemaRange({...schema,type},t)).join(' | ');
      if(schema.type==='null')return 'null';
      if(schema.type==='boolean')return 'true | false';
      if(['integer','number'].includes(schema.type))return (schema.minimum??schema.exclusiveMinimum??'−∞')+'–'+(schema.maximum??schema.exclusiveMaximum??'∞')+(schema.type==='integer'?' ('+t('editor.integer')+')':'');
      return t('editor.'+({string:'text',object:'object',array:'array'}[schema.type]||'text'));
    }
    const displayJson=value=>value==null?'':typeof value==='string'?value:JSON.stringify(value,null,2);
    function parseRegistryDocument(text) {
      const value=JSON.parse(text),object=item=>item&&typeof item==='object'&&!Array.isArray(item);
      if(!object(value)||value.version!==1||!object(value.fields)||!object(value.translations))throw Error('Invalid registry document');
      for(const rule of Object.values(value.fields))if(!object(rule))throw Error('Invalid field rule');
      for(const group of ['models','efforts','tiers','settings']){
        if(value.translations[group]!==undefined&&!object(value.translations[group]))throw Error('Invalid translation group');
        for(const entry of Object.values(value.translations[group]||{}))if(!object(entry))throw Error('Invalid translation entry');
      }
      return value;
    }
    // Rebase local edits onto newly discovered registry data. Unedited values
    // receive fresh defaults; metadata always comes from the registry service.
    function mergeRegistryRefresh(previous,draft,fresh) {
      const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
      const merge=(base,local,remote)=>{
        if(JSON.stringify(base)===JSON.stringify(local))return remote;
        if(object(base)&&object(local)&&object(remote))return Object.fromEntries([...new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])].flatMap(key=>{
          const value=merge(base[key],local[key],remote[key]);return value===undefined?[]:[[key,value]];
        }));
        return local;
      };
      return {...merge(previous,draft,fresh),codexVersion:fresh.codexVersion,updatedAt:fresh.updatedAt};
    }
    function editorDefinitions(catalog) {
      const numbers={maxConcurrent:[1,8],statusPollingIntervalMinutes:[15,120],quotaWarningThreshold:[0,20],debugMaxBytes:[1,1073741824]};
      const aliases={defaultModel:'model',defaultEffort:'model_reasoning_effort',serviceTier:'service_tier',...SETTING_FIELD_KEYS,'agents.interrupt_message':'agents.interrupt_message'};
      return Object.fromEntries(ALL_FIELDS.map(key=>{
        const row=ROWS.find(row=>row.name===key);
        let schema=BOOL_NAMES.includes(key)?{type:'boolean'}:NUM_NAMES.includes(key)||row?.control==='slider'?{type:'integer',minimum:(numbers[key]||[0])[0],maximum:(numbers[key]||[0,2147483647])[1]}:{type:'string'};
        if(row?.options)schema={type:row.numeric?'integer':'string',enum:row.options.map(v=>row.numeric?Number(v):v)};
        if(key==='defaultModel')schema={type:'string',enum:(catalog?.models||FALLBACK_VIEW.models).map(m=>m.id)};
        if(key==='serviceTier')schema={type:'string',enum:['off','flex','fast']};
        if(JSON_FIELDS.includes(key))schema={type:key==='extraCodexConfig'?'array':'object'};
        return [key,{source:aliases[key]?'codex':'plugin',nativeKey:aliases[key],schema,defaultValue:SELECT_DEFAULTS[key]??row?.defaultValue??null}];
      }));
    }
    function configurationTableRows(config,registry,catalog,t) {
      const definitions=registry?.definitions||editorDefinitions(catalog),rows=[],chinese=t('language')==='zh';
      const separator=chinese?'：':': ',joiner=chinese?'；':'; ';
      // Language changes presentation only. Registry IDs, enum values, source
      // English and the Chinese translation document retain their original data.
      const texts=(group,key,entry)=>{
        const defaults=BUNDLED_EDITOR_STATE.document.translations[group]?.[key]||{};
        const translation={...defaults,...registry.document.translations[group]?.[key]};
        const source=group==='settings'?BUNDLED_EDITOR_STATE.configuration.fields[key]:null;
        const name=chinese?translation.name||defaults.name:entry.name||source?.name;
        const description=(chinese?translation.description||defaults.description:entry.description||source?.description)||t('editor.missingDescription');
        return {translation,description:(name&&name!==key?name+separator:'')+description};
      };
      for(const key of ALL_FIELDS){
        const definition=definitions[key]||{},label=t('f.'+key),hint=t('h.'+key);
        const schema=definition.schema||{},options=(schema.enum||[]).map(value=>{const option=t('o.'+value);return value+(option&&option!=='o.'+value&&option!==value?' = '+option:'');});
        rows.push({id:'config:'+key,kind:'config',key,source:definition.source==='codex'?'codex':t('editor.plugin'),value:config[key]??definition.defaultValue,
          inherited:config[key]==null,schema,range:schemaRange(schema,t),description:(label==='f.'+key?key:label)+separator+(hint==='h.'+key?'':hint)+(options.length?' '+options.join(joiner):''),nativeKey:definition.nativeKey});
      }
      if(!registry?.document)return rows;
      const document=registry.document,fields=registry.configuration?.fields||{};
      rows.push({id:'metadata:codexVersion',kind:'metadata',key:'codexVersion',source:'codex',value:document.codexVersion,range:t('editor.versionRange'),description:t('editor.versionDescription'),empty:t('editor.versionUnknown')},
        {id:'metadata:updatedAt',kind:'metadata',key:'updatedAt',source:t('editor.plugin'),value:document.updatedAt,range:t('editor.timeRange'),description:t('editor.timeDescription'),empty:t('editor.neverUpdated')});
      for(const key of Object.keys(document.fields)){
        const rule=document.fields[key],field=fields[key]||{};
        const profile=rows.find(row=>row.nativeKey===key);
        let schema=rule.schema||profile?.schema||field.schema||rule.fallbackSchema;
        if(schema?.enum&&rule.excludedValues)schema={...schema,enum:schema.enum.filter(value=>!rule.excludedValues.includes(value))};
        let value=profile?.value??config.codexConfig?.[key];
        for(const item of Array.isArray(config.extraCodexConfig)?config.extraCodexConfig:[]){if(typeof item!=='string')continue;const index=item.indexOf('=');if(item.slice(0,index).trim()===key){const raw=item.slice(index+1);try{value=JSON.parse(raw);}catch{value=raw;}}}
        rows.push({id:'registry:'+key,kind:'registry',key,source:'codex',value,range:schemaRange(schema,t),schema,group:'settings',...texts('settings',key,{...field,description:field.description||rule.description}),allowed:field.allowed,profile:profile?.key});
      }
      for(const group of ['models','efforts','tiers']){
        const entries=new Map();
        for(const model of catalog?.models||[]){if(group==='models')entries.set(model.id,model);else for(const entry of group==='efforts'?model.efforts:model.serviceTiers)entries.set(entry.id,entry);}
        for(const [key,entry] of entries)rows.push({id:group+':'+key,kind:'translation',group,key,source:'codex',value:key,range:'—',...texts(group,key,entry)});
      }
      return rows.map(row=>({...row,description:row.description.replace(/[。.]\s*$/,'')}));
    }
    /* §2.1/§3.4/§8.6: primary = editable values, secondary = scope/range,
     * tertiary = metadata/inheritance hints. One Save action; fixed header/footer,
     * scrolling table only. Use existing 13/12px type, 8/16/24px spacing and
     * --dsw theme tokens, including dark mode; no new component dependency. */
    function FullConfigModal({t,initial,disabled,onClose,onSave,loadRegistry,catalog,registryInitial=null}) {
      const [draft,setDraft]=react.useState(initial),[saving,setSaving]=react.useState(false),[error,setError]=react.useState('');
      const [tab,setTab]=react.useState('table'),[registry,setRegistry]=react.useState(registryInitial),[registryDraft,setRegistryDraft]=react.useState(registryInitial?JSON.stringify(registryInitial.document,null,2):''),
        [registryError,setRegistryError]=react.useState(''),[loading,setLoading]=react.useState(!!loadRegistry&&!registryInitial),[filter,setFilter]=react.useState(''),[cells,setCells]=react.useState({});
      const dialog=react.useRef(null),baseline=react.useRef(registryInitial?JSON.stringify(registryInitial.document,null,2):'');
      const registryMessage=error=>error.code==='codex-runner/editor-endpoint-unavailable'?t('editor.endpointUnavailable'):error.message;
      const load=async(refresh=false)=>{
        let local;try{local=registry?parseRegistryDocument(registryDraft):null;}catch(e){setError(e.message);return;}
        setLoading(true);setRegistryError('');
        try{const value=await loadRegistry(refresh?{refresh:true}:{});const next=local?mergeRegistryRefresh(registry.document,local,value.document):value.document;
          baseline.current=JSON.stringify(value.document,null,2);setRegistry(value);setRegistryDraft(JSON.stringify(next,null,2));setRegistryError(value.configuration?.error||'');
        }catch(e){setRegistryError(registryMessage(e));}finally{setLoading(false);}
      };
      react.useEffect(()=>{let disposed=false;if(loadRegistry&&!registryInitial){setLoading(true);loadRegistry().then(value=>{if(disposed)return;const text=JSON.stringify(value.document,null,2);baseline.current=text;setRegistry(value);setRegistryDraft(text);setRegistryError(value.configuration?.error||'');},e=>{if(!disposed)setRegistryError(registryMessage(e));}).finally(()=>{if(!disposed)setLoading(false);});}return ()=>{disposed=true;};},[]);
      react.useEffect(()=>{const previous=globalThis.document?.activeElement;dialog.current?.querySelector('[role=tab]')?.focus();return ()=>previous?.focus?.();},[]);
      const dirty=draft!==initial||registryDraft!==baseline.current||Object.keys(cells).length>0;
      const close=()=>{if(!saving&&(!dirty||globalThis.window?.confirm?.(t('unsavedConfig'))))onClose();};
      const flush=()=>{
        if(!Object.keys(cells).length)return draft;
        const value=JSON.parse(draft);
        for(const [key,text] of Object.entries(cells)){
          const schema=(registry?.definitions||editorDefinitions(catalog))[key]?.schema;
          if(!text.trim())value[key]=null;
          else if(schema?.type==='string'&&!JSON_FIELDS.includes(key))value[key]=text;
          else try{value[key]=JSON.parse(text);}catch{throw Error(key+': '+t('invalid'));}
        }
        const text=JSON.stringify(value,null,2);setDraft(text);setCells({});return text;
      };
      const switchTab=next=>{try{flush();if(next==='table'){JSON.parse(draft);if(registryDraft)parseRegistryDocument(registryDraft);}setTab(next);setError('');}catch(e){setError(e.message);}};
      let config={},liveRegistry=registry,tableError='';
      try{config=JSON.parse(draft);if(!config||Array.isArray(config)||typeof config!=='object')throw Error('JSON must be an object');if(registryDraft&&registry)liveRegistry={...registry,document:parseRegistryDocument(registryDraft)};}catch(e){tableError=e.message;}
      const translate=(group,key,field,value)=>{
        try{const document=JSON.parse(registryDraft);document.translations[group]||={};document.translations[group][key]||={};document.translations[group][key][field]=value;setRegistryDraft(JSON.stringify(document,null,2));setError('');}catch(e){setError(e.message);}
      };
      let rows=[];if(!tableError)try{rows=configurationTableRows(config,liveRegistry,catalog,t);}catch(e){tableError=e.message;}
      const shown=rows.filter(row=>(row.key+' '+row.source+' '+row.description+' '+Object.values(row.translation||{}).join(' ')).toLowerCase().includes(filter.toLowerCase()));
      const cellStyle={padding:'12px 16px',verticalAlign:'top',textAlign:'left',overflowWrap:'anywhere',borderBottom:'1px solid var(--dsw-alias-border-l2, GrayText)'};
      const inputStyle={...editorStyle,minHeight:0,resize:'vertical'};
      const tabs=['table','registry','config'];
      return jsx('div',{style:{position:'fixed',inset:0,zIndex:1000,background:'var(--dsw-alias-mask, rgba(0,0,0,0.45))',display:'grid',placeItems:'center',padding:'16px'},onClick:event=>{if(event.target===event.currentTarget)close();},children:jsxs('div',{
        ref:dialog,role:'dialog','aria-modal':true,'aria-label':t('fullConfig'),
        style:{...TYPE_BODY,width:'100%',maxWidth:'1200px',height:'min(88vh, 900px)',maxHeight:'calc(100dvh - 32px)',minHeight:0,display:'flex',flexDirection:'column',overflow:'hidden',boxSizing:'border-box',padding:'16px',borderRadius:'var(--dsw-radius-lg, 8px)',background:'var(--dsw-alias-bg-base, Canvas)',color:'var(--dsw-alias-label-primary, CanvasText)'},
        onKeyDown:event=>{if(event.key==='Escape'){event.preventDefault();close();}if(event.key==='Tab'){const nodes=[...event.currentTarget.querySelectorAll('textarea:not(:disabled),input:not(:disabled),button:not(:disabled)')].filter(n=>n.tabIndex>=0),first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}},
        children:[jsx('div',{style:{...TYPE_LABEL,marginBottom:'8px'},children:t('fullConfig')}),
          jsx('div',{role:'tablist','aria-label':t('fullConfig'),style:{display:'flex',gap:'16px',borderBottom:'1px solid var(--dsw-alias-border-l2, GrayText)',flexShrink:0},children:tabs.map(id=>jsx('button',{type:'button',id:'codex-editor-tab-'+id,role:'tab','aria-selected':tab===id,'aria-controls':'codex-editor-panel-'+id,tabIndex:tab===id?0:-1,
            style:{...TYPE_LABEL,padding:'8px 0',border:0,borderBottom:tab===id?'2px solid currentColor':'2px solid transparent',background:'transparent',color:tab===id?'var(--dsw-alias-label-primary, CanvasText)':'var(--dsw-alias-label-secondary, GrayText)',cursor:'pointer',whiteSpace:'nowrap'},
            onClick:()=>switchTab(id),onKeyDown:event=>{if(['ArrowRight','ArrowLeft','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(id)+(event.key==='ArrowRight'?1:2))%3];switchTab(next);document.getElementById('codex-editor-tab-'+next)?.focus();}},children:t('editor.'+id)},id))}),
          jsx('p',{style:{...hintStyle,margin:'8px 0',flexShrink:0},children:t(tab==='registry'?'editor.registryHint':'editor.hint')}),
          tab!=='config'?jsxs('div',{'data-editor-registry-info':'',style:{flexShrink:0,marginBottom:'8px'},children:[
            jsxs('div',{style:{...TYPE_BODY,marginBottom:'8px'},children:[t('editor.codexVersion')+(t('language')==='zh'?'：':': '),jsx('code',{'data-registry-version':'',children:registry?.document.codexVersion||t('editor.versionUnknown')})]}),
            jsxs('div',{style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:'12px'},children:[
              jsx(P.Button,{variant:'outline',size:'sm',disabled:saving||loading||!loadRegistry,onClick:()=>load(true),children:t('editor.refreshRegistry')}),
              jsxs('span',{style:hintStyle,children:[t('editor.lastUpdated')+(t('language')==='zh'?'：':': '),jsx('time',{'data-registry-updated':'',dateTime:registry?.document.updatedAt||undefined,title:registry?.document.updatedAt||undefined,
                children:registry?.document.updatedAt?new Date(registry.document.updatedAt).toLocaleString(t('language')==='zh'?'zh-CN':'en-US'):t('editor.neverUpdated')})]}),
            ]}),
          ]}):null,
          loading?jsx('p',{role:'status',style:hintStyle,children:t('loading')}):null,
          registry?.configuration?.fallback?jsx('p',{role:'status',style:{...hintStyle,margin:'0 0 8px'},children:t('editor.bundledFallback')+(registry.readOnly?' '+t('editor.bundledReadOnly'):'')}):null,
          registryError?jsxs('div',{role:'status',style:{...actionStyle,margin:0},children:[jsx('span',{children:t(registry?'editor.refreshIssue':'editor.unavailable')+' '+registryError}),jsx(P.Button,{variant:'outline',size:'sm',disabled:loading||saving,onClick:()=>load(true),children:t('editor.retry')})]}):null,
          jsxs('div',{role:'tabpanel',id:'codex-editor-panel-'+tab,'aria-labelledby':'codex-editor-tab-'+tab,style:{flex:1,minHeight:0,display:'flex',flexDirection:'column',overflow:'hidden'},children:[
            tab==='table'?jsxs('div',{style:{display:'flex',flexDirection:'column',minHeight:0,flex:1},children:[jsx('input',{type:'search','aria-label':t('editor.filter'),placeholder:t('editor.filter'),value:filter,onChange:event=>setFilter(event.target.value),style:{...inputStyle,marginBottom:'8px',maxWidth:'400px'}}),
              tableError?jsx('p',{role:'alert',children:tableError}):jsx('div',{'data-editor-table-scroll':'',style:{overflow:'auto',minHeight:0,flex:1,border:'1px solid var(--dsw-alias-border-l2, GrayText)',borderRadius:'var(--dsw-radius-md, 8px)'},children:jsxs('table',{'aria-label':t('editor.table'),style:{width:'100%',minWidth:'960px',tableLayout:'fixed',borderCollapse:'separate',borderSpacing:0},children:[
                jsx('colgroup',{children:['9%','20%','21%','20%','30%'].map((width,index)=>jsx('col',{style:{width}},index))}),
                jsx('thead',{style:{position:'sticky',top:0,zIndex:1,background:'var(--dsw-alias-bg-layer-3, Canvas)'},children:jsx('tr',{children:['source','key','value','range','description'].map(id=>jsx('th',{scope:'col',style:{...cellStyle,...TYPE_LABEL},children:t('editor.'+id)},id))})}),
                jsx('tbody',{children:shown.length?shown.map(row=>jsxs('tr',{'data-editor-row':row.id,children:[
                  jsx('td',{style:cellStyle,children:row.source}),
                  jsxs('td',{style:cellStyle,children:[jsx('code',{children:row.key}),jsx('div',{style:hintStyle,children:t(row.kind==='config'?'editor.configScope':row.kind==='registry'?'editor.registryScope':'editor.translations')})]}),
                  jsx('td',{style:cellStyle,children:row.kind==='config'?jsxs('div',{children:[jsx('textarea',{'aria-label':row.key+' '+t('editor.value'),rows:JSON_FIELDS.includes(row.key)?3:1,value:cells[row.key]??displayJson(row.value),readOnly:disabled||saving||loading,onChange:event=>setCells({...cells,[row.key]:event.target.value}),style:inputStyle}),row.inherited?jsx('small',{style:hintStyle,children:t('editor.inherited')}):null]}):jsx('code',{children:row.value==null?row.empty||t('editor.codexInherited'):displayJson(row.value)})}),
                  jsx('td',{style:cellStyle,children:row.range}),
                  jsx('td',{style:cellStyle,children:['config','metadata'].includes(row.kind)||t('language')!=='zh'?row.description:jsx('div',{children:
                    (row.group==='models'||row.group==='efforts'?['description']:['name','description']).map(field=>jsx('textarea',{'aria-label':row.key+' '+t(field==='name'?'editor.name':'editor.meaning'),placeholder:t(field==='name'?'editor.name':'editor.meaning'),rows:field==='name'?1:2,maxLength:200,value:row.translation[field]||'',readOnly:disabled||saving||loading||!registry||registry.readOnly,
                      onChange:event=>translate(row.group,row.key,field,event.target.value),style:{...inputStyle,marginBottom:'8px'}},field))})}),
                ]},row.id)):jsx('tr',{children:jsx('td',{colSpan:5,style:cellStyle,children:t('editor.noMatches')})})})]})})]}):
            jsx('textarea',{'aria-label':t('editor.'+tab),'aria-invalid':!!error,spellCheck:false,value:tab==='registry'?registryDraft:draft,readOnly:disabled||saving||loading||tab==='registry'&&(!registry||registry.readOnly),
              style:{...editorStyle,flex:1,minHeight:0,fontFamily:'monospace',resize:'none'},onChange:event=>{if(tab==='registry')setRegistryDraft(event.target.value);else setDraft(event.target.value);setError('');}}),
          ]}),error?jsx('p',{role:'alert',style:{margin:'8px 0',overflowWrap:'anywhere',maxHeight:'96px',overflow:'auto'},children:error}):null,
          jsxs('div',{style:{...actionStyle,margin:'16px 0 0',flexShrink:0},children:[jsx(P.Button,{variant:'primary',size:'sm',disabled:disabled||saving||loading,children:t(saving?'saving':'save'),onClick:async()=>{try{const value=flush(),changed=registry&&registryDraft!==baseline.current;const edit=changed?{document:JSON.parse(registryDraft),revision:registry.revision}:null;if(changed&&registry.readOnly)throw Error(t('editor.bundledReadOnly'));if(!changed)parseFullConfig(value);setSaving(true);await onSave(value,edit);}catch(e){setError(e.message);}finally{setSaving(false);}}}),jsx(P.Button,{variant:'outline',size:'sm',disabled:saving,onClick:close,children:t('cancel')})]})]
      })});
    }

    function PolicyModal(props) {
      const {t}=props;
      // 高级 JSON 用两空格缩进；保存时仍写紧凑串（parseClientPolicy 接受任意空白）。
      const formatPolicy=value=>JSON.stringify(value,null,2);
      let initial;try{initial=formatPolicy(parseClientPolicy(props.initial));}catch{initial=String(props.initial);}
      const [draft,setDraft]=react.useState(initial),[tab,setTab]=react.useState('tasks'),[error,setError]=react.useState(''),[saving,setSaving]=react.useState(false);
      const [previewKind,setPreviewKind]=react.useState('architect'),[previewModel,setPreviewModel]=react.useState('gpt-6-sol'),[previewEffort,setPreviewEffort]=react.useState('high');
      const dialog=react.useRef(null);
      react.useEffect(()=>{const previous=globalThis.document?.activeElement;dialog.current?.querySelector('button')?.focus();return ()=>previous?.focus?.();},[]);
      let policy,invalid='';try{policy=parseClientPolicy(draft,props.catalog);}catch(e){invalid=e.message;policy=structuredClone(DEFAULT_SELECTION_POLICY);}
      const update=(path,value)=>{const next=structuredClone(policy);let node=next;for(const key of path.slice(0,-1))node=node[key];node[path.at(-1)]=value;setDraft(formatPolicy(next));setError('');};
      const close=()=>{if(draft===initial||globalThis.window?.confirm?.(t('unsavedPolicy')))props.onClose();};
      const button=(key,onClick,options={})=>jsx(P.Button,{variant:'outline',size:'sm',onClick,disabled:props.disabled||saving,...options,children:t(key)});
      const input=(label,value,onChange,options)=>jsxs('label',{style:{display:'flex',flexWrap:'wrap',alignItems:'center',gap:'8px',margin:'8px 0'},children:[jsx('span',{children:label}),options
        ?jsx('select',{'aria-label':label,value,disabled:props.disabled||saving,style:{maxWidth:'100%',padding:'8px',font:'inherit',background:'var(--dsw-alias-bg-base, Canvas)',color:'inherit'},onChange:e=>onChange(e.target.value),children:options.map(item=>jsx('option',{value:item,children:label===t('policyMode')?t('policyMode.'+item):item},item))})
        :jsx('input',{'aria-label':label,type:typeof value==='boolean'?'checkbox':typeof value==='number'?'number':'text',...(typeof value==='boolean'?{checked:value}:{value}),disabled:props.disabled||saving,style:{maxWidth:'100%',padding:'8px',font:'inherit'},onChange:e=>onChange(typeof value==='boolean'?e.target.checked:typeof value==='number'?Number(e.target.value):e.target.value)})]});
      const models=props.catalog?.models?.filter(m=>!m.hidden).map(m=>m.id);
      const effortOptions=model=>props.catalog?.models?.find(m=>m.id===model)?.efforts.map(e=>e.id);
      const pairFields=(section,key,entry)=>jsxs('fieldset',{style:{border:'none',margin:'0 0 16px',padding:0},children:[
        jsx('legend',{style:{fontWeight:600},children:t((section==='floors'?'task.':'evidence.')+key)}),
        input(t('model'),entry.model,value=>update([section,key,'model'],value),models),
        input(t('effort'),entry.effort,value=>update([section,key,'effort'],value),effortOptions(entry.model)),
        comparePair(entry,DEFAULT_SELECTION_POLICY[section][key])<0?jsx('p',{role:'status',style:{color:'var(--dsw-alias-status-warning, currentColor)'},children:'⚠ '+t('floorLow')}):null,
      ]},key);
      let panel;
      if(tab==='tasks')panel=Object.entries(policy.floors).map(([key,entry])=>pairFields('floors',key,entry));
      if(tab==='evidence')panel=Object.entries(policy.evidence).map(([key,entry])=>pairFields('evidence',key,entry));
      if(tab==='downgrade')panel=[...['allowed','require_reason','require_approval'].map(key=>input(t('policy.'+key),policy.downgrade[key],value=>update(['downgrade',key],value))),
        input(t('reasonCategories'),policy.downgrade.reason_categories.join(', '),value=>update(['downgrade','reason_categories'],value.split(',').map(s=>s.trim()).filter(Boolean))),
        input(t('neverFor'),policy.downgrade.never_for.join(', '),value=>update(['downgrade','never_for'],value.split(',').map(s=>s.trim()).filter(Boolean))),
        jsx('p',{style:hintStyle,children:t('approvalHint')})];
      if(tab==='quota')panel=[input(t('quotaBelow'),policy.quota.below_percent,value=>update(['quota','below_percent'],value)),input(t('quotaAction'),policy.quota.action,value=>update(['quota','action'],value),['pause','allow-downgrade','reduce-scope','deny'])];
      if(tab==='json')panel=jsx('textarea',{'aria-label':t('tab.json'),rows:15,value:draft,spellCheck:false,disabled:props.disabled||saving,style:editorStyle,onChange:e=>setDraft(e.target.value)});
      const preview=evaluateSelection({policy,taskKind:previewKind,recommended:DEFAULT_SELECTION_POLICY.floors[previewKind],actual:{model:previewModel,effort:previewEffort},explicitModel:true,explicitEffort:true,overrideReason:'Preview',downgradeReason:'quota'});
      return jsx('div',{style:{position:'fixed',inset:0,background:'var(--dsw-alias-mask, rgba(0,0,0,0.45))',zIndex:1000,display:'grid',placeItems:'center',padding:'16px'},children:
        jsxs('div',{role:'dialog','aria-modal':true,'aria-labelledby':'codex-policy-title',ref:dialog,
          style:{...TYPE_BODY,width:'100%',maxWidth:'640px',maxHeight:'calc(100vh - 32px)',overflow:'auto',boxSizing:'border-box',padding:'24px',borderRadius:'var(--dsw-radius-lg, 8px)',background:'var(--dsw-alias-bg-base, Canvas)',color:'var(--dsw-alias-label-primary, CanvasText)'},
          onKeyDown:event=>{if(event.key==='Escape'){event.preventDefault();close();}if(event.key==='Tab'){const nodes=[...event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}},
          children:[jsx('h2',{id:'codex-policy-title',style:{fontSize:'18px',margin:'0 0 16px'},children:t('editPolicy')}),
            jsxs('div',{style:actionStyle,children:[button('preset.strict',()=>setDraft(formatPolicy(policyPreset('strict')))),button('preset.balanced',()=>setDraft(formatPolicy(policyPreset('balanced')))),button('preset.economy',()=>setDraft(formatPolicy(policyPreset('economy')))),button('restorePolicy',()=>setDraft(formatPolicy(DEFAULT_SELECTION_POLICY)))]}),
            input(t('policyMode'),policy.mode,value=>update(['mode'],value),['off','audit','enforce']),
            jsx('div',{role:'tablist','aria-label':t('editPolicy'),style:actionStyle,children:['tasks','evidence','downgrade','quota','json'].map(key=>button('tab.'+key,()=>setTab(key),{role:'tab','aria-selected':tab===key,'aria-controls':'codex-panel-'+key,id:'codex-tab-'+key}))}),
            jsx('div',{role:'tabpanel',id:'codex-panel-'+tab,'aria-labelledby':'codex-tab-'+tab,children:panel}),
            jsxs('details',{children:[jsx('summary',{children:t('preview')}),input(t('taskKind'),previewKind,setPreviewKind,Object.keys(policy.floors)),input(t('actualModel'),previewModel,setPreviewModel,models),input(t('actualEffort'),previewEffort,setPreviewEffort,effortOptions(previewModel)),jsx('p',{'data-policy-preview':true,children:t('recommended')+': '+preview.selection.recommended_model+'/'+preview.selection.recommended_effort+'; '+t('actual')+': '+previewModel+'/'+previewEffort+'; '+t('downgrade')+': '+preview.selection.downgrade})]}),
            invalid||error?jsx('p',{role:'alert',children:t('invalid')+' '+(invalid||error)}):null,
            jsxs('div',{style:actionStyle,children:[button('save',async()=>{setSaving(true);try{await props.onSave(parseClientPolicy(draft,props.catalog));}catch(e){setError(e.message);}finally{setSaving(false);}},{disabled:props.disabled||saving||!!invalid,variant:'primary'}),button('cancel',close)]}),
          ]})});
    }

    /* ------------------------------ spec ------------------------------ */
    /** 空 = 清除（回落到下一层）；否则按原文写入。 */
    const textSpec = (field) => ({
      field,
      format: (value) => (value == null ? '' : String(value)),
      parse: (text) => {
        const trimmed = String(text == null ? '' : text).trim();
        return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
      },
    });
    /** 布尔：留空 = 清除；true/false 及常见写法都接受。 */
    const boolSpec = (field) => ({
      field,
      format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
      parse: (text) => {
        const s = String(text == null ? '' : text).trim().toLowerCase();
        if (s === '') return { kind: 'clear' };
        if (['true', '1', 'yes', 'on', '是', '开'].indexOf(s) >= 0) return { kind: 'set', value: true };
        if (['false', '0', 'no', 'off', '否', '关'].indexOf(s) >= 0) return { kind: 'set', value: false };
        return undefined;
      },
    });
    /** 0–20 的整数滑块；留空 = 清除（回落默认 5）。 */
    function sliderSpec(field) {
      return {
        field,
        format: (value) => (value == null ? '' : String(value)),
        parse: (text) => {
          const trimmed = String(text == null ? '' : text).trim();
          if (trimmed === '') return { kind: 'clear' };
          const value = Number(trimmed);
          return Number.isInteger(value) && value >= 0 && value <= 20 ? { kind: 'set', value } : undefined;
        },
      };
    }
    function formSpecs() {
      return ALL_FIELDS.map((name) => {
        if(SETTING_FIELD_KEYS[name])return {field:name,format:value=>value==null?'':String(value),parse:text=>{
          const raw=String(text).trim();if(!raw)return {kind:'clear'};
          const spec=settingFieldSpec(name,SETTING_FIELDS[name]);let value=raw;
          if(spec.type==='bool'){if(!['true','false'].includes(raw))return undefined;value=raw==='true';}
          return validateFieldValue(value,spec.schema)?{kind:'set',value}:undefined;
        }};
        if(name.startsWith('agents.'))return {field:name,format:value=>value==null?'':['string','enum'].includes(CONFIG_WHITELIST[name]?.type)?String(value):JSON.stringify(value),parse:text=>{
          const raw=String(text).trim();if(!raw)return {kind:'clear'};const spec=CONFIG_WHITELIST[name];if(!spec)return undefined;
          let value=raw;if(!['string','enum'].includes(spec.type))try{value=JSON.parse(raw);}catch{return undefined;}
          return validateFieldValue(value,spec.schema)?{kind:'set',value}:undefined;
        }};
        if (name === 'codexConfig' || name === 'extraCodexConfig') return {field:name,format:value=>value==null?'':JSON.stringify(value),parse:text=>{if(!text.trim())return {kind:'clear'};try{const value=JSON.parse(text);if(name==='extraCodexConfig'?!Array.isArray(value):!value||typeof value!=='object'||Array.isArray(value))return undefined;return {kind:'set',value};}catch{return undefined;}}};
        if (name === 'selectionPolicy') return {
          field:name,format:value=>value==null?'':typeof value==='string'?value:JSON.stringify(value),
          parse:text=>{
            if(!String(text).trim())return {kind:'clear'};
            try {const parsed=parseClientPolicy(text);return {kind:'set',value:JSON.stringify(parsed)};}catch{return undefined;}
          },
        };
        if (name === 'quotaWarningThreshold') return sliderSpec(name);
        if (RETENTION_NAMES.includes(name) || name==='pauseGraceMs') return {
          field:name,format:value=>value==null?'':String(value),parse:text=>{
            const raw=String(text).trim();if(!raw)return {kind:'clear'};
            const value=Number(raw);
            return /^\d+$/.test(raw)&&Number.isSafeInteger(value)&&value>=0&&value<=2147483647?{kind:'set',value}:undefined;
          },
        };
        if(name==='debugMaxBytes')return {
          field:name,format:value=>value==null?'':String(value),parse:text=>{
            const raw=String(text).trim();if(!raw)return {kind:'clear'};
            const value=Number(raw);
            return Number.isSafeInteger(value)&&value>=1&&value<=1073741824?{kind:'set',value}:undefined;
          },
        };
        if (name === 'codexExecutable' || name === 'codexHome') return {
          field:name,format:value=>value==null?'':String(value),parse:text=>{
            const value=String(text).trim();if(!value)return {kind:'clear'};
            if(/[\0\r\n]/.test(value)||!(/^[a-z]:[\\/]/i.test(value)||/^\\\\[^\\]+\\[^\\]+/.test(value)))return undefined;
            if(name==='codexExecutable'&&!/\.exe$/i.test(value))return undefined;
            return {kind:'set',value};
          },
        };
        if (name === 'statusPollingIntervalMinutes') return {
          field:name,format:value=>value==null?'':String(value),parse:text=>{
            const s=String(text).trim();if(!s)return {kind:'clear'};
            const value=Number(s);return Number.isInteger(value)&&value>=15&&value<=120?{kind:'set',value}:undefined;
          },
        };
        if (BOOL_NAMES.indexOf(name) >= 0) return boolSpec(name);
        if (NUM_NAMES.indexOf(name) >= 0) return P.settingsNumberField(name);
        return textSpec(name);
      });
    }

    /* ------------------------------ 小组件 ------------------------------ */
    /* 行几何跟官方 SettingsValueField（12px 内边距、无分隔线）一致；
     * 官方开关行是 16px + border-bottom，不混用。 */
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '24px',
      flexWrap: 'wrap',
      padding: '12px 0',
    };
    /* 🚨 不要写 `fontSize: 'var(--dsw-font-s-14, 14px)'`：--dsw-font-s-14 与
     * --dsw-font-xs-13 是 **font 简写**（`14px/22px …` / `13px/20px …`），
     * 作为 font-size 的值不合法 → 声明被丢弃 → 文本继承 body 的 16px。 */
    const labelStyle = { color: 'var(--dsw-alias-label-primary, inherit)', ...TYPE_LABEL };
    const hintStyle = {
      color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      ...TYPE_HINT,
      marginTop: '2px',
    };
    const resetStyle = {
      border: 'none',
      background: 'none',
      padding: 0,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flexShrink: 0,
      color: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      ...TYPE_HINT,
      borderRadius: '2px',
      outline: 'none',
    };

    /** 通用行：左标题 + 说明，右控件（同一行）。 */
    function Row(props) {
      const { t, label, badge, hint, hintId, onReset, disabled, control, beforeControl, wrapControl } = props;
      return jsxs('div', {
        style: {...rowStyle,...(wrapControl?{rowGap:'8px'}:{}),...(beforeControl&&disabled?{opacity:0.5}:{})},
        'aria-disabled':disabled||undefined,
        children: [
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: beforeControl || wrapControl ? '1 1 280px' : '1 1 0' },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' },
                children: [
                  jsx('span', { style: labelStyle, children: label }),
                  badge || null,
                  onReset
                    ? jsx('button', {
                        type: 'button', style: resetStyle, disabled: !!disabled, onClick: onReset,
                        onMouseEnter: event => { event.currentTarget.style.color = 'var(--dsw-alias-label-primary, inherit)'; event.currentTarget.style.textDecoration = 'underline'; },
                        onMouseLeave: event => { event.currentTarget.style.color = 'var(--dsw-alias-label-secondary, #8a8a8a)'; event.currentTarget.style.textDecoration = 'none'; },
                        onFocus: event => { event.currentTarget.style.outline = '2px solid var(--dsw-alias-brand-primary, #4b7bec)'; event.currentTarget.style.outlineOffset = '2px'; },
                        onBlur: event => { event.currentTarget.style.outline = 'none'; },
                        children: t('reset'),
                      })
                    : null,
                ],
              }),
              hint ? jsx('div', { id:hintId, style: hintStyle, children: hint }) : null,
            ],
          }),
          beforeControl || null,
          jsx('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', flex: wrapControl ? '0 1 auto' : '0 0 auto', ...(wrapControl?{maxWidth:'100%'}:{}) },
            children: control,
          }),
        ],
      });
    }

    /** 下拉框：官方 Menu + Button（与 bridge 的镜像选择同款）。 */
    function Select(props) {
      const { t, value, options, disabled, onSelect, ariaLabel } = props;
      const [open, setOpen] = react.useState(false);
      const current = options.filter((option) => option.id === value)[0];
      const shown = current ? current.label : (value === '' || value == null ? t('inheritCodex') : String(value));
      return jsx(P.Menu, {
        open: open && !disabled,
        items: options,
        selectedId: value,
        align: 'end',
        onClose: () => { setOpen(false); },
        onSelect: (id) => { onSelect(id); setOpen(false); },
        anchor: jsxs(P.Button, {
          variant: 'outline',
          size: 'sm',
          'aria-label': ariaLabel,
          'aria-haspopup': 'menu',
          'aria-expanded': open && !disabled,
          disabled: disabled,
          onClick: () => { setOpen((v) => !v); },
          children: [shown, jsx('span', { style: { marginLeft: '6px' }, children: '▾' })],
        }),
      });
    }

    /* Refactoring UI §§2.1, 3.6, 8.6: two explicit units, compact editable
     * values and secondary preset menus; retain DSH tokens and 8/16px gaps. */
    function PresetNumber(props) {
      const {t,name,value,defaultValue,presets,prefix,unit,zeroLabel,disabled,invalid,onChange,ariaLabel,decimal}=props;
      const concrete=String(value??'').trim()||String(defaultValue);
      const [draft,setDraft]=react.useState(concrete),[editing,setEditing]=react.useState(false),[open,setOpen]=react.useState(false);
      react.useEffect(()=>{if(!editing)setDraft(concrete);},[concrete,editing]);
      const border='1px solid var(--dsw-alias-border-l2, GrayText)';
      return jsxs('div',{role:'group','aria-label':ariaLabel,style:{display:'flex',flexDirection:'column',gap:'4px',...TYPE_BODY},children:[
        jsxs('div',{style:{display:'flex',alignItems:'center',gap:'8px',whiteSpace:'nowrap'},children:[
          jsx('span',{children:t(prefix)}),
          jsxs('span',{style:{display:'inline-flex',alignItems:'center',border,borderRadius:'var(--dsw-radius-md, 8px)',background:'var(--dsw-alias-bg-base, Canvas)',color:'var(--dsw-alias-label-primary, CanvasText)',overflow:'hidden',opacity:disabled?0.5:1},children:[
            jsx('input',{name,type:'text',inputMode:decimal?'decimal':'numeric',pattern:decimal?'[0-9]*[.]?[0-9]*':'[0-9]*',autoComplete:'off',value:draft,disabled,'aria-label':ariaLabel,'aria-invalid':invalid||undefined,
              style:{width:'8ch',minWidth:0,boxSizing:'border-box',height:'32px',padding:'0 8px',border:0,background:'transparent',color:'inherit',font:'inherit',fontVariantNumeric:'tabular-nums'},
              onFocus:()=>setEditing(true),onBlur:()=>{setEditing(false);if(!draft.trim())setDraft(String(defaultValue));},
              onChange:event=>{setDraft(event.target.value);onChange(event.target.value);}}),
            // The input shell clips rounded corners; render the native menu outside it.
            jsx(P.Menu,{open:open&&!disabled,portal:true,align:'end',selectedId:concrete,items:presets.map(number=>({id:String(number),label:number===0?t(zeroLabel||(unit==='days'?'noAgeLimit':'noCountLimit')):unit==='days'&&number===365?t('yearPreset'):number+' '+t(unit)})),
              onClose:()=>setOpen(false),onSelect:id=>{setDraft(id);onChange(id);setOpen(false);},
              anchor:jsx('button',{type:'button',disabled,'aria-label':ariaLabel+' · '+t('presets'),'aria-haspopup':'menu','aria-expanded':open&&!disabled,
                style:{height:'32px',width:'32px',padding:0,border:0,borderLeft:border,background:'transparent',color:'inherit',font:'inherit',cursor:disabled?'default':'pointer'},
                onClick:()=>setOpen(next=>!next),children:'▾'})}),
          ]}),
          jsx('span',{children:t(unit)}),
        ]}),
        invalid?jsx('span',{role:'alert',style:hintStyle,children:t('invalid')}):null,
      ]});
    }

    /** 带数值和单位的原生滑块。 */
    function SliderControl(props) {
      const { value, min, max, step, disabled, onChange, ariaLabel, unit = '%' } = props;
      return jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px' },
        children: [
          jsx('input', {
            type: 'range', min: min, max: max, step: step, value: String(value),
            disabled: !!disabled,
            'aria-label': ariaLabel,
            style: { width: '140px', accentColor: 'var(--dsw-alias-brand-primary, #4b7bec)' },
            onChange: (event) => { onChange(String(Number(event.target.value))); },
          }),
          jsx('span', {
            style: { minWidth: '36px', textAlign: 'right', ...hintStyle },
            children: value + unit,
          }),
        ],
      });
    }

    /* ------------------------------ 卡片 ------------------------------ */
    function formLabels(t) {
      return {
        unavailable: t('readOnly'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      };
    }

    // §§2.1/3.2/3.6：保存是唯一主操作，状态为辅助信息；沿用宿主主题和 8/12px 间距。
    // 原生表单没有 footer 插槽；仅隐藏包含本插件保存栏的表单原有 footer，不依赖宿主类名。
    const SAVE_BAR_CSS='div:has(> [data-codex-runner-save-slot]) > div:last-child:not([data-codex-runner-save-slot]){display:none}';
    function SaveBar({t,state,onSave}) {
      const slotRef=react.useRef(null),barRef=react.useRef(null);
      const [placement,setPlacement]=react.useState(null);
      react.useEffect(()=>{
        const slot=slotRef.current,bar=barRef.current;
        if(!slot||!bar)return;
        // Sticky 的底边受宿主滚动容器 padding 影响；从实际可视边界定位，不写死 DSH 的 48px。
        let scroller=null,frame=null;
        const measure=()=>{
          frame=null;
          if(!slot.isConnected)return;
          let candidate=slot.parentElement;
          while(candidate&&candidate!==document.documentElement&&!/(auto|scroll|hidden|clip)/.test(getComputedStyle(candidate).overflowY))candidate=candidate.parentElement;
          if(candidate!==scroller){if(scroller)observer?.unobserve(scroller);scroller=candidate;if(scroller)observer?.observe(scroller);}
          const rect=slot.getBoundingClientRect();
          const scrollRect=scroller?.getBoundingClientRect();
          const nested=scroller&&scroller!==document.body&&scroller!==document.documentElement;
          const left=Math.max(0,rect.left,nested?scrollRect.left+scroller.clientLeft:0);
          const right=Math.min(window.innerWidth,rect.right,nested?scrollRect.left+scroller.clientLeft+scroller.clientWidth:window.innerWidth);
          const bottom=Math.max(0,window.innerHeight-Math.min(window.innerHeight,nested?scrollRect.top+scroller.clientTop+scroller.clientHeight:window.innerHeight));
          const next={left,width:Math.max(0,right-left),bottom,height:bar.getBoundingClientRect().height};
          setPlacement(previous=>previous&&Object.keys(next).every(key=>next[key]===previous[key])?previous:next);
        };
        const schedule=()=>{if(frame===null)frame=requestAnimationFrame(measure);};
        const observer=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
        observer?.observe(slot);observer?.observe(bar);
        window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);measure();
        return ()=>{observer?.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);if(frame!==null)cancelAnimationFrame(frame);};
      },[]);
      const message=state.saving?'saving':!state.writable?'readOnly':state.failed?'saveFailed':state.invalid?'fixSettings':state.dirty?'unsavedSettings':'settingsClean';
      return jsx('div',{'data-codex-runner-save-slot':'',ref:slotRef,style:{marginTop:'8px',flexShrink:0,...(placement?{height:placement.height}:{})},children:jsxs('div',{'data-codex-runner-savebar':'',ref:barRef,style:{...TYPE_BODY,position:placement?'fixed':'sticky',bottom:placement?.bottom??0,...(placement?{left:placement.left,width:placement.width}:{}),zIndex:1,boxSizing:'border-box',display:'flex',alignItems:'center',gap:'12px',padding:'12px 0',minWidth:0,
        background:'var(--dsw-alias-bg-layer-3, Canvas)',borderTop:'1px solid var(--dsw-alias-border-l2, GrayText)'},children:[
        jsx('style',{children:SAVE_BAR_CSS}),
        jsx(P.Button,{variant:'primary',size:'sm',disabled:!state.available||!state.writable||!state.dirty||state.invalid||state.saving,onClick:onSave,children:t(state.saving?'saving':'save')}),
        jsx('span',{role:state.failed?'alert':'status','aria-live':state.failed?'assertive':'polite',style:{...TYPE_HINT,minWidth:0,overflowWrap:'anywhere',color:state.failed?'var(--dsw-alias-label-error, inherit)':'var(--dsw-alias-label-secondary, inherit)'},children:t(message)}),
      ]})});
    }

    function CodexRunnerCard(props) {
      const t = props.t;
      if (props.view === 'summary') return t('description');
      const state = props.useCodexRunnerForm((snapshot) => snapshot);
      const view=react.useSyncExternalStore(props.views.subscribe,props.views.getSnapshot);
      const [policyOpen,setPolicyOpen]=react.useState(false);
      const [configOpen,setConfigOpen]=react.useState(false);
      react.useEffect(()=>{void props.refreshCatalog();void props.refreshQuota('fresh');return props.subscribeRunEnds(()=>{void props.refreshQuota('fresh');});},[]);
      const disabled = !state.writable || state.saving;
      const fieldOf = (name) => state[name] || { text: '', invalid: false };
      const warningOn = String(fieldOf('quotaWarning').text == null ? '' : fieldOf('quotaWarning').text).trim().toLowerCase() === 'true';
      const autoModelOn = String(fieldOf('autoModelAndEffort').text ?? '').trim().toLowerCase() === 'true';


      const children = ROWS.map((row) => {

        const field = fieldOf(row.name);
        const onReset = () => { props.resetField(row.name); };

        // Refactoring UI §§2.1, 3.4, 3.6: group each path with its purpose;
        // use the host Input and wrap the 360px control on narrow screens.
        if(row.control==='path'){
          const id='codex-runner-'+row.name,hintId=id+'-hint',errorId=id+'-error';
          return jsx(Row,{t,label:t(row.label),hint:t(row.hint),hintId,onReset,disabled,wrapControl:true,
            control:jsxs('div',{style:{...TYPE_BODY,display:'grid',gap:'4px',width:'360px',maxWidth:'100%',minWidth:0},children:[
              jsx(P.Input,{id,name:row.name,type:'text',value:field.text??'',disabled,placeholder:t(row.placeholder),spellCheck:false,autoComplete:'off',title:field.text||undefined,
                'aria-label':t(row.label),'aria-invalid':field.invalid||undefined,'aria-describedby':hintId+(field.invalid?' '+errorId:''),
                style:{width:'100%',minWidth:0,boxSizing:'border-box',font:'inherit'},onChange:event=>props.edit(row.name,event.target.value)}),
              field.invalid?jsx('div',{id:errorId,role:'alert',style:hintStyle,children:t(row.error)}):null,
            ]}),
          },'path-'+row.name);
        }

        if(row.control==='preset-number'){
          const raw=String(field.text??'').trim(),scale=row.valueScale||1;
          return jsx(Row,{t,label:t(row.label),hint:t(row.hint),onReset,disabled,wrapControl:true,
            control:jsx(PresetNumber,{t,name:row.name,value:raw&&scale!==1?String(Number(raw)/scale):raw,decimal:scale!==1,defaultValue:row.defaultValue,presets:row.presets,prefix:row.prefix,unit:row.unit,zeroLabel:row.zeroLabel,disabled,invalid:field.invalid,ariaLabel:t(row.label),
              onChange:text=>{
                const next=String(text).trim();
                if(scale===1||!next){props.edit(row.name,text);return;}
                const fraction=(next.split('.')[1]||'').replace(/0+$/,'');
                const valid=/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(next)&&(row.decimalPlaces===undefined||fraction.length<=row.decimalPlaces);
                const scaled=Number(next)*scale;
                props.edit(row.name,valid?String(row.decimalPlaces===undefined?scaled:Math.round(scaled)):'NaN');
              }}),
          },'preset-number-'+row.name);
        }

        if (row.control === 'switch') {
          const low = String(field.text).trim().toLowerCase();
          const on = row.tier ? low === 'fast' : row.name === 'autoModelAndEffort' ? autoModelOn : low === 'true';
          return jsx(Row, {
            t,
            label: t(row.label),
            // §2.2：实验状态用宿主原生 Tag 表达，与标题文字分开。
            badge: row.experimental ? jsx(P.Tag, { tone: 'neutral', children: t('beta') }) : null,
            hint: t(row.hint),
            disabled,
            onReset,
            control: jsx(P.Switch, {
              checked: on,
              disabled,
              label: t(row.label),
              onChange: (next) => {
                props.edit(row.name, row.tier ? (next ? 'fast' : 'off') : (next ? 'true' : 'false'));
                // 打开额度告警时把空的阈值显式落成默认 5%，避免只开开关、阈值留空。
                if (row.name === 'quotaWarning' && next && !String(fieldOf('quotaWarningThreshold').text == null ? '' : fieldOf('quotaWarningThreshold').text).trim()) {
                  props.edit('quotaWarningThreshold', '5');
                }
              },
            }),
          }, 'switch-' + row.name);
        }

        if (row.control === 'select') {
          const selectedModel=String(fieldOf('defaultModel').text||'gpt-6.1-sol');
          const capability=view.catalog?.models?.find(model=>model.id===selectedModel);
          const dynamicOptions=['defaultModel'].includes(row.name)?view.catalog?.models?.filter(m=>!m.hidden).sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||(row.options.indexOf(a.id)<0?999:row.options.indexOf(a.id))-(row.options.indexOf(b.id)<0?999:row.options.indexOf(b.id))).map(m=>m.id)
            :['defaultEffort'].includes(row.name)?capability?.efforts.map(e=>e.id):row.options;
          const concreteDefault=SELECT_DEFAULTS[row.name];
          const options = (dynamicOptions||row.options).map((value) => {
            const key = 'o.' + value;
            const text = t(key);
            // 模型和思考强度始终显示原始标识，其他枚举继续使用界面词典。
            const rawName=['defaultModel','defaultEffort','maxEffortAllowed'].includes(row.name);
            const shown=rawName?value:(!text||text===key)?value:text;
            return {id:value,label:shown};
          });
          return jsx(Row, {
            t,
            label: t(row.label),
            hint: t(row.hint),
            disabled,
            onReset,
            control: jsx(Select, {
              t,
              value: concreteDefault ? String(field.text || '').trim() || concreteDefault : String(field.text || ''),
              options,
              disabled,
              ariaLabel: t(row.label),
              onSelect: (id) => { props.edit(row.name, id); },
            }),
          }, 'select-' + row.name);
        }

        if (row.control === 'slider') {
          const raw = String(field.text == null ? '' : field.text).trim();
          const fallback=row.defaultValue ?? 5;
          const parsed = raw === '' ? fallback : Number(raw);
          const value = Number.isFinite(parsed) ? Math.min(row.max, Math.max(row.min, Math.round(parsed))) : fallback;
          const enabled = !disabled && (row.name==='statusPollingIntervalMinutes' ? String(fieldOf('statusPollingEnabled').text).trim().toLowerCase()==='true' : warningOn);
          return jsx(Row, {
            t,
            label: t(row.label),
            hint: t(row.hint),
            disabled,
            onReset,
            control: jsx(SliderControl, {
              t,
              value,
              unit: row.unitKey ? ' '+t(row.unitKey) : '%',
              min: row.min,
              max: row.max,
              step: row.step || 1,
              disabled: !enabled,
              ariaLabel: t(row.label),
              onChange: (next) => { props.edit(row.name, next); },
            }),
          }, 'slider-' + row.name);
        }

        return null;
      });

      const rowMap=Object.fromEntries(ROWS.map((row,index)=>[row.name,children[index]]));
      const warning=rowMap.quotaWarning,threshold=rowMap.quotaWarningThreshold;
      rowMap.quotaWarning=jsx(Row,{...warning.props,
        disabled,
        beforeControl:threshold.props.control,
        onReset:()=>{props.resetField('quotaWarning');props.resetField('quotaWarningThreshold');},
      },warning.key);
      delete rowMap.quotaWarningThreshold;
      const polling=rowMap.statusPollingEnabled,interval=rowMap.statusPollingIntervalMinutes;
      rowMap.statusPollingEnabled=jsx(Row,{...polling.props,beforeControl:interval.props.control,onReset:()=>{props.resetField('statusPollingEnabled');props.resetField('statusPollingIntervalMinutes');}},polling.key);
      delete rowMap.statusPollingIntervalMinutes;
      const debug=rowMap.debugLogs,capacity=rowMap.debugMaxBytes;
      const debugEnabled=String(fieldOf('debugLogs').text).trim().toLowerCase()==='true';
      rowMap.debugLogs=jsx(Row,{...debug.props,
        beforeControl:jsx(PresetNumber,{...capacity.props.control.props,disabled:disabled||!debugEnabled}),
        onReset:()=>{props.resetField('debugLogs');props.resetField('debugMaxBytes');},
      },debug.key);
      delete rowMap.debugMaxBytes;
      const retention=rowMap.retentionDays,maxRuns=rowMap.retentionMaxRuns;
      rowMap.retentionDays=jsx(Row,{...retention.props,label:t('retentionPolicy'),hint:t('retentionHint'),wrapControl:true,
        onReset:()=>{props.resetField('retentionDays');props.resetField('retentionMaxRuns');},
        control:jsxs('div',{style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:'16px'},children:[retention.props.control,maxRuns.props.control]}),
      },retention.key);
      delete rowMap.retentionMaxRuns;
      const sectionViews=PAGE_LAYOUT.sections.map(section=>{
        // §3.6：选档相关设置随自动补全开关显示，折叠时保留表单草稿。
        if(section.id==='policy'&&!autoModelOn)return null;
        const extra=[];
        if(section.id==='quota')extra.push(jsx(QuotaBar,{t,quota:view.quota,error:view.quotaError,loading:view.quotaLoading,onRefresh:()=>props.refreshQuota('fresh')}));
        if(section.id==='policy') {
          let policy,policyInvalid=false;try{policy=parseClientPolicy(fieldOf('selectionPolicy').text);}catch{policy=DEFAULT_SELECTION_POLICY;policyInvalid=true;}
          extra.push(jsx(Row,{t,label:t('f.selectionPolicy'),hint:policyInvalid?t('fixSettings'):t('h.selectionPolicy'),
            disabled,onReset:()=>props.resetField('selectionPolicy'),control:jsx(Select,{t,value:policy.mode,
              options:['off','audit','enforce'].map(id=>({id,label:t('policyMode.'+id)})),disabled:disabled||policyInvalid,ariaLabel:t('f.selectionPolicy'),
              onSelect:mode=>props.edit('selectionPolicy',JSON.stringify({...policy,mode}))})},'select-selectionPolicy'));
          extra.push(jsxs('div',{style:actionStyle,children:[
            jsx(P.Button,{variant:'outline',size:'sm',disabled,onClick:()=>setPolicyOpen(true),children:t('editPolicy')}),
            jsx(P.Button,{variant:'outline',size:'sm',disabled:view.loading,onClick:props.refreshCatalog,children:t('refreshCatalog')}),
          ]}));
          extra.push(jsx('p',{role:'status',style:hintStyle,children:view.loading?t('loading'):view.error?t('catalogFallback')+': '+view.error:t('catalogSource')+': '+(view.catalog?.source||'fallback')}));
        }
        const content=[];
        for(const rowId of PAGE_LAYOUT.rows[section.id]) {
          if(rowMap[rowId])content.push(rowMap[rowId]);
        }
        // §2.8/§3.6: one secondary action after the advanced fields; reuse the
        // existing compact action spacing and keep Save as the primary action.
        if(section.id==='advanced')content.push(jsx('div',{style:actionStyle,children:jsx(P.Button,{variant:'outline',size:'sm',disabled,onClick:()=>setConfigOpen(true),children:t('editConfig')})},'full-config-action'));
        // §2.4/§3.6：未配置折叠的分组直接展示，只保留紧凑的组间距。
        if(section.collapsed===undefined)return jsxs('div',{'data-section':section.id,style:{margin:section.id==='quota'?'0':'8px 0 0',minWidth:0},children:[...extra,...content]},section.id);
        return jsx(Section,{section,title:t('section.'+section.id),children:[...extra,...content]},section.id);
      });
      if(policyOpen&&autoModelOn)sectionViews.push(jsx(PolicyModal,{t,initial:fieldOf('selectionPolicy').text,catalog:view.catalog,disabled,
        onClose:()=>setPolicyOpen(false),onSave:async value=>{props.edit('selectionPolicy',JSON.stringify(value));await props.save();const shell=props.getShell?.();if(shell?.failed||shell?.invalid)throw Error(t('saveFailed'));setPolicyOpen(false);}},'policy-modal'));
      if(configOpen)sectionViews.push(jsx(FullConfigModal,{t,initial:configSnapshot(fieldOf),disabled,catalog:view.catalog,loadRegistry:props.loadRegistry,onClose:()=>setConfigOpen(false),onSave:async(value,registryEdit)=>{
        let configurationSaved=false,previousRegistry=view.catalog;
        try{
          if(registryEdit){const preview=await props.saveRegistry({...registryEdit,preview:true});updateFieldRegistry({configuration:preview.configuration});}
          const edits=parseFullConfig(value);for(const [name,text] of edits)if(text!==fieldOf(name).text)props.edit(name,text);
          await props.save();const shell=props.getShell?.();if(shell?.failed||shell?.invalid)throw Error(t('saveFailed'));configurationSaved=true;
          if(registryEdit)await props.saveRegistry(registryEdit);
          setConfigOpen(false);
        }catch(error){if(registryEdit)updateFieldRegistry(previousRegistry);throw Error(configurationSaved&&registryEdit?t('editor.partial')+error.message:error.message);}
      }},'full-config-modal'));
      sectionViews.push(jsx(SaveBar,{t,state,onSave:props.save},'save-bar'));
      return jsxs(P.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children:sectionViews,
      });
    }

    Object.assign(zh,{"section.advanced": "高级设置", "editPolicy": "选档策略", "refreshCatalog": "刷新目录", "catalogFallback": "目录不可用，显示最近快照", "catalogSource": "目录来源", "loading": "加载中…", "policyMode": "策略模式", "cancel": "取消", "unsavedPolicy": "存在未保存的策略修改，放弃修改并关闭？", "restorePolicy": "恢复推荐值", "preset.strict": "严格", "preset.balanced": "平衡", "preset.economy": "省额度", "tab.tasks": "任务类型", "tab.evidence": "证据规则", "tab.downgrade": "降级与审批", "tab.quota": "额度策略", "tab.json": "高级 JSON", "model": "模型", "effort": "推理强度", "floorLow": "此 floor 低于推荐值", "policy.allowed": "允许降级", "policy.require_reason": "要求降级原因", "policy.require_approval": "要求人工审批", "reasonCategories": "原因类别（逗号分隔）", "neverFor": "禁止降级的任务（逗号分隔）", "approvalHint": "要求审批时将返回 approval_required；当前不提供逐次批准入口", "quotaBelow": "剩余额度低于 %", "quotaAction": "低额度动作", "preview": "预览示例任务", "taskKind": "任务类型", "actualModel": "实际模型", "actualEffort": "实际强度", "recommended": "推荐", "actual": "实际", "downgrade": "是否降级", "task.mechanical": "机械任务", "task.docs": "文档", "task.review": "复核", "task.implement": "实现", "task.architect": "架构", "task.rework": "返工", "evidence.architecture": "架构决策", "evidence.interface": "接口变化", "evidence.concurrency": "并发风险", "evidence.security": "安全风险", "evidence.design_failure": "设计失败"});
    Object.assign(en,{"section.advanced": "Advanced settings", "editPolicy": "Selection policy", "refreshCatalog": "Refresh catalog", "catalogFallback": "Catalog unavailable; using the latest snapshot", "catalogSource": "Catalog source", "loading": "Loading…", "policyMode": "Policy mode", "cancel": "Cancel", "unsavedPolicy": "Discard unsaved policy changes and close?", "restorePolicy": "Restore recommendations", "preset.strict": "Strict", "preset.balanced": "Balanced", "preset.economy": "Economy", "tab.tasks": "Task types", "tab.evidence": "Evidence rules", "tab.downgrade": "Downgrade and approval", "tab.quota": "Quota policy", "tab.json": "Advanced JSON", "model": "Model", "effort": "Reasoning effort", "floorLow": "This floor is below the recommendation", "policy.allowed": "Allow downgrade", "policy.require_reason": "Require downgrade reason", "policy.require_approval": "Require human approval", "reasonCategories": "Reason categories (comma separated)", "neverFor": "Never downgrade these tasks (comma separated)", "approvalHint": "Requiring approval returns approval_required; per-run approval is not available yet", "quotaBelow": "Below remaining quota %", "quotaAction": "Low quota action", "preview": "Preview a sample task", "taskKind": "Task type", "actualModel": "Actual model", "actualEffort": "Actual effort", "recommended": "Recommended", "actual": "Actual", "downgrade": "Downgrade", "task.mechanical": "Mechanical", "task.docs": "Documentation", "task.review": "Review", "task.implement": "Implementation", "task.architect": "Architecture", "task.rework": "Rework", "evidence.architecture": "Architecture", "evidence.interface": "Interface changes", "evidence.concurrency": "Concurrency", "evidence.security": "Security", "evidence.design_failure": "Design failure"});

    Object.assign(zh,{language:'zh'});
    Object.assign(en,{language:'en'});

    Object.assign(zh,{"remaining": "剩余", "quotaUnknown": "未知", "warningLine": "告警阈值", "resetAfter": "采样时距离重置", "minutes": "分钟", "lastKnown": "最近已知 / stale", "sampled": "采样数据", "quotaTriggered": "剩余额度已达到告警阈值", "recovery": "恢复状态", "refreshQuota": "刷新额度"});
    Object.assign(en,{"remaining": "remaining", "quotaUnknown": "Unknown", "warningLine": "Warning threshold", "resetAfter": "Reset after (at sample)", "minutes": "minutes", "lastKnown": "Last-known / stale", "sampled": "Sampled", "quotaTriggered": "Remaining quota reached warning threshold", "recovery": "Recovery", "refreshQuota": "Refresh quota"});

    Object.assign(zh,{"f.maxConcurrent": "工作区并发上限", "h.maxConcurrent": "最多同时运行的 Codex 任务数，默认 1", "f.debugLogs": "记录调试事件", "h.debugLogs": "本地记录之后启动任务的调试事件，不保存完整回答，不单独调用模型；达到上限后停止记录，任务继续运行", "f.debugMaxBytes": "调试事件容量上限", "h.debugMaxBytes": "每次运行的调试事件容量上限，默认 2 MiB，随运行清理", "f.pauseGraceMs": "额度暂停等待", "h.pauseGraceMs": "额度暂停后等待 Codex 保存进度。0 表示不限等待；非零时超时会再催促一次，可能增加 Codex 模型 token，再等一轮仍未结束则请求强制中断"});
    Object.assign(en,{"f.maxConcurrent": "Workspace concurrency limit", "h.maxConcurrent": "Maximum simultaneous Codex tasks; default 1", "f.debugLogs": "Record debug events", "h.debugLogs": "Record local debug events for new runs without full answers or separate model calls. At the limit, logging stops while the task continues", "f.debugMaxBytes": "Debug event size limit", "h.debugMaxBytes": "Per-run debug event limit; default 2 MiB, cleaned with the run", "f.pauseGraceMs": "Quota pause wait", "h.pauseGraceMs": "Wait for Codex to save progress after a quota pause. 0 waits indefinitely. A nonzero interval sends one extra reminder, which may use Codex model tokens, then requests a forced interruption if another interval expires"});

    /* ------------------------------ 装载 ------------------------------ */
    Object.assign(zh,{"f.selectionPolicy": "增强选档策略", "h.selectionPolicy": "默认关闭。仅审计只记录建议；强制执行会应用规则，并可能要求 DSH 解释选档或补充信息，增加模型 token 开销", "policyMode.off": "关闭", "policyMode.audit": "仅审计", "policyMode.enforce": "强制执行"});
    Object.assign(en,{"f.selectionPolicy": "Enhanced selection policy", "h.selectionPolicy": "Off by default. Audit only records recommendations. Enforcement applies rules and may ask DSH for reasons or more information, using additional model tokens", "policyMode.off": "Off", "policyMode.audit": "Audit only", "policyMode.enforce": "Enforce rules"});

    const inject = ['slots', 'locale', 'configForms'];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-codex-runner: dictionaries');

      const scope = ctx.configForms.get(ENTRY_ID);
      const form = new P.SettingsFormModel(scope, formSpecs(), []);
      const store = form.bind(() => {
        const snapshot = { ...form.shell() };
        for (const name of ALL_FIELDS) snapshot[name] = form.field(name);
        return snapshot;
      });
      const views=createViewStore();
      // Cordis get() explicitly supports optional service lookup. An absent service
      // must not fall through to a property getter: that getter requires inject.
      const optional=name=>typeof ctx.get==='function'?ctx.get(name):ctx[name];
      const api=()=>optional('codexRunner') || connectionApi(optional('connection'));
      const refreshCatalog=async()=>{
        views.update({loading:true,error:null});
        try {const service=api();if(!service)throw Error('Service unavailable');const catalog=await service.getCatalog({refresh:true});updateFieldRegistry(catalog);views.update({catalog,loading:false,error:catalog.error||null});}
        catch(error){views.update({loading:false,error:String(error.message)});}
      };
      const loadRegistry=async(options={})=>{
        let value;try{const service=api();if(!service?.getEditorRegistry)throw Error('Service unavailable');value=await service.getEditorRegistry(options);
          const object=item=>item&&typeof item==='object'&&!Array.isArray(item);
          if(!object(value)||!object(value.configuration?.fields)||!object(value.configuration?.config))throw Error('Invalid registry response');
          parseRegistryDocument(JSON.stringify(value.document));
        }
        catch(error){value=structuredClone(BUNDLED_EDITOR_STATE);value.configuration.error=error.code==='codex-runner/editor-endpoint-unavailable'?t('editor.endpointUnavailable'):String(error.message);}
        updateFieldRegistry({configuration:value.configuration});views.update({catalog:{...views.getSnapshot().catalog,configuration:value.configuration}});return value;
      };
      const saveRegistry=async args=>{const service=api();if(!service?.saveEditorRegistry)throw Error('Service unavailable');const value=await service.saveEditorRegistry(args);if(!args.preview){let catalog={...views.getSnapshot().catalog,configuration:value.configuration};try{catalog=await service.getCatalog();}catch{}updateFieldRegistry(catalog);views.update({catalog});}return value;};
      const refreshQuota=async(probe='none')=>{views.update({quotaLoading:true});try{const service=api();if(!service?.getQuota)throw Error('Service unavailable');views.update({quota:await service.getQuota({probe}),quotaError:null,quotaLoading:false});}catch(error){views.update({quotaError:error.message,quotaLoading:false});}};
      const subscribeRunEnds=listener=>{
        if(!globalThis.EventSource||!globalThis.window?.location)return ()=>{};
        const endpoint=new URL('api/codex-runner/run-events',new URL('.',window.location.href));
        const source=new EventSource(endpoint.href,{withCredentials:true});
        source.onmessage=event=>{try{const value=JSON.parse(event.data);if(typeof value.run_id==='string'&&typeof value.status==='string')listener(value);}catch{}};
        source.onerror=()=>source.close();
        return ()=>source.close();
      };
      const actions=form.actions();
      // The host's actions.save() starts an async save but returns void. Wait for
      // its observable completion before closing the policy dialog or reporting success.
      const save=async()=>{
        actions.save();
        if(form.shell().saving)await new Promise(resolve=>{
          let dispose;
          const finish=()=>{if(!form.shell().saving){dispose?.();resolve();}};
          dispose=store.subscribe(finish);finish();
        });
      };
      const face = {hooks:{codexRunnerForm:store},...actions,save,getShell:()=>form.shell(),views,refreshCatalog,refreshQuota,subscribeRunEnds,loadRegistry,saveRegistry};
      ctx.effect(() => () => { form.dispose(); }, 'dsh-codex-runner: form subscription');

      ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: ENTRY_ID,
        locale: NS,
        inject: () => face,
      }, CodexRunnerCard))), 'dsh-codex-runner: settings page');
    }

    exports.NS = NS;
    exports.ENTRY_ID = ENTRY_ID;
    exports.ROWS = ROWS;
    exports.Row = Row;   // 供离线冒烟断言行内排版（标题/说明/覆盖标记/重置）
    exports.PresetNumber=PresetNumber;
    exports.FullConfigModal=FullConfigModal;
    exports.configurationTableRows=configurationTableRows;
    exports.schemaRange=schemaRange;
    exports.mergeRegistryRefresh=mergeRegistryRefresh;
    exports.BUNDLED_EDITOR_STATE=BUNDLED_EDITOR_STATE;
    exports.parseFullConfig=parseFullConfig;
    exports.configSnapshot=configSnapshot;
    exports.ALL_FIELDS=ALL_FIELDS;
    exports.CONFIG_WHITELIST=CONFIG_WHITELIST;
    exports.updateFieldRegistry=updateFieldRegistry;
    exports.validateFieldValue=validateFieldValue;
    exports.QuotaBar=QuotaBar;
    exports.SaveBar=SaveBar;
    exports.parseClientPolicy=parseClientPolicy;
    exports.policyPreset=policyPreset;
    exports.PolicyModal=PolicyModal;
    exports.Section=Section;
    exports.connectionApi=connectionApi;
    exports.DICTS = { zh: zh, en: en };   // 供离线冒烟断言文案（也便于将来做本地化校验）
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
