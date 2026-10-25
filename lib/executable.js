import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { redactDiagnostic } from './run-data.js';

export const INSTALL_HINT = 'Install standard npm package, or set codexExecutable / CODEX_EXE to a native codex.exe.';
const shimPattern = /\.(cmd|bat|ps1)$/i;
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const children = p => { try { return fs.readdirSync(p).sort(); } catch { return []; } };

export function installationSettingProblem(key, value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return key + ' requires a path without control characters';
  if (!value.trim()) return null;
  if (!path.win32.isAbsolute(value) || path.win32.parse(value).root.length < 2) return key + ' requires an absolute Windows path';
  if (key === 'codexExecutable' && (!/\.exe$/i.test(value) || shimPattern.test(value))) return 'codexExecutable must name a native .exe (not a shell shim)';
  return null;
}

// Each invocation owns its environment; never mutate the host or Codex home.
export function codexEnvironment(settings = {}, env = process.env) {
  const result = { ...env };
  for (const [key, variable] of [['codexExecutable', 'CODEX_EXE'], ['codexHome', 'CODEX_HOME']]) {
    const value = settings[key];
    if (value === undefined || value === '') continue;
    const problem = installationSettingProblem(key, value);
    if (problem) throw Error(problem + '. ' + INSTALL_HINT);
    if (value.trim()) result[variable] = value;
  }
  if (process.versions.electron) result.ELECTRON_RUN_AS_NODE = '1';
  return result;
}

