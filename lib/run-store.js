import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processOwnership, processStartedAt } from './process-evidence.js';
import { runHealth } from './run-health.js';
import { USER_ABORTS } from './run-facts.js';

export const DEFAULT_RUN_RETENTION_DAYS = 0;
export const DEFAULT_RETAINED_RUNS = 0;

export function validateLabel(label) {
  return typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(label)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(label);
}
export const validRunId = (id) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export const isTerminalStatus = status => ['ok','completed','failed','aborted','interrupted','cancelled','spawn-error','killed',
  'killed-unknown','waiting_quota','quota-blocked','needs_attention','orphan','stale'].includes(status);
export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) {} }
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    // Windows can transiently reject rename while a reader/AV has the target
    // open. Retry the atomic replace without ever exposing a partial file.
    let lastError;
    for (let attempt = 0; attempt < 7; attempt++) {
      try { fs.renameSync(tmp, file); return; }
      catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 6) throw error;
        sleepSync(10 * (attempt + 1));
      }
    }
    throw lastError;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Serialize pathname changes, including stale takeover. Never reclaim this
// short-lived guard automatically: an interrupted guard needs explicit review.
export function claimLock(lock, identity) {
  const guard = lock + '.claim';
  let gate;
  try { gate = fs.openSync(guard, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  try {
    const owner = readJson(lock);
    if (fs.existsSync(lock)) {
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(Date.parse(owner.startedAt))
        || Object.entries(identity).some(([key, value]) => owner[key] !== value)
        || (alive(owner.pid) && processOwnership(owner.pid, owner.startedAt) !== 'mismatch')) return null;
      // The guard excludes every other claimant while ownership is rechecked.
      fs.unlinkSync(lock);
    }
    const token = randomUUID();
    const fd = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ ...identity, pid: process.pid, startedAt: processStartedAt(), token })); }
    catch (error) { fs.unlinkSync(lock); throw error; }
    finally { fs.closeSync(fd); }
    return () => { if (readJson(lock)?.token === token) fs.unlinkSync(lock); };
  } finally { fs.closeSync(gate); fs.unlinkSync(guard); }
}
// The workspace itself may be a junction. Plugin data/logs/runs must not redirect.
export function assertStorePath(logDir) {
  for (const dir of [path.dirname(logDir), logDir, path.join(logDir, 'runs')]) {
    let stat;
    try { stat=fs.lstatSync(dir); } catch(error) { if(error.code==='ENOENT')continue;throw error; }
    if(stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Run store directory redirect or invalid directory: '+dir);
  }
}
export function listRecords(logDir) {
  assertStorePath(logDir);
  const root = path.join(logDir, 'runs');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(validRunId).map(id => recordFor(logDir, id))
    .filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function recordFor(logDir, selector) {
  assertStorePath(logDir);
  if (validRunId(selector)) {
    const dir = path.join(logDir, 'runs', selector);
    try { if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return null; } catch { return null; }
    const r = readJson(path.join(dir, 'run.json'));
    return r && r.runId === selector && validateLabel(r.label) && typeof r.createdAt === 'string'
      && Number.isFinite(Date.parse(r.createdAt)) ? r : null;
  }
  if (!validateLabel(selector)) return null;
  return listRecords(logDir).find(r => r.label === selector) || null;
}
export function runDirectory(logDir, record) {
  assertStorePath(logDir);
  if(!validRunId(record?.runId))throw Error('Invalid run identity');
  const dir=path.join(logDir,'runs',record.runId);
  try { if(fs.lstatSync(dir).isSymbolicLink())throw Error('Run directory redirect'); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  return dir;
}
export function updateRecord(logDir, record, patch) {
  const file = path.join(runDirectory(logDir, record), 'run.json');
  const next = { ...(readJson(file) || record), ...patch };
  atomicJson(file, next); return next;
}
export function runEvidence(logDir, record, { now = Date.now(), isAlive = alive, ownership = processOwnership } = {}) {
  const dir = runDirectory(logDir, record);
  const latest=readJson(path.join(dir,'run.json'));
  if(latest?.runId===record.runId)record=latest;
  const meta = readJson(path.join(dir, 'terminal.json')) || readJson(path.join(dir, 'result.meta.json'));
  const hb = readJson(path.join(dir, 'result.hb.json'));
  const driverPid = record.driverPid || meta?.driverPid;
  const childPid = meta?.childPid || record.childPid || null;
  const driverPresent = isAlive(driverPid), childPresent = isAlive(childPid);
  const fresh = hb?.runId === record.runId && now - Date.parse(hb.ts) < 30000;
  const driverOwner = driverPresent ? (fresh ? 'match' : ownership(driverPid, record.driverStartedAt || meta?.driverStartedAt)) : 'dead';
  const driverAlive = driverPresent && driverOwner !== 'mismatch';
  const terminal = isTerminalStatus(meta?.status) || isTerminalStatus(record.state);
  const childOwner = childPresent ? (driverAlive && !terminal ? 'unknown' : ownership(childPid, meta?.childStartedAt || record.childStartedAt)) : 'dead';
  const childAlive = childPresent && childOwner !== 'mismatch';
  const spawnPending = !meta?.status && record.state === 'spawning' && isAlive(record.ownerPid)
    && ownership(record.ownerPid, record.ownerStartedAt) !== 'mismatch';
  let liveness = terminal ? 'terminal' : driverAlive || spawnPending ? 'running'
    : childAlive ? (childOwner === 'match' ? 'orphan' : 'unknown') : fresh ? 'unknown' : 'stale';
  const released = readJson(path.join(dir, 'released.json'))?.runId === record.runId;
  const userCancelled = readJson(path.join(dir, 'cancel.json'))?.runId === record.runId;
  const evidence = { meta, hb, childPid, driverAlive, childAlive, spawnPending, liveness, driverOwner, childOwner, userCancelled,
    released, running: !terminal && liveness === 'running',
    // A terminal PID alone may belong to another process after PID reuse.
    active: !released && (terminal ? childAlive && childOwner === 'match' : liveness !== 'stale'),
    cleanupSafe: terminal && ![record,meta,hb,readJson(path.join(dir,'result.meta.json'))].some(value=>
      alive(value?.driverPid) || alive(value?.childPid)) };
  const pending=readJson(path.join(dir,'pending-messages.json'));
  evidence.pendingMessages=Array.isArray(pending)?pending.length:(meta?.pendingMessages || 0);
  evidence.healthIssue=runHealth(record,evidence,now);
  return evidence;
}
export function reserveRun(logDir, label, maxConcurrent = 1, { resumeThread = null } = {}) {
  if (!validateLabel(label)) throw Error('label must be 1–80 letters, digits, underscores or hyphens; reserved names are forbidden');
  assertStorePath(logDir);
  fs.mkdirSync(logDir, { recursive: true });
  const lock = path.join(logDir, 'admission.lock');
  const release = claimLock(lock, { owner: 'run-admission', root: path.resolve(logDir), tasks: path.resolve(logDir, 'runs') });
  if (!release) throw Error('Another launcher holds admission.lock; retry after an explicit lock-file check if necessary');
  try {
    const runs = listRecords(logDir).map(record => ({record, evidence:runEvidence(logDir, record)}));
    // Reserve the thread identity under the same lock as admission. A different
    // label or a released orphan must not start a second writer to that thread.
    if (resumeThread && runs.some(({record, evidence}) =>
      (record.resumeThread === resumeThread || evidence.meta?.threadId === resumeThread) &&
      (evidence.active || evidence.driverAlive || evidence.childAlive || evidence.spawnPending)))
      throw Error('Codex thread already has an active or unresolved run; query its status before continuing');
    const active = runs.filter(({evidence}) => evidence.active).map(({record}) => record);
    if (active.some(r => r.label === label)) throw Error('label 已在跑；先查询或取消该任务');
    if (active.length >= maxConcurrent) throw Error('Workspace concurrency limit reached; wait or cancel the active run');
    const record = { runId: randomUUID(), label, resumeThread, createdAt: new Date().toISOString(), state: 'spawning', ownerPid: process.pid, ownerStartedAt: processStartedAt() };
    atomicJson(path.join(runDirectory(logDir, record), 'run.json'), record);
    return record;
  } finally { release(); }
}
export function cleanupRuns(logDir, retentionDays = DEFAULT_RUN_RETENTION_DAYS, keep = DEFAULT_RETAINED_RUNS) {
  if([retentionDays,keep].some(value=>!Number.isSafeInteger(value)||value<0||value>2147483647))throw Error('Retention limits must be integers 0..2147483647');
  const cutoff = Date.now() - retentionDays * 86400000;
  const records = listRecords(logDir);
  for (const [index, r] of records.entries()) {
    const dir = runDirectory(logDir, r);
    const evidence=runEvidence(logDir,r),m=evidence.meta;
    const recovery=readJson(path.join(dir,'recovery-state.json'));
    const resolved=readJson(path.join(dir,'cancel.json'))?.runId===r.runId || readJson(path.join(dir,'recovery-resolved.json'))?.runId===r.runId;
    const receipt=readJson(path.join(dir,'notified.json')) || (!r.detached && readJson(path.join(dir,'tool-returned.json')));
    // Preserve evidence while a reply has not been submitted. A host
    // outage must not turn a delayed notification into a deleted task record.
    if(r.sessionId && !resolved && m?.status!=='cancelled' && !USER_ABORTS.has(m?.abortReason) && (receipt?.runId!==r.runId
      || fs.existsSync(path.join(dir,'notify-error.json'))
      || (m?.replySignals || []).some(s=>s.sequence>(receipt.replySequence || 0))))continue;
    // Recovery may need attention even after a successful process exit. A
    // durable registration protects the interval before its first status poll.
    if(!resolved && (['waiting_quota','quota-blocked','needs_attention'].includes(m?.status)
      || (recovery?.runId===r.runId && !['completed','cancelled'].includes(recovery.phase))
      || fs.existsSync(path.join(dir,'recovery-task.md')) && !['completed','cancelled'].includes(recovery?.phase)))continue;
    if (!evidence.cleanupSafe) continue;
    // Only remove UUID directories created by this store, never links or external paths.
    if (fs.lstatSync(dir).isSymbolicLink()) continue;
    const items=fs.readdirSync(dir,{withFileTypes:true});
    if(items.some(item=>item.isSymbolicLink() || item.isDirectory()))continue;
    // Debug/legacy bulk data expires before fixed metadata, regardless of age.
    for(const name of ['events.jsonl','answer.txt','result.err.log','result.jsonl']) {
      const file=path.join(dir,name);
      if(items.some(item=>item.name===name && item.isFile()))fs.unlinkSync(file);
    }
    const ageExpired=retentionDays>0 && Date.parse(r.createdAt)<cutoff;
    const countExceeded=keep>0 && index>=keep;
    if (!ageExpired && !countExceeded) continue;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isFile()) fs.unlinkSync(path.join(dir, item.name));
    }
    try { fs.rmdirSync(dir); } catch {}
  }
}
