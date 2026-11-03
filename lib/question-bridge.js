import fs from 'node:fs';
import path from 'node:path';
import {readInteractions,answerControlMessage} from './interactions.js';
import {runDirectory,atomicJson,recordFor,readJson} from './run-store.js';
import {sendControl} from './run-control.js';

/** Native UserQuestions waterfall: desktop/bridge consumers arbitrate answers. */
export class QuestionBridge {
  constructor({lookupAgent,ask,send=sendControl}) {
    this.lookupAgent=lookupAgent;this.ask=ask;this.send=send;this.runs=new Map();this.waits=new Map();this.closed=false;
    this.timer=setInterval(()=>this.check(),500);this.timer.unref?.();
  }
  track({cwd,record}) {
    if(this.closed||this.runs.has(record.runId)||record.backend!=='app-server')return;
    const dir=runDirectory(path.join(cwd,'.codex-runner/logs'),record);
    const value={cwd,record,dir,watch:null};this.runs.set(record.runId,value);
    try {value.watch=fs.watch(dir,{persistent:false},(_event,file)=>{if(!file||String(file)==='interactions.json')this.checkRun(value);});value.watch.on('error',()=>{value.watch?.close();value.watch=null;});}catch{}
    this.checkRun(value);
  }
  diagnostic(run,code,error) {
    const file=path.join(run.dir,'question-bridge.json'),previous=readJson(file);
    if(previous?.code===code)return;
    try {atomicJson(file,{runId:run.record.runId,code,message:String(error?.message||''),at:new Date().toISOString()});}catch{}
  }
  check(){for(const run of this.runs.values())this.checkRun(run);}
  checkRun(run) {
    if(this.closed)return;
    try {
      const record=recordFor(path.join(run.cwd,'.codex-runner/logs'),run.record.runId);if(!record)return;
      const {interactions}=readInteractions(run.dir,record.runId);
      for(const item of interactions) {
        const key=record.runId+':'+item.interactionId,waiting=this.waits.get(key);
        if(item.state!=='pending'){waiting?.abort.abort();this.waits.delete(key);continue;}
        if(waiting&&(!waiting.retryAt||Date.now()<waiting.retryAt))continue;
        const agent=this.lookupAgent(record.sessionId);
        if(!agent||agent.session?.id!==record.sessionId||!agent.session?.header?.cwd||path.resolve(agent.session.header.cwd)!==path.resolve(run.cwd)){this.diagnostic(run,'session-agent-unavailable');continue;}
        if(item.params.questions.some(q=>q.isSecret)){this.diagnostic(run,'secret-question-renderer-unavailable');continue;}
        const abort=new AbortController(),state={abort,done:false};this.waits.set(key,state);
        const questions=item.params.questions.map(q=>({id:q.id,question:q.question,header:q.header,
          ...(q.options?{options:q.options.map(o=>({...o}))}:{})}));
        // No await: a question must never block unrelated output or another request.
        void Promise.resolve().then(()=>this.ask({agent,questions,signal:abort.signal})).then(async answer=>{
          if(abort.signal.aborted)return;
          const response={answers:Object.fromEntries((answer.answers||[]).map(row=>[row.id,{answers:row.custom?[row.custom]:row.selected}]))};
          const message=answerControlMessage(run.dir,record.runId,item.interactionId,response,'user');
          await this.send(run.dir,record,'answer',message,{signal:abort.signal});
          state.done=true;this.diagnostic(run,'answer-submitted');
        }).catch(async error=>{
          if(abort.signal.aborted)return;
          state.done=true;
          if(error.code==='ASK_CANCELLED') {
            try {await this.send(run.dir,record,'dismiss-question',{interactionId:item.interactionId,connectionId:item.connectionId,source:'user'},{signal:abort.signal});this.diagnostic(run,'user-cancelled');}
            catch(error){this.diagnostic(run,'cancel-delivery-unknown',error);}
          } else {
            if(['NO_PROVIDER','CALLER_NOT_LIVE'].includes(error.code))state.retryAt=Date.now()+5000;
            this.diagnostic(run,'question-unavailable-or-answer-failed',error);
          }
          // Keep the local claim after uncertainty; do not silently replay an answer.
        });
      }
      const meta=readJson(path.join(run.dir,'result.meta.json'));
      if(meta?.status&&!interactions.some(item=>item.state==='pending')){run.watch?.close();this.runs.delete(record.runId);}
    } catch(error){this.diagnostic(run,'question-read-failed',error);}
  }
  close(){this.closed=true;clearInterval(this.timer);for(const run of this.runs.values())run.watch?.close();for(const wait of this.waits.values())wait.abort.abort();this.runs.clear();this.waits.clear();}
}
