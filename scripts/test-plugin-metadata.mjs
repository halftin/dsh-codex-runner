// Exercise the installed DSH reader, locale runtime, and three native consumers.
// No host process, user profile, browser, network request, or model turn is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const asar=process.argv[2];assert.ok(asar,'Pass the installed DSH app.asar');
const fd=fs.openSync(asar,'r');const prefix=Buffer.alloc(16);fs.readSync(fd,prefix,0,16,0);
const data=Buffer.alloc(prefix.readUInt32LE(12));fs.readSync(fd,data,0,data.length,16);
const tree=JSON.parse(data.toString()).files,base=8+prefix.readUInt32LE(4);
function read(name){let entry={files:tree};for(const part of ('dsh/node_modules/@deepseek-ai/'+name).split('/'))entry=entry.files[part];const bytes=Buffer.alloc(entry.size);fs.readSync(fd,bytes,0,bytes.length,base+Number(entry.offset));return bytes.toString();}
const host=read('dsh-app-boot/lib/index.js');
const start=host.indexOf('function missingResource('),end=host.indexOf('\n//#endregion',start);
assert.ok(start>0&&end>start);
const reader=host.slice(start,end)+'\nreadPluginMeta;';
function metadata(dir){
  const require=createRequire(path.join(dir,'package.json'));
  return vm.runInNewContext(reader,{...fs,dirname:path.dirname,LANGUAGE_ID:/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i,
    barePackageName:value=>value.startsWith('@')?value.split('/').slice(0,2).join('/'):value.split('/')[0],
    resolvePluginResource:specifier=>require.resolve(specifier),iconOf:()=>undefined})('dsh-codex-runner',path.join(dir,'package.json'));
}
let loaded;
vm.runInNewContext(read('dsh-client-locale/lib/client.js'),{window:{__ModuleLoader__:{load:value=>{loaded=value;}}},navigator:{languages:['en-US'],language:'en-US'}});
const {LocaleRuntime}=loaded.factory(()=>({}));
const locale=new LocaleRuntime({effect:()=>()=>{},emit:()=>{}},undefined,{languages:['en-US'],preference:null});
function nativeFunction(source,name){const match=source.match(new RegExp('function '+name+'\\([^]*?\\n\\t\\t}'));assert.ok(match,'Missing native consumer '+name);return vm.runInNewContext('('+match[0]+')');}
const manager=read('dsh-client-ui-plugin-manager/lib/client.js');
const consumers=[nativeFunction(manager,'packageText'),nativeFunction(manager,'rowText'),nativeFunction(read('dsh-client-ui-settings-plugin-inventory/lib/client.js'),'pluginText')];
const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const en=JSON.parse(fs.readFileSync(path.join(root,'locale/en.json'),'utf8')).meta;
const zh=JSON.parse(fs.readFileSync(path.join(root,'locale/zh.json'),'utf8')).meta;
assert.equal(manifest.description,en.description);
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'dsh.plugin.json'),'utf8')).description,en.description);
assert.match(zh.description,/[\u4e00-\u9fff]/);assert.doesNotMatch(en.description,/[\u4e00-\u9fff]/);
let languageEvents=0;locale.subscribe(()=>languageEvents++);
function verify(dir){
  const meta=metadata(dir);assert.equal(meta.error,undefined);assert.equal(meta.description.zh,zh.description);assert.equal(meta.description.en,en.description);
  for(const [language,expected]of [['zh',zh],['en',en],['zh',zh]]){
    locale.setLocale(language);
    for(const consume of consumers){const shown=consume({name:manifest.name,moduleName:manifest.name,meta},text=>locale.resolveText(text));assert.equal(shown.title,manifest.name);assert.equal(shown.description,expected.description);}
  }
}
verify(root);assert.ok(languageEvents>=3,'Language changes must publish updates');
for(const file of ['README.md','README.en.md']){
  const content=fs.readFileSync(path.join(root,file),'utf8');
  for(const target of content.matchAll(/\]\(([^):#]+\.md)\)/g))assert.ok(fs.existsSync(path.join(root,target[1])));
}
const temp=fs.realpathSync(os.tmpdir()),scratch=fs.mkdtempSync(path.join(temp,'runner-metadata-'));
const run=(exe,args)=>execFileSync(exe,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});
try{
  const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  const [archive]=JSON.parse(run(process.execPath,[npm,'pack','--json','--pack-destination',scratch]));
  for(const name of ['README.md','README.en.md','locale/en.json','locale/zh.json'])assert.ok(archive.files.some(file=>file.path===name));
  assert.ok(archive.files.every(file=>! /^(scripts|tasks|\.github)\//.test(file.path)));
  const installed=path.join(scratch,'node_modules/dsh-codex-runner');fs.mkdirSync(installed,{recursive:true});
  run('tar',['-xzf',path.join(scratch,archive.filename),'-C',installed,'--strip-components=1']);
  fs.writeFileSync(path.join(scratch,'package.json'),'{}');
  verify(installed);
  console.log(run(process.execPath,['scripts/check-package.mjs',installed]).trim());
  console.log('METADATA-I18N-OK: installed DSH '+JSON.parse(read('dsh-client-locale/package.json')).version+'; 3 native consumers; zh/en/zh switching; source and packed exports; both READMEs included');
}finally{
  assert.equal(path.dirname(scratch),temp);assert.ok(path.basename(scratch).startsWith('runner-metadata-'));
  fs.rmSync(scratch,{recursive:true,force:true});fs.closeSync(fd);
}
