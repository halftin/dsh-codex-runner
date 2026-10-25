#!/usr/bin/env node
import { tomlValue } from '../lib/field-schema.js';
import { stopOwnedTree } from '../lib/owned-process.js';
import { processStartedAt } from '../lib/process-evidence.js';
import { answerSnapshot, isFinalAnswerItem, createDebugLog, failureSummary, utf8Tail, redactDiagnostic, DEBUG_MAX_BYTES } from '../lib/run-data.js';
/**
 * drive-codex.mjs —— 驱动 Codex CLI（ChatGPT Plus 订阅）执行单个任务
 *
 * 契约：提示词走文件 → UTF-8 写 stdin；只保存有界 meta，事件仅在 debug 时有界写入。
 *
 * 本机实测要点（2026-10-06，codex-cli 0.160.1 / 桌面版 0.159.0）：
 *  1) `-s workspace-write` 在 Windows 上**必须**同时给 `windows.sandbox="elevated"`，
 *     否则一切写入被静默拦截，而 agent 只是礼貌地说"read-only"，**exit code 仍为 0**。
 *  2) 额度读数不在 `--json` 的 stdout 里，而在 rollout 会话文件
 *     `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` 的
 *     `token_count` 事件的 `rate_limits`（primary=5h / secondary=7d，整数百分比）。
 *     因此**不要用 `--ephemeral`**，否则没有额度读数。
 *  4) PowerShell 5.1 的 `>` 重定向是 UTF-16LE：日志必须由 Node 直接写字节。
 *
 * 用法:
 *   node drive-codex.mjs --prompt <file> [--label x] [--model gpt-6.1-sol] [--effort high]
 *                        [--sandbox workspace-write] [--bypass] [--resume <threadId>]
 *                        [--quota-limit 100] [--cwd .]
 *                        [--log-dir <dir>] [--verbose]
 *                        [--budget-ms <n>] [--hb-interval-ms <n>]
 *                        [--hb-file <file>]
 *
 * 默认值即纪律（2026-10-06 起）——把踩过的坑写进机制，而不是留在提示词里：
 *   quiet=true        不打心跳（避免零信息量文本挤占指挥方上下文）
 *   model=gpt-6.1-sol 质量优先（2026-10-08 用户拍板；与插件层 cordis.patch.yml 的 defaultModel 一致）。
 *                     通过显式 -m/effort 设置本次主任务参数，其余继承 Codex 配置；
 *                     astra/sol/luna 等其它档位必须调用方显式 --model 指定。
 *   fallback=none     拒绝服务时**停下报告**，不擅自切换
 *   quota-limit=100   不做额度预判，只在被拒绝时停
 *   继承 Codex 原生配置 + windows.sandbox=elevated + 显式 model_reasoning_effort
 *   childPid 落 meta  中断时可用 taskkill /PID <childPid> /T /F 整树终止
 *
 * 600s 通道上限防护（2026-10-07 加）——**绝不把"结束"交给宿主**：
 *   --budget-ms >0    到点**自己**整树终止 → 核实 pid 真死 → 再写终版 meta
 *                     （status=aborted / abortReason=channel-budget / resumable=true）；
 *                     0=不限，不自动调整显式预算。
 *   不传 --budget-ms  默认不限时；需要运行时限时显式设置正数。
 *   心跳文件          每 --hb-interval-ms(默认 5s) 原子重写 <label>-<stamp>.hb.json：
 *                     driver 被杀后仍能交叉验证（seq/ts/threadId/stdoutBytes/childPid）
 *   meta 快照         spawn / thread.started / 每次 turn.completed 各写一次 →
 *                     "被杀即失忆"（thread=none）不再发生
 *   孤儿              只报告历史 PID；不凭持久化 PID 自动终止进程
 */
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { errorTextOf, quotaEvidence, quotaVerdict } from './quota-detect.mjs';
import { resolveCodexExe } from '../lib/executable.js';
import { atomicJson, readJson, validRunId, validateLabel } from '../lib/run-store.js';
import { captureReply } from '../lib/reply-signals.js';

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'bypass') { out.bypass = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) out[key] = true;
    else { out[key] = val; i++; }
  }
  return out;
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); }
  catch (_) { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

/** 终止核实：轮询到 pid 真的消失（或超时）。返回是否**确认**死亡。 */
function verifyDead(pid, timeoutMs) {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(250);
  }
}

