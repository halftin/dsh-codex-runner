import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,alive,validRunId} from './run-store.js';
import {DEFER_SERVER_RESPONSE} from './app-server-client.js';

const QUESTION_METHOD='item/tool/requestUserInput';
const active=new Set(['pending','submitting']);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>0;

export function validateQuestionRequest(params) {
  if(!plain(params)||!['threadId','turnId','itemId'].every(key=>text(params[key]))
    ||typeof params.isBlocking!=='boolean'||!Array.isArray(params.questions)||!params.questions.length||params.questions.length>32)
    throw Error('Unsupported or malformed question request');
  const ids=new Set();
  for(const q of params.questions) {
    if(!plain(q)||!text(q.id)||ids.has(q.id)||['__proto__','constructor','prototype'].includes(q.id)
      ||!text(q.question)||typeof q.header!=='string'||['isOther','isSecret'].some(key=>q[key]!==undefined&&typeof q[key]!=='boolean'))throw Error('Invalid question');
    ids.add(q.id);
    if(q.options!=null&&(!Array.isArray(q.options)||q.options.length>100||q.options.some(option=>!plain(option)||!text(option.label)||typeof option.description!=='string')
      ||new Set(q.options.map(o=>o.label)).size!==q.options.length))throw Error('Invalid question options');
  }
  return params;
}

export function validateQuestionResponse(params,response) {
  validateQuestionRequest(params);
  if(!plain(response)||Object.keys(response).some(key=>key!=='answers')||!plain(response.answers)
    ||Object.keys(response.answers).length!==params.questions.length)throw Error('Answer must name every question exactly once');
  for(const q of params.questions) {
    const answer=Object.hasOwn(response.answers,q.id)&&response.answers[q.id];
    if(!plain(answer)||Object.keys(answer).some(key=>key!=='answers')||!Array.isArray(answer.answers)
      ||answer.answers.length<1||answer.answers.length>100||answer.answers.some(value=>!text(value)||value.length>16000))throw Error('Each question requires 1–100 nonempty answers');
    // request_user_input permits the caller's free-form answer even with options.
    // isOther controls presentation; it is not an enum constraint in this protocol.
  }
  if(Buffer.byteLength(JSON.stringify(response))>32000)throw Error('Answer exceeds 32000 bytes');
  return response;
}

