// Inspect the index of the standalone plugin repository, including ignored files added with -f.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
try {
  if(path.resolve(git('rev-parse','--show-toplevel').trim())!==root) throw Error('Run this check in the standalone plugin repository, not its parent project');
  const files=git('ls-files','-z').split('\0').filter(Boolean);
  if(!files.includes('package.json'))throw Error('Stage the plugin source before checking the index');
  const problems=[];
  for(const file of files) {
    if(/^(?:logs|\.capture|\.local-dev|tasks|coverage|test-results)\//.test(file)
      || /^(?:docs\/codex-streaming-supervision-plan\.md|scripts\/fixtures\/eui-neo-selection\.json|scripts\/(?:experiment-chat-display|chat-display-client-probe|chat-display-browser-probe)\.mjs)$/.test(file)) problems.push(file+': local development data or retired experiment in index');
    if(/(^|\/)(node_modules|\.codex-runner|\.env(?:\..*)?|auth\.json|credentials[^/]*)(\/|$)|\.(tgz|log|jsonl|tmp)$/i.test(file)) problems.push(file+': runtime, credentials or archive file in index');
    const content=git('show',':'+file);
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/.test(content)) problems.push(file+': possible secret in index');
  }
  if(problems.length)throw Error(problems.join('\n'));
  console.log('git-clean: OK ('+files.length+' indexed files; history and repository ownership still need review)');
} catch(e) { console.error('git-clean: FAIL\n'+e.message);process.exitCode=1; }
