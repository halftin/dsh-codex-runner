import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, validRunId, alive } from './run-store.js';

export const CONTROL_MAX_BYTES = 65536;
export function validateControl(request, runId, now = Date.now()) {
  if (!request || request.runId !== runId || !validRunId(request.id)) throw Error('Control identity mismatch');
  if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt < now || request.expiresAt > now + 60000) throw Error('Control request expired or invalid');
  if (!['queue', 'steer', 'interrupt'].includes(request.action)) throw Error('Invalid control action');
  if (request.action !== 'interrupt' && (typeof request.message !== 'string' || !request.message.trim() || Buffer.byteLength(request.message) > 32000)) throw Error('Message must contain 1–32000 bytes');
  if (Buffer.byteLength(JSON.stringify(request)) > CONTROL_MAX_BYTES) throw Error('Control request too large');
  return request;
}

/** A request goes only to the driver recorded in this exact UUID directory. */
export async function sendControl(dir, record, action, message, { timeoutMs = 20000, signal } = {}) {
  const meta = readJson(path.join(dir, 'result.meta.json'));
  if (!validRunId(record.runId) || meta?.runId !== record.runId || meta.backend !== 'app-server') throw Error('This run does not use App Server');
  if (meta.status || !alive(meta.driverPid)) throw Error('Run is no longer active');
  const deadline=Date.now()+timeoutMs;
  const request = validateControl({ id: randomUUID(), runId: record.runId, action, message, expiresAt: Date.now() + Math.min(60000, timeoutMs + 10000) }, record.runId);
  const file = path.join(dir, 'control-' + request.id + '.json');
  const response = path.join(dir, 'reply-' + request.id + '.json');
  atomicJson(file, request);
  let acknowledged=false;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw Error('Control wait cancelled; delivery may already have occurred');
      const result = readJson(response);
      if (result?.id === request.id && result.runId === record.runId) {
        acknowledged=true;
        if (!result.ok) throw Error(result.error || 'Control rejected');
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Control acknowledgement timed out; delivery=undelivered-or-pending; request retained until TTL; check status before retrying');
  } finally {
    if(acknowledged)for (const p of [file, response]) { try { fs.unlinkSync(p); } catch {} }
  }
}

export async function drainControls(dir, runId, handler) {
  for (const name of fs.readdirSync(dir).filter(n => /^control-[a-f0-9-]+\.json$/.test(n)).slice(0, 32)) {
    const id = name.slice(8, -5);
    if (!validRunId(id)) continue;
    const file = path.join(dir, name);
    let request;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CONTROL_MAX_BYTES) throw Error('Invalid control file');
      request = validateControl(readJson(file), runId);
      if (request.id !== id) throw Error('Control filename mismatch');
      const result = await handler(request);
      atomicJson(path.join(dir, 'reply-' + id + '.json'), { ...result, id, runId, ok: true });
    } catch (error) {
      atomicJson(path.join(dir, 'reply-' + id + '.json'), { id, runId, ok: false, error: error.message });
    } finally { try { fs.unlinkSync(file); } catch {} }
  }
}
