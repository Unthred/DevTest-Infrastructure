// Issue #1162: when a reset's advice turns to use now or use before expiry, ONE Needs you item is raised for that reset, at most once per weekly window.
// It closes itself when the reset is marked used or the condition lapses, and a closed item is not raised again in the same window (no nagging).
// `planNotices` and `detectDrop` are pure; `tickResets` is the only part that reads or writes files (the tick calls it).
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';
import { NOTIFY_VERDICTS } from './resetsview.mjs';
import { appendTimeline } from './history.mjs';

const HOUR = 3600000;
// A weekly use that falls by this much inside the same window can only be a reset applied (use never goes down otherwise).
export const RESET_DROP = 0.2;
const SAME_WINDOW_MS = 10 * 60000;

const seenFile = root => path.join(root, 'team', 'resets-seen.json');
export const windowKeyOf = resetsAt => (Number.isFinite(resetsAt) ? String(Math.round(resetsAt / HOUR)) : 'none');

export function readSeen(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenFile(root), 'utf8'));
    return { readings: parsed?.readings || {}, notices: parsed?.notices || {} };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { readings: {}, notices: {} };
    throw error;
  }
}

// Which notices are open now. A notice is kept per reset: { window, status: 'open' | 'closed', openedAt, closedAt?, closedBecause? }.
export function planNotices({ notices, advice, windowKeys, now }) {
  const next = {};
  const byId = new Map(advice.map(item => [item.id, item]));
  for (const [id, notice] of Object.entries(notices)) {
    const current = byId.get(id);
    if (notice.status !== 'open') {
      next[id] = notice;
      continue;
    }
    const why = !current ? 'the reset was marked used or removed' : !NOTIFY_VERDICTS.has(current.verdict) ? 'the condition lapsed' : null;
    next[id] = why ? { ...notice, status: 'closed', closedAt: now, closedBecause: why } : notice;
  }
  for (const item of advice) {
    if (!NOTIFY_VERDICTS.has(item.verdict)) continue;
    const window = windowKeys[item.agent] ?? 'none';
    if (next[item.id]?.window === window) continue;
    next[item.id] = { window, status: 'open', openedAt: now, verdict: item.verdict };
  }
  return next;
}

export function detectDrop(previous, current) {
  if (!previous || !Number.isFinite(current?.used) || !Number.isFinite(current?.resetsAt)) return null;
  const sameWindow = Math.abs(previous.resetsAt - current.resetsAt) <= SAME_WINDOW_MS;
  return sameWindow && previous.used - current.used >= RESET_DROP ? { from: previous.used, to: current.used } : null;
}

const pct = value => `${Math.round(value * 100)}%`;

// The tick's step: close or open notices, and record "limit reset applied" for a sharp drop without the window rolling over.
export function tickResets({ root, resets, budget, now }) {
  const seen = readSeen(root);
  const advice = Object.values(resets.agents).flatMap(agent => agent.advice);
  const windowKeys = Object.fromEntries(Object.entries(budget || {}).map(([name, view]) => [name, windowKeyOf(view.resetsAt)]));
  const events = [];
  for (const [name, view] of Object.entries(budget || {})) {
    const reading = { used: view.used, resetsAt: view.resetsAt, at: now };
    const drop = detectDrop(seen.readings[name], reading);
    if (drop) events.push({ id: `limit-reset:${name}:${now}`, at: now, kind: 'limit_reset', agent: name, event: 'applied', detail: `limit reset applied: weekly use fell from ${pct(drop.from)} to ${pct(drop.to)} without the window rolling over` });
    if (Number.isFinite(view.used) && Number.isFinite(view.resetsAt)) seen.readings[name] = reading;
  }
  const notices = planNotices({ notices: seen.notices, advice, windowKeys, now });
  atomicJson(seenFile(root), { version: 1, readings: seen.readings, notices });
  if (events.length) appendTimeline(root, events);
  return { events, notices };
}

