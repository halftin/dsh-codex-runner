import { DEFAULT_FIELD_REGISTRY, BUNDLED_RULES, SETTING_FIELD_KEYS, registryConfigPairs, getFieldRegistry, getFieldRegistrySync } from './codex-fields.js';
import { validateFieldValue, stringEnumSpec, settingFieldSpec } from './field-schema.js';
import { boundedSubagents } from './subagent-view.js';
import { runFacts, completionNoticeMode } from './run-facts.js';
import { withTaskReturn } from './task-return.js';
import { handoffText } from './task-handoff.js';
import { quotaFromMeta } from './quota-view.js';
import { DEFAULT_SELECTION_POLICY, parsePolicy, evaluateSelection } from './selection-policy.js';
import { getCatalog, peekCatalog, onCatalog, FALLBACK_CATALOG, REASONING_ORDER, validateCatalogSelection } from './model-catalog.js';
/**
 * dsh-codex-runner · core —— 零 dsh 依赖，可脱离宿主独立测试。
 *
 * 统一校验设置、选档和运行身份，再调用所选驱动并返回有界结果。
 * exec 是兼容驱动；App Server 驱动提供活动轮控制与可选额度暂停。
 * 协议实现、进程生命周期、恢复调度分别由对应模块维护。
 */
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJson, validateLabel, validRunId, reserveRun, recordFor, runDirectory, updateRecord, cleanupRuns, assertStorePath, runEvidence, DEFAULT_RUN_RETENTION_DAYS, DEFAULT_RETAINED_RUNS } from './run-store.js';
import { sendControl } from './run-control.js';
import { failureSummary } from './run-data.js';
import { codexEnvironment, installationSettingProblem } from './executable.js';
import { selectWithEvidence } from './selection.js';

/** 允许的模型档位；默认 gpt-6.1-sol。 */
export const ALLOWED_MODELS = FALLBACK_CATALOG.models.map(model=>model.id);
/** 允许的推理强度：与 Codex 模型缓存里的 supported_reasoning_levels 对齐（6.1-sol / astra 支持全部 6 档）。 */
export const ALLOWED_EFFORTS = [...new Set(FALLBACK_CATALOG.models.flatMap(model=>model.efforts.map(e=>e.id)))];
/** 强度排序（用于"自治上限"比较）。 */
export const EFFORT_ORDER = REASONING_ORDER.slice();
onCatalog(catalog=>{
  ALLOWED_MODELS.splice(0,ALLOWED_MODELS.length,...catalog.models.map(m=>m.id));
  const efforts=[...new Set([...REASONING_ORDER,...catalog.models.flatMap(m=>m.efforts.map(e=>e.id))])];
  ALLOWED_EFFORTS.splice(0,ALLOWED_EFFORTS.length,...efforts);
  EFFORT_ORDER.splice(0,EFFORT_ORDER.length,...efforts);
});

/**
 * **机制化选档**：`task_kind` → `{ model, effort }`（把"按任务定档"这条纪律做成可执行规则表，而不是写在文档里靠自觉）。
 *
 * 设计原则：
 *   · 规则是**数据**，不是提示词 —— 可测试、可审计、可改一处生效全局；
 *   · **显式参数永远优先**：只填调用方省略的那一项（`model_source`/`effort_source` 会如实回报）；
 *   · 表内最高只到 `xhigh`（= 默认自治上限）；若设置把上限压低，既有的上限检查照常拦下并要求 `unlock_effort`；
 *   · `max`/`ultra` **故意不进表**：它们必须由人显式放行（混合制要求留痕）。
 */
export const TASK_KINDS = {
  mechanical: { model: 'gpt-6-luna', effort: 'low', why: '机械搬迁/改名/批量替换/跑门禁（大而机械 ≠ 需要高强度）' },
  docs: { model: 'gpt-6-luna', effort: 'low', why: '纯文档/说明同步' },
  review: { model: 'gpt-6.1-sol', effort: 'medium', why: '独立复核/读代码出结论（不写实现）' },
  implement: { model: 'gpt-6.1-sol', effort: 'high', why: '常规实现/修 bug/写测试（本项目默认档）' },
  architect: { model: 'gpt-6-astra', effort: 'xhigh', why: '架构设计/跨层重构/疑难不确定问题' },
  rework: { model: 'gpt-6-astra', effort: 'xhigh', why: '验收失败后的返工批' },
};
/** 规则表里允许的 `task_kind` 名字（错误提示用）。 */
export const TASK_KIND_NAMES = Object.keys(TASK_KINDS);

/**
 * 纯函数：解析本次调用真正使用的档位与"谁定的"。
 * 显式 `model`/`effort` 优先；`task_kind` 只填**调用方省略的那一项**；都没有才用默认值。
 * 抽成纯函数是为了可测试、可审计（`model_source`/`effort_source` 就是它的输出）。
 */
export function resolveSelection({ taskKind, model, effort, defaultModel, defaultEffort }) {
  const rule = taskKind ? TASK_KINDS[taskKind] : null;
  return {
    rule,
    model: model || (rule ? rule.model : defaultModel),
    effort: effort || (rule ? rule.effort : defaultEffort),
    modelSource: model ? 'explicit' : (rule ? 'task_kind' : 'default'),
    effortSource: effort ? 'explicit' : (rule ? 'task_kind' : 'default'),
  };
}

/* ==================== 统一配置 ====================
 * 每次调用读取 DSH profile 的当前值；设置页和 JSON 编辑器共用该数据源。
 * 优先级：代码默认 ← DSH profile ← 支持的单次工具参数。
 */

/**
 * 插件在会话工作目录下的**数据目录（中性命名）**：保存运行日志和记录。
 * 刻意不绑定任何外部工具/产品名，也不依赖任何项目文档 —— 发布版必须自洽。
 */
export const DATA_DIR_NAME = '.codex-runner';
/** 日志目录（相对会话工作目录）：插件把它作为绝对路径用 `--log-dir` 交给 driver，双方不会各写各的。 */
export const LOGS_REL = path.join(DATA_DIR_NAME, 'logs');

/** 允许写入 Codex 的配置键（白名单 + 取值校验），避免插件配置注入任意 Codex 配置。 */
export const CODEX_CONFIG_WHITELIST = DEFAULT_FIELD_REGISTRY.config;
export const NATIVE_AGENT_KEYS=Object.keys(BUNDLED_RULES.fields).filter(key=>BUNDLED_RULES.fields[key].profile);
function nativeAgentProblem(key,value,registry=DEFAULT_FIELD_REGISTRY) {
  if(!NATIVE_AGENT_KEYS.includes(key))return null;
  const spec=registry.config[key];
  if(!spec||!validateFieldValue(value,spec.schema))return key+' has an invalid registry value';
  return null;
}
/** settings 键 → 类型/取值约束。 */
export const SETTINGS_SPEC = {
  ...Object.fromEntries(NATIVE_AGENT_KEYS.map(key=>[key,CODEX_CONFIG_WHITELIST[key]])),
  backend: { type: 'enum', values: ['exec', 'app-server'] },
  autoResumeAfterQuota: { type: 'bool' },
  statusPollingEnabled: { type:'bool' },
  statusPollingIntervalMinutes: { type:'number' },
  // 低额度提醒负责请求保存进度并暂停；自动恢复由独立开关控制。
  quotaWarning: { type: 'bool' },
  quotaWarningThreshold: { type: 'number' },
  selectionPolicy: { type: 'json' },
  selectionMode: { type: 'enum', values: ['legacy', 'manual', 'evidence'] },
  defaultModel: { type: 'enum', values: ALLOWED_MODELS },
  autoModelAndEffort: { type: 'bool' },
  defaultEffort: { type: 'enum', values: ALLOWED_EFFORTS },
  maxEffortAllowed: { type: 'enum', values: ALLOWED_EFFORTS },
  defaultBudgetMs: { type: 'number' },
  driverPath: { type: 'string' },
  codexExecutable: { type: 'string' },
  codexHome: { type: 'string' },
  serviceTier: { type: 'string' },
  sandboxMode: stringEnumSpec(DEFAULT_FIELD_REGISTRY.fields.sandbox_mode),
  approvalPolicy: stringEnumSpec(DEFAULT_FIELD_REGISTRY.fields.approval_policy),
  workspaceNetworkAccess: settingFieldSpec('workspaceNetworkAccess',DEFAULT_FIELD_REGISTRY.fields[SETTING_FIELD_KEYS.workspaceNetworkAccess]),
  codexConfig: { type: 'object' },
  extraCodexConfig: { type: 'array' },
  pauseGraceMs: { type: 'number' },
  maxConcurrent: { type: 'number' },
  retentionDays: { type: 'number' },
  retentionMaxRuns: { type: 'number' },
  debugLogs: { type:'bool' },
  debugMaxBytes: { type:'number' },
};

