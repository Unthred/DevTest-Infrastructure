import * as base from './base.mjs';
import { spawnSync } from 'node:child_process';
import { codexAllowanceFromRollout, codexRolloutFile } from '../allowance.mjs';
import { parseStatusWindow, parseTryAgain } from '../clocktext.mjs';
export const capabilities = { resumeSession: true, usageReset: true };
export function preflight(job) {
  const status = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 10000 });
  if (status.error?.code === 'ENOENT') return 'not_found';
  if (status.status !== 0 || !/logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`)) return false;
  // The governed launcher validates its installed profile and the selected product root.
  const governed = spawnSync('/usr/local/bin/ai-rules-codex', ['--session-name', base.contextForRole(job.role), job.worktree], { encoding: 'utf8', timeout: 15000 });
  return governed.status === 0;
}
export function command(config, job, resume) {
  const args = [...config.command, 'exec', '--json', '--profile', `ai-rules-${base.contextForRole(job.role)}`, '--cd', job.worktree, ...base.accessArgs(config, job), ...base.modelArgs(config, job)];
  if (resume && job.sessionId && config.manifest.capabilities.resume === 'supported') args.push('resume', job.sessionId, '-');
  else args.push('-');
  return args;
}
// `now` is injected so reset times resolve against the supervisor's clock. The message shapes below were captured from the
// interactive Codex CLI 0.165.0 on 2026-10-30; the `codex exec --json` wording of the same condition is NOT yet captured,
// so these results are marked verified only because the text matches a captured shape, not because exec output was seen.
export function observe(line, now = Date.now()) {
  let obj;
  try { obj = JSON.parse(line); } catch { obj = null; }
  if (obj === null && base.isTruncatedPayload(line)) return {};
  const sessionId = obj?.type === 'thread.started' && typeof obj.thread_id === 'string' ? obj.thread_id : null;
  const errorObject = obj && (obj.type === 'error' || obj.type === 'turn.failed');
  const text = obj ? (errorObject ? String(obj.error?.message || obj.message || obj.error || '') : '') : line;
  // Approval is blocking and drops the verdict, so it comes only from a structured error/turn.failed object. A plain line
  // (stderr, tool output) can quote these words and is never approval evidence (issue #68, same principle as #33).
  if (errorObject && /reset your current usage limits|switch(?:ing|ed)? models? due to usage limits/i.test(text)) return { event: 'approval_required', sessionId };
  // "... or try again at 11:44 AM." The text also offers "purchase more credits"; that is an upsell, never consent to paid
  // usage: it stays a plain usage_limit and no billing action is taken.
  const tryAgain = parseTryAgain(text, now);
  // Like approval, limit evidence comes only from a structured error/turn.failed object (or the rollout allowance in postRun);
  // a plain line (stderr, tool output) can quote it (issue #68).
  if (errorObject && /usage limit|you(?:'ve| have) hit your limit/i.test(text) && !/api key|billing/i.test(text)) {
    if (tryAgain) return { event: 'usage_limit', resetAt: tryAgain, resetSource: 'provider_reported', verified: true, sessionId };
    return { event: 'usage_limit', resetAt: base.resetTime(text), resetSource: 'provider_reported', verified: false, sessionId };
  }
  // /status window lines. Only an exhausted window (0% left) is a limit; the process keeps the later of several.
  const window = errorObject ? parseStatusWindow(text, now) : null;
  if (window && window.percentLeft === 0) return { event: 'usage_limit', resetAt: window.resetsAt, resetSource: 'provider_reported', verified: true, sessionId };
  const rest = base.observe(text);
  if (!errorObject && rest.event === 'approval_required') return { sessionId };
  return { ...rest, sessionId };
}
// Codex's exec stream carries no limit data; the thread's rollout file does. Read after the process exits.
export function postRun(job) { return codexAllowanceFromRollout(codexRolloutFile(job.sessionId)); }
