import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { reserveRun, atomicJson, runDirectory, runEvidence, readJson, claimLock } from '../lib/run-store.js';
import { processStartedAt } from '../lib/process-evidence.js';
import { RunNotifier } from '../lib/run-notifier.js';
import { buildToolDefinition, LOGS_REL } from '../lib/core.js';
import { runManaged } from '../lib/managed-run.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const syncSleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const self = fileURLToPath(import.meta.url);
const worker = process.argv.indexOf('--worker');
if (worker !== -1) {
  const [kind, base, slot] = process.argv.slice(worker + 1);
  const cfg = readJson(path.join(base, 'config.json'));
  const read = fs.readFileSync, open = fs.openSync, readdir = fs.readdirSync;
  function gate(phase) {
    fs.writeFileSync(path.join(base, phase + '-' + slot), 'ready');
    const until = Date.now() + 8000;
    while (!fs.existsSync(path.join(base, phase + '-release'))) {
      if (Date.now() > until) throw Error('interleave timeout: ' + phase);
      syncSleep();
    }
  }
  fs.readFileSync = function(file, ...args) {
    let result, error;
    try { result = read.call(this, file, ...args); } catch (e) { error = e; }
    if (String(file) === cfg.lock) gate('read');
    if (kind === 'notify' && String(file) === path.join(cfg.dir, 'notify-intent.json')) gate('intent');
    if (error) throw error;
    return result;
  };
  fs.openSync = function(file, flags, ...args) {
    const fd = open.call(this, file, flags, ...args);
    if (String(file) === cfg.lock && flags === 'wx') gate('open');
    return fd;
  };
  fs.readdirSync = function(file, ...args) {
    const result = readdir.call(this, file, ...args);
    if (kind === 'admission' && String(file) === path.join(cfg.logs, 'runs')) gate('records');
    return result;
  };
  gate('start');
  if (kind === 'notify') {
    const notifier = new RunNotifier({home: cfg.home, schedule: {
      async create() { fs.appendFileSync(path.join(base, 'calls'), 'create\n'); return {id: slot}; },
      async list() { return []; },
    }});
    await notifier.poll(); await notifier.close();
    if (notifier.error) throw Error(notifier.error);
  } else {
    try { reserveRun(cfg.logs, 'request-' + slot); fs.appendFileSync(path.join(base, 'calls'), 'reserved\n'); }
    catch (e) { if (!/admission.lock|concurrency/.test(e.message)) throw e; }
  }
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-final-defects-'));
const only = process.argv[2];
let passed = 0;
async function test(name, fn) {
  if (only && only !== name) return;
  await fn(); console.log('PASS final-defect ' + name); passed++;
}
function workspace() {
  const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
  return {cwd, logs: path.join(cwd, LOGS_REL)};
}
async function concurrent(kind) {
  const base = fs.mkdtempSync(path.join(root, kind + '-')), {cwd, logs} = workspace();
  const record = reserveRun(logs, 'stale');
  const dir = runDirectory(logs, record), home = path.join(base, 'home');
  atomicJson(path.join(dir, 'terminal.json'), {runId: record.runId, status: 'failed'});
  if (kind === 'notify') {
    atomicJson(path.join(dir, 'run.json'), {...record, state:'running', cwd, detached:true, sessionId:'fake-session'});
    const notifier = new RunNotifier({home}); notifier.track({cwd, record:{...record, detached:true}}); await notifier.close();
  }
  const lock = kind === 'notify' ? path.join(dir,'notify.lock') : path.join(logs,'admission.lock');
  const identity = kind === 'notify' ? {owner:'run-notifier',root:path.resolve(cwd),tasks:path.resolve(dir)}
    : {owner:'run-admission',root:path.resolve(logs),tasks:path.resolve(logs,'runs')};
  atomicJson(lock, {...identity,pid:2147483647,startedAt:new Date(0).toISOString()});
  atomicJson(path.join(base,'config.json'),{cwd,logs,dir,home,lock});
  const children = ['a','b'].map(slot => {
    const p = spawn(process.execPath,[self,'--worker',kind,base,slot],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output = ''; p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b);
    const done = new Promise((resolve,reject) => { p.on('error',reject); p.on('exit', code => resolve({code,output})); });
    return {p,done};
  });
  try {
    for (const phase of ['start','read','open',...(kind==='notify'?['intent']:['records'])]) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !fs.existsSync(path.join(base,phase+'-a')) && !fs.existsSync(path.join(base,phase+'-b'))) await sleep(10);
      // Hold the first reader until the second can observe the same old state.
      await sleep(250);
      fs.writeFileSync(path.join(base,phase+'-release'),'go');
    }
    for (const child of children) { const r = await child.done; assert.equal(r.code,0,r.output); }
    assert.equal(fs.readFileSync(path.join(base,'calls'),'utf8').trim().split('\n').length,1,kind+' duplicate claim');
  } finally { for (const {p} of children) if (p.exitCode === null) p.kill(); }
}
await test('stale-notify', () => concurrent('notify'));
await test('stale-admission', () => concurrent('admission'));
await test('lock-identity', () => {
  const base=fs.mkdtempSync(path.join(root,'identity-')), lock=path.join(base,'test.lock');
  const identity={owner:'fixture-owner',root:base,tasks:path.join(base,'runs')};
  const stale={...identity,pid:2147483647,startedAt:new Date(0).toISOString()};
  for (const wrong of [{owner:'foreign'},{root:path.dirname(base)},{tasks:base},{pid:0},{startedAt:null},
    {pid:process.pid,startedAt:processStartedAt()},{pid:process.pid,startedAt:null}]) {
    atomicJson(lock,{...stale,...wrong});
    assert.equal(claimLock(lock,identity),null,JSON.stringify(wrong));
    assert.deepEqual(readJson(lock),{...stale,...wrong});
  }
  atomicJson(lock,{...stale,pid:process.pid}); // reused PID, different start time
  const release=claimLock(lock,identity); assert.equal(typeof release,'function');
  const owner=readJson(lock);
  assert.equal(owner.pid,process.pid); assert.equal(owner.owner,identity.owner); assert.ok(owner.token);
  assert.equal(claimLock(lock,identity),null); release(); assert.equal(fs.existsSync(lock),false);
});

