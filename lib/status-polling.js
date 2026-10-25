import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson, readJson, validRunId, recordFor, runEvidence, claimLock } from './run-store.js';
import { DSH_HANDOFF_PROMPT } from './task-handoff.js';

// One pending one-shot reminder per session; it only requests status/read/report.
// No runner, control, recovery or continuation capability is passed here.
export class StatusPolling {
  constructor({home=process.env.DSH_HOME || path.join(os.homedir(),'.dsh'),schedule=null,
    settings=()=>({statusPollingEnabled:false,statusPollingIntervalMinutes:30}),now=Date.now}={}) {
    this.root=path.join(home,'codex-runner','status-polling');this.schedule=schedule;this.settings=settings;this.now=now;
    this.chain=Promise.resolve();this.closed=false;this.error=null;this.runs=new Map();
    try {this.checkRoot();this.restore();}catch(error){this.error=error.message;}
  }
  checkRoot() {
    for(const dir of [path.dirname(this.root),this.root]) {
      if(fs.existsSync(dir)){const s=fs.lstatSync(dir);if(s.isSymbolicLink() || !s.isDirectory())throw Error('Polling registry redirect');}
    }
    fs.mkdirSync(this.root,{recursive:true});
    for(const name of fs.readdirSync(this.root))if(fs.lstatSync(path.join(this.root,name)).isSymbolicLink())throw Error('Polling file redirect');
  }
  restore(){
    this.runs.clear();
    for(const name of fs.readdirSync(this.root).filter(n=>n.endsWith('.run.json'))) {
      const pointer=readJson(path.join(this.root,name));
      if(validRunId(pointer?.runId) && name===pointer.runId+'.run.json' && typeof pointer.cwd==='string' && path.isAbsolute(pointer.cwd))this.runs.set(pointer.runId,pointer);
    }
  }
  track({cwd,record}) {
    if(this.closed || !validRunId(record?.runId) || !path.isAbsolute(cwd))return;
    try {this.checkRoot();const pointer={runId:record.runId,cwd:path.resolve(cwd)};this.runs.set(record.runId,pointer);atomicJson(path.join(this.root,record.runId+'.run.json'),pointer);}
    catch(error){this.error=error.message;}
  }
  bind(schedule){this.schedule=schedule;}
  start(){if(!this.timer && !this.closed){this.timer=setInterval(()=>{void this.poll();},3000);this.timer.unref?.();}return this;}
  async close(){this.closed=true;clearInterval(this.timer);this.timer=null;await this.chain;}
  poll() {
    const task=this.chain.then(async()=>{
      if(this.closed || !this.schedule)return;
      this.checkRoot();const release=claimLock(path.join(this.root,'poll.lock'),{owner:'status-polling',root:this.root,tasks:this.root});
      if(!release)return;
      try {
        this.restore();
        const groups=new Map();
        for(const [id,pointer] of this.runs) {
          const logs=path.join(pointer.cwd,'.codex-runner/logs'),record=recordFor(logs,id);
          if(!record || path.resolve(record.cwd || '')!==pointer.cwd || !runEvidence(logs,record,{now:this.now()}).running) {
            this.runs.delete(id);fs.unlinkSync(path.join(this.root,id+'.run.json'));continue;
          }
          const s=this.settings(pointer.cwd),minutes=s.statusPollingIntervalMinutes;
          if(s.statusPollingEnabled!==true || !Number.isInteger(minutes) || minutes<15 || minutes>120 || !record.sessionId)continue;
          const group=groups.get(record.sessionId) || {sessionId:record.sessionId,minutes,ids:[]};
          group.minutes=Math.min(group.minutes,minutes);group.ids.push(id);groups.set(record.sessionId,group);
        }
        const states=fs.readdirSync(this.root).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));
        for(const name of states) {
          const file=path.join(this.root,name),state=readJson(file);if(!state?.sessionId)continue;
          const group=groups.get(state.sessionId);
          if(!group)await this.remove(file,state);
        }
        for(const group of groups.values())await this.reconcile(group);
      }finally{release();}
    }).catch(error=>{this.error=error.message;});
    this.chain=task;return task;
  }
  async removeEntries(state) {
    // Reconcile an ambiguous create before deleting, including after restart.
    const entries=await this.schedule.list({sessionId:state.sessionId});
    for(const entry of entries.filter(s=>s.id===state.scheduleId || s.prompt?.includes(state.marker)))
      await this.schedule.delete({sessionId:state.sessionId,id:entry.id});
  }
  async remove(file,state) {
    await this.removeEntries(state);
    if(state.previous)await this.removeEntries(state.previous);
    fs.unlinkSync(file);
  }
  async reconcile(group) {
    const file=path.join(this.root,createHash('sha256').update(group.sessionId).digest('hex')+'.json');
    let state=readJson(file);
    group.ids.sort();
    if(state) {
      const entry=(await this.schedule.list({sessionId:group.sessionId})).find(s=>s.id===state.scheduleId || s.prompt?.includes(state.marker));
      if(!state.scheduleId) {
        if(!entry){this.error='Polling delivery unknown; inspect pending schedule';return;}
        state={...state,scheduleId:entry.id};atomicJson(file,state);
      }
      if(state.previous) {
        // The replacement is confirmed. A crash or failed delete keeps both
        // identities durable so the next poll can finish the handover.
        const pending=await this.schedule.list({sessionId:group.sessionId});
        if(this.now()>=state.previous.at && pending.some(s=>s.id===state.previous.scheduleId || s.prompt?.includes(state.previous.marker)))return;
        await this.removeEntries(state.previous);
        const {previous,...current}=state;state=current;atomicJson(file,state);
      }
      // Host list contains active reminders only. An overdue entry is still
      // awaiting dispatch; leave it intact until the host consumes it.
      if(this.now()>=state.at && entry)return;
      if(this.now()<state.at && state.minutes===group.minutes && JSON.stringify(state.ids)===JSON.stringify(group.ids))return;
    }
    const previous=state;
    const previousAt=previous && previous.minutes===group.minutes && this.now()<previous.at ? previous.at : null;
    state={sessionId:group.sessionId,minutes:group.minutes,ids:group.ids,at:previousAt || this.now()+group.minutes*60000,
      marker:'[codex-status-poll:'+randomUUID()+']',...(previous?{previous}: {})};
    const prompt=state.marker+' Check these plugin-managed runs and merge progress into a brief report. '+DSH_HANDOFF_PROMPT+'\n'+JSON.stringify({run_ids:group.ids});
    atomicJson(file,state); // durable intent before the host RPC
    const created=await this.schedule.create(group.sessionId,{title:'Codex status query',at:new Date(state.at).toISOString(),prompt});
    if(!created?.id)throw Error('Polling schedule creation not confirmed');
    state={...state,scheduleId:created.id};atomicJson(file,state);
    if(previous) {
      const pending=await this.schedule.list({sessionId:group.sessionId});
      if(this.now()>=previous.at && pending.some(s=>s.id===previous.scheduleId || s.prompt?.includes(previous.marker)))return;
      await this.removeEntries(previous);
    }
    const {previous:retired,...current}=state;atomicJson(file,current);
  }
}