/** 代码默认值（最底层）。 */
export const SETTINGS_DEFAULTS = {
  backend: 'app-server',
  codexExecutable: '', codexHome: '',
  autoResumeAfterQuota: false,
  statusPollingEnabled: false,
  statusPollingIntervalMinutes: 30,
  quotaWarning: false,
  quotaWarningThreshold: 5,
  selectionPolicy: DEFAULT_SELECTION_POLICY,
  selectionMode: 'legacy',
  defaultModel: 'gpt-6.1-sol', autoModelAndEffort: false,
  defaultEffort: 'high',
  maxEffortAllowed: 'xhigh',
  defaultBudgetMs: 0,
  serviceTier: 'off',                 // off | flex | fast（Fast = 官方"加速档"，更快但用量更多）
  sandboxMode: 'workspace-write',     // workspace-write | read-only | danger-full-access
  approvalPolicy: 'never',
  workspaceNetworkAccess: false,
  codexConfig: {}, extraCodexConfig: [],
  pauseGraceMs: 0,
  maxConcurrent: 1, retentionDays: DEFAULT_RUN_RETENTION_DAYS, retentionMaxRuns: DEFAULT_RETAINED_RUNS, debugLogs: false, debugMaxBytes: 2097152,
};

/**
 * 一等设置 → Codex 配置对（`--set`）。
 * 这三项用户明确要求"静默传给 codex"，所以做成设置项而不是散落在 codexConfig 里：
 *   serviceTier→service_tier · approvalPolicy→approval_policy · workspaceNetworkAccess→sandbox_workspace_write.network_access
 */
export function derivedCodexPairs(S,registry=DEFAULT_FIELD_REGISTRY) {
  const pairs = [], problems = [];
  const tier = String(S.serviceTier || 'off');
  if (tier && tier !== 'off') {
    const canonical=tier==='fast'?'priority':tier;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(tier) || !peekCatalog().models.some(m=>m.serviceTiers.some(t=>t.id===canonical))) problems.push('serviceTier 取值非法');
    else pairs.push(['service_tier', tier === 'fast' ? 'priority' : tier]);
  }
  for(const key of NATIVE_AGENT_KEYS)if(S[key]!==undefined){const problem=nativeAgentProblem(key,S[key],registry);if(problem)problems.push(problem);else {const checked=registryConfigPairs({[key]:S[key]},registry);pairs.push(...checked.pairs);problems.push(...checked.problems);}}
  const ap = S.approvalPolicy;
  if (ap !== undefined && ap !== null && ap !== '') {
    const checked=validateSetting('approvalPolicy',ap,registry);
    if (!checked.ok) problems.push(checked.problem);
    else pairs.push(['approval_policy', String(ap)]);
  }
  if (S.workspaceNetworkAccess !== undefined && S.workspaceNetworkAccess !== null) {
    const checked=validateSetting('workspaceNetworkAccess',S.workspaceNetworkAccess,registry);
    if(!checked.ok)problems.push(checked.problem);
    else pairs.push([SETTING_FIELD_KEYS.workspaceNetworkAccess,JSON.stringify(S.workspaceNetworkAccess)]);
  }
  return { pairs, problems };
}

/** 校验一个 settings 键值对 → {ok, problem}。 */
export function validateSetting(key, value, registry=DEFAULT_FIELD_REGISTRY) {
  if (key === 'codexExecutable' || key === 'codexHome') {
    const problem = installationSettingProblem(key, value);
    return { ok: !problem, problem };
  }
  const fieldKey=Object.hasOwn(SETTING_FIELD_KEYS,key)&&SETTING_FIELD_KEYS[key];
  const spec = fieldKey?settingFieldSpec(key,registry.fields?.[fieldKey]):SETTINGS_SPEC[key];
  if(fieldKey){const ok=validateFieldValue(value,spec.schema);return {ok,problem:ok?null:key+' has an invalid registry value'};}
  const nativeProblem=nativeAgentProblem(key,value,registry);if(nativeProblem)return {ok:false,problem:nativeProblem};
  if(NATIVE_AGENT_KEYS.includes(key))return {ok:true,problem:null};
  if(key==='selectionPolicy') {try{parsePolicy(value);return {ok:true,problem:null};}catch(error){return {ok:false,problem:error.message};}}
  if (!spec) {
    return { ok: false, problem: '未知设置键 ' + key + '（允许：' + Object.keys(SETTINGS_SPEC).join(', ') + '）' };
  }
  if (spec.type === 'enum' && !spec.values.includes(String(value))) {
    return { ok: false, problem: key + ' 取值非法（允许 ' + spec.values.join(' | ') + '）' };
  }
  if (spec.type === 'bool' && typeof value !== 'boolean') return { ok: false, problem: key + ' 需要布尔值' };
  if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return { ok: false, problem: key + ' 需要数字' };
  if (spec.type === 'string' && typeof value !== 'string') return { ok: false, problem: key + ' 需要字符串' };
  if (spec.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) return { ok: false, problem: key + ' 需要对象' };
  if (spec.type === 'array' && !Array.isArray(value)) return { ok: false, problem: key + ' 需要数组' };
  if (spec.type === 'number' && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)) return { ok: false, problem: key + ' needs a nonnegative bounded integer' };
  if (key === 'maxConcurrent' && (value < 1 || value > 8)) return { ok: false, problem: 'maxConcurrent must be 1..8' };
  if (key === 'statusPollingIntervalMinutes' && (value < 15 || value > 120)) return {ok:false,problem:'statusPollingIntervalMinutes must be an integer 15..120'};
  if (key === 'quotaWarningThreshold' && (!Number.isInteger(value) || value < 0 || value > 20)) {
    return { ok: false, problem: 'quotaWarningThreshold must be an integer 0..20' };
  }
  if (key === 'debugMaxBytes' && (value < 1 || value > 1073741824)) return {ok:false,problem:'debugMaxBytes must be 1..1073741824'};
  if (key === 'extraCodexConfig' || key === 'codexConfig') {
    const result = codexConfigPairs(key === 'codexConfig' ? value : {}, key === 'extraCodexConfig' ? value : [],registry);
    if (result.problems.length) return { ok: false, problem: result.problems.join('; ') };
  }
  return { ok: true, problem: null };
}


export function settingsProblem(effective) {
  const registry=getFieldRegistrySync({settings:effective.settings});
  if (effective.settingsErrors.length) return effective.settingsErrors.join('; ');
  for (const [key, value] of Object.entries(effective.settings)) {
    const result = validateSetting(key, value,registry);
    if (!result.ok) return result.problem;
  }
  return null;
}

/** 把 codexConfig / extraCodexConfig 折成 driver 的 `--set` 对（含白名单与类型校验）。 */
export function codexConfigPairs(codexConfig, extraCodexConfig, registry=DEFAULT_FIELD_REGISTRY) {
  const values={...(codexConfig || {})},problems=[];
  for(const item of extraCodexConfig || []) {
    const index=String(item).indexOf('=');if(index<1){problems.push('extraCodexConfig requires key=value');continue;}
    const key=item.slice(0,index).trim(),spec=registry.config[key];let value=item.slice(index+1);
    if(spec && !['string','enum'].includes(spec.type))try{value=JSON.parse(value);}catch{}
    values[key]=value;
  }
  const checked=registryConfigPairs(values,registry);
  return {pairs:checked.pairs,problems:[...problems,...checked.problems]};
}

/**
 * 无损 JSON 消毒器（宿主硬要求）。
 *
 * 宿主会拒收"非无损 JSON"的工具返回值：`NaN`/`Infinity`/`undefined`/函数/Symbol/BigInt、
 * **非普通对象**（类实例、Date、Map…）、循环引用都会被判为 `value is not lossless JSON`。
 * 我们读的 `config` 是外部输入，不能假设它干净 —— 所以统一消毒，
 * 并把**被清理的路径**回传，把"到底混进了什么"变成可审计数据（而不是静默吞掉）。
 *
 * @param value - 任意值
 * @param path - 诊断用路径前缀
 * @param dropped - 收集被清理的路径（原地追加）
 * @param stack - 祖先链（判循环引用；同一对象出现在兄弟分支不算）
 * @returns 保证可无损 JSON 化的等价值
 */
export function sanitizeJson(value, path = '', dropped = [], stack = []) {
  const t = typeof value;
  if (value === null) return null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (Number.isFinite(value)) return value;
    dropped.push(path + '(' + String(value) + ')');
    return null;
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    dropped.push(path + '(' + t + ')');
    return undefined;
  }
  if (t !== 'object') {
    dropped.push(path + '(' + t + ')');
    return undefined;
  }
  if (stack.indexOf(value) >= 0) {
    dropped.push(path + '(circular)');
    return undefined;
  }
  stack.push(value);
  const out = Array.isArray(value) ? [] : {};
  const proto = Array.isArray(value) ? null : Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    // 类实例 / Date / Map…：不是普通对象，宿主会拒 —— 记一笔，再尽力按自有可枚举属性展开。
    dropped.push(path + '(' + Object.prototype.toString.call(value) + ')');
  }
  for (const key of Object.keys(value)) {
    const child = sanitizeJson(value[key], path === '' ? key : path + '.' + key, dropped, stack);
    if (child !== undefined) out[key] = child;
  }
  stack.pop();
  return out;
}

/**
 * 解开宿主 config 的"访问器壳"。
 *
 * 实测（2026-10-10，DSH 0.2.0-rc.2）：交给外部插件的 config，**每个 `.volatile()` 字段都是
 * `{ get: () => 值 }`**，不是普通值。直接当值用会连环出错：
 *   · `ALLOWED_MODELS.includes({get})` 为假 → 档位白名单误判；
 *   · `derivedCodexPairs` 把 `{get}` 当 serviceTier → 报"取值非法"；
 *   · `fs.existsSync({get})` / `path.isAbsolute({get})` 直接抛类型错。
 * 这里统一取值；取不到（抛错 / 返回 undefined）就按"未设置"处理，交回默认值与下游校验。
 */