await test('live-child', () => {
  for (const owner of ['match','unknown','mismatch','dead']) {
    const {logs} = workspace(), record = reserveRun(logs,'terminal-child'), dir = runDirectory(logs,record);
    // Unknown ownership still blocks a nonterminal run; terminal PID reuse is
    // checked separately below. Keep the trusted terminal live-child control.
    atomicJson(path.join(dir,'terminal.json'), {runId:record.runId,...(owner==='unknown'?{}:{status:'failed'}),childPid:owner==='dead'?2147483647:process.pid,
      ...(owner==='unknown'?{}:{childStartedAt:owner==='mismatch'?new Date(0).toISOString():processStartedAt()})});
    const e = runEvidence(logs,record);
    assert.equal(e.childAlive,owner==='match'||owner==='unknown',owner);
    assert.equal(e.active,e.childAlive,owner);
    if (e.childAlive) {
      assert.throws(()=>reserveRun(logs,'blocked'),/concurrency/);
      atomicJson(path.join(dir,'released.json'),{runId:record.runId});
    }
    assert.ok(reserveRun(logs,'next'),owner);
  }
  for (const driverPresent of [false,true]) {
    for (const owner of ['match','unknown','invalid','mismatch','dead']) {
      const {logs} = workspace(), record = reserveRun(logs,'terminal-identity'), dir = runDirectory(logs,record);
      if (driverPresent) atomicJson(path.join(dir,'run.json'), {...record,state:'running',driverPid:process.pid,driverStartedAt:processStartedAt()});
      const meta = {runId:record.runId,status:'ok',childPid:owner==='dead'?2147483647:process.pid,
        ...(owner==='unknown'?{}:{childStartedAt:owner==='match'?processStartedAt():owner==='invalid'?'invalid':new Date(0).toISOString()})};
      atomicJson(path.join(dir,driverPresent?'result.meta.json':'terminal.json'),meta);
      const e = runEvidence(logs,record), context = `${owner}, driver=${driverPresent}`;
      assert.equal(e.childOwner,owner==='invalid'?'unknown':owner,context);
      assert.equal(e.active,owner==='match',context);
      if (owner==='match') {
        assert.throws(()=>reserveRun(logs,'blocked'),/concurrency/,context);
        atomicJson(path.join(dir,'released.json'),{runId:record.runId});
      }
      assert.ok(reserveRun(logs,'after-terminal'),context);
    }
  }
});

