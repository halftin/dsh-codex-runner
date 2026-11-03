import fs from 'node:fs';
import { BUNDLED_REGISTRY,DEFAULT_FIELD_REGISTRY,SETTING_FIELD_KEYS } from '../lib/codex-fields.js';
import { validateFieldValue,stringEnumSpec,settingFieldSpec } from '../lib/field-schema.js';
import { configurationDefinitions } from '../lib/configuration-editor.js';
import { FALLBACK_CATALOG } from '../lib/model-catalog.js';
// Regenerate the offline browser snapshot from the same table as the server.
const file=new URL('../lib/client.js',import.meta.url);
let source=fs.readFileSync(file,'utf8');
const settingFields=Object.fromEntries(Object.entries(SETTING_FIELD_KEYS).map(([name,key])=>{
  const field=DEFAULT_FIELD_REGISTRY.fields[key];return [name,{schema:field.schema,excludedValues:field.excludedValues}];
}));
const editorFallback={document:{version:1,codexVersion:BUNDLED_REGISTRY.codexVersion,updatedAt:BUNDLED_REGISTRY.updatedAt,fields:BUNDLED_REGISTRY.fields,translations:BUNDLED_REGISTRY.translations},
  configuration:DEFAULT_FIELD_REGISTRY,definitions:configurationDefinitions({...FALLBACK_CATALOG,configuration:DEFAULT_FIELD_REGISTRY}),revision:null,readOnly:true};
const generated='/* field-registry:start */\n    const CONFIG_WHITELIST='+JSON.stringify(DEFAULT_FIELD_REGISTRY.config)+';\n    const SETTING_FIELD_KEYS='+JSON.stringify(SETTING_FIELD_KEYS)+';\n    const SETTING_FIELDS='+JSON.stringify(settingFields)+';\n    const BUNDLED_EDITOR_STATE='+JSON.stringify(editorFallback)+';\n    '+validateFieldValue.toString()+'\n    '+stringEnumSpec.toString()+'\n    '+settingFieldSpec.toString()+'\n    /* field-registry:end */';
if(source.includes('/* field-registry:start */'))source=source.replace(/\/\* field-registry:start \*\/[\s\S]*?\/\* field-registry:end \*\//,generated);
else source=source.replace(/const CONFIG_WHITELIST=.*?;\r?\n/,generated+'\n');
fs.writeFileSync(file,source);console.log('Browser field snapshot synchronized');
