import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function probeRealModel({ctx,root,workspace,hostRequire,packageDir}){
  const {createUserMessage,isAgentLoopRequest}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  const provider=process.env.DSH_ACCEPT_REAL_PROVIDER||'deepseek-account',model=process.env.DSH_ACCEPT_REAL_MODEL;
  const models=await ctx.get('llm').listModels(provider);
  fs.writeFileSync(path.join(root,'real-dsh-preflight.json'),JSON.stringify({provider,model,offered:models.map(m=>({id:m.id,provider:m.provider})),credentialProvider:ctx.get('credentials')?.constructor.name,accountAvailable:!!ctx.get('deepseekAccount'),accountCredentialAvailable:!!(await ctx.get('deepseekAccount')?.resolveToken('https://api.deepseek.com'))},null,2));
  console.log('Real DSH model preflight; evidence='+root);
  assert.ok(models.some(m=>m.id===model),'Requested model is absent from the live provider catalog');
  const marker='ANSWER_'+randomUUID(),direction='DIRECTION_'+randomUUID(),sessionId=randomUUID();
  const realCodex=process.env.DSH_ACCEPT_REAL_CODEX==='1',blocking=process.env.DSH_ACCEPT_REAL_SCENARIO==='blocking',asyncQuestion=process.env.DSH_ACCEPT_REAL_SCENARIO==='async';
  assert.ok(!(blocking||asyncQuestion)||realCodex,'Question scenario requires real Codex');
  const previousEnv=Object.fromEntries(['CODEX_HOME','CODEX_EXE','NODE_OPTIONS','CODEX_RUNNER_SCHEMA_OFFLINE','DSH_ACCEPT_CLIENT_URL','DSH_ACCEPT_WIRE_LOG'].map(k=>[k,process.env[k]]));
  let codexVersion;
  if(realCodex){
    assert.ok(process.env.DSH_ACCEPT_CODEX_HOME,'Real Codex acceptance requires an explicit CODEX_HOME');
    process.env.CODEX_HOME=process.env.DSH_ACCEPT_CODEX_HOME;delete process.env.CODEX_EXE;delete process.env.NODE_OPTIONS;delete process.env.CODEX_RUNNER_SCHEMA_OFFLINE;
    const {diagnoseCodex}=await import('../lib/executable.js');const report=await diagnoseCodex();assert.ok(report.authenticated&&report.app_server);codexVersion=report.version;
    if(blocking){
      process.env.DSH_ACCEPT_CLIENT_URL=pathToFileURL(path.join(packageDir,'lib/app-server-client.js')).href;
      process.env.DSH_ACCEPT_WIRE_LOG=path.join(root,'blocking-wire.jsonl');
      const preload=path.join(root,'acceptance-plan-mode.mjs');fs.copyFileSync(new URL('./acceptance-plan-mode.mjs',import.meta.url),preload);
      process.env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;
    }
  }
  if(process.env.DSH_ACCEPT_REAL_SCENARIO==='conversation') {
    try {return await (await import('./host-conversation-probe.mjs')).probeConversation({ctx,root,workspace,hostRequire,provider,model,codexVersion});}
    finally {for(const [key,value] of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  }
  const promptFile='real-supervision.md';fs.writeFileSync(path.join(workspace,promptFile),asyncQuestion?'Call request_user_input_async to ask one structured question titled Choose a marker. Then emit commentary PROGRESS_BEFORE_ANSWER and execute PowerShell Start-Sleep -Seconds 15. Do not answer your own question. When the user supplies an answer, reply exactly with its marker. If no answer has arrived, finish with WAITING_FOR_ANSWER; the user may reply in a later turn. Do not inspect or modify files, use network, or delegate.':blocking?'Use request_user_input to ask one structured blocking question with title Choose a marker, options Alpha and Beta, and free text allowed. Wait for its actual response. Then reply exactly with the marker from that response. Do not answer your own question, inspect files, run shell, use network, or delegate.':realCodex?'Output a commentary message containing NEED_DIRECTION. Then run PowerShell Start-Sleep -Seconds 30. Do not inspect or modify files, use network, or delegate. After the wait, follow any additional user instruction about the final answer; otherwise answer ORIGINAL_DONE.':'SUPERVISELIVE QUESTION');
  const questionOnly=process.env.DSH_ACCEPT_QUESTION_ONLY==='1';
  const settings=ctx.get('settings');await settings.mutate('dsh-codex-runner',[{op:'set',path:['supervisionEnabled'],value:!questionOnly},{op:'set',path:['autoAnswerQuestions'],value:true}],settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  const handle=await ctx.get('agents').create({sessionId,meta:{cwd:workspace},agentOptions:{provider,model,reasoningEffort:'low'}});
  const requests=[],actions=[];let runId,error;
  const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(workspace,'.codex-runner/logs/runs',runId,name),'utf8'));}catch{return null;}};
  const off=ctx.on('llm/stream',async function*(options,next){
    if(isAgentLoopRequest(options)&&options.messages.some(m=>JSON.stringify(m.content).includes(marker))){requests.push({at:Date.now(),supervision:options.messages.filter(m=>['codex-runner-supervision','codex-runner-questions'].includes(m.source?.kind)).map(m=>m.id),active:runId?!read('result.meta.json')?.status:null});if(requests.length>16)throw Error('Acceptance model step limit reached');}
    yield* next();
  });
  const offQuestion=ctx.on('user-questions/request',request=>{if(request.agent!==handle.agent)return;return new Promise((_r,reject)=>request.signal.addEventListener('abort',()=>reject(Object.assign(Error('No manual answer in this acceptance'),{code:'ASK_CANCELLED'})),{once:true}));},{prepend:true});
  try{
    handle.agent.followup(createUserMessage({content:[{type:'text',text:`Run one controlled Codex acceptance task using codex_run(prompt_file="${promptFile}",label="real-supervision",model="gpt-6.1-sol",effort="low",budget_ms=180000,notify_on_complete="off"). The file already exists. Do not inspect files, run shell commands, use network tools, create schedules, or delegate other tasks. You are authorized to answer any "Choose a marker" question with exactly ${marker}; use codex_questions then codex_answer on the original request. When Codex progress says NEED_DIRECTION, use codex_say action=steer on that same run, instructing Codex to reply exactly ${direction} as its final answer. Supervision will supply updates automatically; do not block with a long status wait or start another run. Once finished, check codex_status and report the final answer. If no update has arrived yet, end your response and let supervision wake you.`}],source:{kind:'user'}}));
    for(let i=0;i<1900;i++){
      const base=path.join(workspace,'.codex-runner/logs/runs');if(!runId&&fs.existsSync(base))for(const name of fs.readdirSync(base)){try{const r=JSON.parse(fs.readFileSync(path.join(base,name,'run.json'),'utf8'));if(r.sessionId===sessionId)runId=r.runId;}catch{}}
      if(runId&&read('result.meta.json')?.status)break;await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(runId,'Real DSH model did not start the requested run');
    const meta=read('result.meta.json'),interaction=read('interactions.json')?.interactions?.[0];
    assert.equal(meta?.status,'ok','Real DSH model did not finish the supervised task');if(!realCodex||blocking||asyncQuestion){assert.equal(interaction?.source,'model');assert.ok(meta.lastMessage.includes(marker));}if(!blocking&&!asyncQuestion)assert.ok(meta.lastMessage.includes(direction));assert.ok(requests.some(r=>r.supervision.length&&r.active));
    if(asyncQuestion){
      assert.equal(interaction.kind,'async-message');assert.equal(interaction.requestId,null);assert.equal(interaction.state,'submitted');
      assert.equal(meta.lastMessage.trim(),marker);assert.ok(['accepted_by_active_turn','accepted_by_next_turn'].includes(interaction.submission));
    }
    if(questionOnly){assert.equal(read('supervision-state.json').modelCursor,0);assert.ok(read('supervision-state.json').questionsRead.length>0);}
    if(blocking){
      assert.equal(interaction.params.isBlocking,true);assert.equal(meta.lastMessage.trim(),marker);
      const wire=fs.readFileSync(process.env.DSH_ACCEPT_WIRE_LOG,'utf8').trim().split('\n').map(JSON.parse);
      const original=wire.find(e=>e.kind==='server-request'&&e.message.method==='item/tool/requestUserInput');
      const replies=wire.filter(e=>e.kind==='original-response');assert.equal(replies.length,1);
      assert.equal(replies[0].id,original.message.id);assert.equal(replies[0].connectionId,original.connectionId);
      assert.ok(JSON.stringify(replies[0].value).includes(marker));
    }
    actions.push({question:interaction?.interactionId,source:interaction?.source,answer:meta.lastMessage});
    console.log('REAL-DSH-MODEL-OK '+provider+'/'+model+'; evidence='+root);
    return requests.length;
  }catch(e){error=e.message;throw e;}finally{
    if(runId&&!read('result.meta.json')?.status)await ctx.get('tools').get('codex_cancel').execute({run_id:runId},{agent:handle.agent});
    fs.writeFileSync(path.join(root,'real-dsh-model.json'),JSON.stringify({classification:realCodex?'real-host/real-dsh-model/real-codex':'real-host/real-dsh-model/fake-codex',questionOnly,scenario:asyncQuestion?'async-correlated-message':blocking?'blocking-original-rpc':'steer',collaborationMode:blocking?'plan':'default',codexVersion,provider,model,sessionId,runId,requests,actions,error,interactions:read('interactions.json'),supervision:read('supervision-state.json')},null,2));
    off();offQuestion();await handle.dispose();
    for(const [key,value]of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
}
