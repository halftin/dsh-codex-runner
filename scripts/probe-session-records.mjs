// Offline API probe of an already installed host. Never starts an agent or writes a session.
// node scripts/probe-session-records.mjs <existing npm host prefix>
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {probeSessionRecords,ITEM_RECORD_TYPE} from '../lib/session-records.js';
const prefix=process.argv[2];if(!prefix)throw Error('Pass an existing npm host prefix; no packages will be installed');
const require=createRequire(path.resolve(prefix,'package.json'));
const api=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
const capability=await probeSessionRecords(async()=>api);assert.equal(typeof capability.append,'function');
const session=api.Session.create('codex-record-probe'),before=session.deriveMessages();
const data={version:2,runId:'probe-run',callId:'probe-call',sessionId:session.id,outputSeq:1,type:'agentMessage',text:'display-only marker',truncated:false};
const seq=capability.append(session,ITEM_RECORD_TYPE,data),events=session.snapshotEvents(),event=events.find(e=>e.seq===seq);
assert.equal(event.type,ITEM_RECORD_TYPE);assert.equal(event.ignorable,true);assert.deepEqual(event.data,data);
assert.equal(api.isSurfaceEvent(event),false);assert.deepEqual(session.deriveMessages(),before);
const restored=api.Session.create(session.id,events);assert.deepEqual(restored.snapshotEvents().filter(e=>e.type===ITEM_RECORD_TYPE),events);assert.deepEqual(restored.deriveMessages(),before);
console.log(JSON.stringify({classification:'offline-existing-host-detached-session',version:require('@deepseek-ai/dsh-session/package.json').version,
  appendPluginRecord:typeof capability.append,flush:typeof api.SessionStore.prototype.flush,seq,ignorable:event.ignorable,
  surface:false,replay:true,modelCalls:0,livePersistence:'not exercised',desktopUi:'not exercised'},null,2));