export function unwrapConfigValue(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

export function loadEffectiveSettings({ config = {} } = {}) {
  const settingsErrors = [];
  const fromConfig = {};
  const configShapes = {};
  for (const k of Object.keys(SETTINGS_SPEC)) {
    const raw = config[k];
    if (raw === undefined) continue;
    const value = unwrapConfigValue(raw);
    if (value !== raw) configShapes[k] = 'accessor';
    else if (raw !== null && typeof raw === 'object') configShapes[k] = 'object';
    if (value === undefined) continue;   // 访问器取不到 → 视为未设置，交给默认值
    if(NATIVE_AGENT_KEYS.includes(k)&&value==null)continue;
    if(['defaultModel','defaultEffort','selectionMode','maxEffortAllowed','sandboxMode','approvalPolicy'].includes(k)&&(value==null||typeof value==='string'&&!value.trim()))continue;
    fromConfig[k] = value;
  }
  const settings = Object.assign({}, SETTINGS_DEFAULTS, fromConfig);
  try { settings.selectionPolicy=parsePolicy(fromConfig.selectionPolicy); }
  catch(error) {settingsErrors.push(error.message);}
  const fieldSources = Object.fromEntries(Object.keys(settings).map(k => [k,Object.hasOwn(fromConfig,k)?'profile':'defaults']));
  const source = Object.keys(fromConfig).length ? 'profile' : 'defaults';
  return { settings, source, configShapes, fieldSources, settingsErrors };
}


/**
 * 默认 driver 位置（相对会话工作目录）：**兜底约定**，只在随包自带的 driver 缺失时才用。
 * 发布版靠 `BUNDLED_DRIVER` 自持（见下），不依赖会话目录里的任何文件。
 */
export const DEFAULT_DRIVER_REL = path.join(DATA_DIR_NAME, 'driver', 'drive-codex.mjs');

/** 随包自带的 driver：插件自持的实现，路径由本模块自身位置派生（不含任何机器/会话相关拼写）。 */
export const BUNDLED_DRIVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'drivers', 'drive-codex.mjs',
);

/**
 * driver 解析顺序：**显式配置** > **随包自带** > 会话目录下的中性兜底约定。
 * 都取不到时返回首选路径，由调用方照常 fail closed 并报错（不静默回落）。
 */
export function resolveDriverPath({ configured = null, cwd }) {
  if (configured) return configured;
  if (fs.existsSync(BUNDLED_DRIVER)) return BUNDLED_DRIVER;
  return path.join(cwd, DEFAULT_DRIVER_REL);
}

/** Assemble execution arguments without rewriting the task prompt. */
export function driverArgs({
  driverPath, promptFile, label, cwd, model, effort,
  budgetMs, resumeThread, setPairs, sandbox, logDir, runId, debugLogs, debugMaxBytes, detach, autoResumeAfterQuota, pauseGraceMs = 0,
  quotaWarning, quotaWarningThreshold,
}) {
  const args = [driverPath, '--prompt', promptFile, '--label', label, '--cwd', cwd];
  if (runId) args.push('--run-id', runId);
  if (detach) args.push('--detached');
  if (autoResumeAfterQuota) args.push('--auto-resume-quota');
  if (quotaWarning) {
    args.push('--quota-warning');
    if (quotaWarningThreshold !== undefined && quotaWarningThreshold !== null) {
      args.push('--quota-warning-threshold', String(quotaWarningThreshold));
    }
  }
  args.push('--pause-grace-ms', String(pauseGraceMs));
  if (debugLogs === true) args.push('--debug-logs');
  if (debugMaxBytes !== undefined) args.push('--debug-max-bytes', String(debugMaxBytes));
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sandbox) args.push('--sandbox', String(sandbox));
  // 显式把日志目录交给 driver：插件与 driver 读写的必须是同一个目录（不依赖 driver 的缺省约定）。
  if (logDir) args.push('--log-dir', String(logDir));
  if (budgetMs !== undefined && budgetMs !== null) args.push('--budget-ms', String(budgetMs));
  if (resumeThread) args.push('--resume', String(resumeThread));
  for (const [k, v] of (setPairs || [])) args.push('--set', k + '=' + v);
  return args;
}

/** Windows 上整树终止（含 codex 派生的 pwsh/mvn/java）。 */
export function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** 读最新一份该 label 的 meta.json。 */
export function readMeta(logDir, label) {
  const record = recordFor(logDir, label);
  if (record) {
    const file = path.join(runDirectory(logDir, record), 'result.meta.json');
    return { meta: readJson(file), file };
  }
  if (!validateLabel(label) || !fs.existsSync(logDir)) return { meta: null, file: null };
  const files = fs.readdirSync(logDir).filter(f => f.startsWith(label + '-') && /^\d{4}-/.test(f.slice(label.length + 1)) && f.endsWith('.meta.json'))
    .map(f => path.join(logDir,f)).sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const file = files[0] || null;
  return { meta: file ? readJson(file) : null, file };
}

