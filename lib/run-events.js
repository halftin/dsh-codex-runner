import fs from 'node:fs';
import path from 'node:path';
import { readJson, isTerminalStatus } from './run-store.js';

// Loss-tolerant invalidations only; output remains durable and cursor-readable.
export function createRunEvents() {
  const listeners=new Set(),watches=new Map(),finished=new Set(),streams=new Set();let closed=false;
  const emit=event=>{for(const listener of listeners)try{listener(event);}catch{}};
  function subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
  function track(dir,record) {
    if(closed||watches.has(record.runId)||finished.has(record.runId))return;
    let outputTimer,finishTimer,watcher;
    const dispose=()=>{clearTimeout(outputTimer);clearTimeout(finishTimer);watcher?.close();watches.delete(record.runId);};
    const check=()=>{
      const stored=readJson(path.join(dir,'terminal.json'))||readJson(path.join(dir,'result.meta.json'));
      const run=readJson(path.join(dir,'run.json'));
      const meta=isTerminalStatus(stored?.status)?stored:isTerminalStatus(run?.state)?{status:run.state}:null;
      if(!meta||finished.has(record.runId))return;
      finished.add(record.runId);
      emit({run_id:record.runId,status:meta.status});
      // Retain a bounded grace window for final output/index and host-record commits.
      finishTimer=setTimeout(dispose,30000);finishTimer.unref?.();
    };
    try {
      watcher=fs.watch(dir,{persistent:false},(_event,file)=>{
        if(!file||['result.meta.json','terminal.json','run.json'].includes(String(file)))check();
        if(!file||['output.idx','output-state.json','session-records.json'].includes(String(file))){
          if(!outputTimer){outputTimer=setTimeout(()=>{outputTimer=null;emit({run_id:record.runId,status:'output_changed'});},50);outputTimer.unref?.();}
        }
      });
      watcher.on('error',dispose);
      watches.set(record.runId,{close:dispose});check();
    }catch{}
  }
  function stream(signal) {
    let unsubscribe=()=>{},heartbeat,controllerRef;
    const cleanup=()=>{unsubscribe();clearInterval(heartbeat);streams.delete(abort);signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();try{controllerRef?.close();}catch{}};
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({start(controller){
      if(closed||signal?.aborted){controller.close();return;}
      streams.add(abort);
      controllerRef=controller;
      controller.enqueue(encoder.encode(': codex-runner read-only run invalidation\n\n'));
      const send=text=>{try{if(controller.desiredSize>0)controller.enqueue(encoder.encode(text));}catch{cleanup();}};
      unsubscribe=subscribe(event=>send('data: '+JSON.stringify(event)+'\n\n'));
      heartbeat=setInterval(()=>send(': keepalive\n\n'),15000);heartbeat.unref?.();
      signal?.addEventListener('abort',abort,{once:true});
    },cancel(){cleanup();}}),{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
  }
  function close(){closed=true;for(const watcher of watches.values())watcher.close();watches.clear();for(const stop of streams)stop();listeners.clear();streams.clear();}
  return {subscribe,track,stream,close};
}
