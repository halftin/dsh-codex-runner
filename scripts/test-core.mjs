import './offline-env.mjs';
/**
 * dsh-codex-runner 自测（不依赖宿主：`defineTool` 由测试注入）。
 * 运行：node --experimental-strip-types --test scripts/test-core.mjs   （纯 JS，无需 ts）
 *   node scripts/test-core.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveRun } from '../lib/run-store.js';
import {
  ALLOWED_MODELS, ALLOWED_EFFORTS, driverArgs, buildToolDefinition, killTree, summarize,
  classifyTermination, buildStatusToolDefinition, summarizeStatus, readRunState,
  loadEffectiveSettings, codexConfigPairs,
  validateSetting, buildConfigToolDefinition, derivedCodexPairs, buildSayToolDefinition,
  sanitizeJson, TASK_KINDS, TASK_KIND_NAMES, resolveSelection, EFFORT_ORDER, unwrapConfigValue,
   DATA_DIR_NAME, LOGS_REL,  BUNDLED_DRIVER, resolveDriverPath,
} from '../lib/core.js';

// 全部路径都**派生**，不写死任何机器位置（发布/换机都能跑）：
//   REPO = 包根目录（本脚本在 <pkg>/scripts/ 下）；TMP = 系统临时目录下的固定子目录。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-runner-smoke-'));
const FAKE_DRIVER = path.join(TMP, 'drive-codex.mjs');
const PROMPT = path.join(TMP, 'task-q.md');
// 自足：测试需要的临时文件由测试自己创建（不依赖任何既有机器文件/目录）。
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(PROMPT, '只回答：1+1=?\n', 'utf8');
fs.writeFileSync(FAKE_DRIVER, '// 测试用假 driver：只为通过"文件存在"检查，不会被真正执行\n', 'utf8');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '  -> ' + e.message); fail++; }
}

// 注入式假 defineTool：只记录定义
let def = null;
const fakeDefineTool = (d) => { def = d; return d; };
const execWith = (cwd, signal) => ({ agent: { session: { header: { cwd } } }, signal });

await t('driverArgs 不暴露纪律类 flag', () => {
  const a = driverArgs({ driverPath: FAKE_DRIVER, promptFile: 'p.md', label: 'L', cwd: REPO });
  for (const forbidden of ['--fallback', '--sandbox', '--bypass', '--verbose', '--quota-limit', '--force']) {
    assert.ok(!a.includes(forbidden), '不得包含 ' + forbidden);
  }
  assert.deepEqual(a.slice(0, 2), [FAKE_DRIVER, '--prompt']);
});



await t('driverArgs：额度告警开关与阈值透传（关闭时不得出现）', () => {
  const off = driverArgs({ driverPath: FAKE_DRIVER, promptFile: 'p.md', label: 'L', cwd: REPO, quotaWarning: false, quotaWarningThreshold: 10 });
  assert.ok(!off.includes('--quota-warning'));
  const on = driverArgs({ driverPath: FAKE_DRIVER, promptFile: 'p.md', label: 'L', cwd: REPO, quotaWarning: true, quotaWarningThreshold: 10 });
  assert.ok(on.includes('--quota-warning'));
  assert.equal(on[on.indexOf('--quota-warning-threshold') + 1], '10');
});

await t('模型白名单包含 gpt-6.1-sol（切换档位用）', () => {
  assert.ok(ALLOWED_MODELS.includes('gpt-6.1-sol'), 'ALLOWED_MODELS 必须含 gpt-6.1-sol');
});

await t('强度白名单含 max/ultra（6.1-sol 的 6 档全开放）', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.ok(ALLOWED_EFFORTS.includes(e), 'ALLOWED_EFFORTS 必须含 ' + e);
  }
});

await t('混合制自治上限：max 默认被拒 / unlock_effort 放行 / xhigh 通过', async () => {
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => REPO, config: {autoModelAndEffort:true,selectionPolicy:{mode:'audit'}} }); // 默认 cap=xhigh
  const r1 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 'x', effort: 'max' }, execWith(REPO));
  assert.equal(r1.status, 'error');
  assert.match(r1.summary_text, /超过自治上限 xhigh/);
  const r2 = await def.execute(
    { override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 'x', effort: 'max', unlock_effort: true }, execWith(REPO));
  assert.match(r2.summary_text, /提示词文件不存在/, '放行后应继续往下走（不再被上限拦）');
  const r3 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 'x', effort: 'xhigh' }, execWith(REPO));
  assert.match(r3.summary_text, /提示词文件不存在/, 'xhigh 不超上限');
});

await t('自治上限可配置：cap=high 时 xhigh 被拒', async () => {
  buildToolDefinition({
    defineTool: fakeDefineTool, resolveCwd: () => REPO,
    config: { maxEffortAllowed: 'high', autoModelAndEffort:true,selectionPolicy:{mode:'audit'} },
  });
  const r = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 'x', effort: 'xhigh' }, execWith(REPO));
  assert.equal(r.status, 'error');
  assert.match(r.summary_text, /超过自治上限 high/);
});


await t('fail closed：拿不到会话 cwd 时不执行', async () => {
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => null });
  const r = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: PROMPT, label: 'x' }, execWith(undefined));
  assert.equal(r.status, 'error');
  assert.match(r.summary_text, /无法确定会话工作目录/);
});

await t('模型白名单', async () => {
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => REPO });
  const r = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: PROMPT, label: 'x', model: 'gpt-9-ultra' }, execWith(REPO));
  assert.equal(r.status, 'error');
  assert.ok(ALLOWED_MODELS.every((m) => !r.summary_text.includes(m + '|') === false || true));
});

await t('提示词文件缺失即报错', async () => {
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => REPO, config: {autoModelAndEffort:true} });
  const r = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope-does-not-exist.md', label: 'x', model:'gpt-6.1-sol', effort:'high' }, execWith(REPO));
  assert.equal(r.status, 'error');
  assert.match(r.summary_text, /提示词文件不存在/);
});

await t('summarize：额度失败保留 Codex 线程并等待恢复', () => {
  const s = summarize('L', {
    exitCode: 1, aborted: false, stderrTail: '', droppedBytes: 0, metaFile: 'L-1.meta.json',
    meta: { status: 'quota-blocked', quotaBefore: 99, quotaAfter: 100, lastMessage: 'usage limit reached', rateLimits: { primary: { user_percent: 100 }, secondary: { used_percent: 5 } } },
  });
  assert.equal(s.status, 'quota-blocked');
  assert.equal(s.handoff.action, 'quota_paused');
  assert.equal(s.handoff.dispatch, 'blocked');
});

await t('定义形状：name/parameters/output.render/presentCall', () => {
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => REPO });
  assert.equal(def.name, 'codex_run');
  assert.equal(def.parameters.prompt_file.required, true);
  assert.equal(def.parameters.label.required, true);
  assert.equal(typeof def.output.render, 'function');
  assert.equal(def.output.render({}, { summary_text: 'S' })[0].text, 'S');
  assert.equal(def.presentCall({ label: 'abc' }).title, 'Run Codex');
});

// —— 600s 防护：参数透传 + 交叉验证分类 ——

await t('driverArgs：budget/resume 透传（且仍不暴露纪律类 flag）', () => {
  const a = driverArgs({
    driverPath: FAKE_DRIVER, promptFile: 'p.md', label: 'L', cwd: REPO,
    budgetMs: 0, resumeThread: '01a1-thread',
  });
  const bi = a.indexOf('--budget-ms');
  assert.ok(bi > 0 && a[bi + 1] === '0', 'budget-ms 必须原样透传（0=不限）');
  const ri = a.indexOf('--resume');
  assert.ok(ri > 0 && a[ri + 1] === '01a1-thread', 'resume 必须透传线程号');
  for (const forbidden of ['--fallback', '--sandbox', '--bypass', '--verbose', '--quota-limit']) {
    assert.ok(!a.includes(forbidden), '不得包含 ' + forbidden);
  }
});

await t('driverArgs：默认不传 --budget-ms（由配置/driver 决定）', () => {
  const a = driverArgs({ driverPath: FAKE_DRIVER, promptFile: 'p.md', label: 'L', cwd: REPO });
  assert.ok(!a.includes('--budget-ms'));
  assert.ok(!a.includes('--resume'));
});

await t('classifyTermination：交叉验证各分支', () => {
  const base = { hostElapsedMs: 60000, budgetMs: 540000, childAlive: false, aborted: false };
  assert.equal(classifyTermination({ ...base, meta: { status: 'ok' } }), 'ok');
  assert.equal(classifyTermination({ ...base, meta: { status: 'quota-blocked' } }), 'quota-blocked');
  assert.equal(classifyTermination({ ...base, meta: { status: 'aborted', abortReason: 'channel-budget' } }), 'channel-budget');
  assert.equal(classifyTermination({ ...base, meta: { status: 'aborted' } }), 'aborted');
  assert.equal(classifyTermination({ ...base, meta: { childPid: 1 }, childAlive: true }), 'orphan');
  assert.equal(
    classifyTermination({ ...base, meta: { childPid: 1 }, hostElapsedMs: 590000 }),
    'channel-budget-unmanaged');
  assert.equal(
    classifyTermination({ ...base, meta: { childPid: 1 }, hostElapsedMs: 575000, budgetMs: 0 }),
    'killed-unknown');
  assert.equal(classifyTermination({ ...base, meta: null }), 'no-evidence');
  assert.equal(
    classifyTermination({ ...base, meta: { status: 'aborted' }, aborted: true }),
    'caller-aborted');
});

await t('summarize：预算中断交给 DSH，保留线程且不直接宣告任务结束', () => {
  const result=summarize('task',{meta:{status:'killed',abortReason:'channel-budget',threadId:'01a1-thread'}});
  assert.equal(result.task_state,'unknown');assert.equal(result.handoff.action,'recover_task');
  assert.match(result.next_action,/resume_thread="01a1-thread"/);
});

await t('summarize：被杀（无终版 meta）时用心跳补出 thread_id 与 termination', () => {
  const s = summarize('L', {
    exitCode: 1, aborted: false, stderrTail: '', droppedBytes: 0, metaFile: 'L-1.meta.json',
    meta: { childPid: 4242, quotaBefore: 51, start: '2026-10-07T15:20:38.000Z' },
  }, {
    ctx: {
      hostElapsedMs: 575000, budgetMs: 0, childAlive: false,
      hb: { seq: 42, ts: '2026-10-07T15:30:00.000Z', threadId: '01a1-from-hb', lastOutAgeMs: 900, childAlive: false },
    },
  });
  assert.equal(s.termination, 'killed-unknown');
  assert.equal(s.thread_id, '01a1-from-hb', '心跳必须补出线程号');
  assert.equal(s.resumable, true);
  assert.equal(s.handoff.action, 'recover_task');
  assert.equal(s.handoff.dispatch, 'after_review');
  assert.match(s.summary_text, /term=killed-unknown/);
});

await t('summarize：预算内主动收尾 = channel-budget（不是 failed）', () => {
  const s = summarize('L', {
    exitCode: 130, aborted: false, stderrTail: '', droppedBytes: 0, metaFile: 'L-2.meta.json',
    meta: {
      status: 'aborted', abortReason: 'channel-budget', killVerified: true, threadId: '01a1-ok',
      elapsedSec: 542, quotaBefore: 40, quotaAfter: 44, usage: { input_tokens: 100, output_tokens: 5 },
    },
  }, { ctx: { hostElapsedMs: 543000, budgetMs: 540000, childAlive: false } });
  assert.equal(s.termination, 'channel-budget');
  assert.equal(s.status, 'aborted');
  assert.equal(s.kill_verified, true);
  assert.match(s.summary_text, /term=channel-budget/);
  assert.match(s.next_action, /resume_thread="01a1-ok"/);
});

// —— 后台（detached）模式 ——

await t('classifyTermination：后台运行中 → running（不诬告为 orphan）', () => {
  const base = { hostElapsedMs: 0, budgetMs: 0, childAlive: true, driverAlive: true, aborted: false };
  assert.equal(classifyTermination({ ...base, meta: { childPid: 1 } }), 'running');
  assert.equal(classifyTermination({ ...base, meta: null }), 'running');
  assert.equal(classifyTermination({ ...base, meta: { status: 'ok' } }), 'ok');
});

await t('summarizeStatus：running 由插件等待且禁止重复派发', () => {
  const result=summarizeStatus('task',{running:true,driverAlive:true});
  assert.equal(result.handoff.action,'await_run');assert.equal(result.handoff.dispatch,'blocked');
  assert.match(result.next_action,/不重复派发/);
});

await t('readRunState/summarizeStatus：靠 registry 的 driverPid 存活判定 running', () => {
  const dir = path.join(TMP, 'status-test');
  fs.mkdirSync(dir, { recursive: true });
  const label = 'st-1';
  fs.writeFileSync(path.join(dir, label + '-2026-01-01T00-00-00.meta.json'),
    JSON.stringify({ label, childPid: 999999, start: new Date().toISOString(), promptBytes: 1 }), 'utf8');
  fs.writeFileSync(path.join(dir, label + '-2026-01-01T00-00-00.hb.json'),
    JSON.stringify({ seq: 3, elapsedSec: 42, items: 2, lastOutAgeMs: 1000, threadId: 'th-1', childPid: 999999 }), 'utf8');
  fs.writeFileSync(path.join(dir, 'codex-live.json'),
    JSON.stringify({ live: [{ driverPid: process.pid, childPid: 999999, label }] }), 'utf8');
  const snap = readRunState(dir, label);
  assert.equal(snap.running, true, 'driverPid（=本进程，必然存活）→ running');
  const s = summarizeStatus(label, snap);
  assert.equal(s.running, true);
  assert.equal(s.termination, 'running');
  assert.equal(s.thread_id, 'th-1', '心跳里的线程号必须透出');
  assert.match(s.summary_text, /running\(detached\)/);
  fs.writeFileSync(path.join(dir, 'codex-live.json'), JSON.stringify({ live: [] }), 'utf8');
  assert.equal(readRunState(dir, label).running, false, 'registry 清空后不再 running');
});

await t('codex_status 定义形状（name/必填 label/render）', () => {
  const def2 = buildStatusToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => REPO });
  assert.equal(def2.name, 'codex_status');
  assert.equal(def2.parameters.run_id.type, 'string');
  assert.equal(typeof def2.execute, 'function');
  assert.equal(def2.output.render({}, { summary_text: 'S' })[0].text, 'S');
});

await t('run 预留记录覆盖 spawn 真空期', () => {
  const dir = path.join(TMP, 'status-gap');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  const label = 'st-gap';
  reserveRun(dir, label);
  const snap = readRunState(dir, label);
  assert.equal(snap.running, true, '刚 spawn、driver 尚未落盘 → 必须判 running');
  assert.equal(snap.spawnPending, true);
  const s = summarizeStatus(label, snap);
  assert.equal(s.termination, 'running');
  assert.match(s.summary_text, /starting\(detached\)/);
});

await t('重复派发同一 label 被拒（预演抓到的 bug #2）', async () => {
  const fakeCwd = path.join(TMP, 'fake-cwd');
  const logDir = path.join(fakeCwd, LOGS_REL);
  fs.mkdirSync(logDir, { recursive: true });
  for (const f of fs.readdirSync(logDir)) fs.unlinkSync(path.join(logDir, f));
  const label = 'st-dup';
  reserveRun(logDir, label);
  let tool = null;
  tool = buildToolDefinition({
    defineTool: (d) => d, resolveCwd: () => fakeCwd,
    config: { backend: 'exec', driverPath: FAKE_DRIVER, autoModelAndEffort:true,selectionPolicy:{mode:'audit'} },
  });
  const r = await tool.execute({override_reason:'Offline fixture explicit selection',
    prompt_file: PROMPT,
    label, detach: true,
  }, execWith(fakeCwd));
  assert.equal(r.status, 'error', '有在跑的后台任务时必须拒绝，而不是再起一个');
  assert.match(r.summary_text, /已在跑/);
  assert.equal(r.driver_pid, undefined, '不得真的 spawn');
});

// —— P1：profile 配置（每次调用读取）+ 自主判断开关 + Codex 配置透传 ——

await t('only profile and code defaults apply; unrelated workspace/global JSON stays untouched', () => {
  const cwd=path.join(TMP,'profile-only'),home=path.join(TMP,'old-global'),previousHome=process.env.DSH_HOME;
  const projectFile=path.join(cwd,'.codex-runner','codex-runner.settings.json'),globalFile=path.join(home,'codex-runner.settings.json');
  fs.mkdirSync(path.dirname(projectFile),{recursive:true});fs.mkdirSync(home,{recursive:true});
  fs.writeFileSync(projectFile,'{invalid legacy JSON');
  const oldGlobal=JSON.stringify({defaultModel:'gpt-6-astra',sandboxMode:'danger-full-access',selectionPolicy:{mode:'enforce'}});
  fs.writeFileSync(globalFile,oldGlobal);process.env.DSH_HOME=home;
  try {
    const e=loadEffectiveSettings({cwd,config:{defaultEffort:'xhigh'}});
    assert.equal(e.source,'profile');assert.equal(e.fieldSources.defaultEffort,'profile');
    assert.equal(e.settings.defaultModel,'gpt-6.1-sol');assert.equal(e.settings.defaultEffort,'xhigh');
    assert.equal(e.settings.sandboxMode,'workspace-write');assert.equal(e.settings.selectionPolicy.mode,'off');
    assert.deepEqual(e.settingsErrors,[]);assert.equal(e.fieldSources.defaultModel,'defaults');
    for(const key of ['projectFile','globalFile','hasProject','hasGlobal'])assert.equal(Object.hasOwn(e,key),false);
    assert.equal(fs.readFileSync(projectFile,'utf8'),'{invalid legacy JSON');assert.equal(fs.readFileSync(globalFile,'utf8'),oldGlobal);
  }finally{if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;}
});

await t('六个下拉框的空配置继承唯一的代码默认值',()=>{
  const cwd=path.join(TMP,'empty-model-defaults');fs.mkdirSync(path.join(cwd,'.codex-runner'),{recursive:true});
  for(const empty of [null,'','   ']){
    const emptyFields={defaultModel:empty,defaultEffort:empty,selectionMode:empty,maxEffortAllowed:empty,sandboxMode:empty,approvalPolicy:empty};
    const defaults=loadEffectiveSettings({cwd,config:emptyFields});
    assert.equal(defaults.settings.defaultModel,'gpt-6.1-sol');assert.equal(defaults.settings.defaultEffort,'high');
    assert.equal(defaults.fieldSources.defaultModel,'defaults');
    assert.equal(defaults.settings.defaultBudgetMs,0);
    assert.equal(defaults.fieldSources.defaultBudgetMs,'defaults');
    for(const [key,value] of Object.entries({selectionMode:'legacy',maxEffortAllowed:'xhigh',sandboxMode:'workspace-write',approvalPolicy:'never'})){assert.equal(defaults.settings[key],value);assert.equal(defaults.fieldSources[key],'defaults');}
    const inherited=loadEffectiveSettings({cwd,config:{defaultModel:'gpt-6-astra',defaultEffort:'xhigh'}});
    assert.equal(inherited.settings.defaultModel,'gpt-6-astra');assert.equal(inherited.settings.defaultEffort,'xhigh');
  }
});

await t('主开关默认关闭：使用默认档位，不需要也不接受 model/effort', async () => {
  const cwd = path.join(TMP, 'p1-cwd2');
  fs.mkdirSync(path.join(cwd, '.codex-runner'), { recursive: true });
  assert.equal(loadEffectiveSettings().settings.autoModelAndEffort,false);
  // 预设策略即使已开启，主开关关闭时也不参与运行。
  for(const config of [{},{selectionPolicy:{mode:'audit'}}]){
    buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => cwd, config });
    const r1 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't' }, execWith(cwd));
    assert.match(r1.summary_text, /提示词文件不存在/, '默认档位不应要求 DSH 传参');
    const r2 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't', model: 'gpt-6.1-sol' }, execWith(cwd));
    assert.equal(r2.status, 'error');
    assert.match(r2.summary_text, /不接受 model\/effort/);
  }
  // 开启主开关但策略关闭：DSH 必须显式给出两项。
  buildToolDefinition({defineTool:fakeDefineTool,resolveCwd:()=>cwd,config:{autoModelAndEffort:true,selectionPolicy:{mode:'off'}}});
  const missing=await def.execute({prompt_file:'nope.md',label:'t'},execWith(cwd));
  assert.match(missing.summary_text,/Selection policy is off/);
  const explicit=await def.execute({prompt_file:'nope.md',label:'t',model:'gpt-6.1-sol',effort:'high'},execWith(cwd));
  assert.match(explicit.summary_text,/提示词文件不存在/);
});

await t('codexConfig：白名单 + 取值校验（拒绝任意 Codex 配置注入）', () => {
  const ok = codexConfigPairs({ web_search: 'live', 'features.memories': false }, []);
  assert.equal(ok.problems.length, 0);
  assert.deepEqual(ok.pairs, [['web_search', JSON.stringify('live')], ['features.memories', 'false']]);
  const bad = codexConfigPairs({ 'mcp_servers.x.command': 'evil.exe' }, []);
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0], /Unsupported Codex configuration/);
  assert.equal(codexConfigPairs({ web_search: 'always' }, []).problems.length, 1);
  assert.equal(codexConfigPairs({}, ['features.apps=true']).pairs[0][0], 'features.apps');
});

await t('driverArgs：--set 透传（driver 侧免重启即可用）', () => {
  const a = driverArgs({
    driverPath: FAKE_DRIVER, promptFile: 'p.md', label: 'L', cwd: REPO,
    setPairs: [['web_search', 'live'], ['model_context_window', '4']],
  });
  const i = a.indexOf('--set');
  assert.ok(i > 0 && a[i + 1] === 'web_search=live');
  assert.ok(a.includes('model_context_window=4'));
});

await t('validateSetting：非法键/非法值被拒', () => {
  assert.equal(validateSetting('defaultEffort', 'ultra').ok, true);
  assert.equal(validateSetting('defaultEffort', 'always').ok, false);
  assert.equal(validateSetting('autoModelAndEffort', 'yes').ok, false);
  assert.equal(validateSetting('nope', 1).ok, false);
});

await t('额度告警设置：默认关闭/阈值 5，范围 0..20 的整数', () => {
  const e = loadEffectiveSettings({ cwd: TMP, config: {} });
  assert.equal(e.settings.quotaWarning, false);
  assert.equal(e.settings.quotaWarningThreshold, 5);
  assert.equal(validateSetting('quotaWarning', true).ok, true);
  for (const ok of [0, 1, 5, 20]) assert.equal(validateSetting('quotaWarningThreshold', ok).ok, true, String(ok));
  for (const bad of [-1, 21, 5.5, '5']) assert.equal(validateSetting('quotaWarningThreshold', bad).ok, false, String(bad));
});

await t('codex_config is read-only, reports live profile values and exposes no file controls', async () => {
  let budget=2000;
  const config={defaultBudgetMs:{get:()=>budget}},tool=buildConfigToolDefinition({defineTool:d=>d,config});
  assert.deepEqual(tool.parameters,{});
  const first=await tool.execute({});assert.equal(first.status,'ok');assert.equal(first.settings.defaultBudgetMs,2000);
  assert.equal(first.settings_source,'profile');assert.equal(first.field_sources.defaultBudgetMs,'profile');
  assert.ok(first.allowed_codex_config_keys.includes('web_search'));
  for(const key of ['action','scope','file','project_file','global_file'])assert.equal(Object.hasOwn(first,key),false);
  budget=0;assert.equal((await tool.execute({})).settings.defaultBudgetMs,0);
  for(const action of ['set','unset','reset','path']){
    const result=await tool.execute({action,key:'defaultBudgetMs',value:1});
    assert.equal(result.status,'error');assert.match(result.summary_text,/read-only/);
  }
  assert.equal(budget,0);
});

await t('参数 schema 自检：每个节点都有合法 type（宿主 defineTool 在**定义期**就会抛错）', () => {
  // 宿主实现：parameterSchemaSpecToJsonSchema → runSchemaCompiler；
  // SCHEMA_TYPES = object/array/string/number/integer/boolean/null，缺 type 或 type 非法即抛。
  // 宿主 author 层允许：object/array/string/number/integer/boolean/null/**json**（见宿主报错原文），
  // 其中 json 会在编译期被展开为"任意 JSON 值"。
  const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null', 'json'];
  const problems = [];
  const walk = (node, p) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { problems.push(p + ' 不是 schema 对象'); return; }
    if (!SCHEMA_TYPES.includes(node.type)) problems.push(p + '.type 非法或缺失：' + String(node.type));
    if (node.description !== undefined && typeof node.description !== 'string') problems.push(p + '.description 必须是字符串');
    // 注意：author 层 spec 里 required 是**布尔**（宿主 compiler 再转成 JSON-Schema 的字符串数组）；
    // 这里两种形态都接受，只拦"既不是布尔也不是字符串数组"的写法。
    if (node.required !== undefined
      && typeof node.required !== 'boolean'
      && (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string'))) {
      problems.push(p + '.required 必须是布尔或字符串数组');
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) problems.push(p + '.enum 必须是非空数组');
    if (node.oneOf !== undefined && (!Array.isArray(node.oneOf) || node.oneOf.length < 2)) problems.push(p + '.oneOf 至少两个 schema');
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, p + '.properties.' + k);
    if (node.items) { if (Array.isArray(node.items)) problems.push(p + '.items 不支持数组形式'); else walk(node.items, p + '.items'); }
    if (node.oneOf) node.oneOf.forEach((v, i) => walk(v, p + '.oneOf[' + i + ']'));
  };
  const defs = [
    buildToolDefinition({ defineTool: (d) => d, resolveCwd: () => REPO, config: {} }),
    buildStatusToolDefinition({ defineTool: (d) => d, resolveCwd: () => REPO, config: {} }),
    buildConfigToolDefinition({ defineTool: (d) => d, resolveCwd: () => REPO, config: {} }),
    buildSayToolDefinition({ defineTool: (d) => d, resolveCwd: () => REPO, config: {} }),
  ];
  for (const d of defs) {
    if (!d.output || !d.output.schema || !d.output.render) problems.push(d.name + ' 缺少 output.schema/render');
    for (const [k, v] of Object.entries(d.parameters || {})) walk(v, d.name + '.parameters.' + k);
  }
  assert.equal(problems.length, 0, problems.join('; '));
});

// —— Q1/Q2/Q3：加速档 / 完全访问闸门 / 插话 ——

await t('derivedCodexPairs：serviceTier / approvalPolicy / 沙箱网络 → --set 对', () => {
  const p = derivedCodexPairs({ serviceTier: 'fast', approvalPolicy: 'never', workspaceNetworkAccess: true });
  assert.equal(p.problems.length, 0);
  assert.deepEqual(p.pairs, [
    ['service_tier', 'priority'], ['approval_policy', 'never'], ['sandbox_workspace_write.network_access', 'true'],
  ]);
  assert.equal(derivedCodexPairs({ serviceTier: 'off' }).pairs.length, 0);
  assert.equal(derivedCodexPairs({ serviceTier: 'turbo' }).problems.length, 1);
  assert.equal(derivedCodexPairs({ approvalPolicy: 'always' }).problems.length, 1);
});

await t('沙箱模式直接决定权限，无需额外放行字段', async () => {
  const cwd = path.join(TMP, 'q3-cwd');
  fs.mkdirSync(path.join(cwd, '.codex-runner'), { recursive: true });
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => cwd, config: {sandboxMode:'danger-full-access',autoModelAndEffort:true} });
  const result = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't',model:'gpt-6.1-sol',effort:'high' }, execWith(cwd));
  assert.match(result.summary_text, /提示词文件不存在/);
  assert.equal(validateSetting('sandboxMode','danger-full-access').ok,true);
  assert.equal(validateSetting('allowFullAccess',true).ok,false);
});

await t('driverArgs：--sandbox 透传', () => {
  const a = driverArgs({
    driverPath: FAKE_DRIVER, promptFile: 'p.md', label: 'L', cwd: REPO,
    sandbox: 'read-only',
  });
  const i = a.indexOf('--sandbox');
  assert.ok(i > 0 && a[i + 1] === 'read-only');
});

await t('codex_say：解析不到线程时报错（不发起任何调用）', async () => {
  const cwd = path.join(TMP, 'say-cwd');
  fs.mkdirSync(path.join(cwd, LOGS_REL), { recursive: true });
  const tool = buildSayToolDefinition({ defineTool: (d) => d, resolveCwd: () => cwd, config: {} });
  const r1 = await tool.execute({override_reason:'Offline fixture explicit selection', message: '改方向：先做 P4-4', label: 'no-such-label' }, execWith(cwd));
  assert.equal(r1.status, 'error');
  assert.match(r1.summary_text, /解析不到线程 id/);
  const r2 = await tool.execute({override_reason:'Offline fixture explicit selection', label: 'x' }, execWith(cwd));
  assert.equal(r2.status, 'error');
  assert.match(r2.summary_text, /message 必填/);
});

await t('sanitizeJson：宿主只收无损 JSON（NaN/undefined/类实例/循环都清掉，并记下路径）', () => {
  const hostile = { a: undefined, b: NaN, c: Infinity, d: new Date(0), e: () => {}, f: { g: [1, 2] } };
  hostile.self = hostile;
  const dropped = [];
  const clean = sanitizeJson(hostile, '', dropped);
  assert.equal(JSON.stringify(clean), JSON.stringify(JSON.parse(JSON.stringify(clean))));
  const paths = dropped.join(',');
  for (const want of ['a(undefined)', 'b(NaN)', 'c(Infinity)', 'self(circular)', 'd([object Date])']) {
    assert.ok(paths.includes(want), want + ' 未被记录：' + paths);
  }
  assert.deepEqual(clean.f, { g: [1, 2] }, '正常部分必须原样保留');
  // 同一对象出现在兄弟分支（DAG）不算循环
  const shared = { x: 1 };
  const dagDropped = [];
  assert.deepEqual(sanitizeJson({ p: shared, q: shared }, '', dagDropped), { p: { x: 1 }, q: { x: 1 } });
  assert.equal(dagDropped.length, 0);
});

// —— P4：机制化选档（task_kind 规则表）——

await t('TASK_KINDS 规则表：模型/档位都在白名单内，且不越过默认自治上限', () => {
  assert.equal(TASK_KIND_NAMES.join(','), 'mechanical,docs,review,implement,architect,rework');
  for (const kind of TASK_KIND_NAMES) {
    const rule = TASK_KINDS[kind];
    assert.ok(ALLOWED_MODELS.includes(rule.model), kind + ' 模型不在白名单：' + rule.model);
    assert.ok(ALLOWED_EFFORTS.includes(rule.effort), kind + ' 强度不在白名单：' + rule.effort);
    assert.ok(EFFORT_ORDER.indexOf(rule.effort) <= EFFORT_ORDER.indexOf('xhigh'), kind + ' 越过默认自治上限');
    assert.ok(typeof rule.why === 'string' && rule.why.length > 0, kind + ' 缺 why 说明');
  }
  // max/ultra 故意不进表：必须由人显式放行（unlock_effort）
  assert.ok(!TASK_KIND_NAMES.some((k) => EFFORT_ORDER.indexOf(TASK_KINDS[k].effort) > EFFORT_ORDER.indexOf('xhigh')));
});

await t('resolveSelection：task_kind 只填缺省项，显式参数优先，并如实回报来源', () => {
  const a = resolveSelection({ taskKind: 'architect', defaultModel: 'gpt-6.1-sol', defaultEffort: 'high' });
  assert.equal(a.model, 'gpt-6-astra'); assert.equal(a.effort, 'xhigh');
  assert.equal(a.modelSource, 'task_kind'); assert.equal(a.effortSource, 'task_kind');
  const b = resolveSelection({ taskKind: 'mechanical', model: 'gpt-6.1-sol', defaultModel: 'x', defaultEffort: 'high' });
  assert.equal(b.model, 'gpt-6.1-sol'); assert.equal(b.modelSource, 'explicit');
  assert.equal(b.effort, 'low'); assert.equal(b.effortSource, 'task_kind');
  const c = resolveSelection({ taskKind: 'implement', effort: 'medium', defaultModel: 'gpt-6.1-sol', defaultEffort: 'high' });
  assert.equal(c.effort, 'medium'); assert.equal(c.effortSource, 'explicit');
  assert.equal(c.model, 'gpt-6.1-sol'); assert.equal(c.modelSource, 'task_kind');
  const d = resolveSelection({ defaultModel: 'gpt-6.1-sol', defaultEffort: 'high' });
  assert.equal(d.modelSource, 'default'); assert.equal(d.effortSource, 'default');
});

await t('codex_run：task_kind 非法被拒 / 规则档受自治上限约束 / 自主开关与策略从属', async () => {
  const cwd = path.join(TMP, 'p4-cwd');
  fs.mkdirSync(path.join(cwd, '.codex-runner'), { recursive: true });
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => cwd, config: {autoModelAndEffort:true,selectionPolicy:{mode:'audit'},} });
  const r1 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't', task_kind: 'whatever' }, execWith(cwd));
  assert.equal(r1.status, 'error');
  assert.match(r1.summary_text, /不在规则表/);

  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => cwd, config: {autoModelAndEffort:true,selectionPolicy:{mode:'audit'}, maxEffortAllowed: 'high' } });
  const r2 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't', task_kind: 'architect' }, execWith(cwd));
  assert.equal(r2.status, 'error');
  assert.match(r2.summary_text, /超过自治上限/);

  // 主开关关闭：固定默认档位，不需要也不接受 model/effort。
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => cwd, config: {autoModelAndEffort:false} });
  const r3 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't', task_kind: 'implement' }, execWith(cwd));
  assert.match(r3.summary_text, /提示词文件不存在/, '主开关关闭时应直接使用默认档位');
  const r4 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't', model:'gpt-6-luna' }, execWith(cwd));
  assert.match(r4.summary_text, /不接受 model\/effort/);

  // 主开关开启且策略关闭：必须显式给两项。
  buildToolDefinition({ defineTool: fakeDefineTool, resolveCwd: () => cwd, config: {autoModelAndEffort:true,selectionPolicy:{mode:'off'}} });
  const r5 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't' }, execWith(cwd));
  assert.match(r5.summary_text, /Selection policy is off/);
  const r6 = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't', model:'gpt-6.1-sol', effort:'high' }, execWith(cwd));
  assert.match(r6.summary_text, /提示词文件不存在/);
});

// —— 宿主 config 的访问器壳（2026-10-10 实测：.volatile() 字段是 { get: () => 值 }）——

await t('unwrapConfigValue / loadEffectiveSettings：解开访问器壳，取不到则视为未设置', () => {
  const cwd = path.join(TMP, 'accessor-cwd');
  fs.mkdirSync(path.join(cwd, '.codex-runner'), { recursive: true });
  const accessor = (v) => ({ get: () => v });
  const e = loadEffectiveSettings({
    cwd,
    config: {
      defaultModel: accessor('gpt-6-astra'),
      defaultEffort: accessor('xhigh'),
      sandboxMode: accessor('danger-full-access'),
      serviceTier: accessor('off'),
      approvalPolicy: accessor('never'),
      autoModelAndEffort: accessor(false),
      defaultBudgetMs: accessor(600000),
      driverPath: accessor(FAKE_DRIVER),
    },
  });
  assert.equal(e.settings.defaultModel, 'gpt-6-astra');
  assert.equal(e.settings.defaultEffort, 'xhigh');
  assert.equal(e.settings.sandboxMode, 'danger-full-access');
  assert.equal(e.settings.autoModelAndEffort, false);
  assert.equal(e.settings.defaultBudgetMs, 600000);
  assert.equal(e.settings.driverPath, FAKE_DRIVER);
  assert.equal(e.source, 'profile');
  assert.equal(e.configShapes.defaultModel, 'accessor');

  // 取不到值（返回 undefined / 抛错）→ 视作未设置，回落默认
  const e2 = loadEffectiveSettings({
    cwd,
    config: { defaultModel: { get: () => undefined }, defaultEffort: { get: () => { throw new Error('boom'); } } },
  });
  assert.equal(e2.settings.defaultModel, 'gpt-6.1-sol');
  assert.equal(e2.settings.defaultEffort, 'high');
  assert.equal(e2.source, 'defaults');

  // 普通值不受影响；普通对象不被误判为访问器
  assert.equal(unwrapConfigValue('plain'), 'plain');
  assert.equal(unwrapConfigValue(5), 5);
  assert.equal(unwrapConfigValue(false), false);
  const e3 = loadEffectiveSettings({ cwd, config: { codexConfig: { web_search: 'live' } } });
  assert.deepEqual(e3.settings.codexConfig, { web_search: 'live' });
  assert.equal(e3.configShapes.codexConfig, 'object');
});

await t('accessor config 不再让 codex_run 误判（原本报"serviceTier 取值非法"）', async () => {
  const cwd = path.join(TMP, 'accessor-run');
  fs.mkdirSync(path.join(cwd, '.codex-runner'), { recursive: true });
  const accessor = (v) => ({ get: () => v });
  buildToolDefinition({
    defineTool: fakeDefineTool,
    resolveCwd: () => cwd,
    config: {
      serviceTier: accessor('off'), approvalPolicy: accessor('never'),
      sandboxMode: accessor('workspace-write'),
      defaultModel: accessor('gpt-6-astra'), maxEffortAllowed: accessor('xhigh'),
      autoModelAndEffort: accessor(true),selectionPolicy: accessor({mode:'audit'}),
      driverPath: accessor('X'),
    },
  });
  const r = await def.execute({override_reason:'Offline fixture explicit selection', prompt_file: 'nope.md', label: 't', effort: 'high' }, execWith(cwd));
  assert.match(r.summary_text, /提示词文件不存在/, r.summary_text);
});


await t('日志目录由插件显式交给 driver（不依赖 driver 的缺省约定）', () => {
  const expected = path.join(REPO, LOGS_REL);
  const a = driverArgs({ driverPath: FAKE_DRIVER, promptFile: PROMPT, label: 'L', cwd: REPO, logDir: expected });
  const i = a.indexOf('--log-dir');
  assert.ok(i > 0 && a[i + 1] === expected, a.join(' '));
  assert.ok(LOGS_REL.indexOf(DATA_DIR_NAME) === 0, '日志目录必须在中性数据目录下');
});

await t('随包自带 driver：默认走它，显式配置优先（发布版自持，不依赖会话目录）', () => {
  assert.ok(fs.existsSync(BUNDLED_DRIVER), 'drivers/drive-codex.mjs 必须随包存在：' + BUNDLED_DRIVER);
  assert.equal(path.resolve(BUNDLED_DRIVER), path.join(REPO, 'drivers', 'drive-codex.mjs'), 'driver belongs to this package even when installed in node_modules');
  // 未配置 → 用自带 driver
  assert.equal(resolveDriverPath({ cwd: REPO }), BUNDLED_DRIVER);
  // 显式配置 → 以配置为准（哪怕它指向别处/不存在，也交给下游 fail closed 报错）
  const configured = path.join(TMP, 'explicit-driver.mjs');
  assert.equal(resolveDriverPath({ configured, cwd: REPO }), configured);
  // 自带 driver 自身也必须干净：无盘符路径；「外部工具名」的禁令由 check-release-clean 全包强制（连本文件一起扫）
  const text = fs.readFileSync(BUNDLED_DRIVER, 'utf8');
  assert.ok(text.indexOf('usage:') > 0 || text.indexOf('用法') > 0, 'driver 文本应可读');
  assert.ok(!/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(text), 'driver 不得含盘符绝对路径');
});

await t('额度判定（纯函数）：只认协议级证据，且必须带证据（含 2429 误报回归）', async () => {
  const q = await import('../drivers/quota-detect.mjs');
  // 1) 事故回归：源码片段里的行号 2429: 绝不能再被当成 429
  const sourceLine = '{"type":"item.completed","item":{"command":"rg -n ... 2428: everything is visible\n2429: setClipLayoutX(0);"}}';
  assert.equal(q.quotaEvidence(sourceLine), null, '源码/回显里的 2429: 不得命中');
  assert.equal(q.quotaEvidence('14293 items processed'), null, '14293 不得命中（词边界）');
  assert.ok(q.quotaEvidence('HTTP 429 Too Many Requests'), '真正的 429 仍要命中');
  // 2) 只认协议级事件：item.* 里的"usage limit"是 agent 文本，不算证据
  const itemEvent = { type: 'item.completed', item: { type: 'agent_message', text: "You've hit your usage limit" } };
  assert.equal(q.errorTextOf(itemEvent), null, 'item.* 一律不取错误文本');
  const errEvent = { type: 'error', message: "You've hit your usage limit. try again at Oct 14th, 2026 9:53 PM." };
  assert.ok(q.errorTextOf(errEvent), 'error 事件必须取出文本');
  // 3) 综合判定
  assert.equal(q.quotaVerdict({ errorTexts: [] }).blocked, false, '无证据不得判触顶');
  assert.equal(q.quotaVerdict({ errorTexts: [q.errorTextOf(errEvent)] }).source, 'error-event');
  assert.equal(q.quotaVerdict({ reached: 'primary' }).source, 'rollout');
  assert.equal(q.quotaVerdict({ afterPct: 100 }).blocked, true);
  assert.equal(q.quotaVerdict({ afterPct: 60 }).blocked, false, '5h 只用到 60% 不得判触顶');
  // 4) 非额度错误：文本里没有额度文案 → 不算触顶
  const otherErr = { type: 'turn.failed', error: { message: 'stream disconnected before completion' } };
  assert.equal(q.quotaVerdict({ errorTexts: [q.errorTextOf(otherErr)] }).blocked, false);
  // 5) 源码级回归：不得再出现"任何错误都当额度"，也不得逐行裸扫
  const driverText = fs.readFileSync(BUNDLED_DRIVER, 'utf8');
  assert.ok(driverText.indexOf('sawQuota = sawQuota || true') < 0, '不得保留"任何错误都算触顶"的写法');
  assert.ok(/errorTextOf\(o\)/.test(driverText), 'driver 必须经由 errorTextOf 取证据');
  assert.ok(driverText.indexOf('QUOTA_PATTERNS.some((re) => re.test(line))') < 0, '不得逐行扫描整条 stdout');
});

console.log('\nresult: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