/** 进程存活检查（插件侧，用于兜底收尸与 orphan 判定）。 */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** 读最新一份该 label 的心跳文件（driver 被杀后，它是唯一的交叉验证源）。 */
export function readHeartbeat(logDir, label) {
  const record = recordFor(logDir, label);
  if (record) return readJson(path.join(runDirectory(logDir, record), 'result.hb.json'));
  if (!validateLabel(label)) return null;
  if (!fs.existsSync(logDir)) return null;
  const files = fs.readdirSync(logDir)
    .filter((f) => f.startsWith(label + '-') && /^\d{4}-/.test(f.slice(label.length + 1)) && f.endsWith('.hb.json'))
    .map((f) => ({ f: path.join(logDir, f), m: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(files[0].f, 'utf8')); } catch { return null; }
}

/** 读 registry（driver 自己维护的"在跑的后台任务"表）。 */
export function readRegistry(logDir) {
  try { return JSON.parse(fs.readFileSync(path.join(logDir, 'codex-live.json'), 'utf8')); }
  catch { return { live: [] }; }
}

/** 睡眠（codex_status 的 wait 用）。 */
export function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

/**
 * 后台运行状态快照（detached 模式用）：driver 存活 + 心跳 + 最新 meta。
 * reserveRun 的独立记录及进程证据覆盖 spawn 真空期。
 */
export function readRunState(logDir, label) {
  const record = recordFor(logDir, label);
  if (record) {
    const dir = runDirectory(logDir, record);
    const evidence = runEvidence(logDir, record);
    const recovery = readJson(path.join(dir, 'recovery-state.json'));
    return { record, ...evidence, recovery: recovery?.runId === record.runId ? recovery : null,
      metaFile: path.join(dir, 'result.meta.json'), entry: record };
  }
  const { meta, file } = readMeta(logDir, label);
  const hb = readHeartbeat(logDir, label);
  const reg = readRegistry(logDir);
  const entry = (reg.live || []).find((e) => e.label === label) || null;
  const driverPid = (entry && entry.driverPid) || null;
  const driverAlive = pidAlive(driverPid);
  const childPid = (meta && meta.childPid) || (hb && hb.childPid) || (entry && entry.childPid) || null;
  const childAlive = pidAlive(childPid);
  const done = !!(meta && meta.status) && !driverAlive;
  const running = !done && (driverAlive || childAlive);
  return {
    running, driverAlive, childAlive, childPid, spawnPending: false,
    meta, metaFile: file, hb, entry,
  };
}

/** 把后台状态折成与 codex_run 同形的有界结果（含 running / 进度 / 停滞提示）。 */
export function summarizeStatus(label, snap) {
  const run = {
    exitCode: snap.meta ? (snap.meta.exitCode ?? null) : null,
    aborted: false, stderrTail: '', droppedBytes: 0,
    meta: snap.meta, metaFile: snap.metaFile,
  };
  const budgetMs = (snap.meta && snap.meta.budgetMs) || 0;
  const s = summarize(label, run, {
    ctx: {
      hostElapsedMs: snap.hb ? Math.round((snap.hb.elapsedSec || 0) * 1000) : 0,
      budgetMs, childAlive: snap.childAlive, driverAlive: snap.running,
      hb: snap.hb,
    },
  });
  if (snap.running) { s.status = 'running'; s.termination = 'running'; }
  else if (snap.liveness && ['stale', 'orphan', 'unknown'].includes(snap.liveness)) {
    s.status = 'needs_attention'; s.termination = snap.liveness;
  }
  else if (!snap.record && !snap.meta && !snap.hb && !snap.entry) { s.status = 'not_found'; s.termination = 'not_found'; }
  s.thread_id ||= snap.record?.resumeThread || null;
  s.label = label;
  s.continuation_of = snap.record?.continuationOf || null;
  s.notify_on_complete = completionNoticeMode(snap.record || {});
  Object.assign(s, runFacts({ status:s.status, termination:s.termination, meta:snap.meta || {},
    threadId:s.thread_id, subagents:s.subagents, answer:snap.meta?.lastMessage || '',
    evidence:snap, userCancelled:snap.userCancelled }));
  s.health_issue = snap.healthIssue || null;
  s.pending_messages = snap.pendingMessages || 0;
  s.liveness = snap.liveness || null;
  s.running = snap.running;
  s.driver_alive = snap.driverAlive;
  s.child_alive = snap.childAlive;
  s.progress = snap.hb
    ? {
      seq: snap.hb.seq ?? null, elapsed_sec: snap.hb.elapsedSec ?? null, items: snap.hb.items ?? null,
      last_out_age_ms: snap.hb.lastOutAgeMs ?? null, thread_id: snap.hb.threadId || null,
      event: snap.hb.event || null,
    }
    : null;
  const starting = !!(snap.running && snap.spawnPending);
  const state = snap.running ? (starting ? 'starting(detached)' : 'running(detached)') : s.status;
  let next = handoffText(s.handoff, s.thread_id);
  if (starting && !snap.healthIssue) {
    next = '刚启动（driver 还没落盘，通常 1–5 秒）：**不要重复派发**，稍后用 codex_status(label=…, wait_ms=…) 取回即可。';
  }
  const head = '[codex] ' + label + ' ' + state + ' term=' + s.termination +
    ' elapsed=' + (s.elapsed_sec ?? 0) + 's' +
    (s.thread_id ? ' thread=' + s.thread_id : '') +
    (s.progress ? ' items=' + s.progress.items + ' hbSeq=' + s.progress.seq + ' lastOutAge=' + Math.round((s.progress.last_out_age_ms || 0) / 1000) + 's' : '') +
    ' budget=' + (budgetMs > 0 ? Math.round(budgetMs / 1000) + 's' : 'off');
  s.next_action = next;
  s.summary_text = head + '\n' + next + (s.answer ? '\n\n' + s.answer : '');
  return s;
}

/**
 * 终止分类（**交叉验证**，不靠单一信号）：把 meta + 心跳 + 宿主时长 + 进程存活
 * 放在一起判定"到底是谁结束了这一轮"。纯函数，便于离线测试。
 */
export function classifyTermination({ meta, aborted, hostElapsedMs, budgetMs, childAlive, driverAlive }) {
  const m = meta || null;
  if (aborted) return 'caller-aborted';
  if (!m) return driverAlive ? 'running' : 'no-evidence';
  if (m.status === 'quota-blocked') return 'quota-blocked';
  if (['waiting_quota','needs_attention','cancelled','interrupted'].includes(m.status)) return m.status;
  if (m.status === 'killed' && m.abortReason === 'channel-budget') return 'channel-budget';
  if (m.status === 'ok') return 'ok';
  if (m.status === 'failed') return 'failed';
  if (m.status === 'spawn-error') return 'spawn-error';
  if (['killed', 'killed-unknown', 'orphan', 'stale'].includes(m.status)) return m.status;
  if (m.status === 'aborted') {
    if (m.abortReason === 'channel-budget') return 'channel-budget';
    return 'aborted';
  }
  // 后台（detached）运行中：driver 仍活着，且还没有终版 meta。
  if (driverAlive) return 'running';
  // 没有终版 meta = driver 来不及写 → 外部强杀；再用另外几个源判定是哪一种。
  if (childAlive) return 'orphan';
  if (budgetMs > 0 && hostElapsedMs >= budgetMs - 15000) return 'channel-budget-unmanaged';
  return 'killed-unknown';
}

/**
 * 跑一次 Codex 任务。stdout 被丢弃（只保留 driver 那唯一一行结论，且不往模型面透传）。
 * @returns {{ exitCode:number|null, aborted:boolean, stderrTail:string, meta:object|null, metaFile:string|null }}
 */
export async function runDriver(opts, signal) {
  if (signal?.aborted) return { exitCode:null, aborted:true, stderrTail:'', droppedBytes:0, meta:{status:'aborted',abortReason:'caller-disconnected'} };
  const args = driverArgs(opts);
  const child = spawn(process.execPath, args, { cwd: opts.cwd,
    env: codexEnvironment(opts),
    stdio: opts.detach ? 'ignore' : ['ignore','pipe','pipe'], windowsHide: true, detached: !!opts.detach });
  let stderr = '', dropped = 0, aborted = false;
  const requestStop = (reason) => {
    if (opts.runId) atomicJson(path.join(opts.logDir, 'stop.json'), {
      runId:opts.runId, reason, requestedAt:new Date().toISOString() });
    else killTree(child);
  };
  const requestCancel = () => { aborted = true; requestStop('caller-disconnected'); };
  child.stdout?.on('data', c => { dropped += c.length; });
  child.stderr?.on('data', c => { stderr = (stderr + c.toString('utf8')).slice(-8192); });
  const closed = new Promise(resolve => {
    child.once('error', e => resolve({ error: e.message, exitCode: null }));
    child.once('close', code => resolve({ exitCode: code }));
  });
  const started = await new Promise(resolve => {
    child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false));
  });
  if (!started) { const result = await closed; return { ...result, aborted: false, stderrTail: result.error, droppedBytes: 0, meta: { status: 'spawn-error', ...failureSummary(result.error,'','spawn-error','spawn-error') }, metaFile: null }; }
  if (opts.detach) {
    closed.then(result => {
      const file = path.join(opts.logDir, 'result.meta.json');
      if (opts.runId && !readJson(file)?.status) {
        const previous = readJson(file) || {};
        try { atomicJson(file, {...previous, status:'failed', ...failureSummary(result.error || 'Driver exited without final metadata','','driver-exit','driver-exit'), exitCode:result.exitCode, end:new Date().toISOString()}); } catch {}
      }
    });
    child.unref(); return { detached: true, driverPid: child.pid, exitCode: null, aborted: false, stderrTail: '', droppedBytes: 0, meta: null, metaFile: null }; }
  child.stop = () => requestStop('host-shutdown'); child.cancel = requestCancel; opts.onSpawn?.(child);
  if (signal?.aborted) requestCancel(); else signal?.addEventListener('abort', requestCancel, { once: true });
  const result = await closed;
  signal?.removeEventListener('abort', requestCancel);
  opts.onClose?.(child);
  const file = opts.runId ? path.join(opts.logDir, 'result.meta.json') : readMeta(opts.logDir || path.join(opts.cwd, LOGS_REL), opts.label).file;
  const terminal=opts.runId ? readJson(path.join(opts.logDir,'terminal.json')) : null;
  if (file && !readJson(file)?.status && !terminal?.status) {
    atomicJson(file,{...(readJson(file)||{}),status:'failed',...failureSummary(result.error || 'Driver exited without final metadata',stderr,'driver-exit','driver-exit'),exitCode:result.exitCode,end:new Date().toISOString()});
  }
  return { ...result, aborted, stderrTail: stderr.slice(-400), droppedBytes: dropped, meta: terminal?.status ? terminal : file ? readJson(file) : null, metaFile: file };
}

export function summarize(label, run, { ctx = {} } = {}) {
  const m = run.meta || {};
  const hb = ctx.hb || null;
  const u = m.usage || {};
  const rl = m.rateLimits || {};
  const threadId = m.threadId || (hb && hb.threadId) || null;
  const term = classifyTermination({
    meta: run.meta, aborted: run.aborted, hostElapsedMs: ctx.hostElapsedMs || 0,
    budgetMs: ctx.budgetMs || 0, childAlive: !!ctx.childAlive,
    driverAlive: !!ctx.driverAlive,
  });
  const status = run.aborted ? 'aborted' : (m.status || (run.exitCode === 0 ? 'ok' : 'failed'));
  const answer = typeof m.lastMessage === 'string' ? m.lastMessage : '';
  // 两钟交叉：driver 自报 elapsed 与宿主实测时长偏差 >5s 记一条证据（不下结论）。
  const clockDivergence = !!(m.elapsedSec && ctx.hostElapsedMs &&
    Math.abs(m.elapsedSec * 1000 - ctx.hostElapsedMs) > 5000);

  const head = '[codex] ' + label + ' ' + status + ' term=' + term +
    ' exit=' + (run.exitCode === null ? 'signal' : run.exitCode) +
    ' ' + (m.elapsedSec ?? Math.round((ctx.hostElapsedMs || 0) / 1000)) + 's' +
    ' quota=' + (m.quotaBefore ?? '?') + '%->' + (m.quotaAfter ?? '?') + '%' +
    ' 7d=' + (rl.secondary ? rl.secondary.used_percent + '%' : '?') +
    ' in=' + (u.input_tokens ?? '?') + ' out=' + (u.output_tokens ?? '?') +
    ' thread=' + (threadId || 'none') +
    ' budget=' + (ctx.budgetMs > 0 ? Math.round(ctx.budgetMs / 1000) + 's' : 'off') +
    (m.killVerified === false ? ' killVerified=false' : '') +
    (clockDivergence ? ' clockDivergence=true' : '');

  const subagents = boundedSubagents(!m.status && hb?.subagents ? hb.subagents : m.subagents);
  const facts = runFacts({status, termination:term, meta:m, threadId, subagents, answer,
    evidence:ctx, userCancelled:ctx.userCancelled});
  const next = handoffText(facts.handoff, threadId);

  return {
    status,
    termination: term,
    label,
    ...facts,
    exit_code: run.exitCode,
    elapsed_sec: m.elapsedSec ?? Math.round((ctx.hostElapsedMs || 0) / 1000),
    model: m.model ?? null,
    channel: m.channel || (hb && hb.channel) || null,
    budget_ms: ctx.budgetMs ?? null,
    budget_source: m.budgetSource ?? null,
    subagents,
    quota: m.quota || null,
    quota_5h_before: m.quotaBefore ?? null,
    quota_5h_after: m.quotaAfter ?? null,
    quota_remaining: m.quota?.remaining ?? null,
    quota_warning: m.warning ?? null,
    quota_7d: rl.secondary ? rl.secondary.used_percent : null,
    resets_at_5h: rl.primary ? rl.primary.resets_at : null,
    resets_at_7d: rl.secondary ? rl.secondary.resets_at : null,
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    thread_id: threadId,
    kill_verified: m.killVerified ?? null,
    abort_reason: m.abortReason ?? null,
    heartbeat: hb ? { seq: hb.seq ?? null, ts: hb.ts ?? null, lastOutAgeMs: hb.lastOutAgeMs ?? null, childAlive: hb.childAlive ?? null } : null,
    quota_pause: m.quota ? { state:m.quota.state, resume_at:m.quota.resumeAt ? new Date(m.quota.resumeAt).toISOString() : null, outcome:m.pauseOutcome||null } : null,
    clock_divergence: clockDivergence,
    orphan_reaped: !!ctx.orphanReaped,
    meta_file: run.metaFile ? path.basename(run.metaFile) : null,
    dropped_stdout_bytes: run.droppedBytes,
    error: m.error ?? null,
    answer,
    next_action: next,
    summary_text: head + '\n' + next + (answer ? '\n\n' + answer : ''),
  };
}

