// Missing model output is not a failure. These checks concern the transport
// heartbeat and persisted execution records, never the meaning of an answer.
export const HEALTH_GRACE_MS = 120000;
export function validReplySignal(signal) {
  return signal && typeof signal==='object' && Number.isSafeInteger(signal.sequence) && signal.sequence>0
    && typeof signal.status==='string' && (signal.turn_id == null || typeof signal.turn_id==='string');
}
export function runHealth(record, evidence, now = Date.now()) {
  const meta=evidence.meta;
  if (meta && (typeof meta!=='object' || Array.isArray(meta)
    || (meta.replySignals!==undefined && (!Array.isArray(meta.replySignals)
      || meta.replySignals.length>64 || meta.replySignals.some(s=>!validReplySignal(s)))))) return 'metadata_invalid';
  const age = now - Date.parse(record.createdAt);
  if (evidence.spawnPending && age > HEALTH_GRACE_MS) return 'startup_stalled';
  if (evidence.driverAlive) {
    const last = evidence.hb?.runId === record.runId ? Date.parse(evidence.hb.ts) : NaN;
    if ((Number.isFinite(last) ? now - last : age) > HEALTH_GRACE_MS) return 'heartbeat_lost';
    if (!evidence.meta && age > HEALTH_GRACE_MS) return 'metadata_unavailable';
  }
  return null;
}