/** 通道识别（交叉验证源之一）：父进程是 DSH 宿主=工具通道；pwsh/powershell=后台 CLI 通道。 */
function detectChannel() {
  const ppid = process.ppid;
  let parentName = null;
  try {
    const out = execSync('tasklist /FI "PID eq ' + ppid + '" /FO CSV /NH', { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith('"'));
    if (first) { const m = first.match(/^"([^"]+)"/); if (m) parentName = m[1]; }
  } catch (_) { /* ignore */ }
  const n = (parentName || '').toLowerCase();
  let channel = 'unknown';
  if (/deepseek|dsh|electron/.test(n)) channel = 'tool';
  else if (/pwsh|powershell|cmd|conhost|windowsterminal|wt\.exe/.test(n)) channel = 'cli';
  return { parentPid: ppid, parentName, channel };
}

/** 每个运行目录保留独立的进程记录，仅用于诊断。 */
function registerLive(registryFile, entry) {
  let reg = { live: [] };
  try { if (fs.existsSync(registryFile)) reg = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch (_) { /* ignore */ }
  reg.live = (reg.live || []).filter((e) => e.driverPid !== entry.driverPid);
  reg.live.push(entry);
  try { atomicJson(registryFile, { updatedAt: new Date().toISOString(), live: reg.live }); } catch (_) { /* ignore */ }
}

function unregisterLive(registryFile, driverPid) {
  try {
    if (!fs.existsSync(registryFile)) return;
    const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    reg.live = (reg.live || []).filter((e) => e.driverPid !== driverPid);
    atomicJson(registryFile, { updatedAt: new Date().toISOString(), live: reg.live });
  } catch (_) { /* ignore */ }
}

/** 在 rollout 会话文件里找指定 thread 的最后一次 rate_limits / usage */
function readRollout(threadId) {
  try {
  const root = path.join(codexHome(), 'sessions');
  if (!fs.existsSync(root)) return null;
  if (!threadId) return null;
  const files = [];
  let visited = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a,b)=>b.name.localeCompare(a.name))) {
      if (++visited > 10000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl') && e.name.includes(threadId)) files.push(p);
    }
  })(root);
  if (!files.length) return null;
  // 注意：最新的 rollout 可能来自一次失败/中止的运行（没有 rate_limits 事件），
  // 所以要按时间倒序找**第一个带 rate_limits 的**文件，而不是无脑取最新那个。
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const candidates = threadId ? files.filter((f) => f.includes(threadId)) : files.slice(0, 12);
  if (!candidates.length) return null;
  for (const target of candidates) {
    let usage = null, rateLimits = null;
    const size = fs.statSync(target).size;
    const buffer = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    const fd = fs.openSync(target, 'r');
    try { fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)); }
    finally { fs.closeSync(fd); }
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload;
      if (p && p.type === 'token_count') {
        if (p.info && p.info.total_token_usage) usage = p.info.total_token_usage;
        if (p.rate_limits) rateLimits = p.rate_limits;
      }
    }
    if (rateLimits || threadId) {
      return { file: target, threadMatched: !!(threadId && target.includes(threadId)), usage, rateLimits };
    }
  }
  return null;
  } catch { return null; } // Optional telemetry must never turn a completed task into a failure.
}

// 额度判定已抽到 ./quota-detect.mjs（纯函数、可单测、必须带证据）——见那里的实测事故说明。

