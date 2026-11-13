// Issue #1166: what a job of one type typically costs an agent, as a share of that agent's weekly window and of its short window.
// Pure functions over one agent's job history: tokens per job divided by that agent's capacity, so a job that is cheap in tokens on one plan
// and dear on another compares fairly. With too little history a configured default share is used and the note says so.
import { tokensOf, isWeekly } from './capacity.mjs';

export const CHOICE_DEFAULTS = {
  min_samples: 3,
  short_per_weekly: 7,
  default_shares: { implement: 0.03, continue: 0.02, fix: 0.01, cifix: 0.01, rebase: 0.005, review: 0.01, inbox: 0.005 },
};
const FALLBACK_SHARE = 0.01;
const RECENT_JOBS = 10;

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Recent finished jobs of one kind that spent tokens, newest first.
const recentOf = (jobs, kind) => (jobs || []).filter(j => (j.kind || 'job') === kind && tokensOf(j) > 0)
  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, RECENT_JOBS);

const windowsOf = job => {
  const windows = (job?.allowance?.windows || []).filter(w => Number.isFinite(w.utilization) && Number.isFinite(w.resetsAt));
  const weekly = windows.filter(isWeekly).sort((a, b) => b.utilization - a.utilization)[0];
  const short = windows.filter(w => !isWeekly(w)).sort((a, b) => b.utilization - a.utilization)[0];
  return weekly && short ? { at: job.allowance.observedAt, weekly, short } : null;
};

// How much of the short window a unit of weekly use takes: the median, over consecutive readings inside one weekly and one short window, of
// the short rise divided by the weekly rise. Null until `min` such pairs exist.
export function shortPerWeekly(jobs, min) {
  const readings = (jobs || []).map(windowsOf).filter(r => r && Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const ratios = [];
  for (let i = 1; i < readings.length; i++) {
    const [a, b] = [readings[i - 1], readings[i]];
    const sameWindows = a.weekly.resetsAt === b.weekly.resetsAt && a.short.resetsAt === b.short.resetsAt;
    const weeklyRise = b.weekly.utilization - a.weekly.utilization, shortRise = b.short.utilization - a.short.utilization;
    if (sameWindows && weeklyRise > 0 && shortRise > 0) ratios.push(shortRise / weeklyRise);
  }
  return ratios.length >= min ? median(ratios) : null;
}

// { weekly, short, source, note }: `source` is 'history' when enough jobs of this type ran and the capacity is known, else 'default'.
export function expectedShare({ jobs, kind, capacity, settings = {} }) {
  const options = { ...CHOICE_DEFAULTS, ...settings, default_shares: { ...CHOICE_DEFAULTS.default_shares, ...(settings.default_shares || {}) } };
  const recent = recentOf(jobs, kind), known = Number.isFinite(capacity) && capacity > 0;
  const ratio = shortPerWeekly(jobs, options.min_samples) ?? options.short_per_weekly;
  if (known && recent.length >= options.min_samples) {
    const weekly = median(recent.map(tokensOf)) / capacity;
    return { weekly, short: weekly * ratio, source: 'history', note: `median of the last ${recent.length} ${kind} jobs over this agent's capacity` };
  }
  const weekly = options.default_shares[kind] ?? FALLBACK_SHARE;
  const why = known ? `${recent.length} of ${options.min_samples} ${kind} jobs seen` : 'capacity unknown';
  return { weekly, short: weekly * ratio, source: 'default', note: `history too short (${why}); configured default share` };
}
