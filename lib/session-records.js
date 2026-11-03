import fs from 'node:fs';
import path from 'node:path';
import {atomicJson,readJson,runDirectory,claimLock,isTerminalStatus} from './run-store.js';
import {readOutput,readOutputResource} from './output-stream.js';

export const ITEM_RECORD_TYPE='plugin:codex-runner/item';
const TYPES={agentMessage:'agentMessage',agent_message:'agentMessage',commandExecution:'commandExecution',command_execution:'commandExecution',fileChange:'fileChange',file_change:'fileChange'};
const PREVIEW_BYTES=8192;
function preview(value,limit=PREVIEW_BYTES) {
  const bytes=Buffer.from(typeof value==='string'?value:'');
  // TextDecoder drops an incomplete trailing code point without inserting U+FFFD.
  return new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes.subarray(0,limit),{stream:bytes.length>limit});
}
export async function probeSessionRecords(load=()=>import('@deepseek-ai/dsh-session')) {
  try {const api=await load();return typeof api.appendPluginRecord==='function'
    ? {append:api.appendPluginRecord,diagnostic:null}
    : {append:null,diagnostic:'appendPluginRecord is unavailable'};}
  catch(error){return {append:null,diagnostic:'dsh-session unavailable: '+String(error.code||error.message)};}
}
function completedItem(dir,runId,event) {
  if(!['item/completed','item.completed'].includes(event.method))return null;
  if(event.params)return event.params.item;
  if(!event.payload)return null;
  const chunks=[];let offset=0;
  for(;;){const part=readOutputResource(dir,runId,{sequence:event.sequence,offset,limit:65536});chunks.push(Buffer.from(part.data,'base64'));offset=part.next_offset;if(!part.has_more)break;}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')).item;
}
/** Only bounded presentation fields enter the host log; outputSeq retains the source. */
export function buildItemRecord(record,event,item=event.params?.item) {
  const type=Object.hasOwn(TYPES,item?.type)?TYPES[item.type]:null;
  if(!['item/completed','item.completed'].includes(event.method)||!type||event.runId!==record.runId)return null;
  const data={version:2,runId:record.runId,callId:record.callId,sessionId:record.sessionId,outputSeq:event.sequence,
    itemId:preview(item.id||event.itemId,512),threadId:preview(event.threadId,512),turnId:preview(event.turnId,512),type,
    completedAt:event.receivedAt,text:'',truncated:false};
  const limit=source=>{const text=typeof source==='string'?source:'';return {text:preview(text),truncated:Buffer.byteLength(text)>PREVIEW_BYTES};};
  if(type==='agentMessage')Object.assign(data,limit(item.text));
  else if(type==='commandExecution') {
    data.command=preview(item.command,1024);Object.assign(data,limit(item.aggregatedOutput??item.aggregated_output??item.output));
    const exit=item.exitCode??item.exit_code;if(Number.isInteger(exit))data.exitCode=exit;
  } else {
    const changes=Array.isArray(item.changes)?item.changes:[];
    Object.assign(data,limit(changes.map(change=>[change.path,change.diff??JSON.stringify(change)].join('\n')).join('\n')));
    data.paths=preview(changes.map(change=>change.path).filter(p=>typeof p==='string').join(', '),1024);
  }
  return data;
}

