import * as base from './base.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { claudeAllowance } from '../allowance.mjs';
import { safeEnvironment } from '../core.mjs';
import { oneLine, summarizeInput } from '../transcript.mjs';
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
// Transcript schema (issue #123): the Claude stream-json shapes mapped to common entries. Thinking blocks are not recorded.
// `state` is per run: the same assistant message id can appear on several lines and its usage is counted once.
const blockText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x?.type === 'text' ? x.text : '')).filter(Boolean).join('\n') : '');
export function transcript(line, state = {}) {
  let o; try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return [];
  const out = [];
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b?.type === 'text' && String(b.text || '').trim()) out.push({ kind: 'assistant', text: b.text });
      else if (b?.type === 'tool_use') out.push({ kind: 'tool_call', tool: b.name, text: summarizeInput(b.input), detail: typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 1) });
    }
    const u = o.message.usage, id = o.message.id;
    if (u && id && !(state.seen ||= new Set()).has(id)) {
      state.seen.add(id);
      const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
      out.push({ kind: 'usage', text: '', tokens: { in: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens), out: n(u.output_tokens) } });
    }
  } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) if (b?.type === 'tool_result') out.push({ kind: 'tool_result', text: blockText(b.content), error: b.is_error === true });
  } else if (o.type === 'result' && o.is_error === true) out.push({ kind: 'system', error: true, text: oneLine(o.result || o.error?.message || o.subtype || 'error', 1000) });
  else if (o.type === 'error') out.push({ kind: 'system', error: true, text: oneLine(o.error?.message || o.error || o.message || 'error', 1000) });
  return out;
}
