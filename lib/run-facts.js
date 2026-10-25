import { taskHandoff } from './task-handoff.js';
// Execution facts only. Task acceptance and the next direction belong to DSH.
export const USER_ABORTS = new Set(['user-cancel', 'user-interrupt']);

export function runFacts({ status, termination = status, meta = {}, threadId = null,
  subagents = {}, answer = '', evidence = {}, userCancelled = false, recovery = evidence.recovery } = {}) {
  const cancelled = userCancelled || status === 'cancelled' || USER_ABORTS.has(meta.abortReason);
  let processStatus = evidence.liveness || (status === 'running' ? 'running' : status ? 'terminal' : 'unknown');
  if (evidence.childAlive && !evidence.driverAlive) processStatus = evidence.childOwner === 'mismatch' ? processStatus
    : evidence.childOwner === 'unknown' ? 'unknown' : 'orphan';
  if (!['running', 'terminal', 'orphan', 'stale', 'unknown'].includes(processStatus)) processStatus = 'unknown';
  if (status === 'not_found') processStatus = 'unknown';
  const waiting = status === 'waiting_quota';
  const autoRecovery = waiting && meta.autoResumeAfterQuota === true && !['needs_attention', 'cancelled', 'completed'].includes(recovery?.phase);
  const completed = status === 'ok' || status === 'completed';
  const turnStatus = status === 'cancelled' || waiting ? 'unknown' : completed ? 'completed'
    : status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'unknown';
  const hasAnswer = typeof answer === 'string' && answer.trim().length > 0;
  const abnormalProcess = ['orphan', 'stale'].includes(processStatus);
  const needsDecision = !cancelled && !autoRecovery && (!!evidence.healthIssue || recovery?.phase === 'needs_attention' || waiting || completed || abnormalProcess ||
    ['failed', 'interrupted', 'aborted', 'killed', 'killed-unknown', 'spawn-error', 'needs_attention', 'orphan', 'stale', 'quota-blocked'].includes(status));
  const reason = cancelled ? 'user_cancelled' : evidence.healthIssue ? evidence.healthIssue : waiting ? 'waiting_quota' : abnormalProcess ? processStatus
    : (evidence.pendingMessages ?? meta.pendingMessages) > 0 && !evidence.driverAlive ? 'pending_messages' : subagents.failed ? 'subagents_failed'
    : completed ? ((subagents.running || subagents.unknown) ? 'subagents_running' : !hasAnswer ? 'empty_answer' : 'turn_completed')
    : needsDecision ? termination : null;
  const facts = {
    turn_status: turnStatus, process_status: processStatus, task_state: 'unknown',
    needs_dsh_decision: needsDecision, decision_reason: reason,
    automation: autoRecovery ? 'quota_resume' : evidence.orphanReaped ? 'process_cleanup' : 'none',
    resumable: !!threadId && !cancelled,
    has_final_answer: hasAnswer, answer_truncated: meta.answerTruncated === true,
  };
  facts.handoff = taskHandoff(facts, { status, meta, evidence, subagents, recovery });
  return facts;
}

export function completionNoticeMode(record) {
  return record.notifyOnComplete ?? (record.detached ? 'decision' : 'off');
}
