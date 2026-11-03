// Offline, isolated processes: fake Codex environment never escapes into live checks.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const external = new Set(['test-dsh-package.mjs', 'test-dsh-browser.mjs', 'test-live.mjs',
  'test-installed-transport.mjs', 'test-shared-transport.mjs', 'test-plugin-metadata.mjs', 'test-openapi.mjs', 'test-live-questions.mjs','test-live-output.mjs','test-live-controls.mjs']);
const stage1 = ['test-core.mjs', 'test-client-controls.mjs', 'test-configuration-editor.mjs',
  'test-field-registry.mjs', 'test-tool-schema.mjs', 'test-stream-contracts.mjs', 'test-live-entry.mjs', 'test-rpc.mjs'];
if (process.argv[2] && process.argv[2] !== 'stage1') throw Error('Unknown suite');
const files = process.argv[2] === 'stage1' ? stage1 : fs.readdirSync(new URL('./', import.meta.url))
  .filter(name => /^test-.*\.mjs$/.test(name) && !external.has(name)).sort();
if(!process.argv[2])files.push('client-smoke.mjs');
let failed = 0;
for (const file of files) {
  console.log('\nVERIFY ' + file);
  const result = spawnSync(process.execPath, ['--import', './scripts/offline-env.mjs', './scripts/' + file],
    { cwd: root, env: { ...process.env }, windowsHide: true, stdio: 'inherit', timeout: 240000 });
  if (result.error || result.status !== 0) { failed++; console.error('FAILED', file, result.error?.message || result.status); }
}
console.log(`\nVERIFY ${files.length - failed}/${files.length} passed; offline only. Host/model/phone acceptance is separate.`);
process.exitCode = failed ? 1 : 0;
