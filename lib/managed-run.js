import { createSubagentTracker } from './subagent-view.js';
import { stopOwnedTree } from './owned-process.js';
import fs from 'node:fs';
import path from 'node:path';
import { AppServerClient } from './app-server-client.js';
import { atomicJson, readJson, alive, validRunId } from './run-store.js';
import { drainControls } from './run-control.js';
import { quotaDecision, accountFingerprint } from './quota-policy.js';
import { processStartedAt } from './process-evidence.js';
import { normalizeModels, validateCatalogSelection } from './model-catalog.js';
import { answerSnapshot, isFinalAnswerItem, createDebugLog, failureSummary, DEBUG_MAX_BYTES } from './run-data.js';
import { captureReply, pendingReplies, MAX_PENDING_REPLIES } from './reply-signals.js';

/** Owns one Codex connection. Control acknowledgements describe RPC acceptance, not task completion. */
export async function runManaged(options, createClient = opts => new AppServerClient(opts)) {
  const { cwd, logDir, runId, prompt, model, effort, resumeThread, sandbox = 'workspace-write',
    config = {}, budgetMs = 0, debugLogs = false, debugMaxBytes = DEBUG_MAX_BYTES, autoResumeAfterQuota = false,
    quotaWarning = false, quotaWarningThreshold = 5, pauseGraceMs = 0 } = options;
  if (!validRunId(runId) || !path.isAbsolute(cwd) || !path.isAbsolute(logDir)) throw Error('Invalid run identity or directories');
  if (!['workspace-write', 'read-only', 'danger-full-access'].includes(sandbox)) throw Error('Invalid sandbox');
  const warningThreshold = Number.isInteger(Number(quotaWarningThreshold)) && quotaWarningThreshold >= 0 && quotaWarningThreshold <= 20
    ? Number(quotaWarningThreshold) : 5;
  const recoveryEnabled = autoResumeAfterQuota === true;
  const subagentTracker=createSubagentTracker();
  const started = Date.now();
  const metaFile = path.join(logDir, 'result.meta.json');
  const queueFile = path.join(logDir, 'pending-messages.json');
  const meta = { runId, backend: 'app-server', driverPid: process.pid, driverStartedAt: processStartedAt(), model, effort, cwd,
    subagents:subagentTracker.snapshot(),start: new Date(started).toISOString(), threadId: null, turnId: null, lastMessage: '',
    autoResumeAfterQuota: recoveryEnabled, configInheritance: 'Codex user configuration; explicit run overrides', debugLogs, debugMaxBytes, logTruncated: false, budgetMs,
    answerLength:0, answerTruncated:false };
  const debug = createDebugLog(logDir,{debugLogs,debugMaxBytes});
  let client, timer, guard, ticking = false, finishing = false, sequence = 0;
  let queue = [], completed = null, turnPending = false;
  const completedStatus = () => completed.status === 'completed' ? 'ok'
    : ['interrupted', 'aborted'].includes(completed.status) ? completed.status : 'failed';
  let lastQuotaPoll = 0, pauseRequestedAt = 0, quotaDirty = false, secondSteerAt = 0, lastPersist = 0;
  const serviceTier = config.service_tier === 'fast' ? 'priority' : (config.service_tier || null);
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const persist = (force = false) => {
    if (!force && Date.now() - lastPersist < 1000) return;
    atomicJson(metaFile, meta); lastPersist = Date.now();
  };
  const writeQueue = () => atomicJson(queueFile, queue);
  const log = (method, params) => {
    debug.write({ ts: new Date().toISOString(), method, params });
    meta.logTruncated = debug.truncated;
  };
  async function finish(status, reason, error) {
    if (finishing) return;
    finishing = true; clearInterval(timer); clearInterval(guard);
    meta.status = status; meta.abortReason = reason || null;
    meta.termination = reason || status;
    meta.pendingMessages = queue.length;
    try {
      try { if (client) await client.close(); } catch (closeError) {
        meta.closeError = String(closeError.message || closeError);
        // This connection object owns the child, so identity is not inferred from a stored PID.
        try { meta.terminationEvidence=stopOwnedTree(client.child,meta.childStartedAt); } catch (error) { meta.terminationError=error.message; }
      }
      meta.terminationEvidence ||= client?.terminationEvidence;
      meta.killVerified = !alive(client?.child?.pid) && meta.terminationEvidence?.verified !== false;
      if (status !== 'ok') Object.assign(meta, failureSummary(error || completed?.error?.message || reason || status,
        client?.stderrTail, meta.termination, typeof completed?.error?.codexErrorInfo === 'string' ? completed.error.codexErrorInfo : reason || 'turn-error'));
      meta.end = new Date().toISOString(); meta.elapsedSec = Math.round((Date.now() - started) / 1000);meta.exitCode=status==='ok'?0:1;
      const { lastMessage, rateLimitsRaw, ...heartbeat } = meta;
      try {atomicJson(path.join(logDir,'result.hb.json'),{...heartbeat,seq:++sequence,ts:meta.end,final:true,childAlive:alive(meta.childPid)});}catch{}
      try { persist(true); } catch (persistError) {
        meta.status='failed';Object.assign(meta,failureSummary(persistError,client?.stderrTail,'metadata-write-failed','metadata-write-failed'));
        // Preserve child identity for admission even if the primary metadata
        // target cannot be replaced. Readers always see complete JSON.
        try { atomicJson(path.join(logDir,'terminal.json'),meta); } catch {}
      }
    } finally { clearInterval(timer); clearInterval(guard); resolveDone(meta); }
  }
  async function startTurn(text) {
    turnPending = true; completed = null; meta.turnId = null; Object.assign(meta,answerSnapshot(''));
    const policy = sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: config['sandbox_workspace_write.network_access'] === true };
    try {
      const result = await client.request('turn/start', { threadId: meta.threadId, input: [{ type: 'text', text }],
        cwd, model, effort, serviceTier, approvalPolicy: config.approval_policy || 'never', sandboxPolicy: policy });
      meta.turnId = result.turn.id; meta.turnState = 'active'; persist(true);
    } finally { turnPending = false; }
  }
  async function control(request) {
    if (finishing) throw Error('Run is closing');
    if (pauseRequestedAt && request.action !== 'interrupt') throw Error('Quota pause is in progress');
    if (request.action === 'queue') {
      if (queue.length >= 32) throw Error('Pending message limit reached');
      queue.push({ id: request.id, text: request.message }); writeQueue();
      meta.pendingMessages = queue.length; persist();
      return { action: 'queue', delivery: 'persisted_for_next_turn', threadId: meta.threadId };
    }
    if (!meta.turnId || completed || turnPending) throw Error('No matching active turn; retry after status check');
    if (request.action === 'steer') {
      await client.request('turn/steer', { threadId: meta.threadId, expectedTurnId: meta.turnId, input: [{ type: 'text', text: request.message }] });
      return { action: 'steer', delivery: 'accepted_by_active_turn', threadId: meta.threadId, turnId: meta.turnId };
    }
    await client.request('turn/interrupt', { threadId: meta.threadId, turnId: meta.turnId });
    meta.interruptRequested = true; persist();
    return { action: 'interrupt', delivery: 'interrupt_requested', threadId: meta.threadId, turnId: meta.turnId };
  }
  function warningMessage(quota) {
    const remaining = Number.isFinite(quota?.remaining) ? Math.max(0, Math.round(quota.remaining)) + '%' : '低于阈值';
    const threshold = Number.isFinite(quota?.threshold) ? quota.threshold + '%' : warningThreshold + '%';
    return '⚠️ 额度告警：Codex 剩余额度' + (Number.isFinite(quota?.remaining) ? '约 ' + remaining : '') +
      '，已达到提醒阈值 ' + threshold + '。额度即将触顶，请立即暂停当前任务：保存已完成工作、待办事项和验证状态的检查点，然后结束本回合；不要开始新的工作。' + (recoveryEnabled ? '额度恢复后将自动继续原任务。' : '自动继续未开启，请保持暂停，等待用户手动继续。');
  }
  async function checkQuota(mode = 'auto') {
    lastQuotaPoll = Date.now();
    quotaDirty = false;
    try {
      const response = await client.request('account/rateLimits/read');
      const now = Date.now();
      const hard = quotaDecision(response, now);
      const soft=mode!=='hard'&&quotaWarning?quotaDecision(response,now,now,100-warningThreshold):null;
      const decision=soft?.state==='blocked'?{...soft,reason:'warning-threshold'}:hard.state==='blocked'?{...hard,reason:'hard-limit'}:hard;
      const windows = decision.windows || [];
      const remaining = windows.length ? Math.min(...windows.map((w) => 100 - w.usedPercent)) : null;
      meta.quota = { ...decision, remaining, threshold: quotaWarning ? warningThreshold : null, sampledAt: now };
      const account=await client.request('account/read',{refreshToken:false});
      meta.accountPlan=account.account?.planType||account.account?.plan_type||null;
      const fingerprint=accountFingerprint(account);
      if (!fingerprint || (meta.accountFingerprint && meta.accountFingerprint !== fingerprint)) meta.quota = { ...meta.quota, state: 'unknown', reason: 'account-not-verifiable-or-changed' };
      else meta.accountFingerprint = fingerprint;
      meta.quotaSampledAt = Date.now();
    } catch (error) { meta.quota = { state: 'unknown', reason: 'quota-read-failed' }; }
    persist(); return meta.quota;
  }
  try {
    fs.mkdirSync(logDir, { recursive: true }); persist(); writeQueue();
    client = createClient({ cwd }); meta.childPid = client.child?.pid; meta.childStartedAt = new Date().toISOString(); persist(true);
    const recordFile=path.join(logDir,'run.json'), record=readJson(recordFile);
    if(record?.runId===runId)atomicJson(recordFile,{...record,driverPid:meta.driverPid,driverStartedAt:meta.driverStartedAt,childPid:meta.childPid,childStartedAt:meta.childStartedAt});
    guard = setInterval(() => {
      if (finishing) return;
      if (readJson(path.join(logDir,'cancel.json'))?.runId===runId) void finish('cancelled','user-cancel');
      else if (readJson(path.join(logDir,'stop.json'))?.runId===runId) {
        if(pauseRequestedAt){meta.pauseOutcome='timeout_without_checkpoint_confirmation';void finish('waiting_quota','quota-pause-timeout');}
        else void finish('killed',readJson(path.join(logDir,'stop.json'))?.reason || 'plugin-stop');
      }
      else if (budgetMs>0 && Date.now()-started>=budgetMs) {
        if(pauseRequestedAt){meta.pauseOutcome='budget_interrupt_without_checkpoint_confirmation';void finish('waiting_quota','quota-pause-budget');}
        else void finish('killed','channel-budget');
      }
    },100);
    client.on('fault', error => { if (!finishing) void finish('failed', 'connection-failure', error); });
    client.on('notification', (method, params) => {
      if (finishing) return;
      log(method, params);
      if (params.threadId && params.threadId !== meta.threadId) return;
      if(params.item){subagentTracker.observe(params.item);meta.subagents=subagentTracker.snapshot();}
      meta.lastEventType = method; meta.lastEventAt = Date.now();
      if (/reasoning/i.test(method) || /reasoning/i.test(params.item?.type || '')) meta.lastReasoningAt = new Date().toISOString();
      if (method === 'item/started' && params.item?.type === 'commandExecution') meta.lastCommandStartAt = new Date().toISOString();
      if (method === 'turn/started') meta.turnId = params.turn.id;
      if (method === 'item/completed' && isFinalAnswerItem(params.item)) {
        Object.assign(meta,answerSnapshot(params.item.text));
        persist(true);
      }
      if (method === 'turn/completed' && (!meta.turnId || params.turn.id===meta.turnId)) {
        completed = params.turn; meta.turnState = params.turn.status;
        if(params.turn.status==='failed')Object.assign(meta,failureSummary(params.turn.error?.message || 'turn failed',
          client?.stderrTail,'failed',typeof params.turn.error?.codexErrorInfo==='string'?params.turn.error.codexErrorInfo:'turn-error'));
        try { captureReply(logDir,meta,params.turn); persist(true); }
        catch(error) { void finish('needs_attention','reply-signal-persistence',error); }
      }
      if (method === 'account/rateLimits/updated') { meta.rateLimitsRaw = params; quotaDirty = true; }
    });
    await client.initialize();
    let catalogRows=[],cursor=null;const catalogCursors=new Set();
    do {
      const page=await client.request('model/list',{limit:100,...(cursor?{cursor}:{})});
      if(!Array.isArray(page.data))throw Error('Invalid model catalog');
      catalogRows.push(...page.data);cursor=page.nextCursor || null;
      if(cursor && (catalogCursors.has(cursor)||catalogCursors.size>=50))throw Error('Invalid catalog pagination');
      if(cursor)catalogCursors.add(cursor);
    }while(cursor);
    const catalogError=validateCatalogSelection({models:normalizeModels(catalogRows)},model,effort,serviceTier);
    if(catalogError)throw Error(catalogError);
    const threadParams = { cwd, model, sandbox, serviceTier, config:{...config,model_reasoning_effort:effort}, approvalPolicy: config.approval_policy || 'never' };
    const result = await client.request(resumeThread ? 'thread/resume' : 'thread/start', resumeThread ? { ...threadParams, threadId: resumeThread } : threadParams);
    meta.threadId = result.thread.id; persist();
    if (autoResumeAfterQuota) {
      const quota = await checkQuota('hard');
      if (quota.state === 'blocked') {
        meta.pauseOutcome = 'turn_not_started';
        await finish('waiting_quota', 'quota-preflight');
        return done;
      }
      // A transient rate-limit read failure must not strand every new run.
      // Only a positively blocked quota pauses before the turn; unknown state
      // proceeds and the normal turn/limit handling remains authoritative.
      if (quota.state !== 'ready') { meta.quotaPreflight = 'unknown-proceed'; persist(); }
    }
    await startTurn(prompt);
    if(quotaWarning)quotaDirty=true;
    if (finishing) return done;
    timer = setInterval(async () => {
      if (ticking || finishing) return;
      ticking = true;
      try {
        if (readJson(path.join(logDir, 'cancel.json'))?.runId === runId) { await finish('cancelled', 'user-cancel'); return; }
        if (readJson(path.join(logDir, 'stop.json'))?.runId === runId) {
          await finish(pauseRequestedAt?'waiting_quota':'killed',pauseRequestedAt?'quota-pause-timeout':(readJson(path.join(logDir,'stop.json'))?.reason || 'plugin-stop')); return;
        }
        if (budgetMs > 0 && Date.now() - started >= budgetMs) {
          if(pauseRequestedAt){meta.pauseOutcome='budget_interrupt_without_checkpoint_confirmation';await finish('waiting_quota','quota-pause-budget');}
          else await finish('killed','channel-budget');
          return;
        }
        await drainControls(logDir, runId, control);
        if (recoveryEnabled && !readJson(path.join(logDir,'quota-disabled.json')) && !pauseRequestedAt && completed?.error?.codexErrorInfo==='usageLimitExceeded') {
          const quota=await checkQuota();
          meta.pauseOutcome='quota_rejection_without_checkpoint_confirmation';
          await finish(quota.state==='blocked'?'waiting_quota':'needs_attention','quota-rejected',completed.error.message);return;
        }
        if ((quotaWarning || recoveryEnabled && !readJson(path.join(logDir,'quota-disabled.json'))) && !pauseRequestedAt && (quotaDirty || Date.now() - lastQuotaPoll >= 15000)) {
          const quota = await checkQuota();
          const isWarning=quotaWarning && quota.reason==='warning-threshold';
          if ((isWarning || recoveryEnabled && !readJson(path.join(logDir,'quota-disabled.json'))) && quota.state === 'blocked') {
            if(completed && !queue.length) { await finish(completedStatus(),meta.interruptRequested ? 'user-interrupt' : null,completed.error?.message); return; }
            pauseRequestedAt = Date.now(); meta.pauseState = 'pause_requested';
            if(isWarning)meta.warning={at:new Date().toISOString(),threshold:warningThreshold,remaining:quota.remaining,source:'quotaWarning',delivery:'requested'};
            persist();
            if (meta.turnId && !completed) {
              try {
                await client.request('turn/steer', { threadId: meta.threadId, expectedTurnId: meta.turnId, input: [{ type: 'text', text: isWarning ? warningMessage(quota) : 'Codex quota is near its limit. Pause the current task now: save a concise checkpoint of completed work, pending work and verification status, then end this turn. Do not begin further work. The original task will resume after quota recovery.' }] });
                if(isWarning)meta.warning.delivery='accepted';
              } catch (error) { meta.pauseRequestError = error.message;if(isWarning)meta.warning.delivery='failed'; }
            }
          }
        }
        if (pauseRequestedAt && !completed && pauseGraceMs > 0 && !secondSteerAt && Date.now() - pauseRequestedAt >= pauseGraceMs) {
          secondSteerAt = Date.now();
          try { await client.request('turn/steer', {threadId:meta.threadId,expectedTurnId:meta.turnId,input:[{type:'text',text:'Please finish the requested checkpoint and end this turn now; the configured pause grace has elapsed.'}]}); }
          catch (error) { meta.pauseRequestError=error.message; }
        }
        if (pauseRequestedAt && (completed || (secondSteerAt && Date.now() - secondSteerAt >= pauseGraceMs))) {
          meta.pauseOutcome = completed ? 'turn_ended_after_pause_request' : 'forced_interrupt_without_checkpoint_confirmation';
          if (!completed && meta.turnId) {
            try { await client.request('turn/interrupt', { threadId: meta.threadId, turnId: meta.turnId }); } catch {}
          }
          await finish('waiting_quota', 'quota-pause'); return;
        }
        if (completed && !turnPending) {
          if (completed.status === 'completed' && queue.length && !meta.interruptRequested) {
            if(pendingReplies(logDir,meta).length >= MAX_PENDING_REPLIES) {
              await finish('needs_attention','reply-signal-backlog');return;
            }
            // Keep the pending message on disk until the new turn has been accepted.
            const next = queue[0]; await startTurn(next.text); queue.shift(); writeQueue();
          } else { await finish(completedStatus(),meta.interruptRequested ? 'user-interrupt' : null,completed.error?.message); return; }
        }
        const { lastMessage, rateLimitsRaw, ...heartbeat } = meta;
        atomicJson(path.join(logDir, 'result.hb.json'), { ...heartbeat, seq: ++sequence, ts: new Date().toISOString(),
          elapsedSec:(Date.now()-started)/1000,lastEventAgeMs:meta.lastEventAt ? Date.now()-meta.lastEventAt : null,
          childAlive: alive(meta.childPid) });
        persist();
      } catch (error) { await finish('failed', 'driver-error', error); }
      finally { ticking = false; }
    }, 200);
  } catch (error) { await finish('failed', 'startup-error', error); }
  return done;
}
