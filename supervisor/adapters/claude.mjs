import * as base from './base.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { claudeAllowance } from '../allowance.mjs';
import { safeEnvironment } from '../core.mjs';
export const capabilities = { resumeSession: true, usageReset: true };
export function preflight() {
  const result = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 10000, env: safeEnvironment() });
  if (result.error?.code === 'ENOENT') return 'not_found';
  try {
    const status = JSON.parse(result.stdout);
    return result.status === 0 && status.loggedIn === true && status.authMethod === 'claude.ai' && !!status.subscriptionType;
  } catch { return false; }
}
export function command(config, job, resume) {
  const context = base.contextForRole(job.role);
  const ruleFile = `/mnt/cache/cursor-workspace/ai-rules-live/adapters/generated/claude/${context}/CLAUDE.md`;
  const governance = fs.readFileSync(ruleFile, 'utf8');
  const args = [...config.command, '--print', '--verbose', '--output-format', 'stream-json', ...base.accessArgs(config, job), ...base.modelArgs(config, job), '--append-system-prompt', `${governance}\nSelected role: ${job.role}. Follow its project and host safety instructions.`];
  if (resume && job.sessionId && config.manifest.capabilities.resume === 'supported') args.push('--resume', job.sessionId);
  return args;
}
export function observe(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { obj = null; }
  if (obj === null && base.isTruncatedPayload(line)) return {};
  const errorObject = obj && (obj.type === 'error' || obj.is_error === true || obj.type === 'result' && obj.is_error === true);
  const sessionId = typeof obj?.session_id === 'string' ? obj.session_id : null;
  if (obj?.type === 'rate_limit_event') return { sessionId, allowance: claudeAllowance(obj.rate_limit_info) };
  const text = obj ? (errorObject ? String(obj.error?.message || obj.error || obj.message || obj.result || '') : '') : line;
  if (errorObject && obj.api_error_status === 401) return { event: 'auth_error', sessionId };
  if (/budget limit|spend limit|insufficient credits/i.test(text)) return { event: 'approval_required', sessionId };
  if (/usage limit|weekly limit|session limit|out of extra usage/i.test(text) && !/api key|billing/i.test(text))
    return { event: 'usage_limit', resetAt: base.resetTime(text), resetSource: 'provider_reported', verified: false, sessionId };
  if (errorObject && obj.api_error_status === 429) return { event: 'transient_rate_limit', sessionId };
  return { ...base.observe(text), sessionId };
}
