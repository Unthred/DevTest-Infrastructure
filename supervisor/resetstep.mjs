// Issue #1162: the dispatcher's limit reset step. Runs after planning so the planner's per-agent hold texts say whether work is queued. Best effort for the
// tick: the caller's guard records a failure and moves on. A homeowner with no recorded reset and no earlier notice costs one file read.
import { budgetView } from './budgetview.mjs';
import { readResets } from './limitresets.mjs';
import { adviceByAgent } from './resetsbuild.mjs';
import { readNotices, tickResets } from './resetnotices.mjs';

export function limitResetStep(team) {
  if (!team.root || !team.modes) return;
  const records = readResets(team.root);
  if (!records.length && !Object.keys(readNotices(team.root).notices).length) return;
  const now = team.clock.now();
  const budget = budgetView(team);
  const byAgent = adviceByAgent({ records, config: team.c, budget, jobs: team.usage?.jobs || [], allowance: team.usage?.allowance || {}, now });
  tickResets({ root: team.root, byAgent, records, budget, now });
}
