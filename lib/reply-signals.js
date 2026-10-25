import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './run-store.js';
import { runFacts } from './run-facts.js';
import { boundedSubagents } from './subagent-view.js';
import { redactDiagnostic, utf8Tail } from './run-data.js';

// A bounded outbox in the existing metadata, not a copy of the event stream.
// Acknowledged entries are reclaimed by the driver; backlog stops queued turns.
export const MAX_PENDING_REPLIES = 64;
export function replyPayload(runId, meta, status, evidence = {}) {
  const subagents = boundedSubagents(meta.subagents);
  const previewMeta={...meta,answerTruncated:meta.answerTruncated===true||String(meta.lastMessage||'').length>500};
  return { run_id:runId, turn_id:meta.turnId || null, status,
    ...runFacts({status,termination:meta.abortReason || status,meta:previewMeta,threadId:meta.threadId,
      answer:meta.lastMessage || '',subagents,evidence}),
    answer_preview:redactDiagnostic(String(meta.lastMessage || '').slice(0,8192)).slice(0,500),
    pending_messages:evidence.pendingMessages ?? (Number.isSafeInteger(meta.pendingMessages)?meta.pendingMessages:0),
    thread_id:meta.threadId || null, quota:meta.quota || null,
    error:status==='failed'?redactDiagnostic(meta.error).slice(0,500):null,
    stderr_tail:status==='failed'?utf8Tail(redactDiagnostic(meta.stderr_tail),2048):null,
    subagents:Object.fromEntries(['count','running','completed','failed','unknown','truncated'].map(k=>[k,subagents[k]])) };
}
export function pendingReplies(logDir, meta) {
  const file=path.join(logDir,'notified.json');
  if(fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())throw Error('Reply acknowledgement redirect');
  const ack=readJson(file);
  return (meta.replySignals || []).filter(s=>s.sequence > (ack?.runId===meta.runId ? ack.replySequence || 0 : 0));
}
export function captureReply(logDir, meta, turn) {
  const pending=pendingReplies(logDir,meta);
  if(meta.lastReplyTurnId===turn.id || pending.some(s=>s.turn_id===turn.id && s.kind==='reply'))return;
  if(pending.length >= MAX_PENDING_REPLIES)throw Error('Reply signal backlog requires attention');
  meta.replySequence=(meta.replySequence || 0)+1;
  meta.lastReplyTurnId=turn.id;
  const status=turn.status==='completed'?'ok':['interrupted','aborted'].includes(turn.status)?turn.status:'failed';
  meta.replySignals=[...pending,{...replyPayload(meta.runId,{...meta,turnId:turn.id},status,{liveness:'running'}),
    kind:'reply',sequence:meta.replySequence,at:new Date().toISOString()}];
}
