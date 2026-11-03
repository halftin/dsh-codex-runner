import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunNotifier, redactNotice, noticeMarker } from '../lib/run-notifier.js';
import { atomicJson, readJson, runDirectory } from '../lib/run-store.js';
import { processStartedAt } from '../lib/process-evidence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-notifier-'));
const logsRelative = '.codex-runner/logs';
let pass = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); pass++; }
function fixture({ status = 'failed', sessionId = 'fixture-session', detached = true, meta = {}, record = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(root, 'workspace-')), home = fs.mkdtempSync(path.join(root, 'home-'));
  const r = { runId: randomUUID(), label: 'notice-fixture', createdAt: new Date().toISOString(), state: 'running', cwd, detached, sessionId, notifyOnComplete:'off', ...record };
  const dir = runDirectory(path.join(cwd, logsRelative), r);
  atomicJson(path.join(dir, 'run.json'), r);
  if (status) atomicJson(path.join(dir, 'result.meta.json'), { status, threadId: 'thread-fixture', exitCode: 1, abortReason: 'protocol-error', ...meta });
  const schedules = [], calls = [], deleted = [];
  const schedule = {
    async create(id, request) { calls.push({ sessionId: id, ...request }); const s = { id: randomUUID(), ...request }; schedules.push(s); return s; },
    async list() { return schedules; },
    async delete({ id }) { deleted.push(id); },
  };
  const notifier = new RunNotifier({ home, schedule, logsRelative }); notifier.track({ cwd, record: r });
  return { cwd, home, dir, record: r, schedule, notifier, calls, schedules, deleted,
    restart() { return new RunNotifier({ home, schedule, logsRelative }); } };
}

await test('failure creates one bounded redacted reminder in the originating session', async () => {
  const f = fixture({ meta: { stderr_tail:'stderr failure token=stderr-secret', error: 'token=private-token fixture@example.invalid ' + 'sk-' + 'x'.repeat(48) } });
  fs.writeFileSync(path.join(f.dir, 'result.err.log'), 'stderr failure token=stderr-secret ' + path.join(f.cwd, 'private.txt'));
  fs.writeFileSync(path.join(f.dir, 'answer.txt'), 'PRIVATE ANSWER MUST NOT ENTER NOTICE');
  try {
    await f.notifier.poll(); await f.notifier.poll();
    assert.equal(f.calls.length, 1); const call = f.calls[0];
    assert.equal(call.sessionId, 'fixture-session');
    assert.ok(Date.parse(call.at) >= Date.now() - 1000);
    for (const text of [f.record.runId, f.record.label, 'termination', 'thread-fixture', 'codex_status', 'governed by the user instructions', 'untrusted diagnostic data']) assert.ok(call.prompt.includes(text), text);
    for (const text of ['private-token', 'stderr-secret', 'fixture@example.invalid', 'x'.repeat(48), 'private.txt', 'PRIVATE ANSWER']) assert.equal(call.prompt.includes(text), false, text);
    assert.ok(call.prompt.length < 2000);
    const marker = readJson(path.join(f.dir, 'notified.json'));
    assert.equal(marker.scheduleId, f.schedules[0].id); assert.ok(marker.notifiedAt);
  } finally { await f.notifier.close(); }
});

await test('complete verified terminal answers avoid a redundant status query',async()=>{
  const answer='实现完成。\n验证通过。';
  const f=fixture({status:'ok',meta:{turnId:'final',exitCode:0,abortReason:null,killVerified:true,end:new Date().toISOString(),lastMessage:answer}});
  atomicJson(path.join(f.dir,'result.meta.json'),{...readJson(path.join(f.dir,'result.meta.json')),runId:f.record.runId});
  try{
    await f.notifier.poll();await f.notifier.poll();assert.equal(f.calls.length,1);
    const payload=JSON.parse(f.calls[0].prompt.split('\n').at(-1));
    assert.equal(payload.requires_status_refresh,false);assert.equal(payload.answer_complete,true);
    assert.equal(payload.answer_preview,answer);assert.equal(payload.process_status,'terminal');
    assert.equal(payload.handoff.action,'review_result');assert.ok(payload.observed_at);
  }finally{await f.notifier.close();}
});
await test('long, redacted, queued and unresolved terminal replies still require a fresh status',async()=>{
  for(const reason of ['long','secret','queued','child','subagents','recovery','unverified']){
    const f=fixture({status:'ok',meta:{turnId:'final',exitCode:0,abortReason:null,killVerified:true,end:new Date().toISOString(),lastMessage:'完整回答'}});
    const meta={...readJson(path.join(f.dir,'result.meta.json')),runId:f.record.runId};
    if(reason==='long')meta.lastMessage='字'.repeat(501);
    if(reason==='secret')meta.lastMessage='token=private-value';
    if(reason==='queued')atomicJson(path.join(f.dir,'pending-messages.json'),[{text:'pending'}]);
    if(reason==='child'){meta.childPid=process.pid;meta.childStartedAt=processStartedAt();}
    if(reason==='subagents')meta.subagents={count:1,running:1,agents:[{id:'child',status:'running'}]};
    if(reason==='recovery')atomicJson(path.join(f.dir,'recovery-state.json'),{runId:f.record.runId,phase:'completed'});
    if(reason==='unverified')meta.killVerified=false;
    atomicJson(path.join(f.dir,'result.meta.json'),meta);
    try{await f.notifier.poll();assert.equal(f.calls.length,1,reason);const payload=JSON.parse(f.calls[0].prompt.split('\n').at(-1));
      assert.equal(payload.requires_status_refresh,true,reason);assert.equal(payload.answer_complete,false,reason);
    }finally{await f.notifier.close();}
  }
});