const opt = parseArgv(process.argv.slice(2));
const workDir = path.resolve(opt.cwd || process.cwd());
const label = opt.label || 'codex';
if (!validateLabel(label)) { console.error('Invalid label'); process.exit(2); }
const runId = opt['run-id'] || null;
if (runId && !validRunId(runId)) { console.error('Invalid run id'); process.exit(2); }
const debugLogs = opt['debug-logs'] === true;
const debugMaxBytes = opt['debug-max-bytes'] === undefined ? DEBUG_MAX_BYTES : Number(opt['debug-max-bytes']);
const model = opt.model || 'gpt-6.1-sol';
const effort = opt.effort || 'high';
const sandbox = opt.sandbox || 'workspace-write';
// 默认值即纪律（见文件头）：不预判额度、拒绝即停、不擅自切换、不灌心跳。
const quiet = !opt.verbose;
const hbIntervalMs = Number(opt['hb-interval-ms'] === undefined ? 5000 : opt['hb-interval-ms']);
// 透传 Codex 配置项（-c k=v）：`--set k=v`，可重复。
// 白名单由插件侧的 settings 约束；driver 只做最小校验 + TOML 字面量序列化，
// 保持"通用透传"而不是逐键硬编码（新增 Codex 配置项无需改 driver）。
const setPairs = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--set') continue;
  const raw = process.argv[i + 1];
  if (typeof raw !== 'string' || raw.indexOf('=') <= 0) continue;
  const eq = raw.indexOf('=');
  const k = raw.slice(0, eq).trim();
  const v = raw.slice(eq + 1);
  if (/^[A-Za-z0-9_.\-]+$/.test(k)) setPairs.push([k, v]);
}
function tomlLiteral(v) {
  try {return tomlValue(JSON.parse(String(v)));}catch{return JSON.stringify(String(v));}
}
const logDir = path.resolve(opt['log-dir'] || path.join(workDir, '.codex-runner', 'logs'));