// Reject renamed scripts too, without loading executable code.
function nativeExe(file) {
  if (!/\.exe$/i.test(file) || !isFile(file)) return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const dos = Buffer.alloc(64), signature = Buffer.alloc(4);
    if (fs.readSync(fd, dos, 0, 64, 0) !== 64 || dos.readUInt16LE(0) !== 0x5a4d) return false;
    const offset = dos.readUInt32LE(60);
    return offset >= 64 && offset <= fs.fstatSync(fd).size - 4 && fs.readSync(fd, signature, 0, 4, offset) === 4 && signature.readUInt32LE(0) === 0x4550;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function discoverCodex(settings = {}, { env = process.env, home = os.homedir(), platform = process.platform, arch = process.arch } = {}) {
  const searched = [], seen = new Set();
  const result = { searched, executable: null, platform, CODEX_HOME: settings.codexHome?.trim() || env.CODEX_HOME || path.join(home, '.codex') };
  const fail = message => { const error = Error(message + '. ' + INSTALL_HINT); error.discovery = { ...result, problem: error.message }; throw error; };
  if (settings.codexHome !== undefined) { const problem = installationSettingProblem('codexHome', settings.codexHome); if (problem) fail(problem); }
  if (platform !== 'win32') fail('Only Windows is supported');
  if (!['x64', 'arm64'].includes(arch)) fail('Unsupported Windows architecture: ' + arch);
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const probe = (source, file) => {
    file = path.resolve(file);
    const identity = file.toLowerCase();
    if (seen.has(identity)) return null;
    seen.add(identity);
    const native = nativeExe(file); searched.push({ source, path: file, exists: isFile(file), native });
    return native ? file : null;
  };
  const packageExe = (source, root) => {
    // Resolve npm/pnpm links before locating nested or hoisted optional deps.
    try { root = fs.realpathSync(root); } catch {}
    const roots = [path.join(root, 'node_modules', '@openai', 'codex-win32-' + arch), path.join(root, '..', 'codex-win32-' + arch), root];
    for (const base of roots) {
      const found = probe(source, path.join(base, 'vendor', triple, 'bin', 'codex.exe'));
      if (found) return found;
    }
    return null;
  };
  const prefixExe = (source, prefix) => packageExe(source, path.join(prefix, 'node_modules', '@openai', 'codex'));
  const shimExe = (source, file) => {
    if (!isFile(file)) return null;
    searched.push({ source, path: file, exists: true, native: false, shim: true });
    let text;
    try { if (fs.statSync(file).size > 65536) fail('Shim is too large: ' + file); text = fs.readFileSync(file, 'utf8'); } catch { fail('Cannot read shim: ' + file); }
    const dir = path.dirname(file);
    text = text.replace(/%~dp0|%dp0%|\$\{basedir\}|\$basedir|\$PSScriptRoot/gi, dir + path.sep);
    // Static quoted targets only: never evaluate any shell expressions.
    for (const match of text.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const target = match[1].replace(/[\\/]+/g, path.sep);
      if (!path.isAbsolute(target)) continue;
      if (/codex(?:-[a-z0-9_-]+)?\.exe$/i.test(target)) { const found = probe(source + ':target', target); if (found) return found; }
      const entry = target.match(/^(.*[\\/]@openai[\\/]codex)[\\/]bin[\\/]codex\.js$/i);
      if (entry) { const found = packageExe(source + ':package', entry[1]); if (found) return found; }
    }
    const found = prefixExe(source + ':prefix', dir);
    if (found) return found;
    fail('Cannot resolve shell shim to a native exe: ' + file);
  };
  const directoryExe = (source, dir) => {
    // Scoop's native launcher has a sidecar pointing at the real CLI.
    const sidecar = path.join(dir, 'codex.shim');
    if (isFile(sidecar)) return shimExe(source, sidecar);
    const found = probe(source, path.join(dir, 'codex.exe'));
    if (found) return found;
    const standalone = probe(source, path.join(dir, 'codex-' + triple + '.exe'));
    if (standalone) return standalone;
    for (const ext of ['cmd', 'bat', 'ps1']) {
      const found = shimExe(source, path.join(dir, 'codex.' + ext));
      if (found) return found;
    }
    return null;
  };
  const finish = executable => ({ ...result, executable });
  for (const [source, value] of [['codexExecutable', settings.codexExecutable], ['CODEX_EXE', env.CODEX_EXE]]) {
    if (value === undefined || value === '') continue;
    const problem = installationSettingProblem('codexExecutable', value);
    if (problem) { searched.push({ source, path: String(value), native: false }); fail(source + ': ' + problem); }
    if (!value.trim()) continue;
    const found = probe(source, value);
    if (!found) fail(source + ' is not an existing native PE executable: ' + value);
    return finish(found);
  }
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  let found = prefixExe('npm', path.join(roaming, 'npm'));
  if (found) return finish(found);
  found = directoryExe('local', path.join(home, '.local', 'bin'));
  if (found) return finish(found);
  const volta = env.VOLTA_HOME || path.join(home, '.volta');
  const voltaExe = () => {
    const root = path.join(volta, 'tools', 'image', 'packages', '@openai', 'codex');
    for (const version of children(root).reverse()) { const found = prefixExe('Volta', path.join(root, version)); if (found) return found; }
    return null;
  };
  for (const raw of (env.PATH || env.Path || '').split(';')) {
    const dir = raw.trim().replace(/^"|"$/g, ''); if (!dir || !path.isAbsolute(dir)) continue;
    if (path.resolve(dir).toLowerCase() === path.join(volta, 'bin').toLowerCase()) {
      found = voltaExe();
      if (!found && ['exe', 'cmd', 'ps1'].some(ext => isFile(path.join(dir, 'codex.' + ext)))) fail('Cannot resolve Volta router: ' + dir);
    } else found = directoryExe('PATH', dir);
    if (found) return finish(found);
  }
  const prefixes = [env.npm_config_prefix, env.NPM_CONFIG_PREFIX];
  for (const config of new Set([env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || path.join(home, '.npmrc'), env.NPM_CONFIG_GLOBALCONFIG || env.npm_config_globalconfig].filter(Boolean))) {
    try {
      if (fs.statSync(config).size > 65536) continue;
      const match = fs.readFileSync(config, 'utf8').match(/^\s*prefix\s*=\s*(.+?)\s*$/mi);
      if (match) prefixes.push(match[1].replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}/g, (_, key) => env[key] || ''));
    } catch {}
  }
  prefixes.push(path.join(roaming, 'npm'), env.PNPM_HOME || path.join(local, 'pnpm'), env.YARN_GLOBAL_FOLDER || path.join(local, 'Yarn', 'Data', 'global'), path.join(home, '.config', 'yarn', 'global'), path.join(env.BUN_INSTALL || path.join(home, '.bun'), 'install', 'global'));
  for (const prefix of new Set(prefixes.filter(p => p && path.isAbsolute(p)))) {
    found = prefixExe('common:prefix', prefix); if (found) return finish(found);
    for (const version of children(path.join(prefix, 'global')).reverse()) {
      found = prefixExe('pnpm', path.join(prefix, 'global', version)); if (found) return finish(found);
    }
    found = directoryExe('common:prefix', prefix); if (found) return finish(found);
  }
  found = voltaExe(); if (found) return finish(found);
  const dirs = [path.join(env.BUN_INSTALL || path.join(home, '.bun'), 'bin'), path.join(env.SCOOP || path.join(home, 'scoop'), 'apps', 'codex', 'current'), path.join(env.SCOOP || path.join(home, 'scoop'), 'shims'),
    path.join(env.SCOOP_GLOBAL || path.join(env.ProgramData || path.join(home, 'ProgramData'), 'scoop'), 'apps', 'codex', 'current'),
    path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(home, 'bin'), path.join(home, 'Apps', 'Codex'), path.join(home, 'Codex'),
    ];
  const desktop = [path.join(local, 'Programs', 'Codex'), ...(env.ProgramFiles ? [path.join(env.ProgramFiles, 'Codex')] : [])];
  for (const base of [path.join(local, 'Programs'), ...(env.ProgramFiles ? [path.join(env.ProgramFiles, 'WindowsApps')] : [])]) {
    for (const name of children(base).filter(n => /codex/i.test(n))) desktop.push(path.join(base, name));
  }
  for (const base of [...desktop]) for (const name of children(base).filter(n => /^app-/i.test(n))) desktop.push(path.join(base, name));
  const winget = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  for (const base of [winget]) {
    for (const name of children(base).filter(n => /codex/i.test(n))) dirs.push(path.join(base, name));
  }
  for (const dir of dirs) for (const suffix of ['', 'bin', 'resources', 'resources/bin', 'app/resources', 'app/resources/bin']) {
    found = directoryExe('common', path.join(dir, suffix)); if (found) return finish(found);
  }
  // Desktop's root Codex.exe is the GUI, so only inspect its CLI resource dirs.
  for (const dir of desktop) for (const suffix of ['resources', 'resources/bin', 'app/resources', 'app/resources/bin']) {
    found = directoryExe('Desktop', path.join(dir, suffix)); if (found) return finish(found);
  }
  fail('Codex CLI not found');
}

