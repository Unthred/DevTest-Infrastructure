// Issue #448: a tick that does not run is recorded with its reason. It was silent: the cron job exited when a previous run still
// held a lock. The record is one JSON line per skip in <state root>/team/skipped-ticks.jsonl, capped, and shown on the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';

const MAX_LINES = 500;
const file = root => path.join(root, 'team', 'skipped-ticks.jsonl');
export const SKIP_WINDOW_MS = 3600000;
export function recordSkip(root, reason, now = Date.now()) {
  const f = file(root); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.appendFileSync(f, `${JSON.stringify({ at: now, reason: redact(String(reason || 'no reason given'), 200) })}\n`, { mode: 0o600 });
  try {
    if (fs.statSync(f).size > 100000) { const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(f, `${lines.slice(-MAX_LINES / 2).join('\n')}\n`, { mode: 0o600 }); }
  } catch { /* the record is best effort */ }
}
export function readSkips(root, sinceMs = 0) {
  try {
    return fs.readFileSync(file(root), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(s => s && Number.isFinite(s.at) && typeof s.reason === 'string' && s.at >= sinceMs);
  } catch { return []; }
}
export const skipsPerHour = (root, now = Date.now()) => readSkips(root, now - SKIP_WINDOW_MS).length;
