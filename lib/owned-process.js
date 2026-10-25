import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processAlive } from './process-evidence.js';

const fallbackScript = fileURLToPath(new URL('./stop-owned-tree.ps1', import.meta.url));
// Only pass the ChildProcess owned by this connection/driver, never a stored PID.
export function stopOwnedTree(child, startedAt) {
  if (!child?.pid || child.exitCode !== null) return { verified: true, pids: [], errors: [] };
  const result = { verified: false, pids: [child.pid], errors: [] };
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch (error) { result.errors.push(error.message); } }
  } else {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      result.errors.push('taskkill: ' + String(error.stderr || error.message).slice(0, 1000));
      // Windows PowerShell is built in. The helper uses Toolhelp on 5.1 and
      // .NET tree termination on 7+, without depending on WMI or pwsh installation.
      try {
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', fallbackScript, '-RootPid', String(child.pid), '-ExpectedStart', startedAt],
        { windowsHide: true, timeout: 12000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const detail = JSON.parse(output.trim());
        result.pids = detail.pids?.length ? detail.pids : result.pids;
        result.errors.push(...(detail.errors || []));
        result.method = detail.method || 'already-exited';
      } catch (fallbackError) {
        result.errors.push('native fallback: ' + String(fallbackError.stderr || fallbackError.message).slice(0, 1000));
      }
    }
  }
  result.verified = result.pids.every(pid => !processAlive(pid));
  return result;
}
