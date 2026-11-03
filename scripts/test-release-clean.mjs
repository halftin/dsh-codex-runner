import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RELEASE_RULES } from './release-paths.mjs';

const slash=String.fromCharCode(92);
const unc=slash.repeat(2)+'server'+slash+'share'+slash+'file.txt';
const rule=RELEASE_RULES.find(r=>r.id==='unc-path');
for(const line of [unc,'"'+unc+'"','path='+unc,'text '+unc,JSON.stringify({path:unc}),'('+unc+')','`'+unc+'`']) {
  assert.equal(rule.re.test(line),true,'True UNC must remain rejected');
}
const relative=['src','main','java','org','example','backend','IPC.md'].join(slash);
for(const line of [relative,JSON.stringify(relative),JSON.stringify({path:relative})])assert.equal(rule.re.test(line),false,'Relative path must not become UNC');
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/synthetic-selection.json',import.meta.url),'utf8'));
assert.ok(fixture.facts.files.includes(relative));
for(const line of fs.readFileSync(new URL('./fixtures/synthetic-selection.json',import.meta.url),'utf8').split(/\r?\n/))assert.equal(rule.re.test(line),false);
assert.equal(RELEASE_RULES.find(r=>r.id==='drive-path').re.test('Z'+':'+slash+'private'),true);
assert.equal(RELEASE_RULES.find(r=>r.id==='posix-home').re.test('/'+'home'+'/'+'private'+'/file'),true);
console.log('RELEASE-PATHS-OK (raw/quoted/serialized UNC, relative JSON, synthetic fixture, other absolute-path rules)');
