// Opt-in Windows acceptance against a real, separately installed DSH CLI.
// All profiles, fixtures and evidence stay under a new temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {probeHostPaths} from './host-path-probe.mjs';
import {prepareOutputProbe} from './host-output-probe.mjs';
import {probeSupervision} from './host-supervision-probe.mjs';
import {specialItems} from './special-content-fixture.mjs';
import {probeSpecialQuestions} from './host-special-question-probe.mjs';

const [hostPrefix,archive]=process.argv.slice(2);
if(!hostPrefix||!archive)throw Error('Usage: node scripts/test-dsh-package.mjs <isolated DSH npm prefix> <candidate.tgz>');
assert.equal(process.platform,'win32','This acceptance covers Windows only');
const hostRequire=createRequire(path.join(path.resolve(hostPrefix),'package.json'));
const cli=hostRequire.resolve('@deepseek-ai/dsh/lib/bin.js');
const hostVersion=JSON.parse(fs.readFileSync(hostRequire.resolve('@deepseek-ai/dsh/package.json'),'utf8')).version;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-dsh-acceptance-')),home=path.join(root,'home'),workspace=path.join(root,'workspace');
fs.mkdirSync(workspace);
// Official Web option: skip account onboarding without supplying a real key.
// No DSH chat/model turn is used by this plugin acceptance.
const overlay=path.join(root,'acceptance.patch.yml');fs.writeFileSync(overlay,'- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n');
if(process.env.DSH_ACCEPT_REAL_MODEL){
  assert.ok(process.env.DSH_ACCEPT_CREDENTIAL_SOURCE,'Live DSH acceptance requires an explicit credential source');
  process.env.DSH_ACCEPT_HOST_PREFIX=path.resolve(hostPrefix);
  const credentialPlugin=path.join(root,'acceptance-credentials.mjs');
  fs.copyFileSync(new URL('./acceptance-credentials.mjs',import.meta.url),credentialPlugin);
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'runner-acceptance-credentials',version:'0.0.0',type:'module'}));
  fs.appendFileSync(overlay,'- id: credentials\n  disabled: true\n- insert:\n    - id: acceptance-credentials\n      name: '+JSON.stringify(pathToFileURL(credentialPlugin).href)+'\n');
}
const archivePath=path.resolve(archive),profile='candidate',profileDir=path.join(home,'profiles',profile);
process.env.DSH_HOME=home;process.env.CODEX_HOME=path.join(root,'codex-home');process.env.DSH_TELEMETRY_DISABLED='1';
process.env.CODEX_RUNNER_SCHEMA_OFFLINE='1';process.chdir(workspace);
const cliCall=(args,name)=>{
  const log=execFileSync(process.execPath,[cli,...args],{env:process.env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(root,name+'.log'),log);return log;
};
const cliVersion=cliCall(['--version'],'cli-version').trim();
fs.writeFileSync(path.join(root,'runtime-preflight.json'),JSON.stringify({nodeVersion:process.version,hostVersion,cliVersion,cliEntrypointWorks:cliVersion===hostVersion},null,2));
assert.equal(cliVersion,hostVersion,'DSH CLI did not execute on this Node runtime; see runtime-preflight.json');
cliCall(['--profile',profile,'--from-default-profile','web','--dump-config'],'initial-config');
cliCall(['plugin','--profile',profile,'add',archivePath,'--ignore-scripts'],'install');
const profileRequire=createRequire(path.join(profileDir,'package.json')),packageDir=path.dirname(profileRequire.resolve('dsh-codex-runner/package.json'));
const pkg=JSON.parse(fs.readFileSync(path.join(packageDir,'package.json'),'utf8'));
assert.ok(cliCall(['--profile',profile,'--dump-config'],'installed-config').includes('dsh-codex-runner'));
const fixture=path.join(root,'fake-cli.mjs'),fallback=fs.readFileSync(path.join(packageDir,'lib/model-catalog.fallback.json'),'utf8');
fs.writeFileSync(fixture,`
import path from 'node:path';import fs from 'node:fs';import readline from 'node:readline';import {randomUUID} from 'node:crypto';
const specialItems=${JSON.stringify(specialItems)};
const command=path.basename(process.argv[1]||'');
if(command==='exec') {let prompt='';for await(const chunk of process.stdin)prompt+=chunk;console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));console.log(JSON.stringify({type:'turn.started'}));for(const item of specialItems)console.log(JSON.stringify({type:'item.completed',item}));let seq=0;setInterval(()=>{
 if(fs.existsSync('.smoke-finish-exec')){console.log(JSON.stringify({type:'item.completed',item:{id:'final',type:'agent_message',phase:'final_answer',text:'SMOKE_FINAL_exec'}}));console.log(JSON.stringify({type:'turn.completed',usage:{}}));process.exit(0);}
 console.log(JSON.stringify({type:'item.completed',item:{id:'exec-stream-'+seq,type:'agent_message',phase:'commentary',text:'Live 中文 '+(++seq)+' <script>plain text</script>'}}));},200);await new Promise(()=>{});}
if(command==='queue'||command==='login'){console.log('--json --thread authenticated');process.exit(0);}
if(command==='app-server'){
 const models=${fallback}.models;let threadId=randomUUID(),turn,live=false,answer='';
 const send=value=>console.log(JSON.stringify(value)),notify=(method,params)=>send({method,params:{threadId,...params}});
 for await(const line of readline.createInterface({input:process.stdin})){
  const m=JSON.parse(line),p=m.params||{};if(m.id===undefined)continue;
  if(m.id==='native-question'){
   notify('serverRequest/resolved',{requestId:m.id});
   if(live){answer=m.result?.answers?.choice?.answers?.[0]||'no answer';notify('item/agentMessage/delta',{turnId:turn,itemId:'need-direction',delta:'NEED_DIRECTION: original answer recorded. Awaiting authorized steering.'});continue;}
   notify('item/completed',{item:{id:'final',type:'agentMessage',phase:'final_answer',text:m.result?.answers?.choice?.answers?.[0]||'no answer'}});
   notify('turn/completed',{turn:{id:turn,status:'completed'}});continue;
  }
  if(m.method==='model/list')send({id:m.id,result:{data:models}});
  else if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt',email:'acceptance@example.invalid'}}});
  else if(m.method==='account/rateLimits/read')send({id:m.id,result:{rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}});
  else if(m.method==='thread/start'||m.method==='thread/resume'){threadId=p.threadId||threadId;send({id:m.id,result:{thread:{id:threadId}}});}
  else if(m.method==='thread/read')send({id:m.id,result:{thread:{id:p.threadId,cwd:process.cwd(),turns:[]}}});
  else if(m.method==='turn/start'){
   live=p.input[0].text.includes('SUPERVISELIVE');turn=randomUUID();notify('turn/started',{turn:{id:turn}});send({id:m.id,result:{turn:{id:turn}}});
   if(p.input[0].text.includes('STREAM'))for(const item of specialItems)notify('item/completed',{turnId:turn,item});
   if(p.input[0].text.includes('QUESTION'))send({id:'native-question',method:'item/tool/requestUserInput',params:{threadId,turnId:turn,itemId:'question',isBlocking:false,questions:[{id:'choice',header:'Choice',question:'Choose a marker',options:null}]}});
   else if(p.input[0].text.includes('SUPERVISE')){notify('item/completed',{turnId:turn,item:{id:'supervise-item',type:'agentMessage',phase:'commentary',text:'Need authorized '+p.input[0].text}});if(p.input[0].text.includes('QUEUE'))setTimeout(()=>notify('turn/completed',{turn:{id:turn,status:'completed'}}),6000);}
   else if(p.input[0].text==='QUEUE_OK'){notify('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:'QUEUE_OK'}});notify('turn/completed',{turn:{id:turn,status:'completed'}});}
   else if(p.input[0].text.includes('STREAM')){let seq=0;const timer=setInterval(()=>{
    if(fs.existsSync('.smoke-finish-app-server')){clearInterval(timer);notify('item/completed',{turnId:turn,item:{id:'final',type:'agentMessage',phase:'final_answer',text:'SMOKE_FINAL_app-server'}});notify('turn/completed',{turn:{id:turn,status:'completed'}});return;}
    notify('item/completed',{turnId:turn,item:{id:'stream-'+seq,type:'agentMessage',phase:'commentary',text:'Live 中文 '+(++seq)+' <script>plain text</script>'}});
   },200);}
   else if(!p.input[0].text.includes('WAIT'))setTimeout(()=>{notify('item/completed',{item:{type:'agentMessage',text:'acceptance complete'}});notify('turn/completed',{turn:{id:turn,status:'completed'}})},40);
  }else if(m.method==='turn/steer'){send({id:m.id,result:{turnId:turn}});notify('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:answer+' '+p.input[0].text}});notify('turn/completed',{turn:{id:turn,status:'completed'}});}
  else if(m.method==='turn/interrupt'){send({id:m.id,result:{}});notify('turn/completed',{turn:{id:turn,status:'interrupted'}});}
  else send({id:m.id,result:{}});
 }
 process.exit(0);
}
`);
process.env.CODEX_EXE=process.execPath;process.env.NODE_OPTIONS='--import='+pathToFileURL(fixture).href;
const {runProfile}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh/profile-boot')));
const {createLaunchEnvironmentSnapshot}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-launch-environment')));
const boot=()=>runProfile({profile,args:['--host','127.0.0.1','--port','0','--no-open'],patchFiles:[overlay],environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}])});
const exec={agent:{session:{header:{cwd:workspace}}}};
let app,activeRun,cancel,passed=[],realModelTurns=0;
const record=name=>{passed.push(name);console.log('PASS package acceptance '+name);};
const tool=name=>{const value=app.ctx.get('tools').get(name);assert.ok(value,'Missing registered tool '+name);return value;};
const configuration=()=>tool('codex_config').execute({},exec);
try {
  app=await boot();
  const names=JSON.parse(fs.readFileSync(path.join(packageDir,'dsh.plugin.json'),'utf8')).contributes.tools;
  for(const name of names)tool(name);assert.equal(names.length,19);record('official install, profile composition and 19 registered tools');
  assert.equal((await configuration()).settings.autoModelAndEffort,false);
  assert.equal((await configuration()).settings.streamOutputEnabled,true);
  assert.equal((await configuration()).settings.supervisionEnabled,true);
  await probeHostPaths({ctx:app.ctx,root,hostRequire});record('native session, questions and agent input paths with a deterministic model adapter');
  await probeSpecialQuestions({ctx:app.ctx,root,workspace,packageDir});record('native special questions and explicit secret renderer limitation');
  const settings=app.ctx.get('settings'),description=settings.describe().find(s=>s.ns==='dsh-codex-runner');
  await settings.mutate('dsh-codex-runner',[{op:'set',path:['maxConcurrent'],value:2},
    {op:'set',path:['autoModelAndEffort'],value:true},
    {op:'set',path:['streamOutputEnabled'],value:false},{op:'set',path:['supervisionEnabled'],value:false},{op:'set',path:['autoAnswerQuestions'],value:false}],description.revision);
  assert.equal((await configuration()).settings.maxConcurrent,2);record('native settings save persists and applies live');
  const questionAgent=await app.ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:workspace}});
  let questionsSeen=0;
  const offQuestion=app.ctx.on('user-questions/request',request=>{
    assert.equal(request.agent,questionAgent.agent);questionsSeen++;
    return {answers:[{id:'choice',selected:[],custom:'NATIVE_QUESTION_OK'}]};
  },{prepend:true});
  try {
    fs.writeFileSync(path.join(workspace,'question.md'),'QUESTION');
    const result=await tool('codex_run').execute({prompt_file:'question.md',label:'native-question',model:'gpt-6.1-sol',effort:'high',budget_ms:15000},
      {agent:questionAgent.agent});
    assert.equal(result.status,'ok',result.summary_text);assert.equal(result.answer,'NATIVE_QUESTION_OK');assert.equal(questionsSeen,1);
    record('both settings off: real native question service answers original fake Codex RPC');
  } finally {offQuestion();await questionAgent.dispose();}
  await settings.mutate('dsh-codex-runner',[{op:'set',path:['autoAnswerQuestions'],value:true}],settings.describe().find(s=>s.ns==='dsh-codex-runner').revision);
  await probeSupervision({ctx:app.ctx,root,workspace,hostRequire});record('native supervision reads active output, answers and controls the original fake Codex run');
  if(process.env.DSH_ACCEPT_HOST_MANAGED==='1'){const {probeHostManaged}=await import('./host-managed-probe.mjs');await probeHostManaged({ctx:app.ctx,root,workspace,hostRequire});record('production host-managed runner admission, collection, controls and directory');}
  if(process.env.DSH_ACCEPT_SEAM==='1'){const {probeSeam}=await import('./host-seam-probe.mjs');await probeSeam({ctx:app.ctx,root,workspace,hostRequire});record('experimental official subagent service reuse matrix');}
  const service=app.ctx.get('codexRunner'),registry=await service.getEditorRegistry();
  registry.document.translations.settings.log_dir.description='发行包隔离验收说明';
  await service.saveEditorRegistry({document:registry.document,revision:registry.revision});
  assert.equal((await service.getEditorRegistry()).document.translations.settings.log_dir.description,'发行包隔离验收说明');
  record('registry editor read, revisioned save and reopen');
  fs.writeFileSync(path.join(workspace,'task.md'),'COMPLETE');
  const finished=await tool('codex_run').execute({prompt_file:'task.md',label:'sync',model:'gpt-6.1-sol',effort:'high'},exec);
  assert.equal(finished.status,'ok',finished.summary_text);assert.equal(finished.answer,'acceptance complete');record('real App Server driver with deterministic fake CLI');
  fs.writeFileSync(path.join(workspace,'task.md'),'WAIT');
  const detached=await tool('codex_run').execute({prompt_file:'task.md',label:'detached',model:'gpt-6.1-sol',effort:'high',detach:true,notify_on_complete:'off'},exec);
  assert.equal(detached.status,'running',detached.summary_text);activeRun=detached.run_id;cancel=tool('codex_cancel');
  await app.ctx.fiber.dispose();app=null;
  app=await boot();assert.equal((await configuration()).settings.maxConcurrent,2);
  if(process.env.DSH_ACCEPT_HOST_MANAGED==='1'){const {probeHostManagedRestart}=await import('./host-managed-probe.mjs');await probeHostManagedRestart({ctx:app.ctx,root});record('opt-in host-managed run cancelled on shutdown; default detached run survives');}
  if(process.env.DSH_ACCEPT_SEAM==='1'){const {probeSeamRestart}=await import('./host-seam-probe.mjs');await probeSeamRestart({ctx:app.ctx,root});record('official external catalog survives host restart without restoring an activation');}
  assert.equal((await configuration()).settings.streamOutputEnabled,false);
  assert.equal((await configuration()).settings.supervisionEnabled,false);
  assert.equal((await app.ctx.get('codexRunner').getEditorRegistry()).document.translations.settings.log_dir.description,'发行包隔离验收说明');
  const status=await tool('codex_status').execute({run_id:activeRun},exec);assert.equal(status.running,true,status.summary_text);record('host restart retains settings, registry and detached run');
  const stopped=await tool('codex_cancel').execute({run_id:activeRun},exec);assert.equal(stopped.status,'ok',stopped.summary_text);
  const terminal=await tool('codex_status').execute({run_id:activeRun,wait_ms:10000},exec);assert.equal(terminal.running,false);activeRun=null;record('cancel after restart reaches a terminal state');
  // Optional browser acceptance uses this live, isolated profile; no model call.
  if(process.env.DSH_ACCEPT_BROWSER_MODULE){const {verifyBrowser}=await import(pathToFileURL(path.resolve(process.env.DSH_ACCEPT_BROWSER_MODULE)));await verifyBrowser({ctx:app.ctx,root,prepareOutput:backend=>prepareOutputProbe({ctx:app.ctx,root,workspace,hostRequire,backend})});record('actual Web settings, configuration editor and live tool cards for both backends');}
  if(process.env.DSH_ACCEPT_REAL_MODEL){const {probeRealModel}=await import('./host-real-model-probe.mjs');realModelTurns=await probeRealModel({ctx:app.ctx,root,workspace,hostRequire,packageDir});record(process.env.DSH_ACCEPT_REAL_SCENARIO==='conversation'?'real DSH model continues the original real Codex thread with a different model':process.env.DSH_ACCEPT_REAL_SCENARIO==='async'?'real DSH model answers real Codex async question via correlated message':process.env.DSH_ACCEPT_REAL_SCENARIO==='blocking'?'real DSH model answers original real Codex blocking RPC':process.env.DSH_ACCEPT_REAL_CODEX==='1'?'real DSH model steers original real Codex run':'real DSH model answers and steers original fake Codex run');}
  await app.ctx.fiber.dispose();app=null;
  cliCall(['plugin','--profile',profile,'remove','dsh-codex-runner'],'uninstall');
  cliCall(['--profile',profile,'--dump-config'],'uninstalled-config');
  const after=JSON.parse(fs.readFileSync(path.join(profileDir,'package.json'),'utf8'));
  assert.equal(Object.hasOwn(after.dependencies||{},'dsh-codex-runner'),false);assert.equal(after.dsh.profile.bundles.includes('dsh-codex-runner'),false);
  app=await boot();for(const name of names)assert.equal(app.ctx.get('tools').get(name),undefined);record('official uninstall removes bundle and tools; host remains bootable');
  const uninstallResidual=fs.readFileSync(path.join(profileDir,'cordis.patch.yml'),'utf8').includes('id: dsh-codex-runner');
  fs.writeFileSync(path.join(root,'acceptance.json'),JSON.stringify({nodeVersion:process.version,hostVersion,pluginVersion:pkg.version,archive:archivePath,
    archiveSha256:createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex'),sourceCommit:process.env.DSH_ACCEPT_COMMIT||null,sourceTree:process.env.DSH_ACCEPT_TREE||null,
    passed,uninstallResidual,realModelTurns},null,2));
  console.log('DSH-PACKAGE-OK '+pkg.version+' on Windows / DSH '+hostVersion+'; evidence='+root);
} finally {
  if(activeRun&&cancel)try{await cancel.execute({run_id:activeRun},exec);}catch{}
  await app?.ctx.fiber.dispose();
}
