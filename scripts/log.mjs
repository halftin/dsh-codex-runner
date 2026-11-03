// Development-only console capture. Runtime task data stays in each workspace.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const [script,...args]=process.argv.slice(2);
if(!script)throw Error('Usage: npm run log -- scripts/<script>.mjs [arguments]');
const target=fs.realpathSync(path.resolve(root,script));
const relative=path.relative(path.join(root,'scripts'),target);
if(relative.startsWith('..')||path.isAbsolute(relative)||!relative.endsWith('.mjs')||target===fileURLToPath(import.meta.url))throw Error('Choose an .mjs script inside scripts/, excluding log.mjs');
const directory=path.join(root,'logs');fs.mkdirSync(directory,{recursive:true});
const name=path.basename(target,'.mjs')+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.log';
const file=path.join(directory,name),fd=fs.openSync(file,'wx',0o600);
console.log('Development log: '+file);
const child=spawn(process.execPath,[target,...args],{cwd:root,stdio:['inherit','pipe','pipe'],windowsHide:true});
child.stdout.on('data',chunk=>{fs.writeSync(fd,chunk);process.stdout.write(chunk);});
child.stderr.on('data',chunk=>{fs.writeSync(fd,chunk);process.stderr.write(chunk);});
child.on('error',error=>{fs.writeSync(fd,error.message+'\n');console.error(error.message);});
child.on('close',(code,signal)=>{
  fs.writeSync(fd,'\n[log] exit_code='+code+' signal='+(signal||'none')+'\n');
  fs.closeSync(fd);process.exitCode=code??1;
});