await test('prepare-eacces', async () => {
  const {cwd,logs} = workspace(), prompt = path.join(cwd,'task.md'); fs.writeFileSync(prompt,'fake only');
  let spawned = 0;
  const tool = buildToolDefinition({defineTool:d=>d,resolveCwd:()=>cwd,config:{autoModelAndEffort:true},onSpawn:()=>spawned++});
  const write = fs.writeFileSync;
  let errors = 0;
  fs.writeFileSync = function(file,...args) {
    if (typeof file==='string' && /selection\.json\./.test(file)) { errors++; throw Object.assign(Error('persistent EACCES fixture'),{code:'EACCES'}); }
    return write.call(this,file,...args);
  };
  try {
    for (let i=0;i<2;i++) {
      const r = await tool.execute({label:'prepare',model:'gpt-6.1-sol',effort:'high',prompt_file:prompt},{});
      assert.equal(r.status,'error'); assert.equal(r.termination,'spawn-error',JSON.stringify(r));
      const record = readJson(path.join(logs,'runs',r.run_id,'run.json'));
      assert.equal(record.state,'spawn-error'); assert.equal(runEvidence(logs,record).active,false);
      assert.equal(readJson(path.join(runDirectory(logs,record),'terminal.json')).status,'spawn-error');
    }
    assert.equal(errors,2); assert.equal(spawned,0); assert.ok(reserveRun(logs,'after-errors'));
  } finally { fs.writeFileSync=write; }
});

await test('terminal-json', async () => {
  const {cwd} = workspace(), runId = randomUUID(), dir=path.join(cwd,runId), target=path.join(dir,'result.meta.json');
  const rename = fs.renameSync, write = fs.writeFileSync;
  let observed=0, invalid=0, rejected=0, direct=0;
  function observe() {
    for (const name of ['result.meta.json','terminal.json']) {
      const file=path.join(dir,name);
      if (fs.existsSync(file)) { observed++; try { JSON.parse(fs.readFileSync(file,'utf8')); } catch { invalid++; } }
    }
  }
  fs.renameSync = function(from,to) {
    observe();
    if (to===target && readJson(from)?.status) { rejected++; throw Object.assign(Error('permanent metadata EACCES'),{code:'EACCES'}); }
    const result=rename(from,to); observe(); return result;
  };
  fs.writeFileSync = function(file,data,...args) {
    // A direct overwrite is deliberately split, with a reader in the middle.
    // This makes the historical fallback observably unsafe, deterministically.
    if (file===target) {
      direct++; const fd=fs.openSync(file,'w');
      try { const bytes=Buffer.from(data); fs.writeSync(fd,bytes.subarray(0,4)); observe(); fs.writeSync(fd,bytes.subarray(4)); }
      finally { fs.closeSync(fd); } return;
    }
    const result=write.call(this,file,data,...args); observe(); return result;
  };
  class Fake extends EventEmitter {
    async initialize() { throw Error('fake startup failure'); }
    async close() {}
  }
  try {
    const meta=await runManaged({cwd,logDir:dir,runId,prompt:'fake',model:'fixture',effort:'high'},()=>new Fake());
    assert.equal(meta.status,'failed'); assert.equal(rejected,7); assert.ok(observed>0);
    assert.equal(invalid,0,'reader observed invalid JSON'); assert.equal(direct,0);
    assert.equal(readJson(path.join(dir,'terminal.json')).runId,runId);
    assert.equal(readJson(path.join(dir,'terminal.json')).status,'failed');
  } finally { fs.renameSync=rename; fs.writeFileSync=write; }
});
console.log('FINAL-DEFECTS-OK '+passed);
