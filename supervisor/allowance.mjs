// Structured allowance evidence from the provider CLIs themselves (issue #20).
// Shapes were captured from the installed CLIs on 2026-10-30:
//   Claude Code 2.1.314: a `rate_limit_event` stream-json line with `rate_limit_info`
//     { status, resetsAt (epoch s), rateLimitType, overageStatus, isUsingOverage, unifiedWindows{five_hour,seven_day:{utilization 0..1,resetsAt,status}} }
//   Codex CLI 0.165/0.166: the session rollout file records `token_count` events whose payload.rate_limits holds
//     { primary|secondary:{used_percent,window_minutes,resets_at (epoch s)}, credits:{has_credits,unlimited,balance}, plan_type, rate_limit_reached_type }
// Only the "allowed" / "not reached" states have been observed live. The exhausted-state values are NOT captured, so
// every limit derived here is `verified: false` and the manifests keep the capability `unverified`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const seconds = value => (Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null);
const fraction = value => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null);

export function claudeAllowance(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = [];
  for (const [type, w] of Object.entries(info.unifiedWindows || {})) {
    if (!/^[a-z_]{1,24}$/.test(type) || !w || typeof w !== 'object') continue;
    windows.push({ type, utilization: fraction(w.utilization), resetsAt: seconds(w.resetsAt), status: String(w.status || 'unknown').slice(0, 32) });
  }
  if (!windows.length && info.rateLimitType) windows.push({ type: String(info.rateLimitType).slice(0, 24), utilization: null, resetsAt: seconds(info.resetsAt), status: String(info.status || 'unknown').slice(0, 32) });
  return { provider: 'claude', status: String(info.status || 'unknown').slice(0, 32), windows, billing: { overageStatus: String(info.overageStatus || 'unknown').slice(0, 32), usingOverage: info.isUsingOverage === true } };
}

export function codexAllowance(limits) {
  if (!limits || typeof limits !== 'object') return null;
  const windows = [];
  for (const type of ['primary', 'secondary']) {
    const w = limits[type];
    if (!w || typeof w !== 'object') continue;
    windows.push({ type, windowMinutes: Number.isFinite(w.window_minutes) ? w.window_minutes : null, utilization: fraction(w.used_percent / 100), resetsAt: seconds(w.resets_at), status: 'unknown' });
  }
  const reached = typeof limits.rate_limit_reached_type === 'string' ? limits.rate_limit_reached_type.slice(0, 48) : null;
  return { provider: 'codex', status: reached ? 'limit_reached' : 'allowed', reachedType: reached, windows,
    billing: { creditsAvailable: limits.credits?.has_credits === true || limits.credits?.unlimited === true, usingOverage: false } };
}

// Evidence that the allowance is exhausted. Never invents a reset: with no future provider-reported time the caller
// gets resetAt null and the supervisor's bounded conservative backoff applies.
export function limitFromAllowance(allowance, now = Date.now()) {
  if (!allowance) return null;
  // Only evidence of exhaustion counts: a known exhausted status or a full window. An unfamiliar status is recorded on
  // the job but never claimed as a limit, so an unrelated failure cannot be misread as one.
  const known = ['rejected', 'blocked', 'exhausted', 'limit_reached'];
  const exhausted = allowance.windows.filter(w => (w.utilization !== null && w.utilization >= 1) || known.includes(w.status));
  const flagged = known.includes(allowance.status) || exhausted.length > 0;
  if (!flagged) return null;
  if (allowance.billing?.usingOverage) return { event: 'approval_required' };
  const times = (exhausted.length ? exhausted : allowance.windows).map(w => w.resetsAt).filter(t => t && t > now);
  const resetAt = times.length ? Math.max(...times) : null;
  return { event: 'usage_limit', resetAt, resetSource: resetAt ? 'provider_reported' : 'none', verified: false };
}

// Billing guard that applies even when the limit evidence itself is ambiguous: a run that failed while the account was
// spending beyond its subscription must never be retried automatically.
export function billingRisk(allowance) { return allowance?.billing?.usingOverage === true; }

// Codex: the rollout file of the thread is the only place the CLI records limits. Read its tail; never any message text.
export function codexRolloutFile(threadId, home = process.env.HOME || os.homedir(), now = Date.now()) {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(threadId || '')) return null;
  for (let back = 0; back < 3; back++) {
    const day = new Date(now - back * 86400000);
    const dir = path.join(home, '.codex', 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
    let names; try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const hit = names.find(n => n.startsWith('rollout-') && n.endsWith(`-${threadId}.jsonl`));
    if (hit) return path.join(dir, hit);
  }
  return null;
}
export function codexAllowanceFromRollout(file, tailBytes = 262144) {
  if (!file) return null;
  const size = fs.statSync(file).size, start = Math.max(0, size - tailBytes), fd = fs.openSync(file, 'r');
  let text;
  try { const buffer = Buffer.alloc(size - start); fs.readSync(fd, buffer, 0, buffer.length, start); text = buffer.toString('utf8'); } finally { fs.closeSync(fd); }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.includes('rate_limits')) continue;
    let record; try { record = JSON.parse(line); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (record?.payload?.type === 'token_count' && record.payload.rate_limits) found = record.payload.rate_limits;
  }
  return codexAllowance(found);
}
