import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { atomicJson, readJson, validRunId, recordFor, runDirectory, runEvidence, claimLock, isTerminalStatus } from './run-store.js';
import { completionNoticeMode, USER_ABORTS } from './run-facts.js';
import { replyPayload } from './reply-signals.js';
import { DSH_HANDOFF_PROMPT } from './task-handoff.js';
import { runHealth, validReplySignal } from './run-health.js';
import { processAlive, processOwnership } from './process-evidence.js';

const POLL_MS = 3000;
const FAILURES = new Set(['failed', 'spawn-error', 'killed-unknown', 'killed', 'needs_attention', 'orphan', 'stale', 'interrupted', 'aborted']);
export function noticeMarker(runId,turnId,kind) {
  return '[codex-run-notice:'+runId+':'+createHash('sha256').update(JSON.stringify([runId,turnId || null,kind])).digest('hex').slice(0,24)+']';
}
function boundedQuota(quota) {
  if(!quota)return null;
  return {state:redactNotice(quota.state,40),reason:redactNotice(quota.reason,200),
    remaining:Number.isFinite(quota.remaining)?quota.remaining:null,
    resumeAt:typeof quota.resumeAt==='number' && Number.isFinite(quota.resumeAt)?quota.resumeAt: redactedDate(quota.resumeAt),
    windows:(Array.isArray(quota.windows)?quota.windows:[]).slice(0,4).map(w=>({
      usedPercent:Number.isFinite(w.usedPercent)?w.usedPercent:null,resetAt:redactedDate(w.resetAt)}))};
}
function redactedDate(value) {return typeof value==='string'?redactNotice(value,80):Number.isFinite(value)?value:null;}

