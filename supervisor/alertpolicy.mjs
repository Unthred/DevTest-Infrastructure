// Issue #634: when Foreman speaks. Three rules on top of the existing alert channel (alert.mjs):
//   1. alert only for Needs you items (one alert per cause group, never one per member) and for a watched item that reached a final state;
//   2. at most `max` alerts in any `windowMs`, and never the same item and cause twice (while it stays in Needs you);
//   3. one quiet daily summary: merged, failed, cost (usage equivalent) and the count still waiting on the homeowner.
// Pure functions plus one small state file, <state root>/team/alert-policy.json. No GitHub, no model, no network. A send that the rate
// limit refuses rejects, so callers that retry on rejection (the watchlist) simply try again on a later tick, and nothing is lost.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, SupervisorError } from './core.mjs';
import { redact } from './redact.mjs';

export const DEFAULT_LIMIT = { max: 5, windowMs: 3600000 };
export const SUMMARY_HOUR_UTC = 8;      // the summary is due once a day, from this hour (UTC) on
const DAY = 24 * 3600000;
const file = root => path.join(root, 'team', 'alert-policy.json');
const MAX_SEEN = 500;

// "homeowner-pr-538" -> "homeowner-pr" (the same grouping as foreman_needs_you).
export const causeOf = id => String(id || 'unknown').replace(/(-[0-9a-f]{6,}|-\d+)+$/i, '') || 'unknown';

export function readPolicy(root) {
  try {
    const v = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    return { sent: (Array.isArray(v.sent) ? v.sent : []).filter(Number.isFinite).slice(-200), seen: (Array.isArray(v.seen) ? v.seen : []).filter(s => typeof s === 'string').slice(-MAX_SEEN), summaryDay: typeof v.summaryDay === 'string' ? v.summaryDay : null };
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return { sent: [], seen: [], summaryDay: null }; throw error; }
}
const writePolicy = (root, p) => { fs.mkdirSync(path.dirname(file(root)), { recursive: true, mode: 0o700 }); atomicJson(file(root), p); };

// Wrap a sender (text => Promise) with the rate limit. Rejects with a SupervisorError when the limit is reached; only a delivered alert counts.
export function rateLimited(root, send, { now = () => Date.now(), limit = DEFAULT_LIMIT } = {}) {
  return async text => {
    const t = now(), p = readPolicy(root), recent = p.sent.filter(at => t - at < limit.windowMs);
    if (recent.length >= limit.max) throw new SupervisorError(`alert rate limit reached (${limit.max} per ${Math.round(limit.windowMs / 60000)} minutes)`);
    await send(redact(text, 600));
    writePolicy(root, { ...readPolicy(root), sent: [...recent, t] });
  };
}

// items: the Needs you cards ({ id, ref?, text, decision? }). One alert per cause group that has an item not alerted before.
export async function alertNeedsYou({ root, items = [], send }) {
  const p = readPolicy(root), current = new Map();
  for (const a of items) { if (a?.id) current.set(`${causeOf(a.id)}|${a.id}`, a); }
  const seen = new Set(p.seen.filter(k => current.has(k)));   // an item that left Needs you may alert again if it returns
  const groups = new Map();
  for (const [key, a] of current) { if (seen.has(key)) continue; const c = causeOf(a.id), g = groups.get(c) || []; g.push([key, a]); groups.set(c, g); }
  const sent = [];
  for (const [cause, members] of groups) {
    const total = [...current.keys()].filter(k => k.startsWith(`${cause}|`)).length, first = members[0][1];
    const refs = members.slice(0, 6).map(([, a]) => (a.ref?.n !== undefined ? `${a.ref.kind === 'issue' ? 'issue' : 'PR'} #${a.ref.n}` : null)).filter(Boolean);
    const text = `Needs the homeowner: ${total === 1 ? '1 item' : `${total} items`} (${cause})${refs.length ? ` — ${refs.join(', ')}${members.length > refs.length ? ' …' : ''}` : ''}. ${redact(first.decision || first.text || 'Decide how to proceed.', 240)}`;
    try { await send(text); for (const [key] of members) seen.add(key); sent.push(cause); }
    catch { break; }   // refused or failed: the rest wait for a later tick
  }
  writePolicy(root, { ...readPolicy(root), seen: [...seen].slice(-MAX_SEEN) });
  return { sent, waiting: items.length };
}

// What a free-text alert from Team or SelfUpgrade is. 'covered': a per-item "Needs the homeowner" text; the item is a Needs you card, so
// alertNeedsYou sends it once per cause group. 'informational': Foreman handles it itself (allowance mode, upgrades, skipped or retried
// upgrades). Both are dropped (reported as delivered, so callers do not retry). Everything else is an actionable alert.
export const INFORMATIONAL = /^Allowance:|^Supervisor upgraded to |flaky:|^Supervisor self-upgrade skipped|^Supervisor upgrade to \S+ not done:/;
export const classifyAlert = text => /needs the homeowner/i.test(text) ? 'covered' : INFORMATIONAL.test(text) ? 'informational' : 'actionable';
// The one sender for Team and SelfUpgrade: only actionable alerts get through, and they share the rate limit.
export function policySender(root, send, opts) {
  const limited = rateLimited(root, send, opts);
  return async text => { if (classifyAlert(String(text)) !== 'actionable') return; await limited(text); };
}

// The facts for a day ending at `now`. jobs: job records; mergeLog: Foreman's merge log; waiting: the Needs you count.
export function summarise({ jobs = [], mergeLog = [], waiting = 0, now }) {
  const from = now - DAY, inDay = v => Number.isFinite(v) && v > from && v <= now;
  const day = jobs.filter(j => inDay([j?.updatedAt, j?.createdAt].find(Number.isFinite)));
  const merged = mergeLog.filter(m => inDay(m.mergedAt)).length, failed = day.filter(j => j.status === 'failed').length;
  const cost = day.reduce((s, j) => s + (Number.isFinite(j.usage?.costUsdEstimate) ? j.usage.costUsdEstimate : 0), 0);
  return { merged, failed, cost: Math.round(cost * 100) / 100, waiting };
}
export const summaryText = s => `Foreman daily summary: ${s.merged} merged, ${s.failed} failed, cost $${s.cost.toFixed(2)} (usage equivalent), ${s.waiting} waiting on you.`;

// Sent at most once per UTC calendar day, from SUMMARY_HOUR_UTC. A refused or failed send is retried on a later tick.
export async function dailySummary({ root, now, facts, send }) {
  const d = new Date(now), day = d.toISOString().slice(0, 10), p = readPolicy(root);
  if (p.summaryDay === day || d.getUTCHours() < SUMMARY_HOUR_UTC) return { sent: false };
  try { await send(summaryText(summarise({ ...facts, now }))); } catch { return { sent: false }; }
  writePolicy(root, { ...readPolicy(root), summaryDay: day });
  return { sent: true };
}