/** 供 `lib/index.js` 与测试共用的工具定义构造器（defineTool 由外部注入）。 */
export function buildToolDefinition({ defineTool, resolveCwd, config = {}, onSpawn, onClose, quotaCoordinator, quotaView = null, catalog = getCatalog, onRunReserved }) {
  return defineTool(withTaskReturn({
    name: 'codex_run',
    description:
      'Run ONE Codex task with the configured exec or App Server backend. SYNC mode (default) waits for the ' +
      'result and returns the complete final answer, with no time limit by default. A positive driver budget stops the ' +
      'owned process tree at the limit, verifies process exit and writes final metadata. ' +
      'DETACHED mode (detach=true): the driver is spawned detached and the call returns IMMEDIATELY — the Codex ' +
      'task uses the same budget as sync mode, unlimited by default; retrieve it with codex_status(run_id=…). ' +
      'Use detach=true when DSH should continue without waiting for the result. ' +
      'Termination is cross-validated (meta + heartbeat + host elapsed + pid liveness) and reported as termination=; resume a thread with resume_thread=<thread_id>. ' +
      'App Server supports codex_say action=steer|interrupt. In evidence selection mode provide structured evidence; unknown scope recommends investigation without rewriting the task. ' +
      'A finished turn does not mean the user task is complete. Follow handoff: verify and continue unfinished work within the original authorization. Use codex_read only for missing evidence. ' +
      'If quota is blocked or waiting_quota, preserve the thread and inspect recovery status; never dispatch repeated attempts while blocked.',
    parameters: {
      prompt_file: { type: 'string', required: true, description: '任务提示词文件（绝对路径或相对会话工作目录）' },
      label: { type: 'string', required: true, description: '任务标签，用于日志与 meta 文件名' },
      detach: { type: 'boolean', description: 'true=后台运行，立刻返回 run id，让 DSH 无需等待；用 codex_status 取回结论。与同步运行共用 defaultBudgetMs（默认 0），可用 budget_ms 覆盖。' },
      model: { type: 'string', description: '模型 ID，见 codex_models 动态目录' },
      effort: { type: 'string', description: '该模型支持的 reasoning effort，见 codex_models；超过自治上限需 unlock_effort=true' },
      task_kind: { type: 'string', description: '机制化选档（推荐）：mechanical|docs=low+luna · review=medium+sol · implement=high+sol · architect|rework=xhigh+astra。只填你省略的 model/effort；显式传的仍优先。规则表见 core.js 的 TASK_KINDS' },
      unlock_effort: { type: 'boolean', description: '放行超过自治上限的强度（max/ultra）——混合制要求显式留痕；只在用户明确放行时使用' },
      evidence: { type: 'object', description: 'Evidence mode: files[], plan_file, acceptance, uncertainty(low|medium|high|unknown), interface_change, architecture_decision, concurrency_risk, security_risk, failure_reason(none|environment|test|design)', additionalProperties: true },
      override_reason: { type: 'string', description: 'Reason for an explicit model/effort override when enhanced selection policy is enforced; optional when off or audit-only' },
      downgrade_reason: {type:'string',description:'Policy category: quota | scope-reduced | already-reviewed | time'},
      budget_ms: { type: 'number', description: 'driver 预算（毫秒）：>0 到点主动收尾；0=不限；省略时同步与后台统一使用 defaultBudgetMs（默认 0）' },
      resume_thread: { type: 'string', description: '续跑上一批返回的 Codex 线程（thread_id）' },
      continuation_of: { type: 'string', description: '上一轮 run_id，仅用于审计，不触发自动续跑' },
      notify_on_complete: { type: 'string', enum: ['off', 'decision', 'always'], description: '完成提醒：detach 默认 decision，同步默认 off；不影响异常提醒' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.summary_text }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'Run Codex', kind: 'execute', rawInput: String(args.label) }),

    async execute(args, exec) {
      const cwd = resolveCwd(exec);
      if (!cwd) {
        return { summary_text: '[codex] error: 无法确定会话工作目录（fail closed，不用宿主 cwd）', status: 'error' };
      }
      if (!validateLabel(args.label)) return { status: 'error', summary_text: '[codex] error: invalid label (1-80 letters/digits/underscore/hyphen)' };
      // 每次调用读取 profile 当前值，不受工作区里的其他配置文件影响。
      const eff = loadEffectiveSettings({ config });
      const S = eff.settings;
      if(S.quotaWarning === true && S.backend !== 'app-server')return {status:'error',summary_text:'Quota reminders require App Server.'};
      const recoveryEnabled = S.autoResumeAfterQuota === true;
      if (recoveryEnabled && (S.backend !== 'app-server' || !quotaCoordinator?.available(exec))) return { status: 'error', summary_text: 'Quota recovery requires App Server, DSH Schedule and an original DSH session.' };
      if (eff.settingsErrors.length) return {status:'error',summary_text:eff.settingsErrors.join('; ')};
      const catalogView = await catalog({settings:S});
      const registry = catalogView.configuration || DEFAULT_FIELD_REGISTRY;
      for (const [key,value] of Object.entries(S)) { const v = validateSetting(key,value,registry); if (!v.ok) return { status:'error', summary_text:'[codex] error: '+v.problem }; }
      const defaultModel = ALLOWED_MODELS.includes(S.defaultModel) ? S.defaultModel : 'gpt-6.1-sol';
      const defaultEffort = ALLOWED_EFFORTS.includes(S.defaultEffort) ? S.defaultEffort : 'high';
      const defaultDriver = S.driverPath || null;
      const maxEffortAllowed = ALLOWED_EFFORTS.includes(S.maxEffortAllowed) ? S.maxEffortAllowed : 'xhigh';
      const quotaWarning = S.quotaWarning === true;
      const quotaWarningThreshold = Number.isInteger(Number(S.quotaWarningThreshold)) ? Number(S.quotaWarningThreshold) : 5;
      // ---- 机制化选档：task_kind（规则表）→ model/effort；显式参数优先 ----
      const taskKind = (args.task_kind === undefined || args.task_kind === null || args.task_kind === '')
        ? null : String(args.task_kind);
      if (taskKind && !TASK_KINDS[taskKind]) {
        return {
          summary_text: '[codex] error: task_kind="' + taskKind + '" 不在规则表 ' + TASK_KIND_NAMES.join('|') +
            '（机械/文档=low+luna，复核=medium+sol，实现=high+sol，架构/返工=xhigh+astra）',
          status: 'error',
        };
      }
      const rule = taskKind ? TASK_KINDS[taskKind] : null;
      let selectionEvidence = null;
      if (S.selectionMode === 'manual' && (!args.model || !args.effort)) return {status:'error',summary_text:'Manual mode requires model and effort'};
      if (S.selectionMode === 'evidence') {
        try {
          selectionEvidence = selectWithEvidence(cwd, args.evidence, taskKind);
        } catch(error) { return {status:'error',summary_text:error.message}; }
      }
      // 两个"自主判断"开关的可执行语义：关掉 → 必须**显式**给值（显式 model/effort 或 task_kind 都算显式），否则拒绝。
      if (S.autoModelAndEffort === false && !args.model && !rule && !selectionEvidence) {
        return { summary_text: '[codex] error: 策略 autoModelAndEffort=false（来源 ' + eff.source + '）：必须显式传 model 或 task_kind', status: 'error' };
      }
      if (S.autoModelAndEffort === false && !args.effort && !rule && !selectionEvidence) {
        return { summary_text: '[codex] error: 策略 autoModelAndEffort=false（来源 ' + eff.source + '）：必须显式传 effort 或 task_kind', status: 'error' };
      }
      const cfgPairs = codexConfigPairs(S.codexConfig, S.extraCodexConfig,registry);
      if (cfgPairs.problems.length) {
        return { summary_text: '[codex] error: codexConfig 非法：' + cfgPairs.problems.join('; '), status: 'error' };
      }
      // 一等设置 → Codex 配置对（service_tier / approval_policy / 沙箱内网络）
      const derived = derivedCodexPairs(S,registry);
      if (derived.problems.length) {
        return { summary_text: '[codex] error: 设置非法：' + derived.problems.join('; '), status: 'error' };
      }
      const sandboxMode = S.sandboxMode;
      const allPairs = cfgPairs.pairs.concat(derived.pairs);

      const sel = resolveSelection({
        taskKind, model: args.model, effort: args.effort, defaultModel, defaultEffort,
      });
      let model = args.model || selectionEvidence?.model || sel.model;
      let effort = args.effort || selectionEvidence?.effort || sel.effort;
      // 如实回报"档位是谁定的"：explicit（调用方）/ task_kind（规则表）/ default（默认值）
      const modelSource = selectionEvidence && !args.model ? 'evidence' : sel.modelSource;
      const effortSource = selectionEvidence && !args.effort ? 'evidence' : sel.effortSource;
      if (!catalogView.models.some(m=>m.id===model)) {
        return { summary_text: '[codex] error: model 不在白名单 ' + ALLOWED_MODELS.join('|'), status: 'error' };
      }
      const catalogError=validateCatalogSelection(catalogView,model,effort,S.serviceTier);
      if(catalogError)return {status:'error',summary_text:catalogError};
      if(rule) {const ruleError=validateCatalogSelection(catalogView,rule.model,rule.effort);if(ruleError)return {status:'error',summary_text:'TASK_KINDS catalog mismatch: '+ruleError};}
      if (!ALLOWED_EFFORTS.includes(effort)) {
        return { summary_text: '[codex] error: effort 不在白名单 ' + ALLOWED_EFFORTS.join('|'), status: 'error' };
      }
      const policyDecision=evaluateSelection({policy:S.selectionPolicy,taskKind,
        recommended:selectionEvidence || rule || {model:defaultModel,effort:defaultEffort},actual:{model,effort},
        explicitModel:!!args.model,explicitEffort:!!args.effort,overrideReason:args.override_reason,downgradeReason:args.downgrade_reason,
        claims:selectionEvidence?.caller_claims || args.evidence || {},stage:selectionEvidence?.stage});
      const selectionAudit={...selectionEvidence,...policyDecision.selection};
      const selectionFields={selection_policy:{version:selectionAudit.policy_version,mode:selectionAudit.policy_mode},
        recommended_model:selectionAudit.recommended_model,recommended_effort:selectionAudit.recommended_effort,
        downgrade:selectionAudit.downgrade,downgrade_reason:selectionAudit.downgrade_reason};
      if(policyDecision.status!=='ok')return {...selectionFields,status:policyDecision.status,summary_text:policyDecision.error};
      model=policyDecision.model;effort=policyDecision.effort;
      const finalSelectionError=validateCatalogSelection(catalogView,model,effort,S.serviceTier);
      if(finalSelectionError)return {status:'error',summary_text:finalSelectionError};
      // Policy quota gate: the UI may save deny/pause/reduce-scope; the
      // dispatch path must honor it before reserving or spawning a run.
      const quotaPolicy=S.selectionPolicy?.quota;
      if(S.selectionPolicy.mode==='enforce' && quotaPolicy && quotaPolicy.action!=='allow-downgrade' && quotaView?.get) {
        let quotaAtDispatch=null;
        try { quotaAtDispatch=await quotaView.get({probe:'active',settings:S,logs:path.join(cwd,LOGS_REL)}); } catch {}
        if(quotaAtDispatch?.status==='ok') {
          const remaining=Object.values(quotaAtDispatch.windows||{}).filter(Boolean)
            .map(w=>w.remaining_percent).filter(n=>Number.isFinite(n));
          const left=remaining.length?Math.min(...remaining):null;
          if(left!==null && left<=quotaPolicy.below_percent) {
            return {
              status:'error',
              summary_text:'[codex] error: selectionPolicy.quota.action='+quotaPolicy.action+
                ' 且当前剩余 '+left+'% ≤ 阈值 '+quotaPolicy.below_percent+'%；本次未启动 Codex。'+
                (quotaPolicy.action==='reduce-scope'?'请显式缩小任务范围或等待额度恢复。':'请等待额度恢复或调整策略。'),
            };
          }
        }
      }
      // 混合制：默认档位由 harness 依规则自判，但不得越过自治上限；更高强度必须显式放行（留痕）。
      const effortUnlocked = !!args.unlock_effort;
      if (EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(maxEffortAllowed) && !effortUnlocked) {
        return {
          summary_text: '[codex] error: effort=' + effort + ' 超过自治上限 ' + maxEffortAllowed +
            '（混合制：高强度需显式放行）。降到 ≤' + maxEffortAllowed + '，或传 unlock_effort=true 并在汇报里写明理由。',
          status: 'error',
        };
      }
      const detach = !!args.detach;
      const notifyOnComplete = args.notify_on_complete ?? (detach ? 'decision' : 'off');
      if (!['off', 'decision', 'always'].includes(notifyOnComplete)) return {status:'error',summary_text:'Invalid notify_on_complete'};
      if (args.continuation_of !== undefined && !validRunId(args.continuation_of)) return {status:'error',summary_text:'Invalid continuation_of'};
      const logDir = path.join(cwd, LOGS_REL);
      try { assertStorePath(logDir); } catch(error) { return {status:'error',summary_text:error.message}; }
      // 同步与后台共用默认预算，单次显式 budget_ms 优先。
      const budgetMs = args.budget_ms === undefined ? S.defaultBudgetMs : args.budget_ms;
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > 2147483647) {
        return { summary_text: '[codex] error: budget_ms 非法 ' + args.budget_ms, status: 'error' };
      }
      const resumeThread = args.resume_thread ? String(args.resume_thread) : null;
      let promptFile = path.isAbsolute(args.prompt_file)
        ? args.prompt_file
        : path.join(cwd, args.prompt_file);
      if (!fs.existsSync(promptFile)) {
        return { summary_text: '[codex] error: 提示词文件不存在 ' + promptFile, status: 'error' };
      }
      if (S.backend === 'app-server' && defaultDriver) return { status: 'error', summary_text: 'App Server backend requires the bundled driver; clear driverPath.' };
      const driverPath = S.backend === 'app-server'
        ? fileURLToPath(new URL('../drivers/drive-app-server.mjs', import.meta.url))
        : path.resolve(cwd, resolveDriverPath({ configured: defaultDriver, cwd }));
      if (!fs.existsSync(driverPath)) {
        return { summary_text: '[codex] error: driver 不存在 ' + driverPath, status: 'error' };
      }
      if (detach) {
        // 同一 label 已有后台任务在跑 → 拒绝重复派发（否则白交一次启动税 + 双倍烧额度 + 日志互相覆盖）。
        const live = readRunState(logDir, args.label);
        if (live.running) {
          const who = (live.entry && live.entry.driverPid)
            ? 'driver pid ' + live.entry.driverPid
            : '启动中';
          return {
            summary_text: '[codex] error: label=' + args.label + ' 已在跑（' + who +
              '）；先用 codex_status(label="' + args.label + '") 取回，或换一个 label。',
            status: 'error',
          };
        }
      }

      let record;
      try { cleanupRuns(logDir, S.retentionDays, S.retentionMaxRuns); record = reserveRun(logDir, args.label, S.maxConcurrent, { resumeThread }); }
      catch (e) { return { status: 'error', summary_text: '[codex] error: ' + e.message }; }
      let executionDir;
      try {
        executionDir = runDirectory(logDir, record);
        const trackedRecord=updateRecord(logDir, record, {backend:S.backend,cwd,detached:detach,sessionId:exec?.agent?.session?.id||null,
          notifyOnComplete, continuationOf:args.continuation_of || null, resumeThread, debugLogs:S.debugLogs, debugMaxBytes:S.debugMaxBytes,
          ...(args.recovery_parent?{recoveryParent:args.recovery_parent}:{})});
        try {onRunReserved?.({cwd,record:trackedRecord,args,exec,detach});}
        catch(error){atomicJson(path.join(executionDir,'tracking-error.json'),{runId:record.runId,error:error.message});}
        atomicJson(path.join(executionDir,'selection.json'),selectionAudit);
        if (recoveryEnabled) {
          try { await quotaCoordinator.track({ cwd, record, exec, settings: S, args: {...args,prompt_file:promptFile}, model, effort }); }
          catch (error) { throw new Error('Recovery registration failed: ' + error.message); }
        }
      } catch (error) {
        // No child exists yet. Try independent targets so a persistent failure
        // of one preparation file cannot leave a live-owner reservation forever.
        const terminal = { runId: record.runId, status: 'spawn-error', ...failureSummary(error,'','spawn-error'), end: new Date().toISOString() };
        const cleanupErrors = [];
        try { updateRecord(logDir, record, { state: 'spawn-error' }); } catch (e) { cleanupErrors.push(e.message); }
        for (const [name, value] of [['result.meta.json',terminal], ['terminal.json', terminal], ['released.json', { runId: record.runId, reason: 'preparation-failed' }]]) {
          try { atomicJson(path.join(runDirectory(logDir, record), name), value); } catch (e) { cleanupErrors.push(e.message); }
        }
        return { status: 'error', run_id: record.runId, termination: 'spawn-error',
          label:args.label, thread_id:resumeThread, continuation_of:args.continuation_of || null,
          ...runFacts({status:'spawn-error',threadId:resumeThread}),
          summary_text: '[codex] error: ' + error.message, ...(cleanupErrors.length ? { cleanup_errors: cleanupErrors } : {}) };
      }
      const spawnedAt = Date.now();
      const run = await runDriver({
        codexExecutable: S.codexExecutable, codexHome: S.codexHome,
        driverPath, promptFile, label: args.label, cwd, model, effort,
        autoResumeAfterQuota: S.autoResumeAfterQuota, quotaWarning, quotaWarningThreshold, pauseGraceMs: S.pauseGraceMs,
        budgetMs, resumeThread, detach, setPairs: allPairs, sandbox: sandboxMode, logDir: executionDir, runId: record.runId, debugLogs:S.debugLogs, debugMaxBytes:S.debugMaxBytes,
        onSpawn, onClose,
      }, detach ? undefined : exec.signal);

      if (run.meta?.status === 'spawn-error' || run.meta?.abortReason === 'caller-disconnected') {
        atomicJson(path.join(executionDir, 'result.meta.json'), run.meta);
        updateRecord(logDir, record, { state: run.meta.status });
      }
      if (run.detached) {
        updateRecord(logDir, record, { state: 'running', driverPid: run.driverPid });

        const next = '后台已启动，run_id=' + record.runId + '；用 codex_cancel(run_id=…) 可取消。用 ' +
          'codex_status(label="' + args.label + '", wait_ms=540000) 取回结论；**不要重复派发同一批**。';
        return {
          ...selectionFields, status: 'running', termination: 'running', detached: true, label: args.label, run_id: record.runId,
          driver_pid: run.driverPid, budget_ms: budgetMs, thread_id:resumeThread,
          continuation_of:args.continuation_of || null, notify_on_complete:notifyOnComplete,
          ...runFacts({status:'running',threadId:resumeThread}),
          subagents:boundedSubagents(null), answer:'', quota:null,
          model, effort, effort_cap: maxEffortAllowed, effort_unlocked: effortUnlocked,
          task_kind: taskKind, model_source: modelSource, effort_source: effortSource,
          selection_evidence: selectionEvidence,
          settings_source: eff.source,
          auto_model_and_effort: S.autoModelAndEffort !== false,
          quota_warning: quotaWarning, quota_warning_threshold: quotaWarningThreshold,
          sandbox_mode: sandboxMode, service_tier: S.serviceTier || 'off',
          full_access: sandboxMode === 'danger-full-access',
          codex_config_applied: allPairs.map(([k, v]) => k + '=' + v),
          next_action: next,
          summary_text: '[codex] ' + args.label + ' running(detached) driver_pid=' + run.driverPid +
            ' budget=' + (budgetMs > 0 ? Math.round(budgetMs / 1000) + 's' : 'off') +
            ' model=' + model + ' effort=' + effort + '\n' + next,
        };
      }

      const hostElapsedMs = Date.now() - spawnedAt;
      // ---- 交叉验证的其余源：心跳、pid 存活（必要时兜底收尸）----
      const hb = readHeartbeat(logDir, record.runId);
      let childAlive = pidAlive(run.meta && run.meta.childPid);
      let orphanReaped = false;
      // Do not kill a persisted PID: it may have been reused. Driver owns process termination.


      const out = summarize(args.label, run, {
        ctx: { hostElapsedMs, budgetMs, childAlive, hb, orphanReaped },
      });
      Object.assign(out,selectionFields);
      out.run_id = record.runId;
      out.reply_signals = run.meta?.replySignals || [];
      out.continuation_of = args.continuation_of || null;
      out.notify_on_complete = notifyOnComplete;
      const finalEvidence = runEvidence(logDir, record);
      out.pending_messages = finalEvidence.pendingMessages;
      Object.assign(out, runFacts({status:out.status, termination:out.termination, meta:run.meta || {},
        threadId:out.thread_id, subagents:out.subagents, answer:run.meta?.lastMessage || '',
        evidence:finalEvidence, userCancelled:finalEvidence.userCancelled}));
      out.next_action = handoffText(out.handoff, out.thread_id);
      out.summary_text = out.summary_text.split('\n')[0] + '\n' + out.next_action +
        (out.error ? '\nerror: ' + out.error : '') + (out.answer ? '\n\n' + out.answer : '');
      out.model = out.model || model;
      out.effort = effort;
      out.effort_cap = maxEffortAllowed;
      out.effort_unlocked = effortUnlocked;
      out.task_kind = taskKind;
      out.model_source = modelSource;
      out.effort_source = effortSource;
      out.selection_evidence = selectionEvidence;
      out.settings_source = eff.source;
      out.auto_model_and_effort = S.autoModelAndEffort !== false;
      out.quota_warning = quotaWarning;
      out.quota_warning_threshold = quotaWarningThreshold;
      out.sandbox_mode = sandboxMode;
      out.service_tier = S.serviceTier || 'off';
      out.full_access = sandboxMode === 'danger-full-access';
      out.codex_config_applied = allPairs.map(([k, v]) => k + '=' + v);
      // 高风险/高消耗设置必须在返回值里**显眼**标出（静默传递不等于静默风险）
      const marks = [];
      if (taskKind) marks.push('kind=' + taskKind + '(' + modelSource + '/' + effortSource + ')');
      if (quotaWarning) marks.push('quota-warn=' + quotaWarningThreshold + '%');
      if (sandboxMode === 'danger-full-access') marks.push('sandbox=FULL-ACCESS');
      if (String(S.serviceTier || 'off') === 'fast') marks.push('tier=fast(用量↑)');
      if (S.workspaceNetworkAccess === true) marks.push('sandbox-net=on');
      if (marks.length) out.summary_text = '[' + marks.join(' ') + '] ' + out.summary_text;
      return out;
    },
  }, resolveCwd, LOGS_REL));
}

