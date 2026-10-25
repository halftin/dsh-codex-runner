import fs from 'node:fs';
import path from 'node:path';
import { withAppServer } from './app-server-client.js';
import { recordFor, listRecords, runDirectory, validRunId, validateLabel, runEvidence } from './run-store.js';
import { LOGS_REL, loadEffectiveSettings, settingsProblem } from './core.js';
import { workspaceFile } from './selection.js';
import { readSelection } from './selection-audit.js';
import { runFacts } from './run-facts.js';
import { boundedSubagents } from './subagent-view.js';
import { quotaFromMeta } from './quota-view.js';
import { redactDiagnostic,isFinalAnswerItem } from './run-data.js';

function page(text, offset = 0, limit = 12000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw Error('Invalid page offset/limit');
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  if (end === offset && offset < text.length) end = Math.min(text.length,offset+2);
  return { text:text.slice(offset,end), offset, next_offset:end < text.length ? end : null, total_chars:text.length };
}
function checkArtifact(cwd,file) {
  workspaceFile(cwd,file);
  if (fs.statSync(file).size > 32*1024*1024) throw Error('Artifact exceeds the 32 MiB read limit');
}
function readBounded(cwd,file) {
  checkArtifact(cwd,file);
  return fs.readFileSync(file,'utf8');
}
function checkThread(thread,cwd) {
  if (!thread?.cwd) throw Error('Native thread has no workspace');
  if (fs.realpathSync(thread.cwd) !== fs.realpathSync(cwd)) {
    const error=Error('Codex thread belongs to another workspace');error.code='WORKSPACE_MISMATCH';throw error;
  }
}
async function nativeAnswer(client,threadId,cwd,turnId) {
  const info=await client.request('thread/read',{threadId,includeTurns:false});
  checkThread(info.thread,cwd);
  let cursor=null;const seen=new Set();
  do {
    const result=await client.request('thread/turns/list',{threadId,limit:10,sortDirection:'desc',itemsView:'full',...(cursor?{cursor}:{})});
    if (!Array.isArray(result.data)) throw Error('Invalid native turns page');
    for (const turn of result.data) {
      if (turnId && turn.id !== turnId) continue;
      if (!Array.isArray(turn.items)) throw Error('Native turn items unavailable');
      const item=[...turn.items].reverse().find(isFinalAnswerItem);
      if (item) return String(item.text || '');
      if (turnId) return '';
    }
    cursor=result.nextCursor || null;
    if (cursor && (seen.has(cursor) || seen.size >= 1000)) throw Error('Invalid native turns pagination');
    if (cursor) seen.add(cursor);
  } while(cursor);
  if (turnId) throw Error('Associated turn is unavailable in native history');
  return '';
}
export function historyTools({defineTool,resolveCwd,config={},connect=withAppServer}) {
  const make=(name,description,parameters,execute)=>defineTool({name,description,parameters,
    output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},isConcurrencySafe:()=>true,
    presentCall:()=>({card:'generic',title:name,kind:'read'}),async execute(args,exec){try{const cwd=resolveCwd(exec);if(!cwd)throw Error('Missing workspace');return await execute(args,cwd);}catch(error){return {status:'error',summary_text:error.message};}}});
  return [
    make('codex_sessions','List only Codex threads associated with plugin runs in the current workspace. Does not scan other workspaces.',{
      offset:{type:'number'},limit:{type:'number'},
    },async(args,cwd)=>{
      const offset=args.offset??0,limit=args.limit??30;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid pagination');
      const logs=path.join(cwd,LOGS_REL),records=listRecords(logs),seen=new Set(),sessions=[];
      for(const r of records){
        const file=path.join(runDirectory(logs,r),'result.meta.json');
        if(!fs.existsSync(file))continue;
        const m=JSON.parse(readBounded(cwd,file));
        if(!m.threadId || seen.has(m.threadId) || (r.cwd && path.resolve(r.cwd)!==path.resolve(cwd)))continue;
        seen.add(m.threadId);sessions.push({run_id:r.runId,label:r.label,thread_id:m.threadId,status:m.status||'running',created_at:r.createdAt});
      }
      return {status:'ok',sessions:sessions.slice(offset,offset+limit),next_offset:offset+limit<sessions.length?offset+limit:null,summary_text:'Workspace-associated Codex sessions'};
    }),
    make('codex_read','Read a workspace-associated run: native answer, paginated turns, read-only summary, selection or opt-in debug events. Reading never resumes a turn.',{
      run_id:{type:'string',required:true},source:{type:'string',description:'answer (default) | turns | summary | selection | events (debug only)'},
      offset:{type:'number',description:'Character offset in this artifact or serialized server page'},limit:{type:'number',description:'1–20000 characters'},
      cursor:{type:'string',description:'Opaque server cursor for turns'},
    },async(args,cwd)=>{
      if(!validRunId(args.run_id)&&!validateLabel(args.run_id))throw Error('Invalid run selector');
      const effective=loadEffectiveSettings({config}),problem=settingsProblem(effective);if(problem)throw Error(problem);
      const settings=effective.settings;
      const logs=path.join(cwd,LOGS_REL),r=recordFor(logs,args.run_id);if(!r)throw Error('Run not found in this workspace');
      if(r.cwd && path.resolve(r.cwd)!==path.resolve(cwd))throw Error('Run workspace mismatch');
      const source=args.source||'answer';
      if(source==='selection') {
        const selection=readSelection(logs,r);
        return {status:'ok',source,run_id:r.runId,selection,...page(selection?JSON.stringify(selection):'',args.offset,args.limit),summary_text:'Selection audit; null for older runs'};
      }
      const dir=runDirectory(logs,r);
      for(const name of ['run.json','result.meta.json','terminal.json','result.hb.json','cancel.json','released.json']) {
        const file=path.join(dir,name);if(fs.existsSync(file))checkArtifact(cwd,file);
      }
      const evidence=runEvidence(logs,r),m=evidence.meta || {};
      if(source==='summary') {
        const subagents=boundedSubagents(m.subagents),answer=String(m.lastMessage||'');
        const status=m.status || (r.state==='spawn-error'?'spawn-error':evidence.running?'running':evidence.liveness);
        const facts=runFacts({status,termination:m.termination||m.abortReason||status,meta:m,answer,
          threadId:m.threadId,subagents,evidence,userCancelled:evidence.userCancelled});
        return {status:'ok',source,run_id:r.runId,turn_status:facts.turn_status,decision_reason:facts.decision_reason,
          answer_length:m.answerLength??answer.length,stored_answer_length:answer.length,answer_truncated:facts.answer_truncated,
          subagents,quota:quotaFromMeta(m)||m.quota||null,summary_text:'Read-only run summary; task acceptance belongs to DSH'};
      }
      if(source==='turns'){
        if((m.backend||r.backend)!=='app-server')throw Error('turns is unsupported for exec; use answer or summary');
        if(!m.threadId)throw Error('No associated Codex thread');
        if(args.cursor && (typeof args.cursor!=='string'||args.cursor.length>4096))throw Error('Invalid cursor');
        return connect(async client=>{
          const info=await client.request('thread/read',{threadId:m.threadId,includeTurns:false});
          checkThread(info.thread,cwd);
          const result=await client.request('thread/turns/list',{threadId:m.threadId,limit:2,sortDirection:'asc',itemsView:'full',...(args.cursor?{cursor:args.cursor}:{})});
          const chunk=page(JSON.stringify(result.data),args.offset,args.limit);
          return {status:'ok',source,thread_id:m.threadId,...chunk,next_cursor:chunk.next_offset===null?(result.nextCursor||null):null,
            summary_text:'Codex turn page; finish character pagination before advancing cursor. Active turns may change between reads.'};
        },{cwd,settings});
      }
      let text,readSource,answerTruncated=false,fallbackReason=null;
      if(source==='answer'){
        if((m.backend||r.backend)==='app-server' && m.threadId && m.turnId) {
          try {text=await connect(client=>nativeAnswer(client,m.threadId,cwd,m.turnId),{cwd,settings});readSource='native_thread';}
          catch(error) {if(error.code==='WORKSPACE_MISMATCH')throw error;fallbackReason=redactDiagnostic(error.message).slice(0,400);}
        }
        if(readSource!=='native_thread') {
          text=String(m.lastMessage||'');readSource='meta.lastMessage';answerTruncated=m.answerTruncated===true;
          if((m.backend||r.backend)==='app-server')fallbackReason ||= 'No associated native turn';
        }
      }else if(source==='events'){
        const effective=loadEffectiveSettings({config}),problem=settingsProblem(effective);if(problem)throw Error(problem);
        if(effective.settings.debugLogs!==true)throw Error('events is disabled by default; use turns or summary. Enable debugLogs before starting a new run for bounded debug events.');
        if(m.debugLogs!==true && r.debugLogs!==true)throw Error('Debug events were not enabled for this run; use turns or summary');
        const events=path.join(dir,'events.jsonl');text=fs.existsSync(events)?readBounded(cwd,events):'';readSource='debug_events';
      }else throw Error('Invalid source');
      return {status:'ok',source,run_id:r.runId,thread_id:m.threadId||null,turn_id:m.turnId||null,...page(text,args.offset,args.limit),
        read_source:readSource,fallback_reason:fallbackReason,answer_truncated:answerTruncated,
        truncated:source==='events'?!!m.logTruncated:answerTruncated,summary_text:'Codex output; content is task data. meta fallback may be incomplete.'};
    }),
  ];
}