await test('failed reply snapshot and needs_attention share one failure notification', async () => {
  const f = fixture({ status: 'failed', meta: { turnId: 'turn-x', replySignals: [{ run_id: 'run-x', turn_id: 'turn-x', status: 'failed', sequence: 1, answer_preview: '' }] } });
  atomicJson(path.join(f.dir, 'recovery-state.json'), { runId: f.record.runId, phase: 'needs_attention' });
  try {
    await f.notifier.poll(); await f.notifier.poll();
    assert.equal(f.calls.length, 1, 'one failure reminder');
    assert.equal(readJson(path.join(f.dir, 'notified.json')).key.includes('failure'), true);
  } finally { await f.notifier.close(); }
});

await test('off still signals completion and quota; user stop and long thinking stay quiet', async () => {
  for (const status of ['ok', 'cancelled', 'waiting_quota', 'quota-blocked']) {
    const f = fixture({ status }); try { await f.notifier.poll(); assert.equal(f.calls.length, status==='cancelled'?0:1, status); } finally { await f.notifier.close(); }
  }
  const f = fixture({ status: null, record: { driverPid: process.pid, driverStartedAt: processStartedAt() } });
  atomicJson(path.join(f.dir, 'result.hb.json'), { runId: f.record.runId, ts: new Date().toISOString(), event: 'thinking' });
  try { await f.notifier.poll(); assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(f.dir, 'notified.json')), false); }
  finally { await f.notifier.close(); }
});

await test('only specified terminal failures, including proven orphan and stale, notify', async () => {
  for (const status of ['failed', 'spawn-error', 'killed-unknown', 'killed', 'needs_attention', 'interrupted', 'aborted', 'orphan', 'stale']) {
    const f = status === 'orphan' ? fixture({ status: null, record: { childPid: process.pid, childStartedAt: processStartedAt() } })
      : status === 'stale' ? fixture({ status: null }) : fixture({ status });
    try { await f.notifier.poll(); assert.equal(f.calls.length, 1, status); assert.ok(f.calls[0].prompt.includes('"status":"' + status + '"')); }
    finally { await f.notifier.close(); }
  }
  const f = fixture({ status: null, record: { state: 'spawn-error' } });
  try { await f.notifier.poll(); assert.equal(f.calls.length, 1); } finally { await f.notifier.close(); }
});

await test('failed run with a surviving owned child notifies as orphan', async()=>{
  const f = fixture({ status: 'failed', record: { childPid: process.pid, childStartedAt: processStartedAt() } });
  try {
    await f.notifier.poll();
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].prompt.includes('"status":"orphan"'));
    assert.ok(f.calls[0].prompt.includes('"child_alive":true'));
  } finally { await f.notifier.close(); }
});

await test('user cancellation suppresses failure/orphan even before driver finalizes', async () => {
  const f = fixture(); atomicJson(path.join(f.dir, 'cancel.json'), { runId: f.record.runId });
  const g = fixture({ meta: { abortReason: 'user-cancel' } });
  try { await f.notifier.poll(); await g.notifier.poll(); assert.equal(f.calls.length + g.calls.length, 0); }
  finally { await f.notifier.close(); await g.notifier.close(); }
});

await test('returned sync runs do not notify twice; early final metadata waits for driver exit', async () => {
  const f = fixture({ detached: false }); const g = fixture({ record: { driverPid: process.pid, driverStartedAt: processStartedAt() } });
  atomicJson(path.join(f.dir,'tool-returned.json'),{runId:f.record.runId});
  try {
    await f.notifier.poll(); await g.notifier.poll(); assert.equal(f.calls.length + g.calls.length, 0);
    assert.equal(f.notifier.runs.size,0);
    assert.equal(fs.existsSync(path.join(f.dir, 'notify-error.json')), false);
  } finally { await f.notifier.close(); await g.notifier.close(); }
});

await test('host restart discovers registered detach runs and durable marker prevents resending', async () => {
  const f = fixture(); await f.notifier.close(); const restarted = f.restart();
  try { await restarted.poll(); assert.equal(f.calls.length, 1); } finally { await restarted.close(); }
  const again = f.restart(); again.track({ cwd: f.cwd, record: f.record });
  try { await again.poll(); await again.poll(); assert.equal(f.calls.length, 1); } finally { await again.close(); }
});