/**
 * `codex_status` —— 取回 detach 启动的后台任务：先给心跳进度，跑完给有界结论。
 * `wait_ms` 只是"等待"，不打断后台任务；所以单次等待即使被宿主上限截断，也不会影响 Codex 干活。
 */
export function buildStatusToolDefinition({ defineTool, resolveCwd, config = {}, quotaCoordinator }) {

  return defineTool({
    name: 'codex_status',
    description:
      'Read a background (detach=true) codex_run: heartbeat progress while it runs, and the bounded result ' +
      '(same shape as codex_run, with cross-validated termination=) once it finishes. wait_ms blocks up to N ms ' +
      'and is only a wait — it never interrupts the Codex task, so keep N safely below the host response time limit ' +
      '(e.g. 540000). Returns code-classified handoff, the complete final answer and errors in one call; only use codex_read for missing evidence. ' +
      'DSH should advance unfinished authorized work after review; never duplicate active work or quota recovery.',
    parameters: {
      label: { type: 'string', description: '任务标签（最新一次）' },
      run_id: { type: 'string', description: '准确的运行 ID；优先于 label' },
      wait_ms: { type: 'number', description: '可选：最多阻塞等待多少毫秒（建议 ≤540000）；0/省略=立刻返回当前状态' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.summary_text }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'Codex status', kind: 'read', rawInput: String(args.label) }),

    async execute(args, exec) {
      const cwd = resolveCwd(exec);
      if (!cwd) {
        return { summary_text: '[codex] error: 无法确定会话工作目录（fail closed）', status: 'error' };
      }
      const selector = args.run_id || args.label;
      if (!(validRunId(selector) || validateLabel(selector))) {
        return { summary_text: '[codex] error: label 必填', status: 'error' };
      }
      const logDir = path.join(cwd, LOGS_REL);
      const effective = loadEffectiveSettings({ config });
      const problem = settingsProblem(effective);
      if (problem) return { status: 'error', summary_text: problem };
      const settings = effective.settings;
      const waitMs = Math.min(540000, Math.max(0, Number(args.wait_ms) || 0));
      const deadline = Date.now() + waitMs;
      for (;;) {
        const snap = readRunState(logDir, selector);
        if (!snap.running || Date.now() >= deadline || exec.signal?.aborted) {
          const result={ ...summarizeStatus(snap.record?.label || selector, snap), run_id: snap.record?.runId || null };
          const quotaSnapshot=quotaFromMeta(snap.meta)||quotaFromMeta(snap.hb);
          result.quota_source=quotaSnapshot?.source||null;
          result.quota_sampled_at=quotaSnapshot?.sampledAt?new Date(quotaSnapshot.sampledAt).toISOString():null;
          if(result.quota_remaining===null && quotaSnapshot)result.quota_remaining=Math.min(...Object.values(quotaSnapshot.windows).filter(Boolean).map(window=>window.remaining_percent));
          result.quota_warning ||= {enabled:settings.quotaWarning===true,threshold:settings.quotaWarningThreshold,triggered:settings.quotaWarning===true&&result.quota_remaining!==null&&result.quota_remaining<=settings.quotaWarningThreshold};
          try { result.recovery=await quotaCoordinator?.state(cwd,result.run_id)||snap.recovery||null; }
          catch(error){result.recovery={phase:'needs_attention',error:error.message};}
          Object.assign(result, runFacts({status:result.status, termination:result.termination, meta:snap.meta || {},
            threadId:result.thread_id, subagents:result.subagents, answer:snap.meta?.lastMessage || '',
            evidence:snap, userCancelled:snap.userCancelled, recovery:result.recovery}));
          result.next_action = handoffText(result.handoff, result.thread_id);
          result.summary_text = result.summary_text.split('\n')[0] + '\n' + result.next_action +
            (result.error ? '\nerror: ' + result.error : '') + (result.answer ? '\n\n' + result.answer : '');
          if(result.recovery)result.summary_text+='\nquota recovery: '+JSON.stringify(result.recovery);
          if(snap.record) {
            const dir=runDirectory(logDir,snap.record), noticeError=readJson(path.join(dir,'notify-error.json')),
              receipt=readJson(path.join(dir,'notified.json'));
            result.notification={delivery:noticeError?'needs_attention':receipt?'submitted':snap.record.detached?'pending':'tool_result',
              code:noticeError?.code || null};
            if(noticeError)result.summary_text+='\nnotification: '+noticeError.code+'（通知提交情况不明；当前查询已取回任务状态，按 handoff 处理）';
          }
          return result;
        }
        await sleep(Math.min(3000, Math.max(500, deadline - Date.now())));
      }
    },
  });
}

