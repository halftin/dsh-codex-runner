// Real installed DSH services, deterministic adapter: no provider HTTP/model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function probeHostPaths({ctx,root,hostRequire}) {
  const {LlmAdapter,createUserMessage,isAgentLoopRequest} = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')));
  let release, started;
  const first = new Promise(resolve=>{started=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  const calls=[],events=[];let auxiliaryCalls=0;
  class Adapter extends LlmAdapter {
    async *stream(options) {
      if(isAgentLoopRequest(options)) {
        calls.push(options.messages);
        if(calls.length===1){started();await gate;}
      } else auxiliaryCalls++;
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'HOST_PROBE_OK'};
      yield {type:'block-end',index:0,block:{type:'text',text:'HOST_PROBE_OK'}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const registration=ctx.get('llm').registerAdapter(['runner-probe'],new Adapter());
  const handle=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:root},agentOptions:{provider:'runner-probe',model:'fixture'}});
  const {agent}=handle;
  const off=ctx.on('session/event',(session,event)=>{if(session.id===agent.session.id)events.push(event.type);});
  const message=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});
  try {
    agent.followup(message('initial'));
    await Promise.race([first,new Promise((_,reject)=>setTimeout(()=>reject(Error('Host fixture did not start')),10000))]);
    agent.steer(message('active-steering'));
    assert.equal(calls.length,1,'Active request is not modified or concurrently invoked');
    release();await agent.whenIdle();
    console.log('Host probe active calls='+calls.length+' auxiliary='+auxiliaryCalls);
    assert.equal(calls.length,2,'Steering must run at the next step boundary');
    assert.ok(JSON.stringify(calls[1]).includes('active-steering'));
    agent.followup(message('idle-wakeup'));await agent.whenIdle();
    assert.equal(calls.length,3,'Idle followup must wake a new turn');
    assert.ok(events.includes('assistant/message'));
    assert.ok(events.includes('turn/end'));
    let received=false;
    const offAnswer=ctx.on('user-questions/request',request=>{
      received=request.agent===agent&&request.questions[0].id==='q';
      return {answers:[{id:'q',selected:[],custom:'answer'}]};
    },{prepend:true});
    try {
      const answer=await ctx.get('userQuestions').ask({agent,signal:AbortSignal.timeout(10000),questions:[{id:'q',question:'Probe?'}]});
      assert.equal(received,true);assert.equal(answer.answers[0].custom,'answer');
    } finally {offAnswer();}
    assert.equal(calls.length,3,'Questions service itself must not wake a model');
    const report={classification:'real-host/deterministic-model-adapter',providerHttpCalls:0,
      calls:calls.length,auxiliaryCalls,events,activeInput:'next-step-boundary',idleInput:'new-turn',
      questions:'native scoped waterfall',passiveDisplay:'no independent public message surface found; ordinary messages enter model history',
      mobile:'not tested'};
    fs.writeFileSync(path.join(root,'host-paths.json'),JSON.stringify(report,null,2));
    console.log('HOST-PATHS-OK active steering, idle wakeup, native questions and session events; deterministic adapter only');
  } finally {release();off();await handle.dispose();registration();}
}
