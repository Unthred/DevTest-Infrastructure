// Issue #1162: the dispatcher's limit reset step. Runs after planning so the planner's per-agent hold texts say whether work is queued. Best effort for the
// tick: the caller's guard records a failure and moves on.
import fs from 'node:fs';
import path from 'node:path';
import { budgetView } from './budgetview.mjs';
import { readRecords } from './resetrecords.mjs';
import { resetsView } from './resetsview.mjs';
import { tickResets } from './resetnotices.mjs';

export function limitResetStep(team, report) {
  if (!team.root || !team.modes) return;
  const now = team.clock.now();
  const records = readRecords(team.root);
  const seenFile = path.join(team.root, 'team', 'resets-seen.json');
  if (!records.length && !fs.existsSync(seenFile)) return;   // nothing to advise on and no earlier reading to keep
  const budget = budgetView(team);
  const resets = resetsView({ records, budget, config: team.c, jobs: team.usage?.jobs || [], allowance: team.usage?.allowance || {}, now });
  const { events } = tickResets({ root: team.root, resets, budget, now });
  for (const event of events) (report.notified ||= []).push({ what: 'limit reset applied', agent: event.agent });
}
