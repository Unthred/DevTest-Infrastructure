// Interim review (D-021, issue #81): is an agent out of allowance? Provider-agnostic (D-012): only provider-reported
// allowance records and the supervisor's own job records count, never a guess. Pure; the caller supplies the data.
import { weeklyUtilization } from './models.mjs';

const EXHAUSTED = ['rejected', 'blocked', 'exhausted', 'limit_reached'];
const WEEK = 7 * 86400000;

// allowance: the provider's latest recorded allowance (dashdata latestAllowance), or null.
// jobs: supervisor job records. hadLimit(id): whether that job recorded a usage_limit event.
// Returns { out: boolean, reason?: string, until?: epoch ms | null }.
export function outOfAllowance({ provider, jobs = [], allowance = null, weeklyAt = 0.95, now = Date.now(), hadLimit = () => false }) {
  // Set when the provider's own record shows that every window it reported used up has since reset.
  let resetSince = null;
  if (allowance && Array.isArray(allowance.windows)) {
    const spent = allowance.windows.filter(w => (Number.isFinite(w.utilization) && w.utilization >= 1) || EXHAUSTED.includes(w.status));
    if (spent.length && spent.every(w => Number.isFinite(w.resetsAt) && w.resetsAt <= now)) resetSince = allowance.observedAt || 0;
    const live = w => !(Number.isFinite(w.resetsAt) && w.resetsAt <= now);
    const used = allowance.windows.filter(w => live(w) && ((Number.isFinite(w.utilization) && w.utilization >= 1) || EXHAUSTED.includes(w.status)));
    if (used.length) {
      const until = used.map(w => w.resetsAt).filter(Number.isFinite);
      return { out: true, reason: `${provider} reports a used-up ${used[0].type || 'allowance'} window`, until: until.length ? Math.max(...until) : null };
    }
    // A bare exhausted status counts only when the provider reported no windows to judge by.
    if (!allowance.windows.length && EXHAUSTED.includes(allowance.status) && now - (allowance.observedAt || 0) < WEEK)
      return { out: true, reason: `${provider} reports its allowance ${allowance.status}`, until: null };
    const weekly = weeklyUtilization(allowance, now);
    if (weekly !== null && weekly >= weeklyAt) return { out: true, reason: `${provider} weekly use ${Math.round(weekly * 100)}% >= ${Math.round(weeklyAt * 100)}%`, until: null };
  }
  // The provider's most recent supervised job: the freshest direct evidence, and the probe that clears this when it succeeds.
  const latest = jobs.filter(j => j && j.provider === provider).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  // A job paused on the limit that this same record reported (observed with or after the pause) is stale once that limit reset.
  const pausedOnResetLimit = latest && resetSince !== null && resetSince >= (latest.updatedAt || 0) - 300000;
  if (latest && now - (latest.updatedAt || 0) < WEEK && !pausedOnResetLimit) {
    const id = String(latest.id || '').slice(0, 8);
    if (latest.status === 'paused_limit' || (latest.status !== 'completed' && latest.lastEvent === 'usage_limit'))
      return { out: true, reason: `${provider} job ${id} is paused on a usage limit`, until: Number.isFinite(latest.resetAt) ? latest.resetAt : null };
    if (latest.status === 'blocked' && latest.lastEvent === 'retry_exhausted' && hadLimit(latest.id))
      return { out: true, reason: `${provider} job ${id} ran out of retries on usage limits`, until: null };
  }
  return { out: false };
}
