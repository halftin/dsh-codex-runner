// Read-only, version-matched protocol audit. No model turn or config mutation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveCodexExe} from '../lib/executable.js';
import {AppServerClient} from '../lib/app-server-client.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-native-audit-'));
const executable=resolveCodexExe(),schemaDir=path.join(root,'schema');
const version=execFileSync(executable,['--version'],{encoding:'utf8',windowsHide:true}).trim();
execFileSync(executable,['app-server','generate-json-schema','--experimental','--out',schemaDir],{windowsHide:true});
const read=name=>JSON.parse(fs.readFileSync(path.join(schemaDir,name),'utf8'));
const requests=read('ClientRequest.json'),notifications=read('ServerNotification.json');
const start=read('v2/TurnStartParams.json'),steer=read('v2/TurnSteerParams.json');
const client=new AppServerClient({cwd:root});let live;
try{
  const handshake=await client.initialize();
  const modes=await client.request('collaborationMode/list',{});
  const features={data:[]};let cursor;const seen=new Set();
  do{
    const page=await client.request('experimentalFeature/list',{limit:100,...(cursor?{cursor}:{})});
    features.data.push(...page.data);cursor=page.nextCursor;
    if(cursor){if(seen.has(cursor))throw Error('Repeated feature cursor');seen.add(cursor);}
  }while(cursor);
  live={handshake,modes,features};
}finally{await client.close();}
const report={classification:'native-schema-and-rpc/no-model-turn',version,
  executableSha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
  clientMethods:requests.oneOf.map(v=>v.properties.method.enum[0]),
  asyncQuestion:notifications.definitions.AsyncUserInputQuestion,
  agentMessage:notifications.definitions.ThreadItem?.oneOf?.find(v=>v.properties?.type?.enum?.includes('agentMessage')),
  originalRequest:read('ToolRequestUserInputParams.json'),originalResponse:read('ToolRequestUserInputResponse.json'),
  turnStartFields:Object.keys(start.properties),turnSteerFields:Object.keys(steer.properties),
  userInput:steer.definitions.UserInput,standaloneToolOutput:start.definitions.TurnToolOutput,
  injectItems:requests.definitions.ThreadInjectItemsParams,live};
fs.writeFileSync(path.join(root,'acceptance.json'),JSON.stringify(report,null,2));
console.log('NATIVE-AUDIT-OK '+version+'; '+report.clientMethods.length+' methods; evidence='+root);
