// Read-only comparison of the shipped Electron ASAR with an isolated npm host.
// Usage: node scripts/probe-desktop-chat.mjs <app.asar> <npm-host-prefix> <report.json>
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [archive,prefix,output]=process.argv.slice(2);
if(!output)throw Error('Supply ASAR, isolated host prefix and report path');
const fd=fs.openSync(archive,'r');
try {
  const head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);
  const size=head.readUInt32LE(12);if(size>64*1024*1024)throw Error('Unexpected ASAR header');
  const bytes=Buffer.alloc(size);fs.readSync(fd,bytes,0,size,16);const header=JSON.parse(bytes.toString());
  function entry(name,depth=0){if(depth>20)throw Error('ASAR link cycle');let node=header;const parts=name.split('/');for(let i=0;i<parts.length;i++){node=node.files?.[parts[i]];if(!node)throw Error('Missing ASAR member: '+name);if(node.link)return entry(node.link+(i+1<parts.length?'/'+parts.slice(i+1).join('/'):''),depth+1);}return node;}
  function read(name){const e=entry(name);if(e.unpacked)throw Error('Unpacked member requires separate inspection');const b=Buffer.alloc(e.size);fs.readSync(fd,b,0,e.size,8+head.readUInt32LE(4)+Number(e.offset));return b;}
  const desktop=JSON.parse(read('package.json'));
  const modules=['dsh-client-ui-chat','dsh-client-ui-conversation'];
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const comparisons=modules.map(name=>{
    const relative='dsh/node_modules/@deepseek-ai/'+name;
    const shipped=JSON.parse(read(relative+'/package.json'));
    const clientBytes=read(relative+'/lib/client.js'),text=clientBytes.toString(),shippedHash=hash(clientBytes);
    const testedBytes=fs.readFileSync(path.join(prefix,'node_modules/@deepseek-ai',name,'lib/client.js')),testedHash=hash(testedBytes);
    // Build machines generate different CSS module class names and source paths.
    // Remove only complete CSS regions; compare all remaining JS byte-for-byte.
    const executableJs=source=>source.replace(/^[\t ]*\/\/#region \\0dsh-css:[\s\S]*?^[\t ]*\/\/#endregion\r?\n/gm,'').replaceAll('\r\n','\n');
    const contracts=name==='dsh-client-ui-chat'?['conversation.chat.node','groupTree','anchorSeq']:['uiConversation','buildViewNode','register(definition)'];
    const contractPresence=Object.fromEntries(contracts.map(key=>[key,text.includes(key)]));
    fs.writeFileSync(path.join(path.dirname(output),name+'-desktop-client.js'),clientBytes);
    return {name,version:shipped.version,shippedHash,testedHash,identical:shippedHash===testedHash,nonCssJsIdentical:executableJs(text)===executableJs(testedBytes.toString()),contractPresence};
  });
  const report={classification:'read-only-shipped-artifact-comparison',desktopVersion:desktop.version,comparisons,electronRuntimeUi:'not exercised'};
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{fs.closeSync(fd);}