/** Inspect the same profile configuration used by the settings page; never persist changes. */
export function buildConfigToolDefinition({ defineTool, config = {} }) {
  return defineTool({
    name: 'codex_config',
    description: 'Read current dsh-codex-runner settings, field sources and allowed configuration keys. '
      + 'Saved settings come only from the DSH plugin profile, with code defaults for unset fields. '
      + 'This tool is read-only and takes no arguments. Change saved settings in the plugin settings page '
      + 'or its full JSON editor; supported per-task parameters affect only that invocation.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.summary_text }] },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Codex settings', kind: 'execute' }),
    async execute(args = {}) {
      if (Object.keys(args).length) return { status: 'error', summary_text: 'codex_config is read-only and takes no arguments. Change saved settings in the plugin settings page or its JSON editor.' };
      const e = loadEffectiveSettings({ config });
      const registry = await getFieldRegistry({ settings: e.settings });
      const lines = [
        '[codex_config] 只读配置查询；持久化修改请使用插件设置页或完整配置 JSON 编辑器。',
        '  生效来源=' + e.source,
        '  字段来源=' + JSON.stringify(e.fieldSources),
        '  defaultModel=' + e.settings.defaultModel + '   autoModelAndEffort=' + e.settings.autoModelAndEffort,
        '  defaultEffort=' + e.settings.defaultEffort,
        '  maxEffortAllowed=' + e.settings.maxEffortAllowed + '   defaultBudgetMs=' + e.settings.defaultBudgetMs,
        '  quotaWarning=' + e.settings.quotaWarning + '   quotaWarningThreshold=' + e.settings.quotaWarningThreshold + '%',
        '  codexConfig=' + JSON.stringify(e.settings.codexConfig || {}),
        '  extraCodexConfig=' + JSON.stringify(e.settings.extraCodexConfig || []),
        '  可用 settings 键：' + Object.keys(SETTINGS_SPEC).join(', '),
        '  可用 codexConfig 键：' + Object.keys(registry.config).join(', '),
      ];
      const dropped = [];
      const payload = sanitizeJson({
        status: 'ok', settings_source: e.source, settings: e.settings, field_sources: e.fieldSources,
        settings_errors: e.settingsErrors, allowed_settings_keys: Object.keys(SETTINGS_SPEC),
        allowed_codex_config_keys: Object.keys(registry.config), config_shapes: e.configShapes,
        summary_text: lines.join('\n'),
      }, '', dropped);
      if (dropped.length) {
        payload.sanitized_paths = dropped;
        payload.summary_text += '\n  ⚠️ 已清理非无损 JSON 值 ' + dropped.length + ' 处：' + dropped.slice(0, 6).join(', ');
      }
      return payload;
    },
  });
}