export function resolveCodexExe(settings = {}, options) { return discoverCodex(settings, options).executable; }

export async function diagnoseCodex(settings = {}, { discovery = discoverCodex, check = execFileSync, connect } = {}) {
  let result;
  try { result = discovery(settings); }
  catch (error) { return { ok: false, searched: [], executable: null, version: null, CODEX_HOME: settings.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), ...(error.discovery || {}), problem: error.message, auth: 'not checked' }; }
  const env = codexEnvironment(settings);
  result = { ...result, ok: false, version: null, auth: 'not checked', authenticated: false };
  const run = (...args) => check(result.executable, args, { env, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    result.version = redactDiagnostic(run('--version').trim()).slice(0,200);
    result.exec = run('exec', '--help').includes('--json');
    result.queue = run('queue', '--help').includes('--thread');
    try { run('login', 'status'); result.auth = 'authenticated'; result.authenticated = true; }
    catch { result.auth = 'not authenticated or login status failed'; }
    const withServer = connect || (await import('./app-server-client.js')).withAppServer;
    await withServer(async () => {}, { executable: result.executable, env, timeoutMs: 15000 });
    result.app_server = true;
    result.ok = result.exec && result.queue && result.authenticated;
    if (!result.ok) result.problem = 'Codex capability or authentication check failed. ' + INSTALL_HINT;
  } catch { result.problem = 'Codex diagnostic failed for native exe: ' + result.executable + '. ' + INSTALL_HINT; }
  return result;
}
