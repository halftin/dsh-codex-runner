import fs from 'node:fs';
import path from 'node:path';

export const DEBUG_MAX_BYTES = 2097152;

export function isFinalAnswerItem(item) {
  return ['agentMessage','agent_message'].includes(item?.type) && (item.phase==null || item.phase==='final_answer');
}

export function answerSnapshot(value) {
  const text = String(value || '');
  return { lastMessage:text, answerLength:text.length, answerTruncated:false };
}

// Redact before truncating: a cut token or path must not escape the filter.
export function redactDiagnostic(value) {
  return String(value || '')
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)\b/gi, '[secret]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[secret]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[path]')
    .replace(/\\{2}[^\s"'<>]+/g, '[path]')
    .replace(/\/(?:home|Users)\/[^\s"'<>]+/g, '[path]')
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, '[opaque]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

export function utf8Tail(text, maxBytes = 2048) {
  const bytes = Buffer.from(String(text || ''));
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function failureSummary(error, stderr, termination, errorClass = null) {
  const message = typeof error === 'object' && error !== null ? error.message : error;
  return {
    error:utf8Tail(redactDiagnostic(message || termination), 2000),
    error_class:errorClass || (typeof error?.code === 'string' ? error.code : null),
    stderr_tail:utf8Tail(redactDiagnostic(stderr), 2048),
    termination,
  };
}

// This writer belongs to exactly one run. Once full, even smaller events stop.
// Agent message text/deltas are omitted so debug does not duplicate full answers.
export function createDebugLog(dir, { debugLogs = false, debugMaxBytes = DEBUG_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(debugMaxBytes) || debugMaxBytes < 1 || debugMaxBytes > 1073741824) throw Error('Invalid debugMaxBytes');
  let bytes = 0, stopped = false;
  return {
    get truncated() { return stopped; },
    write(event) {
      if (!debugLogs || stopped) return;
      const line = JSON.stringify(event, (key,value) => {
        if (value && typeof value === 'object' && /^(agentMessage|agent_message)$/.test(value.type)) {
          const { text, ...rest } = value; return { ...rest, text_chars:typeof text === 'string' ? text.length : 0 };
        }
        if (key === 'delta' || key === 'lastMessage') return undefined;
        return typeof value === 'string' ? redactDiagnostic(value) : value;
      }) + '\n';
      const size = Buffer.byteLength(line);
      if (bytes + size > debugMaxBytes) { stopped = true; return; }
      fs.appendFileSync(path.join(dir,'events.jsonl'), line, {mode:0o600,flag:bytes === 0 ? 'wx' : 'a'});
      bytes += size;
      if (bytes === debugMaxBytes) stopped = true;
    },
  };
}
