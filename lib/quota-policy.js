import { createHash } from 'node:crypto';
export function accountFingerprint(response) {
  const a = response?.account;
  return a?.type === 'chatgpt' && typeof a.email === 'string' && a.email
    ? createHash('sha256').update(a.type + ':' + a.email.trim().toLowerCase()).digest('hex') : null;
}
/** All times in the Codex wire protocol are Unix seconds. Never guess a reset time. */
export function quotaDecision(response, sampledAt, now = Date.now(), threshold = 95) {
  if (!Number.isSafeInteger(sampledAt) || now - sampledAt > 60000 || sampledAt > now + 5000) return { state: 'unknown', reason: 'stale-quota' };
  const buckets = response?.rateLimitsByLimitId || (response?.rateLimits ? { codex: response.rateLimits } : {});
  const windows = [];
  for (const [bucket, limits] of Object.entries(buckets)) {
    if (bucket !== 'codex') continue;
    for (const kind of ['primary', 'secondary']) {
      const w = limits?.[kind]; if (!w) continue;
      if (!Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 || !Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0) return { state: 'unknown', reason: 'invalid-quota' };
      windows.push({ bucket, kind, ...w });
    }
  }
  if (!windows.length) return { state: 'unknown', reason: 'missing-account-quota' };
  const blocked = windows.filter(w => w.usedPercent >= threshold);
  if (!blocked.length) return { state: 'ready', windows };
  if (blocked.some(w => !Number.isSafeInteger(w.resetsAt) || w.resetsAt * 1000 <= now || w.resetsAt * 1000 > now + 370 * 86400000)) return { state: 'unknown', reason: 'missing-or-invalid-reset', windows };
  return { state: 'blocked', windows, resumeAt: Math.max(...blocked.map(w => w.resetsAt * 1000)) + 180000 };
}
