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
  // Captured live 2026-10-31 (Codex CLI 0.166.0, a supervised `codex exec` job that hit its limit): the rollout's last
  // rate_limits had `primary: null, secondary: null` and no reached type. That is no reading at all, so it is `unknown`,
  // never `allowed` (issue #75): an empty record must not pass for evidence of capacity.
  return { provider: 'codex', status: reached ? 'limit_reached' : windows.length ? 'allowed' : 'unknown', reachedType: reached, windows,
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

// A window whose provider-reported reset time has passed: its utilisation describes a window that no longer exists, so it
// is neither evidence of a limit nor of capacity (issue #75). The one rule every surface uses.
export const windowExpired = (w, now) => Number.isFinite(w?.resetsAt) && w.resetsAt > 0 && w.resetsAt <= now;
// A record that carries at least one window, i.e. an actual reading (an empty record only says "the CLI reported nothing").
export const hasReading = allowance => Array.isArray(allowance?.windows) && allowance.windows.length > 0;

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
function tailText(file, tailBytes) {
  const size = fs.statSync(file).size, start = Math.max(0, size - tailBytes), fd = fs.openSync(file, 'r');
  try { const buffer = Buffer.alloc(size - start); fs.readSync(fd, buffer, 0, buffer.length, start); return buffer.toString('utf8'); } finally { fs.closeSync(fd); }
}
// Every token_count rate_limits record in the tail, oldest first, with its own timestamp (ms or null). Never message text.
function rateLimitRecords(file, tailBytes) {
  const out = [];
  for (const line of tailText(file, tailBytes).split('\n')) {
    if (!line.includes('rate_limits')) continue;
    let record; try { record = JSON.parse(line); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (record?.payload?.type === 'token_count' && record.payload.rate_limits) {
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      out.push({ at: Number.isFinite(at) ? at : null, limits: record.payload.rate_limits });
    }
  }
  return out;
}
export function codexAllowanceFromRollout(file, tailBytes = 262144) {
  if (!file) return null;
  return codexAllowance(rateLimitRecords(file, tailBytes).at(-1)?.limits ?? null);
}

// Model-free periodic probe (issue #75). A paused agent runs no job, so its reading would never refresh. Codex records the
// account's rate_limits in the rollout of EVERY session on this host (supervised or interactive), so the newest reading is a
// bounded local file read: the newest few rollouts of the last two days, their tails only, the rate_limits counts only.
// observedAt is the record's own timestamp, so the age shown is the age of the reading, not of the probe. Returns null
// when no rollout holds a reading. Claude Code has no model-free source: its limits arrive only in a live stream.
export function codexAllowanceProbe({ home = process.env.HOME || os.homedir(), now = Date.now(), maxFiles = 12, tailBytes = 262144 } = {}) {
  const files = [];
  for (let back = 0; back < 2; back++) {
    const day = new Date(now - back * 86400000);
    const dir = path.join(home, '.codex', 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
    let names; try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    for (const n of names) {
      if (!/^rollout-[\w.-]{1,160}\.jsonl$/.test(n)) continue;
      const file = path.join(dir, n);
      let st; try { st = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (st.isFile()) files.push({ file, mtime: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let best = null;
  for (const { file, mtime } of files.slice(0, maxFiles)) {
    if (best && mtime < best.observedAt) break;          // an older file cannot hold a newer record
    for (const r of rateLimitRecords(file, tailBytes)) {
      const a = codexAllowance(r.limits), at = Math.min(r.at ?? mtime, now);
      if (hasReading(a) && (!best || at > best.observedAt)) best = { ...a, observedAt: at, source: 'session-log' };
    }
  }
  return best;
}
