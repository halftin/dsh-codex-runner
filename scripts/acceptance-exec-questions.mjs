// Explicit real-model diagnostic for the exec transport, not an offline test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveCodexExe} from '../lib/executable.js';
import {stopOwnedTree} from '../lib/owned-process.js';
if(process.env.NODE_OPTIONS||process.env.CODEX_RUNNER_SCHEMA_OFFLINE)throw Error('Use a clean real-model environment');
if(!process.env.CODEX_HOME)throw Error('Set CODEX_HOME explicitly');
const mode=process.argv[2]||'async';if(!['async','rpc'].includes(mode))throw Error('Use async or rpc');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-exec-questions-'));
const executable=resolveCodexExe(),version=execFileSync(executable,['--version'],{encoding:'utf8',windowsHide:true}).trim();
const model='gpt-6.1-sol',effort='low',tool=mode==='async'?'request_user_input_async':'request_user_input';
const prompt=`This is an exact tool capability test. Call ${tool} to ask one structured question: Which acceptance marker should be used? Offer Alpha and Beta. Do not substitute another question tool or plain prose. If this exact tool is unavailable, reply exactly TOOL_UNAVAILABLE and stop. After calling it, if execution can continue, print commentary EXEC_AFTER_QUESTION and run PowerShell Start-Sleep -Seconds 3. Do not answer the question yourself. Finish with EXEC_DONE_WITHOUT_ANSWER. Do not inspect or modify files, use network, or delegate. No answer will be provided during this test.`;
fs.writeFileSync(path.join(root,'prompt.txt'),prompt);
const args=['exec','--json','--skip-git-repo-check','-m',model,'-c','model_reasoning_effort="low"','-c','windows.sandbox="elevated"',
  '-c','sandbox_mode="read-only"','-c','approval_policy="never"',...(mode==='rpc'?['-c','features.default_mode_request_user_input=true']:[]),'-'];
const startedAt=new Date().toISOString(),child=spawn(executable,args,{cwd:root,env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
const frames=[];let buffer='',stderr='',parseErrors=[],timedOut=false;
const consume=line=>{if(!line.trim())return;try{frames.push({at:Date.now(),event:JSON.parse(line)});}catch{parseErrors.push(line);}};
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
child.stdout.on('data',text=>{fs.appendFileSync(path.join(root,'stdout.jsonl'),text);buffer+=text;let end;while((end=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+1);}});
child.stderr.on('data',text=>{stderr=(stderr+text).slice(-8192);});child.stdin.on('error',()=>{});
console.log('EXEC-QUESTIONS '+mode+' '+version+'; evidence='+root);
const timer=setTimeout(()=>{timedOut=true;stopOwnedTree(child,startedAt);},90000);
const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));child.stdin.end(prompt);}).finally(()=>clearTimeout(timer));
if(buffer)consume(buffer);fs.writeFileSync(path.join(root,'stderr-tail.txt'),stderr);
const threadId=frames.find(f=>f.event.type==='thread.started')?.event.thread_id;
let rolloutPath,related=[];
if(threadId){
  const sessions=path.join(process.env.CODEX_HOME,'sessions');
  const matches=fs.readdirSync(sessions,{recursive:true}).filter(name=>name.endsWith(threadId+'.jsonl'));
  if(matches.length===1){
    rolloutPath=path.join(sessions,matches[0]);const rows=fs.readFileSync(rolloutPath,'utf8').trim().split('\n').map(JSON.parse);
    const calls=rows.filter(r=>r.type==='response_item'&&r.payload?.type==='function_call'&&['request_user_input_async','request_user_input'].includes(r.payload.name));
    const ids=new Set(calls.map(r=>r.payload.call_id));
    related=rows.filter(r=>calls.includes(r)||(r.type==='response_item'&&r.payload?.type==='function_call_output'&&ids.has(r.payload.call_id))||
      (r.type==='event_msg'&&['agent_message','request_user_input'].includes(r.payload?.type)));
  }
}
const events=frames.map(f=>f.event),items=events.filter(e=>e.item).map(e=>e.item);
const report={classification:'real-codex/exec-json/no-dsh/no-answer-submitted',version,executableSha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
  mode,model,effort,args,result,timedOut,threadId,rolloutPath,parseErrors,frames,relatedRollout:related,
  observations:{nativeQuestionCalls:related.filter(r=>r.payload?.type==='function_call').map(r=>r.payload.name),
    structuredQuestionItems:items.filter(i=>Array.isArray(i.questions)),
    questionTextVisible:items.some(i=>typeof i.text==='string'&&i.text.includes('Which acceptance marker')),
    continued:items.some(i=>typeof i.text==='string'&&i.text.includes('EXEC_AFTER_QUESTION')),
    finishedWithoutAnswer:items.some(i=>i.text?.trim()==='EXEC_DONE_WITHOUT_ANSWER'),
    unavailable:items.some(i=>i.text?.trim()==='TOOL_UNAVAILABLE')},stderr};
fs.writeFileSync(path.join(root,'acceptance.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({result,timedOut,observations:report.observations,evidence:root}));
process.exitCode=result.code===0&&!timedOut&&!parseErrors.length?0:1;
