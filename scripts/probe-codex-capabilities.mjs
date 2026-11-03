// Read-only capability preflight. Uses an isolated registry cache, never a model turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnoseCodex } from '../lib/executable.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-capabilities-'));
process.env.DSH_HOME=path.join(root,'host');
const settings={...(process.env.CODEX_HOME?{codexHome:process.env.CODEX_HOME}:{})};
const report=await diagnoseCodex(settings);
const {getFieldRegistry}=await import('../lib/codex-fields.js');
const registry=await getFieldRegistry({refresh:true,settings});
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.name.endsWith('.json'))files.push(file);}}
walk(process.env.DSH_HOME);
const schemas=files.filter(file=>/RequestUserInput|ServerRequestResolved|Elicitation|PermissionsRequest|TurnSteer|AgentMessageDelta/.test(path.basename(file)))
  .map(file=>({file:path.relative(root,file),schema:JSON.parse(fs.readFileSync(file,'utf8'))}));
fs.writeFileSync(path.join(root,'capabilities.json'),JSON.stringify({diagnostic:report,registry:{version:registry.codexVersion,error:registry.error,schemas:registry.protocolSchemaCount},schemas,realModelTurns:0},null,2));
console.log(JSON.stringify({version:report.version,authenticated:report.authenticated,exec:report.exec,queue:report.queue,app_server:report.app_server,
  protocolSchemas:registry.protocolSchemaCount,relevantSchemas:schemas.map(s=>path.basename(s.file)),registryError:registry.error,evidence:root,realModelTurns:0},null,2));
// An unavailable latest web reference does not invalidate a successful local export.
if(!report.app_server||!registry.protocolSchemaCount)process.exitCode=1;
