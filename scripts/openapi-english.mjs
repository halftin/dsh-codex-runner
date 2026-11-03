import fs from 'node:fs';
import assert from 'node:assert/strict';

// Translate display text only. Wire identifiers, constraints, defaults, and
// examples remain identical. Missing translations stop generation.
const translations=JSON.parse(fs.readFileSync(new URL('./openapi-en-text.json',import.meta.url),'utf8'));
export function englishOpenApi(specification) {
  const used=new Set();
  function translate(value) {
    if(typeof value==='string') {
      if(!/\p{Script=Han}/u.test(value))return value;
      assert.ok(Object.hasOwn(translations,value),'Missing OpenAPI English translation: '+value);
      used.add(value);return translations[value];
    }
    if(Array.isArray(value))return value.map(translate);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,translate(item)]));
    return value;
  }
  const result=translate(specification);
  assert.equal(used.size,Object.keys(translations).length,'Stale OpenAPI translations; review the changed source descriptions');
  assert.ok(!/\p{Script=Han}/u.test(JSON.stringify(result)),'Untranslated OpenAPI text');
  return result;
}
