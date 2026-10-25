import fs from 'node:fs';
import { runManaged } from '../lib/managed-run.js';

const args = process.argv.slice(2), options = {}, pairs = [];
const names = { '--prompt':'promptFile', '--label':'label', '--cwd':'cwd', '--model':'model', '--effort':'effort',
  '--sandbox':'sandbox', '--log-dir':'logDir', '--run-id':'runId', '--budget-ms':'budgetMs', '--debug-max-bytes':'debugMaxBytes',
  '--resume':'resumeThread',
  '--pause-grace-ms':'pauseGraceMs', '--quota-warning-threshold':'quotaWarningThreshold' };
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--debug-logs') { options.debugLogs = true; continue; }
    if (args[i] === '--auto-resume-quota') { options.autoResumeAfterQuota = true; continue; }
    if (args[i] === '--quota-warning') { options.quotaWarning = true; continue; }
    if (args[i] === '--detached') { options[args[i].slice(2)] = true; continue; }
    if (args[i] === '--set') { pairs.push(args[++i]); continue; }
    if (!names[args[i]] || args[i + 1] === undefined) throw Error('Invalid driver arguments');
    options[names[args[i]]] = args[++i];
  }
  for (const key of ['budgetMs','debugMaxBytes','pauseGraceMs']) if (options[key] !== undefined) {
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < 0) throw Error('Invalid ' + key);
  }
  if (options.quotaWarningThreshold !== undefined) {
    options.quotaWarningThreshold = Number(options.quotaWarningThreshold);
    if (!Number.isInteger(options.quotaWarningThreshold) || options.quotaWarningThreshold < 0 || options.quotaWarningThreshold > 20) throw Error('Invalid quotaWarningThreshold');
  }
  options.config = {};
  for (const pair of pairs) {
    const at = pair.indexOf('='); if (at < 1) throw Error('Invalid config pair');
    const raw = pair.slice(at + 1);
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    options.config[pair.slice(0, at)] = value;
  }
  options.prompt = fs.readFileSync(options.promptFile, 'utf8');
  const result = await runManaged(options);
  process.exitCode = result.status === 'ok' ? 0 : 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