// ---- 插话模式（codex queue）：`--queue <threadId> --message <text>` ----
// 一次性调用：解析 exe → 转发给 `codex queue` → 打印结果后退出；与主流程（需要 --prompt）无关。
// 实测（2026-10-10，0.160.1）：无 TTY 也可用，返回 "Queued message <id> for thread <thread>"。
if (opt.queue) {
  const th = String(opt.queue);
  const msg = opt.message === undefined ? '' : String(opt.message);
  if (!msg) { console.error('[drive-codex] --queue 需要 --message <text>'); process.exit(2); }
  const qexe = resolveCodexExe();
  if (!qexe) { console.error('[drive-codex] codex executable not found (set CODEX_EXE)'); process.exit(2); }
  try {
    const out = execFileSync(qexe, ['queue', '--thread', th, '--message', msg], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    console.log('[codex-queue] ' + String(out || '').trim());
    process.exit(0);
  } catch (e) {
    const detail = (e && (e.stderr || e.stdout)) ? String(e.stderr || e.stdout).trim() : (e && e.message ? e.message : String(e));
    console.error('[codex-queue] 失败：' + detail);
    process.exit(1);
  }
}

if (!opt.prompt) { console.error('[drive-codex] --prompt <file> is required'); process.exit(2); }
if (!fs.existsSync(opt.prompt)) { console.error('[drive-codex] prompt not found: ' + opt.prompt); process.exit(2); }
const CODEX_EXE = resolveCodexExe();
if (!CODEX_EXE) { console.error('[drive-codex] codex executable not found (set CODEX_EXE)'); process.exit(2); }

fs.mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// 文件名带 driver pid：并发/重复派发若落在同一秒，也不会互相覆盖日志与 meta。
const metaFile = path.join(logDir, runId ? 'result.meta.json' : label + '-' + stamp + '-p' + process.pid + '.meta.json');
const debug = createDebugLog(logDir, {debugLogs,debugMaxBytes});
const hbFile = path.resolve(opt['hb-file'] || path.join(logDir, runId ? 'result.hb.json' : label + '-' + stamp + '-p' + process.pid + '.hb.json'));
const registryFile = path.join(logDir, 'codex-live.json');

// 显式预算优先；未指定时不限时。
const channelInfo = detectChannel();
let budgetMs, budgetSource, budgetRequestedMs = null;
if (opt['budget-ms'] !== undefined) {
  budgetRequestedMs = Math.max(0, Number(opt['budget-ms']) || 0);
  budgetMs = budgetRequestedMs;
  budgetSource = budgetMs === 0 ? 'cli-off' : 'cli';
} else if (channelInfo.channel === 'cli') {
  budgetMs = 0; budgetSource = 'channel-cli';
} else {
  budgetMs = 0; budgetSource = 'channel-tool';
}
if (!Number.isFinite(budgetMs)) budgetMs = 0;
// Persisted PIDs are not proof of ownership. Never kill a process from historical data.
const reapedOrphans = [];

let promptText = fs.readFileSync(opt.prompt, 'utf8');

// 历史额度只用于展示，不能阻止新任务。
const before = null; // Historical quota snapshots are telemetry, never an admission gate.
const beforePct = before && before.rateLimits && before.rateLimits.primary
  ? before.rateLimits.primary.used_percent : null;

const meta = {
  label, runId, backend:'exec', debugLogs, debugMaxBytes, logTruncated:false, ...answerSnapshot(''), detached: !!opt.detached, driverPid: process.pid, driverStartedAt: processStartedAt(), prompt: opt.prompt, cwd: workDir, model, effort, sandbox,
  resume: opt.resume || null, bypass: !!opt.bypass,
  start: new Date().toISOString(), codexExe: CODEX_EXE,
  codexHome: codexHome(), promptBytes: Buffer.byteLength(promptText, 'utf8'),
  quotaBefore: beforePct,
  channel: channelInfo.channel, parentPid: channelInfo.parentPid, parentName: channelInfo.parentName,
  budgetMs, budgetSource, budgetRequestedMs,
  hbIntervalMs, hbFile, reapedOrphans,
};

function writeMeta(extra) {
  atomicJson(metaFile, Object.assign(meta, extra));
}

// 仅根据当前运行的协议错误报告额度失败，不自动切换模型。
// ---- 组参数（fresh 与 resume 共用的选项集；resume 不支持 -s/-C，故统一用 -c 覆盖） ----
const args = ['exec'];
if (opt.resume) args.push('resume', String(opt.resume));
args.push('--json', '-m', model,
  '-c', 'model_reasoning_effort="' + effort + '"',
  '-c', 'windows.sandbox="elevated"',
  '--skip-git-repo-check');
if (opt.bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
else { args.push('-c', 'sandbox_mode=' + tomlValue(sandbox)); }
for (const [k, v] of setPairs) args.push('-c', k + '=' + tomlLiteral(v));
if (opt.resume) args.push('-');           // 续跑：提示词仍走 stdin
else args.push('-');
meta.args = args;
meta.codexConfigSet = setPairs.map(([k, v]) => k + '=' + v);
writeMeta({});
if (!quiet) {
  console.log('[drive-codex] exe=' + CODEX_EXE);
  console.log('[drive-codex] model=' + model + ' effort=' + effort + ' sandbox=' + (opt.bypass ? 'bypass' : sandbox));
  console.log('[drive-codex] quota(before)=' + (beforePct === null ? 'n/a' : beforePct + '%'));
  console.log('[drive-codex] meta=' + metaFile);
}

const t0 = Date.now();
const child = spawn(CODEX_EXE, args, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });

// 立刻把 codex 子进程 PID 记进 meta：Windows 上父进程被强杀时（Stop-Process -Force /
// 任务被取消）**任何信号处理器都不会执行**，codex 及其派生的 pwsh/mvn/java 会变成孤儿。
// 唯一可靠的中断方式是外部用这个 PID 做整树终止：taskkill /PID <childPid> /T /F
meta.childPid = child.pid ?? null;
meta.childStartedAt = new Date().toISOString();
meta.pidRecordedAt = new Date().toISOString();
writeMeta({});
if (runId) atomicJson(path.join(logDir, 'run.json'), { ...(readJson(path.join(logDir, 'run.json')) || {}), runId, label, state: 'running', driverPid: process.pid, driverStartedAt: meta.driverStartedAt, childPid: meta.childPid, childStartedAt: meta.childStartedAt });
registerLive(registryFile, {
  driverPid: process.pid, childPid: child.pid ?? null, label,
  startedAt: meta.start, hbFile, budgetMs,
});

let aborted = false, abortReason = null, killVerified = null;
function killTree(reason) {
  if (aborted) return;
  aborted = true;
  abortReason = reason;
  if (!child.pid || child.exitCode !== null) { killVerified = true; return; }
  meta.terminationEvidence = stopOwnedTree(child, meta.childStartedAt);
  killVerified = verifyDead(child.pid, 10000);        // 核实，而不是"发完命令就当死了"
  if (!killVerified) { meta.terminationEvidence = stopOwnedTree(child, meta.childStartedAt); killVerified = verifyDead(child.pid, 5000); }
  killVerified = killVerified && meta.terminationEvidence.verified;
  writeMeta({ abortReason, killVerified, cancellationState: killVerified ? 'stopped' : 'needs_attention' });
  console.log('[codex] aborted (' + reason + ') child pid=' + child.pid + ' killVerified=' + killVerified);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    killTree(sig);
    writeMeta({ status: 'aborted', abortReason: sig, killVerified, ...failureSummary(sig,stderrTail,sig,'signal'), end: new Date().toISOString() });
    setTimeout(() => process.exit(130), 300);
  });
}
// 管理式提前收尾：到点由**我们自己**结束，而不是等宿主在 600s 处裸杀。
let budgetTimer = null;
if (budgetMs > 0) budgetTimer = setTimeout(() => killTree('channel-budget'), budgetMs);

