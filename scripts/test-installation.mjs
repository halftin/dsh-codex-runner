import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverCodex, resolveCodexExe, diagnoseCodex, codexEnvironment, INSTALL_HINT } from '../lib/executable.js';
import { AppServerClient } from '../lib/app-server-client.js';
import { SETTINGS_DEFAULTS, SETTINGS_SPEC, validateSetting, loadEffectiveSettings, runDriver, buildSayToolDefinition, buildToolDefinition, LOGS_REL } from '../lib/core.js';
import { createQuotaView } from '../lib/quota-view.js';
import { historyTools } from '../lib/history.js';
import { reserveRun, atomicJson, runDirectory } from '../lib/run-store.js';
import { fetchCatalog, FALLBACK_CATALOG } from '../lib/model-catalog.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-installation-'));
let count=0;
async function test(id,fn){if(process.env.INSTALL_CASE&&process.env.INSTALL_CASE!==id)return;await fn();count++;console.log('PASS installation '+id);}
const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);return file;};
const native=file=>{const bytes=Buffer.alloc(132);bytes.writeUInt16LE(0x5a4d);bytes.writeUInt32LE(128,60);bytes.writeUInt32LE(0x4550,128);return write(file,bytes);};
const fixture=id=>{const home=path.join(root,id);return {home,platform:'win32',arch:'x64',env:{APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),PATH:'',ProgramFiles:path.join(home,'programs')}};};
const packageNative=(prefix,{arch='x64',layout='nested'}={})=>{
  const pkg=path.join(prefix,'node_modules','@openai','codex');
  const base=layout==='legacy'?pkg:layout==='hoisted'?path.join(pkg,'..','codex-win32-'+arch):path.join(pkg,'node_modules','@openai','codex-win32-'+arch);
  return native(path.join(base,'vendor',arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc','bin','codex.exe'));
};
const discover=(f,settings={})=>discoverCodex(settings,f);
const assertFound=(f,expected,label)=>{let actual;try{actual=discover(f).executable;}catch(error){actual='ERROR: '+error.message;}assert.equal(actual,expected,label);};

await test('standard',()=>{
  for(const layout of ['nested','hoisted','legacy']){
    const f=fixture('standard-'+layout),exe=packageNative(path.join(f.env.APPDATA,'npm'),{layout});
    assertFound(f,exe,'standard npm native');assert.equal(discover(f).searched.at(-1).native,true);
  }
  const f=fixture('standard-arm');f.arch='arm64';const exe=packageNative(path.join(f.env.APPDATA,'npm'),{arch:'arm64'});
  assertFound(f,exe,'arm64 npm native');
});
await test('order',()=>{
  const f=fixture('order'),npm=packageNative(path.join(f.env.APPDATA,'npm'));
  const local=native(path.join(f.home,'.local','bin','codex.exe')),portable=native(path.join(f.home,'bin','codex.exe'));
  const pathExe=native(path.join(f.home,'path','codex.exe'));f.env.PATH=path.dirname(pathExe);
  assertFound(f,npm,'npm before local PATH common');fs.unlinkSync(npm);
  assertFound(f,local,'local before PATH common');fs.unlinkSync(local);
  assertFound(f,pathExe,'PATH before common');fs.unlinkSync(pathExe);
  assertFound(f,portable,'common portable fallback');
});
await test('explicit',()=>{
  const f=fixture('explicit'),setting=native(path.join(f.home,'explicit.exe')),env=native(path.join(f.home,'environment.exe'));
  f.env.CODEX_EXE=env;packageNative(path.join(f.env.APPDATA,'npm'));
  assert.equal(discover(f,{codexExecutable:setting}).executable,setting,'setting has priority');
  assertFound(f,env,'CODEX_EXE fallback');
  assert.throws(()=>discover(f,{codexExecutable:path.join(f.home,'absent.exe')}),/not an existing native PE/,'invalid explicit no fallback');
});
await test('reject',()=>{
  const f=fixture('reject');packageNative(path.join(f.env.APPDATA,'npm'));
  for(const ext of ['cmd','bat','ps1']){
    const shim=write(path.join(f.home,'codex.'+ext),'echo DO_NOT_EXECUTE');
    assert.throws(()=>discover(f,{codexExecutable:shim}),/native .exe/,'explicit shim rejected');
    f.env.CODEX_EXE=shim;assert.throws(()=>discover(f),/CODEX_EXE:.*native .exe/,'environment shim rejected');
  }
  const fake=write(path.join(f.home,'renamed.exe'),'echo not native');f.env.CODEX_EXE=fake;
  assert.throws(()=>discover(f),/native PE/,'renamed script rejected');
});
await test('prefix',()=>{
  for(const mode of ['env','npmrc','userconfig','globalconfig']){
    const f=fixture('prefix-'+mode),prefix=path.join(f.home,'custom prefix'),exe=packageNative(prefix);
    if(mode==='env')f.env.NPM_CONFIG_PREFIX=prefix;
    else {const config=write(path.join(f.home,mode==='npmrc'?'.npmrc':mode+'.ini'),'prefix="'+prefix+'"\n');
      if(mode==='userconfig')f.env.NPM_CONFIG_USERCONFIG=config;
      if(mode==='globalconfig')f.env.NPM_CONFIG_GLOBALCONFIG=config;
    }
    assertFound(f,exe,'custom prefix native');
  }
});
await test('shim',()=>{
  for(const ext of ['cmd','bat','ps1']){
    const f=fixture('shim-'+ext),prefix=path.join(f.home,'tools'),exe=packageNative(prefix),dir=path.join(f.home,'shims');
    const variable=ext==='ps1'?'$basedir':'%~dp0';
    write(path.join(dir,'codex.'+ext),'node "'+variable+'/../tools/node_modules/@openai/codex/bin/codex.js"');f.env.PATH=dir;
    assertFound(f,exe,'shim target native');assert.ok(discover(f).searched.some(p=>p.shim),'shim candidate listed');
  }
});
await test('shim-prefix',()=>{
  const f=fixture('shim-prefix'),dir=path.join(f.home,'prefix'),exe=packageNative(dir);
  write(path.join(dir,'codex.cmd'),'@node unquoted-entry');f.env.PATH=dir;
  assertFound(f,exe,'shim prefix native');
});
await test('shim-only',()=>{
  const f=fixture('shim-only'),dir=path.join(f.home,'broken');
  const shim=write(path.join(dir,'codex.cmd'),'@echo SHIM_MUST_NOT_RUN');
  const later=native(path.join(f.home,'later','codex.exe'));f.env.PATH=dir+';'+path.dirname(later);
  assert.throws(()=>discover(f),e=>e.message.includes('Cannot resolve shell shim')&&e.message.includes(shim)&&e.message.includes(INSTALL_HINT),'broken shim stops discovery');
});
await test('pnpm',()=>{
  const f=fixture('pnpm');f.env.PNPM_HOME=path.join(f.home,'pnpm');
  const prefix=path.join(f.env.PNPM_HOME,'global','5'),store=path.join(f.home,'store'),exe=packageNative(store,{layout:'hoisted'});
  const link=path.join(prefix,'node_modules','@openai','codex');fs.mkdirSync(path.dirname(link),{recursive:true});
  fs.mkdirSync(path.join(store,'node_modules','@openai','codex'),{recursive:true});
  fs.symlinkSync(path.join(store,'node_modules','@openai','codex'),link,'junction');
  assertFound(f,exe,'pnpm store native');
});
await test('volta',()=>{
  const f=fixture('volta');f.env.VOLTA_HOME=path.join(f.home,'volta');
  const exe=packageNative(path.join(f.env.VOLTA_HOME,'tools','image','packages','@openai','codex','1.2.3'));
  native(path.join(f.env.VOLTA_HOME,'bin','codex.exe'));f.env.PATH=path.join(f.env.VOLTA_HOME,'bin');
  assertFound(f,exe,'Volta router resolved');f.env.PATH='';assertFound(f,exe,'Volta outside PATH');
});
await test('scoop',()=>{
  const f=fixture('scoop');f.env.SCOOP=path.join(f.home,'scoop');
  const exe=native(path.join(f.env.SCOOP,'apps','codex','current','codex.exe')),shims=path.join(f.env.SCOOP,'shims');
  native(path.join(shims,'codex.exe'));write(path.join(shims,'codex.shim'),'path = "'+exe+'"');f.env.PATH=shims;
  assertFound(f,exe,'scoop sidecar target');f.env.PATH='';assertFound(f,exe,'scoop current native');
});
await test('yarn-bun',()=>{
  const yarn=fixture('yarn');const exe=packageNative(path.join(yarn.env.LOCALAPPDATA,'Yarn','Data','global'));
  assertFound(yarn,exe,'yarn global native');
  const bun=fixture('bun');bun.env.BUN_INSTALL=path.join(bun.home,'bun');const bexe=packageNative(path.join(bun.env.BUN_INSTALL,'install','global'));
  assertFound(bun,bexe,'bun global native');
});
await test('winget-desktop',()=>{
  const f=fixture('winget'),exe=native(path.join(f.env.LOCALAPPDATA,'Microsoft','WinGet','Packages','OpenAI.Codex_test','codex-x86_64-pc-windows-msvc.exe'));
  assertFound(f,exe,'winget native');
  const desktop=fixture('desktop'),base=path.join(desktop.env.ProgramFiles,'WindowsApps','OpenAI.Codex_1.0_x64');
  native(path.join(base,'Codex.exe'));const cli=native(path.join(base,'app','resources','codex.exe'));
  assertFound(desktop,cli,'Desktop CLI resource not GUI');
});
await test('not-found',()=>{
  const f=fixture('missing');
  assert.throws(()=>resolveCodexExe({},f),error=>error.message.includes('Codex CLI not found')&&error.message.includes(INSTALL_HINT)&&error.discovery.searched.length>10,'missing candidates and hint');
});
await test('platform',()=>{
  const f=fixture('platform');f.platform='linux';
  assert.throws(()=>discover(f),/Only Windows/,'non Windows rejected');
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).os,['win32']);
});
await test('settings',()=>{
  for(const name of ['codexExecutable','codexHome']){
    assert.equal(SETTINGS_DEFAULTS[name],'','installation default blank');assert.equal(SETTINGS_SPEC[name].type,'string');
    assert.equal(validateSetting(name,'').ok,true,'blank setting valid');assert.equal(validateSetting(name,42).ok,false);
    assert.equal(validateSetting(name,'relative').ok,false,'relative setting invalid');
  }
  for(const ext of ['cmd','bat','ps1'])assert.equal(validateSetting('codexExecutable',process.execPath+'.'+ext).ok,false,'setting shim invalid');
  const cwd=path.join(root,'settings');fs.mkdirSync(cwd);
  const value=loadEffectiveSettings({cwd,config:{codexExecutable:{get:()=>process.execPath},codexHome:{get:()=>root}}});
  assert.equal(value.settings.codexExecutable,process.execPath,'accessor executable');assert.equal(value.settings.codexHome,root,'accessor home');
});
await test('environment',()=>{
  const before={CODEX_EXE:process.execPath,CODEX_HOME:root,PATH:'unchanged'},home=path.join(root,'different-home');
  const injected=codexEnvironment({codexExecutable:process.execPath,codexHome:home},before);
  assert.equal(injected.CODEX_HOME,home,'home injected');assert.equal(injected.CODEX_EXE,process.execPath,'exe injected');
  assert.equal(before.CODEX_HOME,root,'host env unchanged');assert.equal(injected.PATH,'unchanged','PATH unchanged');
  assert.deepEqual(codexEnvironment({codexExecutable:'',codexHome:''},before),before,'blank inherits environment');
  assert.equal(fs.existsSync(home),false,'no home content created');
});
await test('app-server-env',async()=>{
  const cwd=path.join(root,'app-server'),home=path.join(cwd,'home');fs.mkdirSync(cwd,{recursive:true});
  const fixtureFile=write(path.join(cwd,'server.mjs'),"import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id!==undefined)console.log(JSON.stringify({id:m.id,result:m.method==='environment'?{exe:process.env.CODEX_EXE,home:process.env.CODEX_HOME}:{}}));}");
  const client=new AppServerClient({cwd,args:[fixtureFile],settings:{codexExecutable:process.execPath,codexHome:home}});
  try{await client.initialize();const result=await client.request('environment');assert.equal(result.home,home,'App Server receives home');assert.equal(result.exe,process.execPath,'App Server receives executable');}finally{await client.close();}
  assert.equal(fs.existsSync(home),false,'App Server plugin never creates home');
  assert.throws(()=>new AppServerClient({executable:fixtureFile+'.cmd'}),/native .exe/,'App Server rejects explicit shim');
});
const makeDriver=id=>{
  const cwd=path.join(root,id);fs.mkdirSync(cwd,{recursive:true});
  const driver=write(path.join(cwd,'driver.mjs'),"import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(path.join(process.cwd(),'environment.json'),JSON.stringify({exe:process.env.CODEX_EXE,home:process.env.CODEX_HOME}));console.log('queued');");
  return {cwd,driver,codexExecutable:process.execPath,codexHome:path.join(cwd,'home')};
};
await test('driver-env',async()=>{
  for(const detach of [false,true]){
    const opts=makeDriver('driver-'+detach),logDir=path.join(opts.cwd,'logs');fs.mkdirSync(logDir);
    const result=await runDriver({...opts,driverPath:opts.driver,promptFile:'task.md',label:'env',logDir,runId:randomUUID(),detach});
    const file=path.join(opts.cwd,'environment.json');
    if(detach){const deadline=Date.now()+10000;while(!fs.existsSync(file)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));}
    else assert.equal(result.exitCode,0,'fixture driver exit');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),{exe:opts.codexExecutable,home:opts.codexHome},'driver receives installation settings');
  }
});
await test('queue-env',async()=>{
  const opts=makeDriver('queue'),tool=buildSayToolDefinition({defineTool:d=>d,resolveCwd:()=>opts.cwd,config:{backend:'exec',driverPath:opts.driver,codexExecutable:opts.codexExecutable,codexHome:opts.codexHome}});
  const result=await tool.execute({thread:randomUUID(),message:'queued'},{});assert.equal(result.status,'ok','queue fixture succeeds');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(opts.cwd,'environment.json'))),{exe:opts.codexExecutable,home:opts.codexHome},'queue receives installation settings');
});
await test('run-settings',async()=>{
  const opts=makeDriver('run-settings');write(path.join(opts.cwd,'task.md'),'bounded fixture');let catalogSettings;
  const tool=buildToolDefinition({defineTool:d=>d,resolveCwd:()=>opts.cwd,config:{backend:'exec',driverPath:opts.driver,codexExecutable:opts.codexExecutable,codexHome:opts.codexHome,autoModelAndEffort:true},catalog:async options=>{catalogSettings=options.settings;return FALLBACK_CATALOG;}});
  await tool.execute({label:'installation',model:'gpt-6.1-sol',effort:'high',prompt_file:'task.md',task_kind:'mechanical'},{});
  assert.equal(catalogSettings.codexHome,opts.codexHome,'run catalog receives home');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(opts.cwd,'environment.json'))),{exe:opts.codexExecutable,home:opts.codexHome},'run tool forwards installation settings');
});
await test('read-settings',async()=>{
  const cwd=path.join(root,'read-settings'),logs=path.join(cwd,LOGS_REL);fs.mkdirSync(cwd,{recursive:true});
  const r=reserveRun(logs,'reader'),dir=runDirectory(logs,r);atomicJson(path.join(dir,'result.meta.json'),{backend:'app-server',status:'ok',threadId:randomUUID()});
  const settings={codexExecutable:process.execPath,codexHome:path.join(cwd,'home')};let observed;
  const tool=historyTools({defineTool:d=>d,resolveCwd:()=>cwd,config:settings,connect:async(fn,options)=>{observed=options.settings;return fn({request:async method=>method==='thread/read'?{thread:{cwd}}:{data:[],nextCursor:null}});}}).find(t=>t.name==='codex_read');
  const result=await tool.execute({run_id:r.runId,source:'turns'},{});assert.equal(result.status,'ok');assert.equal(observed?.codexHome,settings.codexHome,'history receives home');
});
await test('quota-settings',async()=>{
  const settings={backend:'app-server',codexHome:root,codexExecutable:process.execPath};let observed,calls=0;
  const view=createQuotaView({connect:async(fn,options)=>{calls++;observed=options.settings;return fn({request:async method=>method==='account/read'?{account:{type:'chatgpt',email:'offline@example.invalid'}}:{rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}});}});
  await view.get({probe:'fresh',settings});assert.equal(observed?.codexHome,root,'quota receives home');
  await view.get({probe:'fresh',settings:{...settings,codexHome:path.join(root,'other-account')}});assert.equal(calls,2,'quota cache separates homes');
});
await test('catalog-settings',async()=>{
  const env=codexEnvironment({codexHome:root});let observed;
  await fetchCatalog({executable:process.execPath,env,connect:async(fn,options)=>{observed=options;return fn({request:async method=>method==='model/list'?{data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}:{}});}});
  assert.equal(observed.env?.CODEX_HOME,root,'catalog receives environment');
});
await test('doctor',async()=>{
  const f=fixture('doctor'),exe=packageNative(path.join(f.env.APPDATA,'npm')),home=path.join(f.home,'codex-home');let initialized=false;
  const check=(file,args,options)=>{assert.equal(file,exe);assert.equal(options.env.CODEX_HOME,home,'doctor home injected');
    return args[0]==='--version'?'codex fixture':args[0]==='exec'?'--json':args[0]==='queue'?'--thread':'DO_NOT_DISPLAY_AUTH_SECRET';};
  const settings={codexHome:home};
  const result=await diagnoseCodex(settings,{discovery:s=>discover(f,s),check,connect:async(fn,options)=>{initialized=true;assert.equal(options.env.CODEX_HOME,home,'doctor initialize home');return fn({});}});
  assert.equal(result.ok,true,'doctor success');assert.equal(result.version,'codex fixture');assert.equal(result.executable,exe);assert.ok(result.searched.length,'doctor searched candidates');
  assert.equal(result.CODEX_HOME,home,'doctor effective home');assert.equal(JSON.stringify(result).includes('DO_NOT_DISPLAY_AUTH_SECRET'),false,'doctor hides auth output');assert.equal(result.auth,'authenticated');assert.equal(initialized,true,'doctor initializes App Server');
  const failed=await diagnoseCodex(settings,{discovery:s=>discover(f,s),check:(file,args,options)=>{if(args[0]==='login')throw Error('DO_NOT_DISPLAY_AUTH_SECRET');return check(file,args,options);},connect:async()=>{}});
  assert.equal(failed.ok,false,'doctor rejects auth failure');assert.equal(failed.authenticated,false);assert.equal(JSON.stringify(failed).includes('DO_NOT_DISPLAY_AUTH_SECRET'),false);
  const missing=await diagnoseCodex({},{discovery:()=>discover(fixture('doctor-missing'))});
  assert.equal(missing.ok,false);assert.ok(missing.searched.length,'doctor missing keeps candidates');assert.match(missing.problem,/codexExecutable \/ CODEX_EXE/);
});
assert.ok(count>0,'selected installation test exists');
console.log('INSTALLATION-OK '+count);
