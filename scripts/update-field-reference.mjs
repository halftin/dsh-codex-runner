import fs from 'node:fs';
import { flattenConfigSchema } from '../lib/field-schema.js';
// Development maintenance: refresh public metadata, then regenerate the browser
// fallback. This unversioned URL is never labelled as an installed CLI schema.
const url='https://developers.openai.com/codex/config-schema.json';
const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error('Official schema HTTP '+response.status);
const fields=flattenConfigSchema(await response.json());
fs.writeFileSync(new URL('../lib/codex-fields.default.json',import.meta.url),JSON.stringify({version:1,source:url,codexVersion:null,fields},null,2)+'\n');
await import('./sync-field-client.mjs');
console.log('Updated '+Object.keys(fields).length+' official reference fields');
