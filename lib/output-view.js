import path from 'node:path';
import {listRecords,readJson,isTerminalStatus} from './run-store.js';
import {resolveSupervisedRun} from './supervision.js';
import {readOutput,readOutputResource} from './output-stream.js';

export function createOutputView({lookupSession,settings,onRead}) {
  function resolve(args) {
    if(typeof args.sessionId!=='string'||typeof args.callId!=='string'||!args.callId||args.callId.length>512)throw Error('Session and exact tool call are required');
    const session=lookupSession(args.sessionId),cwd=session?.header?.cwd;
    if(!cwd)throw Error('Session workspace is unavailable');
    if(args.runId!==undefined){
      const resolved=resolveSupervisedRun(cwd,{run_id:args.runId},args.sessionId);
      if(resolved.record.callId!==args.callId)throw Error('Output tool call mismatch');
      onRead?.(resolved.dir,resolved.record);return resolved;
    }
    const matches=listRecords(path.join(cwd,'.codex-runner/logs')).filter(row=>row.sessionId===args.sessionId&&row.callId===args.callId);
    if(matches.length!==1)throw Error('Exact tool call has no unique run');
    if(args.runId!==undefined&&args.runId!==matches[0].runId)throw Error('Output run mismatch');
    const resolved=resolveSupervisedRun(cwd,{run_id:matches[0].runId},args.sessionId);
    onRead?.(resolved.dir,resolved.record);return resolved;
  }
  return {
    read(args) {
      if(args.after!==undefined&&(!Number.isSafeInteger(args.after)||args.after<0)||args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>200))throw Error('Invalid output cursor or limit');
      const {record,dir}=resolve(args),enabled=settings().streamOutputEnabled!==false;
      if(!enabled)return {status:'disabled',run_id:record.runId,events:[],next_cursor:args.after||0,has_more:false};
      const records=readJson(path.join(dir,'session-records.json'));
      const itemRecords=records?.runId===record.runId&&records?.sessionId===record.sessionId&&records?.callId===record.callId&&records.count>0;
      // Observe terminal state before reading the output cursor: a final response
      // must not combine a stale output boundary with a newer terminal marker.
      const executionStatus=readJson(path.join(dir,'terminal.json'))?.status||readJson(path.join(dir,'result.meta.json'))?.status||(isTerminalStatus(record.state)?record.state:'running');
      return {...readOutput(dir,record.runId,args),run_id:record.runId,backend:record.backend,item_records:itemRecords,
        execution_status:executionStatus,mobile:'unverified'};
    },
    resource(args) {const {record,dir}=resolve(args);if(settings().streamOutputEnabled===false)throw Error('Output display is disabled');return readOutputResource(dir,record.runId,args);},
  };
}
