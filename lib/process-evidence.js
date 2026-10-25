import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cache = new Map();
export const processStartedAt = () => new Date(Date.now() - process.uptime() * 1000).toISOString();
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// Called only for suspect records. Failure is unknown, never permission to kill.
export function processOwnership(pid, startedAt) {
  if (!processAlive(pid)) return 'dead';
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return 'unknown';
  if (pid === process.pid) return Math.abs(Date.parse(startedAt) - Date.parse(processStartedAt())) < 10000 ? 'match' : 'mismatch';
  const key = pid + ':' + startedAt, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  let value = 'unknown';
  if (process.platform === 'win32') {
    try {
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (Number.isFinite(Date.parse(raw))) value = Math.abs(Date.parse(raw) - Date.parse(startedAt)) < 10000 ? 'match' : 'mismatch';
    } catch {}
  }
  if (cache.size > 256) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function inspectProcessTree(pid,startedAt) {
  if(!processAlive(pid))return {source:'process-check',nodes:[],error:null};
  if(process.platform!=='win32'||!startedAt)return {source:'unavailable',nodes:[],error:'No native process identity'};
  try {
    const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      fileURLToPath(new URL('./stop-owned-tree.ps1',import.meta.url)),'-RootPid',String(pid),'-ExpectedStart',startedAt,'-Inspect'],
    {encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','pipe']});
    const result=JSON.parse(output.trim());return {...result,nodes:(result.nodes||[]).slice(0,32),error:null};
  }catch(error){return {source:'unavailable',nodes:[],error:String(error.message).slice(0,500)};}
}