/** Host-only tailer. No model, supervisor, schedule or driver dependency. */
export class SessionRecords {
  constructor({lookupSession,settings,flush,load,intervalMs=1000}) {
    this.lookupSession=lookupSession;this.settings=settings;this.flush=flush;this.intervalMs=intervalMs;
    this.capability=probeSessionRecords(load);this.runs=new Map();this.closed=false;
  }
  track({cwd,record}) {
    if(this.closed||!record?.sessionId||!record.callId)return;
    const dir=runDirectory(path.join(cwd,'.codex-runner/logs'),record);
    if(!this.runs.has(record.runId))this.runs.set(record.runId,{cwd,dir,record});
  }
  start() {if(!this.timer&&!this.closed){this.timer=setInterval(()=>void this.poll(),this.intervalMs);this.timer.unref?.();}return this;}
  async close() {this.closed=true;clearInterval(this.timer);await this.polling;}
  poll() {
    if(this.closed)return Promise.resolve();
    if(this.polling)return this.polling;
    this.polling=(async()=>{for(const run of this.runs.values()){
      if(this.closed)break;
      try {await this.inspect(run);}catch(error){this.diagnostic(run,'error',String(error.message));}
    }})().finally(()=>{this.polling=null;});return this.polling;
  }
  diagnostic(run,status,error=null) {
    if(!fs.existsSync(run.dir))return;
    const file=path.join(run.dir,'session-records-diagnostic.json'),previous=readJson(file);
    if(previous?.status===status&&previous?.error===error)return;
    try{atomicJson(file,{runId:run.record.runId,status,error,at:new Date().toISOString()});}catch{}
  }
  async inspect(run) {
    const {record,dir}=run,{append,diagnostic}=await this.capability;
    if(!fs.existsSync(dir)){this.runs.delete(record.runId);return;}
    if(!append){this.diagnostic(run,'unavailable',diagnostic);this.runs.delete(record.runId);return;}
    if(this.settings().streamOutputEnabled===false){this.diagnostic(run,'disabled');return;}
    const session=this.lookupSession(record.sessionId);
    if(!session||session.id!==record.sessionId||path.resolve(session.header?.cwd||'')!==path.resolve(run.cwd)){
      this.diagnostic(run,'session-unavailable');return;
    }
    const release=claimLock(path.join(dir,'session-records.lock'),{runId:record.runId,sessionId:record.sessionId});
    if(!release)return;
    try {
      const file=path.join(dir,'session-records.json');
      let state=readJson(file);
      if(fs.existsSync(file)&&(!state||state.version!==1||state.runId!==record.runId||state.sessionId!==record.sessionId||state.callId!==record.callId
        ||!Number.isSafeInteger(state.cursor)||state.cursor<0||!Number.isSafeInteger(state.count)||state.count<0
        ||state.pending&&(!Number.isSafeInteger(state.pending.outputSeq)||state.pending.outputSeq<=state.cursor)))throw Error('Invalid session record cursor');
      state||={version:1,runId:record.runId,sessionId:record.sessionId,callId:record.callId,cursor:0,count:0,pending:null};
      const commit=async(seq,outputSeq)=>{
        if(this.flush&&await this.flush(session)===false)throw Error('Session record durability listener unavailable');
        state={...state,cursor:outputSeq,count:state.count+1,lastRecordSeq:seq,pending:null};atomicJson(file,state);
      };
      if(state.pending) {
        // The previous append/flush may have committed before the process stopped.
        // Reconcile by exact run + call + output sequence, never by thread/item id.
        if(typeof session.snapshotEvents!=='function')throw Error('Pending record delivery uncertain; session replay API unavailable');
        const existing=session.snapshotEvents().find(event=>event.type===ITEM_RECORD_TYPE&&event.data?.runId===record.runId
          &&event.data?.sessionId===record.sessionId&&event.data?.callId===record.callId&&event.data?.outputSeq===state.pending.outputSeq);
        if(existing)await commit(existing.seq,state.pending.outputSeq);
        else {state.pending=null;atomicJson(file,state);}
      }
      const batch=readOutput(dir,record.runId,{after:state.cursor,limit:100});
      for(const event of batch.events) {
        if(this.closed||this.settings().streamOutputEnabled===false)break;
        const data=buildItemRecord(record,event,completedItem(dir,record.runId,event));
        if(data) {
          state.pending={outputSeq:event.sequence};atomicJson(file,state);
          const seq=await append(session,ITEM_RECORD_TYPE,data);
          if(!Number.isSafeInteger(seq)||seq<0)throw Error('Invalid plugin record receipt');
          await commit(seq,event.sequence);
        } else {state.cursor=event.sequence;}
      }
      if(batch.events.length)atomicJson(file,state);
      this.diagnostic(run,'available');
      const meta=readJson(path.join(dir,'terminal.json'))||readJson(path.join(dir,'result.meta.json')),latest=readJson(path.join(dir,'run.json'));
      if(state.cursor===batch.latest_cursor&&(isTerminalStatus(meta?.status)||isTerminalStatus(latest?.state)))this.runs.delete(record.runId);
    } finally {release();}
  }
}