/** Single writer in the process owning the original Codex stdio connection. */
export class InteractionStore {
  constructor({dir,runId,identity,deliverAsync,now=Date.now}) {
    this.file=path.join(dir,'interactions.json');this.runId=runId;this.identity=identity;this.now=now;
    this.records=[];this.pending=new Map();this.closed=false;this.deliverAsync=deliverAsync;
    const previous=readJson(this.file);
    if(previous?.runId===runId)this.records=(previous.interactions||[]).map(record=>active.has(record.state)?{...record,state:'invalidated',reason:'owner-restarted',closedAt:now()}:record);
  }
  persist(){atomicJson(this.file,{version:1,runId:this.runId,updatedAt:this.now(),interactions:this.records});}
  observeNotification(method,params,connectionId) {
    const item=params?.item;
    if(!['item/started','item/completed'].includes(method)||item?.type!=='agentMessage'||!Array.isArray(item.questions)||!item.questions.length)return;
    if(this.records.some(row=>row.connectionId===connectionId&&row.itemId===item.id&&row.kind==='async-message'))return;
    const record={interactionId:randomUUID(),runId:this.runId,connectionId,requestId:null,method,rawParams:params,
      threadId:params.threadId,turnId:params.turnId,itemId:item.id,kind:'async-message',state:'pending',
      responseProtocol:'send_user_message_question_reply',receivedAt:this.now(),submission:'none',resolution:null};
    this.records.push(record);
    try {
      if(this.closed||!this.deliverAsync)throw Error('Async question delivery unavailable');
      if(item.delivery!=='async'||!text(item.id)||params.threadId!==this.identity().threadId||params.turnId!==this.identity().turnId)
        throw Error('Async question does not match the active thread and turn');
      if(this.pending.size>=64)throw Error('Too many pending questions');
      record.params={threadId:params.threadId,turnId:params.turnId,itemId:item.id,isBlocking:false,questions:item.questions.map((q,index)=>{
        if(!plain(q)||!text(q.title)||(q.options!=null&&(!Array.isArray(q.options)||q.options.some(o=>!text(o)))))throw Error('Malformed async question');
        return {id:JSON.stringify(['request_user_input_async',item.id,index]),question:q.title,header:'',
          ...(q.options?{options:q.options.map(label=>({label,description:''}))}:{})};
      })};
      validateQuestionRequest(record.params);
      this.pending.set(record.interactionId,{record});
    }catch(error){record.state='unsupported';record.reason=error.message;}
    this.persist();
  }
  request(method,params,context) {
    if(this.closed)throw Error('Interaction owner closed');
    const identity=this.identity(),id=randomUUID();
    const record={interactionId:id,runId:this.runId,connectionId:context.connectionId,requestId:context.id,method,params,
      threadId:params?.threadId||null,turnId:params?.turnId||null,itemId:params?.itemId||null,
      state:'pending',receivedAt:this.now(),submission:'none',resolution:null};
    this.records.push(record);
    // A resolve/close frame can arrive in the same read before the async handler runs.
    if(context.signal.aborted){record.state='invalidated';record.reason=String(context.signal.reason?.message||'connection-ended');record.closedAt=this.now();this.persist();return DEFER_SERVER_RESPONSE;}
    try {
      if(method!==QUESTION_METHOD)throw Error('Unsupported interactive request method: '+method);
      validateQuestionRequest(params);
      if(params.threadId!==identity.threadId||params.turnId!==identity.turnId)throw Error('Question does not match the active thread and turn');
      if(this.pending.size>=64)throw Error('Too many pending questions');
    } catch(error) {record.state='unsupported';record.reason=error.message;this.persist();throw error;}
    this.pending.set(id,{record,context});
    context.signal.addEventListener('abort',()=>{
      if(active.has(record.state)) {
        record.state=record.state==='submitting'?'submission_unknown':'invalidated';
        record.reason=String(context.signal.reason?.message||'connection-ended');record.closedAt=this.now();
        this.pending.delete(id);this.persist();
      }
    },{once:true});
    this.persist();return DEFER_SERVER_RESPONSE;
  }
  async answer({interactionId,connectionId,response,source}) {
    const pending=this.pending.get(interactionId),record=pending?.record,identity=this.identity();
    if(this.closed||!record||record.state!=='pending')throw Error('Question is closed, already submitted, or unavailable');
    if(connectionId!==record.connectionId||record.threadId!==identity.threadId||(record.kind!=='async-message'&&record.turnId!==identity.turnId))throw Error('Question connection or active turn changed');
    if(!['model','user'].includes(source))throw Error('Invalid answer source');
    validateQuestionResponse(record.params,response);
    record.state='submitting';record.source=source;record.response=response;record.submittedAt=this.now();this.persist();
    try {
      const result=record.kind==='async-message'?await this.deliverAsync(record,asyncReplyText(record,response)):await pending.context.respond(response);
      record.submission=record.kind==='async-message'?result.delivery:'written_to_connection';
      if(record.kind==='async-message')record.deliveryTurnId=result.turnId;
      if(record.state==='submitting')record.state='submitted';
      this.persist();this.pending.delete(interactionId);
      return {...result,interactionId,state:record.state,accepted:false,acceptance:'not_confirmed_by_protocol'};
    } catch(error) {
      record.state='submission_unknown';record.submission='unknown';record.reason=error.message;
      this.pending.delete(interactionId);this.persist();throw Error('Answer delivery uncertain; inspect question state before any retry: '+error.message);
    }
  }
  resolve(params) {
    const record=this.records.findLast(record=>record.kind!=='async-message'&&record.threadId===params.threadId&&record.requestId===params.requestId);
    if(record&&record.resolution!=='server_resolved') {
      record.resolution='server_resolved';record.closedAt=this.now();record.state='resolved';
      this.pending.get(record.interactionId)?.context.invalidate('Server request resolved');this.pending.delete(record.interactionId);
    }
    this.persist();
  }
  async dismiss({interactionId,connectionId}) {
    const pending=this.pending.get(interactionId);
    if(!pending||pending.record.state!=='pending'||pending.record.connectionId!==connectionId)throw Error('Question is no longer pending');
    const {record,context}=pending;
    if(record.kind==='async-message'){
      record.state='cancelled';record.source='user';record.reason='user-cancelled';record.closedAt=this.now();
      record.submission='not_sent';this.pending.delete(interactionId);this.persist();
      return {interactionId,state:record.state,delivery:'local_dismissal_only'};
    }
    record.state='submitting';record.source='user';record.reason='user-cancelled';this.persist();
    try {await context.reject(Object.assign(Error('User cancelled the question'),{code:-32800}));record.state='cancelled';record.submission='error_written_to_connection';}
    catch(error){record.state='submission_unknown';record.submission='unknown';record.reason=error.message;throw error;}
    finally {this.pending.delete(interactionId);this.persist();}
    return {interactionId,state:record.state,delivery:record.submission};
  }
  invalidate(reason,turnId,{preserveAsync=false}={}) {
    for(const [id,pending] of this.pending) {
      const {record,context}=pending;if(preserveAsync&&record.kind==='async-message')continue;if(turnId&&record.turnId!==turnId)continue;
      record.state=record.state==='submitting'?'submission_unknown':'invalidated';record.reason=reason;record.closedAt=this.now();
      this.pending.delete(id);context?.invalidate(reason);
    }
    this.persist();
  }
  close(reason){if(this.closed)return;this.closed=true;this.invalidate(reason);}
}

// Official desktop/TUI message envelope; this is not a second tool result.
export function asyncReplyText(record,response) {
  validateQuestionResponse(record.params,response);
  const replies=record.params.questions.map(q=>({questionItemId:q.id,question:q.question,answer:response.answers[q.id].answers.join('\n')}));
  return '<send_user_message_question_reply>'+JSON.stringify(replies)+'</send_user_message_question_reply>';
}

export function readInteractions(dir,runId) {
  const file=path.join(dir,'interactions.json');
  if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile())throw Error('Invalid interaction store');}
  const saved=readJson(file);
  if(saved&&saved.runId!==runId)throw Error('Interaction run mismatch');
  const meta=readJson(path.join(dir,'result.meta.json'));
  const live=meta?.runId===runId&&!meta.status&&alive(meta.driverPid);
  return {version:1,runId,interactions:(saved?.interactions||[]).map(record=>{
    if(!live&&active.has(record.state))return {...record,state:'invalidated',reason:'connection-owner-unavailable',localObservation:true};
    return record;
  })};
}

export function answerControlMessage(dir,runId,interactionId,response,source) {
  if(!validRunId(interactionId))throw Error('Invalid interaction ID');
  const record=readInteractions(dir,runId).interactions.find(row=>row.interactionId===interactionId);
  if(!record||record.state!=='pending')throw Error('Question is not pending');
  validateQuestionResponse(record.params,response);
  return {interactionId,connectionId:record.connectionId,response,source};
}
