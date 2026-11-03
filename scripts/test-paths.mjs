import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reserveRun, listRecords, cleanupRuns, runDirectory, atomicJson } from '../lib/run-store.js';
import { LOGS_REL } from '../lib/core.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-paths-'));
let pass=0;
function test(name,fn){fn();pass++;console.log('PASS '+name);}
for(const component of ['data','logs','runs'])test('reject '+component+' parent junction before reading or writing',()=>{
  const cwd=path.join(root,component),outside=path.join(root,component+'-outside');
  fs.mkdirSync(cwd);fs.mkdirSync(outside);
  const logs=path.join(cwd,LOGS_REL);
  const redirected=component==='data'?path.dirname(logs):component==='logs'?logs:path.join(logs,'runs');
  fs.mkdirSync(path.dirname(redirected),{recursive:true});fs.symlinkSync(outside,redirected,'junction');
  assert.throws(()=>reserveRun(logs,'escape'),/redirect/i);
  assert.throws(()=>listRecords(logs),/redirect/i);
  assert.throws(()=>cleanupRuns(logs,0,0),/redirect/i);
  assert.deepEqual(fs.readdirSync(outside),[]);
});
test('cleanup cannot follow a redirected run directory',()=>{
  const logs=path.join(root,'cleanup',LOGS_REL),r=reserveRun(logs,'safe'),dir=runDirectory(logs,r);
  const original=dir+'-original';fs.renameSync(dir,original);
  const outside=path.join(root,'sentinel');fs.mkdirSync(outside);
  atomicJson(path.join(outside,'run.json'),r);atomicJson(path.join(outside,'result.meta.json'),{status:'ok'});
  fs.symlinkSync(outside,dir,'junction');cleanupRuns(logs,0,0);
  assert.ok(fs.existsSync(path.join(outside,'run.json')));
});
console.log('PATHS-OK '+pass);