/**
 * `codex_say` —— 给**已存在的 Codex 线程**追加一条指令（"插话"）。
 * 实现：解析线程 id（显式 `thread` 优先，否则用 `label` 的最新 meta/心跳）→ 调 driver 的
 * `--queue <thread> --message <text>` → 转发给 `codex queue`。
 *
 * 语义（**不夸大**）：`queue` 是把消息**排进该线程**，对正在跑的 exec 会在**当前回合结束后**
 * 作为同线程的下一回合被消费——是"追加/转向"，**不是**打断当前工具调用。本工具自身不发起模型调用。
 */
export function buildSayToolDefinition({ defineTool, resolveCwd, config = {} }) {
  return defineTool({
    name: 'codex_say',
    description:
      'Control an existing Codex run. action=queue (default) persists an instruction for its next turn; ' +
      'action=steer sends it to the active App Server turn; action=interrupt requests interruption without a message. ' +
      'Steer/interrupt require an active App Server run_id or label, not an explicit thread override. ' +
      'Acceptance is not completion: inspect codex_status afterward. The exec compatibility backend supports only queue.',
    parameters: {
      message: { type: 'string', description: '要追加给该线程的指令文本；queue/steer 必填' },
      label: { type: 'string', description: '用哪个 label 的运行记录解析线程（与 thread 二选一）' },
      thread: { type: 'string', description: '直接指定线程 id（优先于 label）' },
      run_id: { type: 'string', description: '准确的运行 ID' },
      action: { type: 'string', description: 'queue（默认，下一轮追加）|steer（活动轮转向）|interrupt（中断）；steer/interrupt 需要 app-server 运行 ID' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.summary_text }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'Codex say', kind: 'execute', rawInput: String(args.label || args.thread || '') }),

    async execute(args, exec) {
      const cwd = resolveCwd(exec);
      if (!cwd) return { summary_text: '[codex] error: 无法确定会话工作目录（fail closed）', status: 'error' };
      const msg = args.message ? String(args.message) : '';
      const action = args.action || 'queue';
      if (!['queue', 'steer', 'interrupt'].includes(action)) return { status: 'error', summary_text: 'Invalid action' };
      if (!msg && action !== 'interrupt') return { summary_text: '[codex] error: message 必填', status: 'error' };

      const eff = loadEffectiveSettings({ config });
      const S = eff.settings;
      const problem = settingsProblem(eff);
      if (problem) return { status: 'error', summary_text: problem };
      const logDir = path.join(cwd, LOGS_REL);

      // 先解析线程：调用方最常见的错误是"label 写错/没跑过"，这个错误比"driver 不存在"更该先报。
      let thread = args.thread ? String(args.thread) : null;
      const label = args.run_id || (args.label ? String(args.label) : null);
      if (label && !(validRunId(label) || validateLabel(label))) return {status:'error',summary_text:'Invalid run selector'};
      const record = label ? recordFor(logDir, label) : null;
      if (record?.backend === 'app-server' || action !== 'queue') {
        if (!record || args.thread) return { status: 'error', summary_text: 'Managed controls require a run_id or label, without thread override' };
        try {
          const result = await sendControl(runDirectory(logDir, record), record, action, msg, { signal: exec.signal });
          return { status: 'ok', ...result, summary_text: '[codex_say] ' + action + ': ' + result.delivery };
        } catch (error) { return { status: 'error', summary_text: '[codex_say] ' + error.message }; }
      }
      if (!thread && label) {
        const { meta } = readMeta(logDir, label);
        thread = (meta && meta.threadId) || null;
        if (!thread) {
          const hb = readHeartbeat(logDir, label);
          thread = (hb && hb.threadId) || null;
        }
      }
      if (!thread) {
        return {
          summary_text: '[codex] error: 解析不到线程 id（给一个跑过的 label，或直接传 thread）',
          status: 'error',
        };
      }

      const driverPath = path.resolve(cwd, resolveDriverPath({ configured: S.driverPath || null, cwd }));
      if (!fs.existsSync(driverPath)) {
        return { summary_text: '[codex] error: driver 不存在 ' + driverPath, status: 'error' };
      }

      const snap = label ? readRunState(logDir, label, null) : { running: false };
      try {
        const out = await new Promise((resolve, reject) => execFile(process.execPath, [driverPath, '--queue', thread, '--message', msg], {
          env: codexEnvironment(S),
          encoding: 'utf8', cwd, windowsHide: true, timeout: 90000, maxBuffer: 65536, signal: exec.signal,
        }, (error, stdout) => error ? reject(error) : resolve(stdout)));
        const line = String(out || '').trim();
        return {
          status: 'ok', action: 'queue', thread_id: thread, label,
          running: !!snap.running,
          summary_text: '[codex_say] ' + line +
            (snap.running
              ? '\n该线程当前**在跑**：这条消息会在**当前回合结束后**作为同线程的下一回合被消费（不是打断）。'
              : '\n该线程当前**不在跑**：消息已排队，续跑/恢复该线程时会被消费。'),
        };
      } catch (e) {
        const detail = (e && (e.stderr || e.stdout))
          ? String(e.stderr || e.stdout).trim()
          : (e && e.message ? e.message : String(e));
        return { summary_text: '[codex] error: queue 失败：' + detail, status: 'error' };
      }
    },
  });
}
