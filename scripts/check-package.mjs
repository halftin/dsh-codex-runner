import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=path.resolve(process.argv[2]||''),read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const manifest=read('package.json'),plugin=read('dsh.plugin.json');
assert.equal(manifest.name,'dsh-codex-runner');assert.equal(manifest.version,plugin.version);
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,entry.name);assert.ok(!entry.isSymbolicLink(),'Package must not contain redirect links');
  if(entry.isDirectory())walk(full);else files.push(path.relative(root,full).replaceAll(path.sep,'/'));
}}
walk(root);
let imports=0;
for(const file of files){
  assert.ok(file==='package.json'||manifest.files.some(item=>file===item||['lib','drivers'].includes(item)&&file.startsWith(item+'/')||item==='locale/*.json'&&/^locale\/[a-z0-9-]+\.json$/i.test(file)),'Unexpected packaged file: '+file);
  assert.ok(!/(^|\/)(node_modules|\.git|\.codex-runner|tasks|auth\.json|credentials[^/]*|\.env[^/]*)(\/|$)|\.(log|jsonl|tgz|tmp|bak)$/i.test(file),'Runtime or private data in package: '+file);
  if(/\.[mc]?js$/.test(file))for(const match of fs.readFileSync(path.join(root,file),'utf8').matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){
    imports++;assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(root,file)),match[1])),'Missing relative import in '+file+': '+match[1]);
  }
}
for(const file of ['lib/index.js','lib/client.js','lib/codex-registry.json','lib/configuration-editor.js','lib/stop-owned-tree.ps1','drivers/drive-app-server.mjs','drivers/drive-codex.mjs','cordis.patch.yml'])assert.ok(files.includes(file),'Missing runtime file: '+file);
assert.equal(files.includes('docs/upstream-settings-row.md'),false);
const core=await import(pathToFileURL(path.join(root,'lib/core.js')).href);
assert.equal(core.SETTINGS_DEFAULTS.autoModelAndEffort,false);
console.log('PACKAGE-OK '+manifest.version+'; '+files.length+' files; '+imports+' relative imports; no runtime/private data');
