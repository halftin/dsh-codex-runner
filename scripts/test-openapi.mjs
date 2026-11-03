import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {registerRunnerRpc} from '../lib/runner-service.js';
import {createRunEvents} from '../lib/run-events.js';
import {createConfigurationEditor} from '../lib/configuration-editor.js';
import {DEFAULT_FIELD_REGISTRY} from '../lib/codex-fields.js';
import {createCatalogI18n} from '../lib/catalog-i18n.js';
import {FALLBACK_CATALOG,normalizeModels} from '../lib/model-catalog.js';
import {createQuotaView} from '../lib/quota-view.js';
import {createSubagentTracker} from '../lib/subagent-view.js';
import {OutputWriter} from '../lib/output-stream.js';
import {createOutputView} from '../lib/output-view.js';
import {atomicJson} from '../lib/run-store.js';
const exec=promisify(execFile),file=new URL('../docs/api/openapi.json',import.meta.url),spec=JSON.parse(fs.readFileSync(file,'utf8'));
const englishFile=new URL('../docs/api/openapi.en.json',import.meta.url),englishSpec=JSON.parse(fs.readFileSync(englishFile,'utf8'));
let translatedStrings=0;
function compareLanguages(zh,en,pointer='') {
  if(typeof zh==='string'&&zh!==en) {
    assert.ok(/\p{Script=Han}/u.test(zh)&&typeof en==='string'&&!/\p{Script=Han}/u.test(en),'Unexpected translated value at '+pointer);
    assert.ok(/\/(description|summary|title)$|^\/tags\/\d+\/name$|^\/paths\/.*\/(post|get)\/tags\/\d+$/.test(pointer),'Contract data changed at '+pointer);
    translatedStrings++;return;
  }
  if(zh&&typeof zh==='object') {
    assert.ok(en&&typeof en==='object');assert.equal(Array.isArray(zh),Array.isArray(en));
    assert.deepEqual(Object.keys(zh),Object.keys(en),'Different contract keys at '+pointer);
    for(const key of Object.keys(zh))compareLanguages(zh[key],en[key],pointer+'/'+key);
  } else assert.deepEqual(zh,en,'Different contract data at '+pointer);
}
compareLanguages(spec,englishSpec);
assert.ok(translatedStrings>0);assert.ok(!/\p{Script=Han}/u.test(JSON.stringify(englishSpec)));
const temp=fs.realpathSync(os.tmpdir()),scratch=fs.mkdtempSync(path.join(temp,'runner-openapi-check-'));
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
try {
  const installed=await exec(process.execPath,[npm,'install','--prefix',scratch,'--ignore-scripts','--no-audit','--no-fund','--prefer-offline','--registry=https://registry.npmjs.org/','@apidevtools/swagger-parser@13.1.0','ajv@8.20.0','ajv-formats@3.0.1'],{windowsHide:true,maxBuffer:1024*1024,timeout:120000});
  const require=createRequire(path.join(scratch,'package.json'));
  const Parser=require('@apidevtools/swagger-parser');await Parser.validate(file.pathname.replace(/^\/([A-Za-z]:)/,'$1'));
  await Parser.validate(englishFile.pathname.replace(/^\/([A-Za-z]:)/,'$1'));
  const resolved=await Parser.dereference(structuredClone(spec));
  const englishResolved=await Parser.dereference(structuredClone(englishSpec));
  const Ajv=require('ajv'),ajv=new Ajv({strict:false,allErrors:true});require('ajv-formats')(ajv);
  const validate=(schema,value,label)=>{const check=ajv.compile(schema);assert.ok(check(value),label+': '+ajv.errorsText(check.errors));};
  let englishExampleChecks=0;
  for(const [url,item] of Object.entries(englishResolved.paths)) {
    if(!item.post)continue;
    const operation=item.post;
    validate(operation.requestBody.content['application/json'].schema,operation.requestBody.content['application/json'].example,url+' English request');englishExampleChecks++;
    for(const sample of Object.values(operation.responses['200'].content['application/json'].examples)) {
      validate(operation.responses['200'].content['application/json'].schema,sample.value,url+' English response');englishExampleChecks++;
    }
  }
  const routes=new Map(),calls=[],events=createRunEvents(),service={runEventStream:signal=>events.stream(signal)};
  const scope={connection:{fetch:{register:route=>{routes.set(route.path,route);return ()=>{};}},rpc:{handle:()=>()=>{}}},webServer:{},effect:fn=>fn()};
  registerRunnerRpc({inject:(_services,fn)=>fn(scope)},service);
  assert.equal(routes.size,9);assert.deepEqual([...routes.keys()].sort(),Object.keys(spec.paths).sort());
  let checks=0;
  for(const [url,item]of Object.entries(resolved.paths)){
    if(item.get)continue;
    const operation=item.post,method=operation.operationId,route=routes.get(url),body=operation.requestBody.content['application/json'].example;
    validate(operation.requestBody.content['application/json'].schema,body,method+' request example');checks++;
    for(const sample of Object.values(operation.responses['200'].content['application/json'].examples)){validate(operation.responses['200'].content['application/json'].schema,sample.value,method+' response example');checks++;}
    const success=operation.responses['200'].content['application/json'].examples.success.value;
    service[method]=async value=>{calls.push({method,value});return success.result.value;};
    const request=(value,contentType='application/json')=>new Request('http://localhost'+url,{method:'POST',headers:{'content-type':contentType},body:typeof value==='string'?value:JSON.stringify(value)});
    const response=await route.fetch(request(body));assert.equal(response.status,200);validate(operation.responses['200'].content['application/json'].schema,await response.json(),method+' handler');checks++;
    const args=calls.at(-1).value;assert.deepEqual(args,method==='getSubagents'?body.payload.runId:body.payload);
    for(const [value,status,type]of [ ['{',400,'application/json'],[{...body,extra:true},400,'application/json'],[{...body,rpcId:body.rpcId.toUpperCase().replace(/^1/,'A')},400,'application/json'],[{...body,method:'codex-runner/unknown'},400,'application/json'],[body,415,'text/plain'] ]){assert.equal((await route.fetch(request(value,type))).status,status);checks++;}
    const business=await route.fetch(request({...body,payload:{unknown:true}}));assert.equal(business.status,200);const error=await business.json();assert.equal(error.result.ok,false);validate(operation.responses['200'].content['application/json'].schema,error,method+' validation error');checks++;
    const max=operation['x-dsh-request-max-code-units'];assert.equal((await route.fetch(request(' '.repeat(max+1)))).status,413);checks++;
  }
  const post=(method,payload)=>routes.get('/api/codex-runner/'+method).fetch(new Request('http://localhost/api/codex-runner/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'11111111-1111-4111-8111-111111111111',method:'codex-runner/'+method,payload})}));
  for(const timeoutMs of [0,60001,1.5]){assert.equal((await (await post('getQuota',{timeoutMs})).json()).result.ok,false);checks++;}
  for(const probe of ['invalid',null]){assert.equal((await (await post('getQuota',{probe})).json()).result.ok,false);checks++;}
  service.getSubagents=async()=>null;assert.equal((await (await post('getSubagents',{runId:'11111111-1111-4111-8111-111111111111'})).json()).result.value,null);checks++;
  service.saveEditorRegistry=async()=>{throw Error('Registry changed on disk. Reopen the editor before saving.');};
  const saveBody=resolved.paths['/api/codex-runner/saveEditorRegistry'].post.requestBody.content['application/json'].example;
  const conflict=await post('saveEditorRegistry',saveBody.payload);assert.equal(conflict.status,200);assert.equal((await conflict.json()).result.ok,false);checks++;
  const abort=new AbortController(),stream=await routes.get('/api/codex-runner/run-events').fetch(new Request('http://localhost/api/codex-runner/run-events',{signal:abort.signal}));
  assert.equal(stream.headers.get('content-type'),'text/event-stream');assert.equal(stream.headers.get('cache-control'),'no-store');const reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/^: codex-runner/);abort.abort();await reader.cancel();events.close();checks++;
  const readme=fs.readFileSync(new URL('../docs/api/README.md',import.meta.url),'utf8');assert.ok(readme.includes('9 个接口'));
  const fixture=path.join(scratch,'fixture');fs.mkdirSync(fixture);
  const catalog=createCatalogI18n({home:fixture}).decorate({models:normalizeModels(FALLBACK_CATALOG.models),source:'fallback',fetchedAt:null,stale:true,cached:false,configuration:structuredClone(DEFAULT_FIELD_REGISTRY)});
  validate(resolved.components.schemas.CatalogView,catalog,'Actual fallback catalog');checks++;
  const editor=createConfigurationEditor({home:fixture}),view=editor.get(catalog);
  validate(resolved.components.schemas.RegistryEditorView,view,'Actual registry editor');checks++;
  const edited=structuredClone(view.document);edited.translations.settings.log_dir.name='OpenAPI fixture';
  const preview=editor.save(catalog,{document:edited,revision:view.revision,preview:true});validate(resolved.components.schemas.RegistryPreviewView,preview,'Actual registry preview');checks++;
  const saved=editor.save(catalog,{document:edited,revision:view.revision,preview:false});validate(resolved.components.schemas.RegistryEditorView,saved,'Actual isolated registry save');checks++;
  const quota=await createQuotaView({identity:()=> 'fixture'}).get({settings:{backend:'app-server'}});validate(resolved.components.schemas.QuotaView,quota,'Actual unknown quota');checks++;
  const agents=createSubagentTracker();validate(resolved.components.schemas.SubagentsView,agents.snapshot(),'Actual empty subagent snapshot');checks++;
  const runId='11111111-1111-4111-8111-111111111111',sessionId=runId,callId='call_fixture',dir=path.join(fixture,'.codex-runner/logs/runs',runId);
  atomicJson(path.join(dir,'run.json'),{runId,sessionId,callId,label:'api',backend:'app-server',createdAt:new Date().toISOString()});
  const writer=new OutputWriter({dir,runId,backend:'app-server'});writer.append('item/completed',{item:{text:'中文'.repeat(20000)}});
  let display=true;const output=createOutputView({lookupSession:()=>({header:{cwd:fixture}}),settings:()=>({streamOutputEnabled:display})});
  validate(resolved.components.schemas.OutputView,output.read({sessionId,callId}),'Actual captured output');checks++;
  validate(resolved.components.schemas.OutputResourceView,output.resource({sessionId,callId,sequence:1}),'Actual resource chunk');checks++;
  display=false;validate(resolved.components.schemas.OutputView,output.read({sessionId,callId}),'Actual disabled display');checks++;
  const summary={openapi:spec.openapi,version:spec.info.version,languages:['zh','en'].join(','),operations:routes.size,schemas:Object.keys(spec.components.schemas).length,translatedStrings,englishExampleChecks,contractChecks:checks,validator:'@apidevtools/swagger-parser',realModelCalls:0,userProfileWrites:0};
  console.log('OPENAPI-OK '+JSON.stringify(summary));
} finally {
  assert.equal(path.dirname(fs.realpathSync(scratch)),temp);assert.ok(path.basename(scratch).startsWith('runner-openapi-check-'));fs.rmSync(scratch,{recursive:true,force:true});
}
