// Issue #1159: limit resets the homeowner applied on a provider plan, found in the stored tick snapshots, and where they are put:
// the Usage page's card (withLimitResets) and the history timeline (limitResetEntries, appended by the tick). One detection rule,
// resetdetect.mjs. Reads local files only.
import fs from 'node:fs';
import path from 'node:path';
import { weeklyHistory } from './budget.mjs';
import { appliedResets } from './resetdetect.mjs';
import { readResets } from './limitresets.mjs';
import { resetsView } from './resetsview.mjs';

const percent = f => `${Math.round(f * 100)}%`;

// { agent: [applied reset events] } for the agents that had any, from snapshots ({ at, allowance: { agent: reading } }).
export function appliedByAgent(snapshots, agents) {
  const out = {};
  for (const agent of agents) {
    const events = appliedResets(weeklyHistory(snapshots, agent));
    if (events.length) out[agent] = events;
  }
  return out;
}

function readSnapshotLines(root) {
  const out = [];
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, 'dashboard', 'snapshots.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('allowance')) continue;
    try { out.push(JSON.parse(line)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return out;
}

// Timeline entries (kind limit_reset). The id is stable, so a pass that sees the same event again adds nothing.
export function limitResetEntries({ root, config }) {
  const events = appliedByAgent(readSnapshotLines(root), Object.keys(config?.agents || {}));
  return Object.entries(events).flatMap(([agent, list]) => list.map(e => ({ id: `limitreset:${agent}:${e.at}`, at: e.at, kind: 'limit_reset', agent,
    detail: `limit reset applied: weekly use fell from ${percent(e.from)} to ${percent(e.to)} inside one window` })));
}

// Adds view.limitResets for the Usage page. A degraded view without a budget gets none.
export function withLimitResets(view, { root, config, snapshots, now }) {
  if (!view || !view.budget) return view;
  const agents = Object.keys(config?.agents || {});
  view.limitResets = resetsView({ resets: readResets(root), config, budget: view.budget, applied: appliedByAgent(snapshots, agents), agents, now });
  for (const a of Object.values(view.limitResets.byAgent)) for (const row of a.resets) row.advice = view.resetAdvice?.[row.id] ?? null;   // issue #1162
  return view;
}
