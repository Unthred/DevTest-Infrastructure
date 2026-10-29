import * as base from './base.mjs';
import { spawnSync } from 'node:child_process';
export const capabilities = { resumeSession: true, usageReset: true };
export function preflight(job) {
  const status = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 10000 });
  if (status.status !== 0 || !/logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`)) return false;
  // The governed launcher validates its installed profile and the selected product root.
  const governed = spawnSync('/usr/local/bin/ai-rules-codex', ['--session-name', base.contextForRole(job.role), job.worktree], { encoding: 'utf8', timeout: 15000 });
  return governed.status === 0;
}
export function command(config, job, resume) {
  const args = [...config.command, 'exec', '--json', '--profile', `ai-rules-${base.contextForRole(job.role)}`, '--cd', job.worktree];
  if (resume && job.sessionId && config.manifest.capabilities.resume === 'supported') args.push('resume', job.sessionId, '-');
  else args.push('-');
  return args;
}
export function observe(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { obj = null; }
  const sessionId = obj?.type === 'thread.started' && typeof obj.thread_id === 'string' ? obj.thread_id : null;
  const errorObject = obj && (obj.type === 'error' || obj.type === 'turn.failed');
  const text = obj ? (errorObject ? String(obj.error?.message || obj.message || obj.error || '') : '') : line;
  if (/reset your current usage limits|switch(?:ing|ed)? models? due to usage limits/i.test(text)) return { event: 'approval_required', sessionId };
  if (/usage limit|you(?:'ve| have) hit your limit/i.test(text) && !/api key|billing/i.test(text))
    return { event: 'usage_limit', resetAt: base.resetTime(text), resetSource: 'provider_reported', verified: false, sessionId };
  return { ...base.observe(text), sessionId };
}
