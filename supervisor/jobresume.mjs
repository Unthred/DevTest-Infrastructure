// The checks before a paused, blocked or failed job is resumed, shared by the homeowner's approved `resume_job` action (issue #629) and the overseer's
// direct `start_job` (issue #1164), so the two cannot drift apart. Throws a SupervisorError with the reason; returns nothing when resuming is allowed.
import { SupervisorError } from './core.mjs';
import * as breaker from './breaker.mjs';

export const RESUMABLE = ['paused_manual', 'paused_limit', 'blocked', 'failed'];

// `target` is the id as the caller named it (it appears in the messages). `roleOf` maps a job kind to its provider role. `allowed` is the set of
// statuses this caller may resume (the undo of a direct stop adds 'stopped').
export async function checkResumable(team, { target, rec, job }, roleOf, allowed = RESUMABLE) {
  if (!allowed.includes(job.status)) throw new SupervisorError(`job ${target} is ${job.status}, not resumable`);
  if (typeof team.jobs.resume !== 'function') throw new SupervisorError('this supervisor cannot resume a job');
  const pr = rec.pr != null ? (await team.gh.listPulls()).find(p => p.number === rec.pr) : null;
  if (rec.pr != null && (!pr || (rec.head && pr.headRefOid !== rec.head))) {
    throw new SupervisorError(`PR #${rec.pr} is closed or has a newer head, so job ${target} cannot be resumed to any purpose; close it instead`);
  }
  if (team.limitedOf(rec.agent)?.out) throw new SupervisorError(`${rec.agent} is out of allowance; resume it after the reset`);
  // Issue #713: the same rule as resumeTransient (issue #549).
  if (breaker.blocks(team.s.breaker, team.c.breaker, { type: rec.kind, issue: rec.issue ?? null })) {
    throw new SupervisorError(`the circuit breaker has halted new ${rec.kind} jobs; resume the breaker first`);
  }
  const provider = job.provider ?? team.c.agents[rec.agent]?.provider;
  if (await team.providerRoleFull(provider, roleOf(rec.kind))) throw new SupervisorError('the provider has no free slot for this role right now');
}
