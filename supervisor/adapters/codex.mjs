import * as base from './base.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexAllowanceFromRollout, codexRolloutFile } from '../allowance.mjs';
import { oneLine } from '../transcript.mjs';
import { parseStatusWindow, parseTryAgain } from '../clocktext.mjs';
import { deliveredPolicy, policyPreflight } from '../policy.mjs';
const POLICY_DELIVERY = 'developer_instructions';
const profileFor = (job) => {
  const delivered = deliveredPolicy(job, 'codex', POLICY_DELIVERY);
  return delivered ? path.basename(delivered.artifact, '.config.toml') : `ai-rules-${base.contextForRole(job.role)}`;
};
export const capabilities = { resumeSession: true, usageReset: true };
export function preflight(job) {
  const status = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 10000 });
  if (status.error?.code === 'ENOENT') return 'not_found';
  if (status.status !== 0 || !/logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`)) return false;
  // The governed launcher validates its installed profile and the selected product root.
  const policy = policyPreflight(job, 'codex', POLICY_DELIVERY);
  if (policy !== true) return policy;
  const profile = profileFor(job);
  const env = profile.startsWith('ai-rules-project-') ? { ...process.env, AI_RULES_POLICY_PROFILE: profile } : process.env;
  const session = ['--session-name', base.contextForRole(job.role), job.worktree];
  const governed = spawnSync('/usr/local/bin/ai-rules-codex', session, { encoding: 'utf8', timeout: 15000, env });
  return governed.status === 0;
}
export function command(config, job, resume) {
  const args = [...config.command, 'exec', '--json', '--profile', profileFor(job), '--cd', job.worktree, ...base.accessArgs(config, job), ...base.modelArgs(config, job)];
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
// Transcript schema (issue #123): Codex `exec --json` items mapped to common entries. Reasoning items are not recorded.
export function transcript(line) {
  let o; try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return [];
  const it = o.item, n = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  if (o.type === 'turn.completed' && o.usage) return [{ kind: 'usage', text: '', tokens: { in: n(o.usage.input_tokens), out: n(o.usage.output_tokens) } }];
  if (o.type === 'turn.failed' || o.type === 'error') return [{ kind: 'system', error: true, text: oneLine(o.error?.message || o.message || o.error || 'error', 1000) }];
  if (!it || typeof it !== 'object') return [];
  if (o.type === 'item.completed' && it.type === 'agent_message' && String(it.text || '').trim()) return [{ kind: 'assistant', text: it.text }];
  if (it.type === 'command_execution') {
    if (o.type === 'item.started') return [{ kind: 'tool_call', callId: it.id, tool: 'shell', text: oneLine(it.command), detail: String(it.command || '') }];
    if (o.type === 'item.completed') return [{ kind: 'tool_result', callId: it.id, error: Number.isFinite(it.exit_code) && it.exit_code !== 0, text: `exit ${it.exit_code ?? '?'}\n${it.aggregated_output || ''}` }];
  }
  if (o.type === 'item.completed' && it.type === 'mcp_tool_call') return [{ kind: 'tool_call', tool: `${it.server || 'mcp'}.${it.tool || 'tool'}`, text: oneLine(JSON.stringify(it.arguments ?? {})), detail: JSON.stringify(it.arguments ?? {}, null, 1) }];
  if (o.type === 'item.completed' && it.type === 'file_change') return [{ kind: 'tool_call', tool: 'file_change', text: oneLine((it.changes || []).map(c => `${c.kind || 'change'} ${c.path || ''}`).join(', ')) }];
  if (o.type === 'item.completed' && it.type === 'web_search') return [{ kind: 'tool_call', tool: 'web_search', text: oneLine(it.query) }];
  return [];
}
