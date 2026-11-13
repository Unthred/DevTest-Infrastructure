// Issue #1162: when a reset's advice turns to use now or use before expiry, ONE Needs you item is raised for that reset, at most once per weekly window.
// It closes itself when the reset is marked used or the condition lapses, and a closed item is not raised again in the same window (no nagging).
// `planNotices` is pure; `readNotices` and `tickResets` are the only parts that touch a file (the tick calls `tickResets`).
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';
import { NOTIFY_VERDICTS } from './resetadvice.mjs';

const HOUR = 3600000;
const noticeFile = root => path.join(root, 'team', 'reset-notices.json');
export const windowKeyOf = resetsAt => (Number.isFinite(resetsAt) ? String(Math.round(resetsAt / HOUR)) : 'none');

export function readNotices(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(noticeFile(root), 'utf8'));
    return { notices: parsed?.notices || {} };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { notices: {} };
    throw error;
  }
}

// Which notices are open now. A notice is kept per reset: { window, status: 'open' | 'closed', openedAt, closedAt?, closedBecause? }.
// `knownIds` are the ids of every stored reset: a closed notice for a reset that no longer exists is dropped.
export function planNotices({ notices, advice, windowKeys, knownIds, now }) {
  const next = {};
  const byId = new Map(advice.map(item => [item.id, item]));
  for (const [id, notice] of Object.entries(notices)) {
    const current = byId.get(id);
    if (notice.status !== 'open') {
      if (knownIds.has(id)) next[id] = notice;
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

// The tick's step: open and close the notices from the current advice, and save them.
export function tickResets({ root, byAgent, records, budget, now }) {
  const windowKeys = Object.fromEntries(Object.entries(budget || {}).map(([name, view]) => [name, windowKeyOf(view.resetsAt)]));
  const notices = planNotices({ notices: readNotices(root).notices, advice: Object.values(byAgent).flat(), windowKeys, knownIds: new Set(records.map(r => r.id)), now });
  atomicJson(noticeFile(root), { version: 1, notices });
  return notices;
}