await test('missing session or schedule writes diagnostics without crashing; later service binding works', async () => {
  const f = fixture({ sessionId: null }), g = fixture(); g.notifier.bind(null);
  try {
    await f.notifier.poll(); await g.notifier.poll();
    assert.equal(readJson(path.join(f.dir, 'notify-error.json')).code, 'missing-session');
    assert.equal(readJson(path.join(g.dir, 'notify-error.json')).code, 'missing-schedule');
    assert.equal(f.calls.length + g.calls.length, 0);
    g.notifier.bind(g.schedule); await g.notifier.poll(); assert.equal(g.calls.length, 1);
  } finally { await f.notifier.close(); await g.notifier.close(); }
});

await test('schedule errors never block other runs and are not retried into spam', async () => {
  const f = fixture(), g = fixture(); const create = f.schedule.create;
  f.schedule.create = async (id, request) => {
    if (request.prompt.includes(f.record.runId)) { f.calls.push(request); throw Error('fixture scheduling failure token=hidden'); }
    return create(id, request);
  };
  f.notifier.track({ cwd: g.cwd, record: g.record });
  try {
    await f.notifier.poll(); await f.notifier.poll(); await f.notifier.poll();
    assert.equal(f.calls.length, 2); assert.equal(f.schedules.length, 1);
    const diagnostic = readJson(path.join(f.dir, 'notify-error.json'));
    assert.equal(diagnostic.code, 'schedule-create-failed'); assert.equal(diagnostic.error.includes('hidden'), false);
    assert.equal(readJson(path.join(g.dir, 'notified.json')).runId, g.record.runId);
  } finally { await f.notifier.close(); await g.notifier.close(); }
});

await test('create-before-commit crash and ambiguous create error reconcile existing schedule once', async () => {
  const f = fixture(); const marker = noticeMarker(f.record.runId,null,'failure');
  atomicJson(path.join(f.dir, 'notify-intent.json'), { runId: f.record.runId, marker });
  f.schedules.push({ id: 'existing-reminder', prompt: marker });
  try { await f.notifier.poll(); assert.equal(f.calls.length, 0); assert.equal(readJson(path.join(f.dir, 'notified.json')).scheduleId, 'existing-reminder'); }
  finally { await f.notifier.close(); }
  const g = fixture(), original = g.schedule.create;
  g.schedule.create = async (...args) => { await original(...args); throw Error('response lost'); };
  try {
    await g.notifier.poll(); await g.notifier.close(); const restarted = g.restart();
    try { await restarted.poll(); assert.equal(g.calls.length, 1); assert.ok(readJson(path.join(g.dir, 'notified.json'))); }
    finally { await restarted.close(); }
  } finally { await g.notifier.close(); }
});

await test('unknown delivery after intent does not create a second schedule', async () => {
  const f = fixture(); atomicJson(path.join(f.dir, 'notify-intent.json'), { runId: f.record.runId });
  try { await f.notifier.poll(); await f.notifier.poll(); assert.equal(f.calls.length, 0); assert.equal(readJson(path.join(f.dir, 'notify-error.json')).code, 'delivery-unknown'); }
  finally { await f.notifier.close(); }
});

await test('concurrent hosts claim one notification and cancellation during RPC removes pending reminder', async () => {
  const f = fixture(), other = f.restart();
  try { await Promise.all([f.notifier.poll(), other.poll()]); assert.equal(f.calls.length, 1); }
  finally { await f.notifier.close(); await other.close(); }
  const g = fixture(), create = g.schedule.create;
  g.schedule.create = async (...args) => { const result = await create(...args); atomicJson(path.join(g.dir, 'cancel.json'), { runId: g.record.runId }); return result; };
  try { await g.notifier.poll(); await g.notifier.poll(); assert.equal(g.calls.length, 1); assert.equal(g.deleted.length, 1); }
  finally { await g.notifier.close(); }
});

await test('timer is internal, unrefed and disposed; registry cannot redirect into other directories', async () => {
  const f = fixture(); f.notifier.start(); assert.equal(f.notifier.timer.hasRef(), false); await f.notifier.close(); assert.equal(f.notifier.timer, null);
  const home = fs.mkdtempSync(path.join(root, 'redirect-home-')), outside = fs.mkdtempSync(path.join(root, 'redirect-outside-'));
  fs.symlinkSync(outside, path.join(home, 'codex-runner'), 'junction');
  const notifier = new RunNotifier({ home, schedule: f.schedule });
  try { notifier.track({ cwd: f.cwd, record: f.record }); assert.match(notifier.error, /redirect/); assert.deepEqual(fs.readdirSync(outside), []); }
  finally { await notifier.close(); }
  const drivePath = path.join(f.cwd, 'secret.txt');
  const redacted = redactNotice('Bearer private-credential password="hidden value" ' + drivePath);
  assert.equal(redacted.includes('private-credential'), false); assert.equal(redacted.includes('hidden value'), false); assert.equal(redacted.includes('secret.txt'), false);
});

console.log('NOTIFIER-OK ' + pass);
