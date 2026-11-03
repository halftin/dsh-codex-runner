// Test dependency: every implicit catalog request goes to a fake App Server.
// Explicit fixtures still supply their own executable, NODE_OPTIONS and home.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (!process.env.DSH_HOME) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'runner-offline-'));
  process.env.DSH_HOME=path.join(home,'host');
  process.env.CODEX_HOME=path.join(home,'codex');
}
if(!process.env.CODEX_EXE)process.env.CODEX_EXE=process.execPath;
if(!process.env.NODE_OPTIONS)process.env.NODE_OPTIONS='--import='+pathToFileURL(fileURLToPath(new URL('./fake-catalog-cli.mjs',import.meta.url))).href;

// Schema discovery is tested with injected exports/fetches, never the network.
process.env.CODEX_RUNNER_SCHEMA_OFFLINE='1';