// Diagnostic data is untrusted. Never put full output, file contents or identity
// into the reminder. Redact before truncation so a cut credential stays hidden.
export function redactNotice(value, limit = 400) {
  if (typeof value !== 'string') return null;
  return value.slice(-8192)
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)\b/gi, '[secret]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[secret]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[path]')
    .replace(/\\{2}[^\s"'<>]+/g, '[path]')
    .replace(/\/(?:home|Users)\/[^\s"'<>]+/g, '[path]')
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, '[opaque]')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, limit);
}

function plainFile(file) {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Notification file redirect'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

/** Only exact plugin-owned runs eligible for notices are registered; no global CLI discovery.
 * Pointers survive host reload independently of quota recovery / DSH storages.
 * Durable intent precedes schedule.create: ambiguous delivery is reconciled by
 * marker, never automatically retried into a second model turn.
 */
export class RunNotifier {
  constructor({ schedule = null, passive = null, home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    logsRelative = '.codex-runner/logs', now = Date.now, rpcTimeoutMs = 10000 } = {}) {
    this.schedule = schedule; this.passive = passive; this.now = now; this.logsRelative = logsRelative;
    this.root = path.join(home, 'codex-runner', 'notifier-runs');
    this.runs = new Map(); this.chain = Promise.resolve(); this.closed = false;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.restore();
  }
  registryPath(runId) {
    if (!validRunId(runId)) throw Error('Invalid notification run identity');
    for (const dir of [path.dirname(this.root), this.root]) {
      try { const stat = fs.lstatSync(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Notification registry redirect'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return plainFile(path.join(this.root, runId + '.json'));
  }
  restore() {
    try {
      this.registryPath('00000000-0000-4000-8000-000000000000');
      if (!fs.existsSync(this.root)) return;
      for (const name of fs.readdirSync(this.root)) {
        const id = name.slice(0, -5); if (name !== id + '.json' || !validRunId(id)) continue;
        const pointer = readJson(this.registryPath(id));
        if (pointer?.runId === id && typeof pointer.cwd === 'string' && path.isAbsolute(pointer.cwd)) this.runs.set(id, pointer);
      }
    } catch (error) { this.error = redactNotice(error.message); }
  }
  track({ cwd, record }) {
    if (this.closed || !record || !validRunId(record.runId) || !path.isAbsolute(cwd)) return;
    const pointer = { runId: record.runId, cwd: path.resolve(cwd), label:record.label,
      sessionId:record.sessionId, detached:record.detached, createdAt:record.createdAt,
      notifyOnComplete:record.notifyOnComplete };
    this.runs.set(record.runId, pointer);
    try {
      atomicJson(this.registryPath(record.runId), pointer);
      const dir = runDirectory(path.join(cwd, this.logsRelative), record);
      if (!record.sessionId) this.diagnostic(dir, record.runId, 'missing-session');
      else if (!this.passive && !this.schedule?.create) this.diagnostic(dir, record.runId, 'missing-schedule');
    } catch (error) { this.error = redactNotice(error.message); }
  }
  bind(schedule) { this.schedule = schedule; }
  async rpc(call) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(call), new Promise((_,reject) => {
      timer=setTimeout(()=>reject(Error('Notification service timed out; delivery uncertain')),this.rpcTimeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  start() {
    if (this.closed || this.timer) return this;
    this.timer = setInterval(() => { if (!this.polling) void this.poll(); }, POLL_MS);
    this.timer.unref?.(); return this;
  }
  async close() { this.closed = true; clearInterval(this.timer); this.timer = null; await this.chain; }
  diagnostic(dir, runId, code, error) {
    const file = plainFile(path.join(dir, 'notify-error.json')), message = redactNotice(error?.message || error);
    const previous = readJson(file);
    if (previous?.code === code && previous?.error === message) return;
    atomicJson(file, { runId, at: new Date(this.now()).toISOString(), code, error: message });
  }
  forget(id) {
    this.runs.delete(id);
    try { fs.unlinkSync(this.registryPath(id)); } catch (error) { if (error.code !== 'ENOENT') this.error = redactNotice(error.message); }
  }
  poll() {
    const task = this.chain.then(async () => {
      if (this.closed) return;
      this.polling = true;
      try {
        for (const pointer of [...this.runs.values()]) {
          if (this.closed) break;
          try { await this.inspect(pointer); } catch (error) { this.error = redactNotice(error.message); }
        }
      } finally { this.polling = false; }
    });
    this.chain = task.catch(() => {}); return task;
  }
  async inspect(pointer) {
    const { cwd, runId } = pointer;
    const logs = path.join(cwd, this.logsRelative), stored = recordFor(logs, runId);
    const recordMissing = !stored || path.resolve(stored.cwd || '') !== path.resolve(cwd);
    const record = recordMissing ? pointer : stored;
    const dir = runDirectory(logs, record);
    const file = name => plainFile(path.join(dir, name));
    const cancelled = () => readJson(file('cancel.json'))?.runId === runId;
    if (cancelled()) { this.forget(runId); return; }
    if (recordMissing) {
      await this.deliver({record,dir,file,cancelled,kind:'record-unavailable',payload:{run_id:runId,
        status:'needs_attention',task_state:'unknown',needs_dsh_decision:true,decision_reason:'record_unavailable',
        handoff:{owner:'dsh',action:'locate_run',dispatch:'blocked'},answer_preview:''}});
      return;
    }
    const evidence = runEvidence(logs, record, { now: this.now() }), meta = evidence.meta || {};
    const recovery=readJson(file('recovery-state.json'));
    let status = recovery?.runId===runId && recovery.phase==='needs_attention' ? 'needs_attention'
      : meta.status || (record.state === 'spawn-error' ? 'spawn-error' : evidence.liveness);
    // A driver can die before writing terminal metadata. A persisted 'running'
    // value must not conceal stale/orphan/unknown process evidence forever.
    if (!evidence.driverAlive && !evidence.spawnPending && !isTerminalStatus(status))
      status = evidence.liveness === 'unknown' ? 'needs_attention' : evidence.liveness;
    if (USER_ABORTS.has(meta.abortReason) || status === 'cancelled') { this.forget(runId); return; }
    evidence.healthIssue = runHealth(record,evidence,this.now());
    if (evidence.healthIssue) {
      if (!await this.deliver({record,dir,file,cancelled,kind:'health:'+evidence.healthIssue,
        payload:replyPayload(runId,meta,'needs_attention',evidence)})) return;
    }
    if (!record.detached) {
      const returned=readJson(file('tool-returned.json'));
      if (returned?.runId === runId && recovery?.phase !== 'needs_attention') {
        try { fs.unlinkSync(file('notify-error.json')); } catch(error) { if(error.code!=='ENOENT')throw error; }
        if (!recovery || ['completed','cancelled','resumed'].includes(recovery.phase)) this.forget(runId);
        return;
      }
      if (evidence.driverAlive || evidence.spawnPending) return;
      // Give the synchronous call time to submit its result. If its owner died,
      // the channel was aborted, or the result never arrives, use the outbox.
      const ownerAlive=processAlive(record.ownerPid) && processOwnership(record.ownerPid,record.ownerStartedAt)!=='mismatch';
      let ended=Date.parse(meta.end);
      if (!Number.isFinite(ended)) { try { ended=fs.statSync(file('result.meta.json')).mtimeMs; } catch {} }
      if (ownerAlive && !fs.existsSync(file('stop.json')) && this.now()-ended < 10000) return;
    }
    const current = replyPayload(runId,meta,status,{...evidence,recovery:recovery?.runId===runId?recovery:null});
    const signals=Array.isArray(meta.replySignals)?meta.replySignals.filter(validReplySignal).slice(0,64):[];
    // Reply snapshots must be consumed even while the next queued turn is live.
    for(const signal of signals) {
      if(meta.interruptRequested && ['interrupted','aborted'].includes(signal.status))continue;
      const currentFailure=signal.status==='failed' && signal.turn_id===meta.turnId;
      const payload={...signal,handoff:current.handoff,pending_messages:current.pending_messages,
        ...(current.pending_messages > 0 && !evidence.driverAlive ? {needs_dsh_decision:true,decision_reason:'pending_messages'} : {}),
        error:redactNotice(signal.error || (currentFailure?meta.error:null)),
        stderr_tail:redactNotice(signal.stderr_tail || (currentFailure?meta.stderr_tail:null))};
      const kind = ['ok','completed'].includes(signal.status) ? 'reply' : 'failure';
      if(!await this.deliver({record,dir,file,cancelled,payload,kind,sequence:signal.sequence}))return;
    }
    if (evidence.driverAlive || evidence.spawnPending) return;
    if (evidence.childAlive && evidence.childOwner === 'match') status = 'orphan';
    const eligible=FAILURES.has(status) || ['ok','completed','waiting_quota','quota-blocked'].includes(status);
    if(!eligible)return;
    const alreadyCaptured=signals.some(s=>s.turn_id===meta.turnId && s.status===status)
      || (meta.lastReplyTurnId && meta.lastReplyTurnId===meta.turnId && ['ok','completed','failed','interrupted','aborted'].includes(status));
    if(!alreadyCaptured) {
      const payload={...replyPayload(runId,meta,status,{...evidence,recovery:recovery?.runId===runId?recovery:null}),
        termination: redactNotice(meta.termination || meta.abortReason || status, 100),
        exit:Number.isInteger(meta.exitCode)?meta.exitCode:null,child_alive:evidence.childAlive===true,
        error:redactNotice(meta.error),stderr_tail: redactNotice(meta.stderr_tail) };
      const kind = ['ok','completed'].includes(status) ? 'reply' : (FAILURES.has(status) ? 'failure' : status);
      if(!await this.deliver({record,dir,file,cancelled,payload,kind}))return;
    }
    if(!recovery || ['completed','cancelled','resumed'].includes(recovery.phase))this.forget(runId);
  }
  async deliver({record,dir,file,cancelled,payload,kind,sequence=0}) {
    const runId=record.runId;
    const keyTurn=payload.turn_id || null;
    const key=JSON.stringify([runId,keyTurn,kind]);
    const marker=noticeMarker(runId,keyTurn,kind);
    const acknowledged=ack=>ack?.runId===runId &&
      (sequence ? ack.replySequence>=sequence : ack.key===key || ack.keys?.includes(key) || (!ack.key && !ack.replySequence));
    if(acknowledged(readJson(file('notified.json'))))return true;
    if (typeof record.sessionId !== 'string' || !record.sessionId) { this.diagnostic(dir, runId, 'missing-session'); return; }
    const schedule = this.schedule;
    if (!this.passive && typeof schedule?.create !== 'function') { this.diagnostic(dir, runId, 'missing-schedule'); return; }
    const release = claimLock(file('notify.lock'), { owner: 'run-notifier', root: path.resolve(record.cwd), tasks: path.resolve(dir) });
    if (!release) return;
    try {
      if (this.closed || cancelled()) return;
      let previous=readJson(file('notified.json'));
      if(acknowledged(previous))return true;
      const intentFile = file('notify-intent.json'), storedIntent = readJson(intentFile);
      // A new event must not overwrite an unresolved earlier delivery. A lost
      // create response may already have enqueued the earlier DSH turn.
      if (storedIntent?.key && storedIntent.key!==key && previous?.key!==storedIntent.key && !previous?.keys?.includes(storedIntent.key)) {
        let earlier;
        try { earlier=typeof schedule?.list==='function'
          ? (await this.rpc(()=>schedule.list({sessionId:record.sessionId}))).find(s=>s.prompt?.includes(storedIntent.marker)) : null; }
        catch(error) { this.diagnostic(dir,runId,'schedule-reconcile-failed',error);return; }
        if(!earlier) { this.diagnostic(dir,runId,'delivery-unknown');return; }
        previous={...previous,runId,key:storedIntent.key,
          keys:[...new Set([...(previous?.keys || []),previous?.key,storedIntent.key].filter(Boolean))].slice(-128),
          replySequence:Math.max(previous?.replySequence || 0,storedIntent.sequence || 0),
          notifiedAt:new Date(this.now()).toISOString(),scheduleId:earlier.id};
        atomicJson(file('notified.json'),previous);
      }
      const intent=storedIntent && (!storedIntent.key || storedIntent.key===key) ? storedIntent : null;
      let delivered;
      if (intent) {
        if (typeof schedule?.list === 'function') {
          try { delivered = (await this.rpc(()=>schedule.list({ sessionId: record.sessionId }))).find(s => s.prompt?.includes(marker)); }
          catch (error) { this.diagnostic(dir, runId, 'schedule-reconcile-failed', error); return; }
        }
        if (!delivered) {
          if (!readJson(file('notify-error.json'))) this.diagnostic(dir, runId, 'delivery-unknown');
          return;
        }
      } else {
        // Recheck the run just before delivery. Only unchanged, fully ended replies
        // with a complete safe answer can be reviewed without another tool call.
        const evidence=runEvidence(path.join(record.cwd,this.logsRelative),record,{now:this.now()});
        const meta=evidence.meta||{},recovery=readJson(file('recovery-state.json'));
        const current=replyPayload(runId,meta,meta.status,{...evidence,recovery});
        const answer=typeof meta.lastMessage==='string'?meta.lastMessage:'';
        const safeAnswer=answer.length<=500&&redactNotice(answer,500)===answer.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ');
        const complete=kind==='reply'&&['ok','completed'].includes(meta.status)&&meta.runId===runId
          &&(payload.turn_id||null)===(meta.turnId||null)&&meta.killVerified===true&&!meta.abortReason&&!meta.error
          &&Number.isFinite(Date.parse(meta.end))&&!evidence.driverAlive&&!evidence.childAlive&&!evidence.spawnPending
          &&!evidence.userCancelled&&!runHealth(record,evidence,this.now())&&!recovery&&!current.pending_messages
          &&!current.subagents.running&&!current.subagents.unknown&&!current.subagents.failed&&!current.subagents.truncated
          &&current.has_final_answer&&!current.answer_truncated&&safeAnswer&&current.handoff.action==='review_result';
        payload={...payload,...(complete?{...current,answer_preview:answer}:{}),answer_complete:!!complete,
          requires_status_refresh:!complete,observed_at:new Date(this.now()).toISOString()};
        const mode=completionNoticeMode(record);
        const abnormal=kind!=='reply' || ['empty_answer','pending_messages','subagents_failed'].includes(payload.decision_reason);
        const wake=mode==='always' || (payload.needs_dsh_decision===true && (mode==='decision' || abnormal));
        payload={...payload,run_id:runId,label:redactNotice(record.label,80),kind,
          thread_id:redactNotice(payload.thread_id,100),answer_preview:complete?answer:redactNotice(payload.answer_preview,500) || '',
          quota:boundedQuota(payload.quota),wake_dsh:wake};
        const prompt = marker + '\n[Codex] ' + DSH_HANDOFF_PROMPT + '\n' + JSON.stringify(payload);
        atomicJson(intentFile, { runId, key, sequence, attemptedAt: new Date(this.now()).toISOString(), marker });
        if (this.closed || cancelled()) { fs.unlinkSync(intentFile); return; }
        try {
          // A passive adapter is used when the host provides a supported one.
          // Schedule-only hosts use ONE reminder for visibility and optional wake.
          if(this.passive) {
            delivered=await this.rpc(()=>this.passive(record.sessionId,{text:prompt,key}));
            if(wake && schedule?.create) {
              delivered=await this.rpc(()=>schedule.create(record.sessionId,{title:'Codex decision',at:new Date(this.now()+1000).toISOString(),prompt}));
              if(!delivered?.id)throw Error('Notification schedule creation not confirmed');
            }
          } else {
            delivered = await this.rpc(()=>schedule.create(record.sessionId, { title: 'Codex reply', at: new Date(this.now() + 1000).toISOString(), prompt }));
            if(!delivered?.id)throw Error('Notification schedule creation not confirmed');
          }
        }
        catch (error) { this.diagnostic(dir, runId, 'schedule-create-failed', error); return; }
      }
      atomicJson(file('notified.json'), { runId, key, replySequence:sequence || previous?.replySequence || 0,
        keys:[...new Set([...(previous?.keys || []),previous?.key,key].filter(Boolean))].slice(-128),
        notifiedAt: new Date(this.now()).toISOString(), scheduleId: delivered?.id || null });
      try { fs.unlinkSync(file('notify-error.json')); } catch(error) { if(error.code!=='ENOENT')throw error; }
      // Cancellation during the RPC should remove the pending reminder where
      // the shared service supports it; it can never restart the Codex task.
      if (cancelled() && delivered?.id && typeof schedule?.delete === 'function') {
        try { await this.rpc(()=>schedule.delete({ sessionId: record.sessionId, id: delivered.id })); }
        catch (error) { this.diagnostic(dir, runId, 'cancel-reminder-failed', error); }
      }
      return true;
    } catch (error) { this.diagnostic(dir, runId, 'notification-persistence-failed', error); }
    finally {
      release();
    }
  }
}
