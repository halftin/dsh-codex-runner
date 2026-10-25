import fs from 'node:fs';
import path from 'node:path';
import { readJson, isTerminalStatus } from './run-store.js';

// Event-driven invalidation while settings are open: no browser polling loop.
export function createRunEvents() {
  const listeners=new Set(),watches=new Map(),finished=new Set(),streams=new Set();let closed=false;
  function subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
  function track(dir,record) {
    if(closed||watches.has(record.runId)||finished.has(record.runId))return;
    const check=()=>{
      const stored=readJson(path.join(dir,'terminal.json'))||readJson(path.join(dir,'result.meta.json'));
      const run=readJson(path.join(dir,'run.json'));
      const meta=isTerminalStatus(stored?.status)?stored:isTerminalStatus(run?.state)?{status:run.state}:null;
      if(!meta||finished.has(record.runId))return;
      finished.add(record.runId);
      watches.get(record.runId)?.close();watches.delete(record.runId);
      for(const listener of listeners)try{listener({run_id:record.runId,status:meta.status});}catch{}
    };
    try {
      const watcher=fs.watch(dir,{persistent:false},(_event,file)=>{if(!file||['result.meta.json','terminal.json','run.json'].includes(String(file)))check();});
      watcher.on('error',()=>{watcher.close();watches.delete(record.runId);});
      watches.set(record.runId,watcher);check();
    }catch{}
  }
  function stream(signal) {
    let unsubscribe=()=>{};
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({start(controller){
      if(closed||signal?.aborted){controller.close();return;}
      streams.add(controller);
      controller.enqueue(encoder.encode(': codex-runner read-only run invalidation\n\n'));
      unsubscribe=subscribe(event=>{try{controller.enqueue(encoder.encode('data: '+JSON.stringify(event)+'\n\n'));}catch{unsubscribe();}});
      signal?.addEventListener('abort',()=>{unsubscribe();streams.delete(controller);try{controller.close();}catch{}},{once:true});
    },cancel(){unsubscribe();}}),{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
  }
  function close(){closed=true;for(const watcher of watches.values())watcher.close();watches.clear();listeners.clear();for(const controller of streams)try{controller.close();}catch{}streams.clear();}
  return {subscribe,track,stream,close};
}
