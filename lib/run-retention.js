import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {atomicJson,readJson,cleanupRuns,DEFAULT_RUN_RETENTION_DAYS,DEFAULT_RETAINED_RUNS} from './run-store.js';

// Exact workspace pointers, independent of run notifications and DSH storage.
// Loading the plugin and the daily timer clean known workspaces without a run.
export function createRunRetention({home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),
  retentionDays=()=>DEFAULT_RUN_RETENTION_DAYS,retentionMaxRuns=()=>DEFAULT_RETAINED_RUNS,clean=cleanupRuns,onError=()=>{}}={}) {
  const root=path.join(home,'codex-runner','workspaces'),workspaces=new Set();
  const plain=dir=>{try{const s=fs.lstatSync(dir);if(s.isSymbolicLink()||!s.isDirectory())throw Error('Retention registry redirect');}catch(e){if(e.code!=='ENOENT')throw e;}};
  const checkRoot=()=>{plain(path.dirname(root));plain(root);};
  function sweep() {
    for(const cwd of workspaces)try{clean(path.join(cwd,'.codex-runner','logs'),retentionDays(cwd),retentionMaxRuns(cwd));}catch(error){onError(error);}
  }
  function track(cwd) {
    cwd=path.resolve(cwd);workspaces.add(cwd);checkRoot();
    const id=createHash('sha256').update(cwd).digest('hex'),file=path.join(root,id+'.json');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('Retention pointer redirect');
    atomicJson(file,{cwd});
  }
  try {
    checkRoot();
    if(fs.existsSync(root))for(const name of fs.readdirSync(root)) {
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const file=path.join(root,name);if(fs.lstatSync(file).isSymbolicLink())continue;
      const p=readJson(file);if(typeof p?.cwd==='string'&&path.isAbsolute(p.cwd))workspaces.add(p.cwd);
    }
    sweep();
  }catch(error){onError(error);}
  const timer=setInterval(sweep,86400000);timer.unref?.();
  return {track,sweep,close(){clearInterval(timer);}};
}
