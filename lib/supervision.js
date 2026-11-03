import path from 'node:path';
import { recordFor, runDirectory, validRunId } from './run-store.js';
import {readInteractions,answerControlMessage} from './interactions.js';
import {sendControl} from './run-control.js';
import {readOutput} from './output-stream.js';
import {readJson} from './run-store.js';

// Versioned plugin contract. These are not Codex configuration fields.
export const STREAM_CONTRACT_VERSION = 1;
export function runCapabilities(backend) {
  if (!['exec', 'app-server'].includes(backend)) throw Error('Unsupported backend');
  return {
    contract_version: STREAM_CONTRACT_VERSION, backend,
    output: { status: 'available', granularity: backend === 'exec' ? 'item' : 'delta',display:'host_adapter_required',mobile:'unverified' },
    questions: { status: backend === 'exec' ? 'unsupported' : 'available', methods: backend==='exec'?[]:['item/tool/requestUserInput'],
      unknown_requests:'explicit_error',approval_requests:'unsupported_no_automatic_approval',
      async_agent_message_questions:backend==='exec'?'unsupported':'correlated_user_message',
      async_reply_protocol:backend==='exec'?null:'send_user_message_question_reply' },
    supervision: { status: 'available',delivery:'native_agent_inbox',receipt:'provider_request_started',host_required:true },
    control: backend === 'exec' ? ['queue'] : ['queue', 'steer', 'interrupt'],
    model_question_support: 'unverified',
  };
}

export function resolveSupervisedRun(cwd, args, sessionId) {
  if (!cwd || !path.isAbsolute(cwd)) throw Error('Session workspace is unavailable');
  if (!validRunId(args?.run_id)) throw Error('A valid run_id is required');
  const logs = path.join(cwd, '.codex-runner', 'logs');
  const record = recordFor(logs, args.run_id);
  if (!record || record.runId !== args.run_id) throw Error('Run not found in this workspace');
  if (!sessionId || record.sessionId !== sessionId) throw Error('Run belongs to a different or unavailable session');
  if (!['exec', 'app-server'].includes(record.backend)) throw Error('Unsupported backend');
  return { record, dir: runDirectory(logs, record) };
}

const specs = {
  codex_capabilities: {
    description: 'Read the exact run backend capabilities and implementation state. A saved preference does not prove that streaming, questions, or supervision is available.',
    fields: {},
  },
  codex_stream: {
    description: 'Read Codex output after an exclusive sequence cursor. Display and model cursors are independent. Large payloads retain a complete JSON resource in the run directory; a preview is not the full content. Never infer an inaccessible resource was read.',
    fields: { after: { type: 'integer', description: 'Exclusive sequence, initially 0.' }, limit: { type: 'integer', description: 'Maximum events, 1–200.' } },
  },
  codex_questions: {
    description: 'List structured questions for the exact run, independently of execution state and both display settings. Pending questions can be answered with codex_answer. Submitted means written to the connection; resolved means closed, not proof the answer was accepted.',
    fields: {},
  },
  codex_answer: {
    description: 'Answer an exact pending Codex interaction using {answers:{questionId:{answers:["answer"]}}}; copy question IDs exactly from codex_questions. Native RPC questions use the original response. Async message questions use the official correlated user-message envelope in the active or next turn of the same thread. Answer only within existing task authorization; ask the user for missing information. Never auto-approve permissions. Delivery is not proof the model used the answer.',
    fields: {
      interaction_id: { type: 'string', required: true, description: 'Plugin interaction UUID returned by codex_questions.' },
      response: { type: 'json', required: true, description: 'Response matching the recorded request method and response schema.' },
    },
  },
};

export function supervisionTools({ defineTool, resolveCwd }) {
  return Object.entries(specs).map(([name, spec]) => defineTool({
    name, description: spec.description,
    parameters: { run_id: { type: 'string', required: true }, ...spec.fields },
    output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: value.summary_text }] },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: name, kind: name === 'codex_answer' ? 'execute' : 'read' }),
    async execute(args, exec) {
      try {
        if (!args || Object.keys(args).some(key => !['run_id', ...Object.keys(spec.fields)].includes(key))) throw Error('Invalid arguments');
        if (name === 'codex_stream' && ((args.after !== undefined && (!Number.isSafeInteger(args.after) || args.after < 0))
          || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 200)))) throw Error('Invalid output cursor or limit');
        if (name === 'codex_answer' && (!validRunId(args.interaction_id) || !args.response || typeof args.response !== 'object' || Array.isArray(args.response))) throw Error('Invalid interaction or response');
        const { record,dir } = resolveSupervisedRun(resolveCwd(exec), args, exec?.agent?.session?.id);
        const capabilities = runCapabilities(record.backend);
        let status = name === 'codex_capabilities' ? 'ok' : record.backend === 'exec' && ['codex_questions', 'codex_answer'].includes(name) ? 'unsupported' : 'not_implemented';
        let data={};
        if(name==='codex_capabilities')data.supervision_state=readJson(path.join(dir,'supervision-state.json'));
        if(name==='codex_stream'){data=readOutput(dir,record.runId,{after:args.after,limit:args.limit});status=data.status;}
        if(record.backend==='app-server'&&name==='codex_questions'){data=readInteractions(dir,record.runId);status='ok';}
        if(record.backend==='app-server'&&name==='codex_answer') {
          const message=answerControlMessage(dir,record.runId,args.interaction_id,args.response,'model');
          data=await sendControl(dir,record,'answer',message,{signal:exec?.signal});status='ok';
        }
        const result = { status, contract_version: STREAM_CONTRACT_VERSION, run_id: record.runId, capabilities,...data };
        return { ...result, summary_text: JSON.stringify(result) };
      } catch (error) { return { status: 'error', summary_text: error.message }; }
    },
  }));
}
