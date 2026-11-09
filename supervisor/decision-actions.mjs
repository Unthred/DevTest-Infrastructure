// Effects for dashboard-approved choices. Team owns the tick and persistence; this
// module only makes the small, rechecked state transition an action requires.
import { SupervisorError } from './core.mjs';

export async function grantFixRound(team, number, reason) {
  const pr = (await team.gh.listPulls()).find(p => p.number === number);
  if (!pr) throw new SupervisorError(`PR #${number} is not open`);
  if (team.fixCount(number) < team.c.limits.max_fix_attempts) throw new SupervisorError(`PR #${number} still has fix rounds left; nothing to grant`);
  if (team.escalationPending(number, pr) || team.carriedHold(pr)) throw new SupervisorError(`PR #${number} cannot start another ordinary fix round yet`);
  const keys = Object.keys(team.s.fixAttempts).filter(k => k === String(number) || k.startsWith(`${number}:`)).sort().reverse();
  let excess = team.fixCount(number) - team.c.limits.max_fix_attempts + 1;
  for (const key of keys) {
    const used = Math.min(excess, team.s.fixAttempts[key]);
    team.s.fixAttempts[key] -= used;
    excess -= used;
    if (!excess) break;
  }
  team.save();
  team.logUnblock({}, {
    target: number,
    tk: 'pull',
    what: 'granted one more fix round',
    why: `homeowner approved on the dashboard: ${reason}`,
    result: 'the next tick may plan one ordinary fix round',
  });
  return `PR #${number} has room for one more fix round`;
}
