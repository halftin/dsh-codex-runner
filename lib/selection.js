import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function workspaceFile(cwd, value) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw Error('Evidence path is invalid');
  const root = fs.realpathSync(cwd), file = fs.realpathSync(path.resolve(root, value));
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel) || !fs.statSync(file).isFile()) throw Error('Evidence must be a file inside this workspace');
  return { file, relative: rel };
}

/** Deterministic policy. Caller claims are disclosed separately from filesystem facts. */
export function selectWithEvidence(cwd, evidence, taskKind) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw Error('evidence requires a structured task description');
  const allowed = ['files','plan_file','acceptance','interface_change','architecture_decision','concurrency_risk','security_risk','uncertainty','failure_reason'];
  if (Object.keys(evidence).some(k => !allowed.includes(k))) throw Error('Unknown evidence field');
  if (!Array.isArray(evidence.files) || evidence.files.length > 80) throw Error('evidence.files must contain at most 80 workspace files');
  for (const key of ['interface_change','architecture_decision','concurrency_risk','security_risk']) if (evidence[key] !== undefined && typeof evidence[key] !== 'boolean') throw Error(key + ' must be boolean');
  if (!['low','medium','high','unknown'].includes(evidence.uncertainty || 'unknown')) throw Error('Invalid uncertainty');
  if (!['none','environment','test','design'].includes(evidence.failure_reason || 'none')) throw Error('Invalid failure_reason');
  if (typeof evidence.acceptance !== 'string' || !evidence.acceptance.trim() || evidence.acceptance.length > 2000) throw Error('A bounded acceptance description is required');
  const files = [...new Set(evidence.files)].map(f => workspaceFile(cwd, f).relative);
  let plan = null;
  if (evidence.plan_file) {
    const p = workspaceFile(cwd, evidence.plan_file);
    const stat = fs.statSync(p.file);if (!stat.size || stat.size > 1048576) throw Error('Plan must be nonempty and at most 1 MiB');
    plan = { file: p.relative, sha256: createHash('sha256').update(fs.readFileSync(p.file)).digest('hex') };
  }
  const modules = [...new Set(files.map(f => f.split(path.sep)[0]))];
  const claims = { ...evidence };delete claims.files;delete claims.plan_file;
  const reasons = [], facts = { files, modules, plan }, result = { facts, caller_claims: claims, reasons, stage: 'execution' };
  const complex = evidence.architecture_decision || evidence.interface_change || evidence.concurrency_risk || evidence.security_risk || evidence.failure_reason === 'design';
  if (complex) {
    reasons.push('Declared architecture/interface/concurrency/security decision or design failure');
    return { ...result, model: 'gpt-6-astra', effort: 'xhigh' };
  }
  if (!files.length || !evidence.uncertainty || ['unknown','high'].includes(evidence.uncertainty)) {
    reasons.push('Insufficient verified scope or unresolved uncertainty: investigate before implementation');
    return { ...result, stage:'investigation', model:'gpt-6.1-sol', effort:'medium' };
  }
  if (['mechanical','docs'].includes(taskKind) && plan && evidence.uncertainty === 'low' && evidence.failure_reason !== 'test') {
    reasons.push('Mechanical/documentation task, verified plan and files, declared low uncertainty');
    return { ...result, model:'gpt-6-luna', effort:'low' };
  }
  reasons.push(evidence.failure_reason === 'environment' ? 'Environment failure does not justify model escalation' : 'Implementation/review with verified workspace scope');
  return { ...result, model:'gpt-6.1-sol', effort:evidence.failure_reason === 'test' || evidence.uncertainty === 'medium' ? 'high' : 'medium' };
}