let outBytes = 0, errBytes = 0, tail = '', threadId = null, stderrTail = '';
let turnUsage = null, sawQuota = false, itemCount = 0;
let turnErrorText = null, quotaEvidenceText = null, quotaEvidenceSource = null;
let stdoutChunks = 0, heartbeatChars = 0;   // 心跳噪声计量：进入指挥方上下文的零信息量文本
let lastOutAt = Date.now(), lastEventTs = null, hbSeq = 0;
let lastEventType = null, lastReasoningAt = null, lastCommandStartAt = null, turnState = 'starting';

/** 心跳：落盘且原子替换。driver 被杀后，这份文件是唯一的交叉验证源。 */
function writeHeartbeat(extra) {
  hbSeq += 1;
  const hb = Object.assign({
    runId, seq: hbSeq, ts: new Date().toISOString(), label, channel: channelInfo.channel,
    driverPid: process.pid, childPid: child.pid ?? null, budgetMs, budgetSource,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
    threadId, stdoutBytes: outBytes, stderrBytes: errBytes, items: itemCount, stdoutChunks,
    lastOutAgeMs: Date.now() - lastOutAt, lastEventTs, lastEventType, turnState, lastReasoningAt, lastCommandStartAt,
    lastEventAgeMs: lastEventTs ? Date.now()-Date.parse(lastEventTs) : null,
    childAlive: pidAlive(child.pid),
  }, extra || {});
  try {
    const tmp = hbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hb), 'utf8');
    fs.renameSync(tmp, hbFile);
  } catch (_) { /* ignore */ }
}
const cancelTimer = runId ? setInterval(() => {
  const request = readJson(path.join(logDir, 'cancel.json'));
  if (request?.runId === runId) killTree('user-cancel');
  else if (readJson(path.join(logDir, 'stop.json'))?.runId === runId) killTree(readJson(path.join(logDir,'stop.json'))?.reason || 'plugin-stop');
}, 250) : null;
const hbTimer = hbIntervalMs > 0 ? setInterval(() => writeHeartbeat({ event: 'tick' }), hbIntervalMs) : null;
writeHeartbeat({ event: 'spawned' });

