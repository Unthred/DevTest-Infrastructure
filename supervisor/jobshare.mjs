// Issue #1345: expected cost of a job from plain history and configuration.
// This module is pure: callers provide one agent's completed jobs and capacity.

export const DEFAULT_JOB_SHARE = {
  minSamples: 3,
  shortPerWeekly: 7,
  shares: {
    implement: 0.03,
    fix: 0.01,
    cifix: 0.01,
    rebase: 0.005,
    review: 0.01,
    inbox: 0.005,
  },
};

const RECENT_JOB_LIMIT = 10;
const FALLBACK_WEEKLY_SHARE = 0.01;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function settingsOf(settings) {
  return {
    ...DEFAULT_JOB_SHARE,
    ...settings,
    shares: { ...DEFAULT_JOB_SHARE.shares, ...(settings?.shares ?? {}) },
  };
}

function validTokens(job) {
  return Number.isFinite(job?.tokens) && job.tokens > 0;
}

function recentJobs(jobs, type) {
  return (jobs ?? [])
    .filter(job => job?.type === type && validTokens(job))
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))
    .slice(0, RECENT_JOB_LIMIT);
}

function ratioSamples(readings) {
  const sorted = [...readings]
    .filter(reading => Number.isFinite(reading?.at))
    .sort((left, right) => left.at - right.at);
  const samples = [];
  for (let index = 1; index < sorted.length; index++) {
    const before = sorted[index - 1];
    const after = sorted[index];
    const sameWindow = before.weekly?.resetsAt === after.weekly?.resetsAt
      && before.short?.resetsAt === after.short?.resetsAt;
    const weeklyRise = after.weekly?.used - before.weekly?.used;
    const shortRise = after.short?.used - before.short?.used;
    if (sameWindow && weeklyRise > 0 && shortRise > 0) samples.push(shortRise / weeklyRise);
  }
  return samples;
}

// Learn how much short-window share one weekly-share unit usually consumes.
export function shortPerWeekly(readings = [], minSamples = DEFAULT_JOB_SHARE.minSamples) {
  const samples = ratioSamples(readings);
  return samples.length >= minSamples ? median(samples) : null;
}

// The median of the latest ten jobs of one type divided by that agent's capacity.
// A configured default is returned with a visible note until enough history exists.
export function expectedShare({ jobs = [], readings = [], type, capacity, settings = {} }) {
  const configured = settingsOf(settings);
  const recent = recentJobs(jobs, type);
  const usableCapacity = Number.isFinite(capacity) && capacity > 0;
  const weeklyDefault = configured.shares[type] ?? FALLBACK_WEEKLY_SHARE;
  const learnedRatio = shortPerWeekly(readings, configured.minSamples);
  const shortRatio = learnedRatio ?? configured.shortPerWeekly;

  if (usableCapacity && recent.length >= configured.minSamples) {
    const weekly = median(recent.map(job => job.tokens)) / capacity;
    return {
      weekly,
      short: weekly * shortRatio,
      source: 'history',
      note: `median of the last ${recent.length} ${type} jobs over capacity; ${learnedRatio === null ? 'configured' : 'learned'} short ratio`,
    };
  }

  const history = usableCapacity
    ? `${recent.length} of ${configured.minSamples} ${type} jobs seen`
    : 'capacity is missing or invalid';
  return {
    weekly: weeklyDefault,
    short: weeklyDefault * shortRatio,
    source: 'default',
    note: `history too short (${history}); configured default share; ${learnedRatio === null ? 'configured' : 'learned'} short ratio`,
  };
}
