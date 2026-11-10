// Effects for dashboard-approved choices. Team owns the tick and persistence; this
// module only makes the small, rechecked state transition an action requires.
import { SupervisorError } from './core.mjs';
import { requestBreakerResume } from './breakerresume.mjs';

export async function applyDecisionAction(team, action, number, reason) {
  if (action === 'new_review_attempt') return team.grantReviewAttempt(number, reason);
  if (action === 'extra_fix_round') return grantFixRound(team, number, reason);
  if (action === 'clear_retry_cap') return team.clearRetryCap(number, reason);
  if (action === 'park') return parkWork(team, number);
  if (action === 'resume_breaker') {
    requestBreakerResume(team.root, 'all', team.clock.now());
    return 'requested that the next tick resumes the circuit breaker';
  }
  if (action === 'merge') return mergePull(team, number, reason);
  if (action === 'approve' || action === 'review_verdict') return recordPullOverride(team, action, number, reason);
  return null;
}

async function parkWork(team, number) {
  const pull = (await team.gh.listPulls()).find(p => p.number === number);
  if (pull) {
    await team.gh.addLabel(number, 'needs-homeowner');
    return `PR #${number} is parked until the homeowner removes its needs-homeowner label`;
  }
  await team.gh.addLabel(number, 'parked');
  return `issue #${number} is parked until the homeowner removes its parked label`;
}

async function mergePull(team, number, reason) {
  const pull = (await team.gh.listPulls()).find(p => p.number === number);
  if (!pull) throw new SupervisorError(`PR #${number} is not open`);
  if (typeof team.gh.merge !== 'function') throw new SupervisorError('this supervisor cannot merge pull requests');
  await team.gh.merge(number, pull.headRefOid);
  team.logUnblock({}, { target: number, tk: 'pull', what: 'merged the pull request', why: `homeowner approved on the dashboard: ${reason}`, result: 'merged' });
  return `PR #${number} was merged`;
}

function recordPullOverride(team, action, number, reason) {
  const key = `${number}:${team.clock.now()}`;
  team.s.homeownerOverrides ||= {};
  team.s.homeownerOverrides[key] = { action, pr: number, reason, at: team.clock.now() };
  team.save();
  return `recorded the homeowner ${action.replace('_', ' ')} override for PR #${number}`;
}

export async function grantFixRound(team, number, reason) {
  const pr = (await team.gh.listPulls()).find(p => p.number === number);
  if (!pr) throw new SupervisorError(`PR #${number} is not open`);
  if (team.fixCount(number) < team.c.limits.max_fix_attempts) throw new SupervisorError(`PR #${number} still has fix rounds left; nothing to grant`);
  if (team.escalationPending(number, pr)) throw new SupervisorError(`PR #${number} cannot start another ordinary fix round yet`);
  if (team.carriedHold(pr)) {
    const key = `${number}:${pr.headRefOid}`;
    delete team.s.verdicts[key];
  }
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
