import path from 'node:path';
import { atomicJson, recordFor, runDirectory } from './run-store.js';
import { runFacts } from './run-facts.js';
import { handoffText } from './task-handoff.js';

// A submitted tool result is a transport receipt, not task acceptance by DSH.
export function withTaskReturn(definition, resolveCwd, logsRelative) {
  const execute = definition.execute;
  return { ...definition, async execute(args, exec) {
    let result;
    try { result = await execute(args, exec); }
    catch (error) { result = { status:'error', summary_text:'[codex] error: ' + error.message }; }
    if (result.status === 'error' && !result.handoff) {
      Object.assign(result, runFacts({status:'failed',evidence:{liveness:'unknown'}}));
      result.next_action = handoffText(result.handoff);
      result.summary_text += '\n' + result.next_action;
    }
    if (result.run_id && !result.detached && !exec?.signal?.aborted && result.abort_reason !== 'host-shutdown') {
      try {
        const logs = path.join(resolveCwd(exec), logsRelative), record = recordFor(logs,result.run_id);
        if (record) atomicJson(path.join(runDirectory(logs,record),'tool-returned.json'), {
          runId:record.runId, at:new Date().toISOString(),
          replySequence:Math.max(0,...(result.reply_signals || []).map(s=>s.sequence || 0)),
        });
      } catch { /* Retain the notifier registration if receipt persistence fails. */ }
    }
    return result;
  } };
}