function consume(line) {
  if (!line) return;
  // 注意：**不在这里扫描整行**——那行文本包含 agent 读到的源码/日志/命令回显，
  // 曾把源码行号 "2429:" 误判成额度触顶（见 drivers/quota-detect.mjs 的事故说明）。
  let o; try { o = JSON.parse(line); } catch { return; }
  try { debug.write(o); meta.logTruncated = debug.truncated; }
  catch {killTree('log-io-error');}
  lastEventTs = new Date().toISOString();
  lastEventType = o.type;
  if (/reasoning/.test(o.item?.type || o.type || '')) lastReasoningAt = lastEventTs;
  if (o.type === 'item.started' && o.item?.type === 'command_execution') lastCommandStartAt = lastEventTs;
  if (o.type === 'turn.started') {
    turnState = 'active'; meta.execTurnSequence=(meta.execTurnSequence || 0)+1;
    meta.turnId=o.turn_id || o.turn?.id || 'exec-turn-'+meta.execTurnSequence;
    writeMeta(answerSnapshot(''));
  }
  if (o.type === 'turn.completed' || o.type === 'turn.failed') turnState = o.type;
  if (o.type === 'thread.started' && o.thread_id) {
    // 立刻落盘：被杀时"thread=none"的问题就此终结（续跑要靠它）。
    threadId = o.thread_id;
    writeMeta({ threadId, snapshot: 'thread.started', snapshotAt: lastEventTs });
    writeHeartbeat({ event: 'thread.started' });
  }
  if (o.type === 'item.completed' && o.item) {
    itemCount++;
    if (isFinalAnswerItem(o.item)) writeMeta(answerSnapshot(o.item.text));
  }
  if(o.type==='turn.completed' || o.type==='turn.failed') {
    meta.turnId=o.turn_id || o.turn?.id || meta.turnId || 'exec-turn-1';
    if(o.type==='turn.failed')Object.assign(meta,failureSummary(errorTextOf(o) || 'turn failed',stderrTail,'failed','turn-error'));
    captureReply(logDir,meta,{id:meta.turnId,status:o.type==='turn.completed'?'completed':'failed'});
    writeMeta({});
  }
  if (o.type === 'turn.completed' && o.usage) {
    turnUsage = o.usage;
    const roll = readRollout(threadId);
    const rl2 = roll && roll.rateLimits ? roll.rateLimits : null;
    writeMeta({
      threadId, usage: turnUsage, rateLimits: rl2,
      quotaAfter: rl2 && rl2.primary ? rl2.primary.used_percent : null,
      snapshot: 'turn.completed', snapshotAt: lastEventTs,
    });
    writeHeartbeat({ event: 'turn.completed' });
  }
  // 只认协议级错误载荷：非额度错误记进 turnError（运行结果应为 failed，而不是 ok）。
  const errText = errorTextOf(o);
  if (errText) {
    turnErrorText = redactDiagnostic(errText).slice(0, 500);
    const hit = quotaEvidence(errText);
    if (hit) {
      sawQuota = true;
      quotaEvidenceText = errText.slice(0, 300);
      quotaEvidenceSource = 'error matched ' + hit;
    }
  }
}

const decoder = new StringDecoder('utf8');
child.stdout.on('data', (chunk) => {
  outBytes += chunk.length;
  lastOutAt = Date.now();
  stdoutChunks += 1;
  const line = '[out +' + chunk.length + 'B total=' + outBytes + 'B]\n';
  heartbeatChars += line.length;          // 无论 quiet 与否都记账：这就是"若不 quiet 会注入多少噪声"
  if (!quiet) {
    // 心跳是零信息量文本：只用于人工观察进度。默认不打，--verbose 才开，
    // 避免它按输出量无界增长地挤占指挥方的上下文预算。
    process.stdout.write(line);
  }
  tail += decoder.write(chunk);
  if (tail.length > 4194304) { tail = ''; killTree('output-limit'); return; }
  let idx;
  while ((idx = tail.indexOf('\n')) >= 0) { consume(tail.slice(0, idx)); tail = tail.slice(idx + 1); }
});
child.stderr.on('data', (chunk) => {
  errBytes += chunk.length;
  stderrTail = utf8Tail(stderrTail + chunk.toString('utf8'), 8192);
});
child.stdin.on('error', e => { if (e.code !== 'EPIPE') killTree('stdin-error'); });
child.stdin.write(promptText, 'utf8');
child.stdin.end();

child.on('error', (e) => {
  if (budgetTimer) clearTimeout(budgetTimer);
  if (hbTimer) clearInterval(hbTimer);
  if (cancelTimer) clearInterval(cancelTimer);
  unregisterLive(registryFile, process.pid);
  writeMeta({ ...failureSummary(e,stderrTail,'spawn-error'), status: 'spawn-error', end: new Date().toISOString() });
  process.exit(3);
});

