// Issue #1162: an agent's full pace in tokens per hour of work, from its job history. Pure.
// Pace is tokens spent divided by the hours at least one job was running (overlapping jobs count once), so idle gaps do not lower it:
// the question a reset asks is what Foreman could spend if it kept working until the natural reset.
const HOUR = 3600000;
const LOOKBACK_MS = 14 * 24 * HOUR;
const MIN_BUSY_HOURS = 1;

const tokensOf = job => (job?.usage ? (job.usage.inputTokens || 0) + (job.usage.outputTokens || 0) : 0);

function mergedHours(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of sorted) {
    const start = Math.max(from, end);
    if (to > start) total += to - start;
    end = Math.max(end, to);
  }
  return total / HOUR;
}

export function fullPace(jobs, provider, now) {
  const mine = (jobs || []).filter(job => job?.provider === provider && tokensOf(job) > 0 && Number.isFinite(job.createdAt)
    && job.createdAt >= now - LOOKBACK_MS && Number.isFinite(job.updatedAt ?? job.createdAt) && (job.updatedAt ?? job.createdAt) > job.createdAt);
  const busy = mergedHours(mine.map(job => [job.createdAt, job.updatedAt]));
  const tokens = mine.reduce((sum, job) => sum + tokensOf(job), 0);
  return busy >= MIN_BUSY_HOURS && tokens > 0 ? tokens / busy : null;
}