child.on('close', async (code, signal) => {
  if (budgetTimer) clearTimeout(budgetTimer);
  if (hbTimer) clearInterval(hbTimer);
  if (cancelTimer) clearInterval(cancelTimer);
  unregisterLive(registryFile, process.pid);
  tail += decoder.end();
  if (tail) consume(tail);
  const elapsed = Math.round((Date.now() - t0) / 100) / 10;
  const after = readRollout(threadId);
  const rl = after && after.rateLimits ? after.rateLimits : null;
  const reached = rl && rl.rate_limit_reached_type ? String(rl.rate_limit_reached_type) : null;
  const afterPct = rl && rl.primary ? rl.primary.used_percent : null;
  // 额度判定：只认当前运行的协议错误，不把历史读数或成功后的用量当作失败。
  const verdict = quotaVerdict({
    errorTexts: quotaEvidenceText ? [quotaEvidenceText] : [],
    reached: null,
    afterPct: null, // A completed run is not a quota failure merely because the last token used the quota.
  });
  const blocked = verdict.blocked || sawQuota;
  const status = aborted
    ? 'aborted'
    : (blocked ? 'quota-blocked' : (code === 0 ? (turnErrorText ? 'failed' : 'ok') : 'failed'));

  writeMeta({
    end: new Date().toISOString(), exitCode: code, signal: signal || null, elapsedSec: elapsed,
    stdoutBytes: outBytes, stderrBytes: errBytes, stdoutChunks, heartbeatChars,
    threadId, items: itemCount,
    ...(status === 'ok' ? {termination:'ok'} : failureSummary(turnErrorText || abortReason || 'Codex exec exited with code '+code,
      stderrTail, abortReason || status, blocked ? 'usageLimitExceeded' : signal ? 'signal' : turnErrorText ? 'turn-error' : 'process-exit')),
    usage: turnUsage, rollout: after ? after.file : null, threadMatched: after ? after.threadMatched : null,
    rateLimits: rl, quotaAfter: afterPct, quotaReached: reached, status,
    // 「额度触顶」这条结论必须可审计：证据 + 来源 + 任何非额度错误原文
    quotaEvidence: verdict.evidence || (sawQuota ? quotaEvidenceSource : null),
    quotaEvidenceSource: verdict.source || (sawQuota ? 'error-event' : null),
    turnError: turnErrorText,
    // 交叉验证与"被杀也不失忆"所需字段
    channel: channelInfo.channel, parentName: channelInfo.parentName,
    budgetMs, budgetSource, budgetRequestedMs,
    killVerified, abortReason: abortReason || null,
    resumable: !!(threadId && abortReason !== 'user-cancel'),
    hbFile, hbSeq, reapedOrphans,
  });
  writeHeartbeat({ event: 'done', status, final: true, childAlive: pidAlive(child.pid) });

  // 单行紧凑结论：这是唯一需要进入指挥方上下文的文本（≈30–50 tokens）。
  // 细节全部留在 meta.json / 日志里，由指挥方按需读取。
  const u = turnUsage || {};
  console.log('[codex] ' + label + ' ' + status + ' exit=' + code +
    ' ' + elapsed + 's quota=' + (beforePct === null ? '?' : beforePct) + '%->' +
    (afterPct === null ? '?' : afterPct) + '% 7d=' + (rl && rl.secondary ? rl.secondary.used_percent + '%' : '?') +
    ' in=' + (u.input_tokens === undefined ? '?' : u.input_tokens) +
    ' out=' + (u.output_tokens === undefined ? '?' : u.output_tokens) +
    ' chunks=' + stdoutChunks + ' thread=' + (threadId || 'none') +
    ' term=' + (abortReason || status) +
    ' budget=' + (budgetMs > 0 ? Math.round(budgetMs / 1000) + 's/' + budgetSource : 'off/' + budgetSource) +
    ' killVerified=' + killVerified +
    ' meta=' + path.basename(metaFile));

  process.exit(aborted ? 130 : (code === 0 ? 0 : 1));
});
