// Issue #1116: the one place allowance is computed in real capacity (the provider readings themselves are read in allowance.mjs). Pure functions over plain data: no clock, no file, no network.
//
// The providers report a percentage of a weekly window, but the plans differ hugely (15 percent of one is a day or two of
// implementing, 15 percent of another a few hours), so a percentage cannot be compared across agents. Each agent therefore gets
// a weekly capacity in one common unit (tokens): learned from history as tokens spent divided by the rise in its reported weekly
// use over the same period, smoothed over the latest windows, or an optional configured starting value per agent.
//
//   remaining = capacity x (1 - used)
//   reserve   = what the open pull requests are projected to need before the reset (reviews and fixes, from job history)
//               plus a margin; an agent whose remaining capacity falls to the reserve is reviews-only.
//
// Without a trusted capacity nothing here guesses: the caller falls back to the fixed high-water share and says so.

export const isWeekly = w => /^seven_day|week/.test(w?.type || '') || (Number.isFinite(w?.windowMinutes) && w.windowMinutes >= 10000);

export const ALLOWANCE_DEFAULTS = { reserve_margin: 0.05, capacity_windows: 4, min_window_delta: 0.03, min_trusted_windows: 2 };
const RESET_TOLERANCE_MS = 10 * 60000;
const RECENT_JOBS_PER_KIND = 10;

const tokensOf = job => (job?.usage ? (job.usage.inputTokens || 0) + (job.usage.outputTokens || 0) : 0);
const sameReset = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= RESET_TOLERANCE_MS;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// A usage figure is a fraction of the window. Negative, missing or non-numeric figures are refused with the reason; above 1 is read as used up.
export function checkUsage(used) {
  if (used === null || used === undefined) return { ok: false, reason: 'the weekly usage figure is missing' };
  if (typeof used !== 'number' || !Number.isFinite(used)) return { ok: false, reason: 'the weekly usage figure is not a number' };
  if (used < 0) return { ok: false, reason: 'the weekly usage figure is negative' };
  return { ok: true, used: Math.min(used, 1) };
}

// Per weekly window: the tokens of the jobs that ran between two readings and the rise in use across them.
// Interactive use between readings also raises the use, so the capacity learned this way errs low, never high.
export function capacitySamples(jobs) {
  const readings = [];
  for (const job of jobs || []) {
    const at = job?.allowance?.observedAt;
    if (!Number.isFinite(at)) continue;
    const windows = (job.allowance.windows || []).filter(w => isWeekly(w) && Number.isFinite(w.utilization) && Number.isFinite(w.resetsAt));
    const weekly = windows.sort((a, b) => b.utilization - a.utilization)[0];
    if (weekly) readings.push({ at, used: weekly.utilization, resetsAt: weekly.resetsAt, tokens: tokensOf(job) });
  }
  readings.sort((a, b) => a.at - b.at);
  const perWindow = [];
  for (let i = 1; i < readings.length; i++) {
    const delta = readings[i].used - readings[i - 1].used;
    // A fall in use, including an applied limit reset (issue #1159), has a negative delta and is skipped here, so it never feeds capacity.
    if (!sameReset(readings[i].resetsAt, readings[i - 1].resetsAt) || readings[i].tokens <= 0 || delta <= 0) continue;
    let entry = perWindow.find(w => sameReset(w.resetsAt, readings[i].resetsAt));
    if (!entry) perWindow.push(entry = { resetsAt: readings[i].resetsAt, tokens: 0, delta: 0 });
    entry.tokens += readings[i].tokens;
    entry.delta += delta;
  }
  return perWindow.sort((a, b) => a.resetsAt - b.resetsAt);
}

// Capacity in tokens per week. Trusted only from at least `min_trusted_windows` windows that each moved far enough to be a signal;
// one window, however clean, is not trusted alone (it falls back to the configured starting value).
export function learnCapacity({ jobs, configured = null, options = ALLOWANCE_DEFAULTS }) {
  const usable = capacitySamples(jobs).filter(w => w.delta >= options.min_window_delta).slice(-options.capacity_windows);
  const start = Number.isFinite(configured) && configured > 0 ? configured : null;
  if (usable.length >= options.min_trusted_windows) {
    const tokens = usable.reduce((s, w) => s + w.tokens, 0), delta = usable.reduce((s, w) => s + w.delta, 0);
    const each = usable.map(w => w.tokens / w.delta), spread = Math.max(...each) / Math.min(...each);
    const confidence = usable.length >= 3 && spread <= 2 ? 'high' : 'medium';
    return { capacity: tokens / delta, source: 'learned', confidence, windows: usable.length, note: `learned from ${usable.length} weekly windows (${confidence} confidence)` };
  }
  const why = usable.length ? 'only one usable weekly window so far, not trusted alone' : 'no usable history yet';
  if (start !== null) {
    return { capacity: start, source: 'configured', confidence: 'low', windows: usable.length, note: `configured starting value (${why})` };
  }
  return { capacity: null, source: 'none', confidence: 'none', windows: usable.length, note: `no capacity known (${why}, no starting value configured)` };
}

// Tokens one review and one fix round typically cost, from the latest finished jobs of each kind (null when none ran yet).
export function typicalTokens(jobs, kind) {
  const done = (jobs || []).filter(j => (j.kind || 'job') === kind && tokensOf(j) > 0).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return median(done.slice(0, RECENT_JOBS_PER_KIND).map(tokensOf));
}

// Tokens the open pull requests are projected to need before the reset: one review and one fix round each.
export function projectedNeed({ jobs, openPrs }) {
  const count = Number.isSafeInteger(openPrs) && openPrs > 0 ? openPrs : 0;
  return count * ((typicalTokens(jobs, 'review') || 0) + (typicalTokens(jobs, 'fix') || 0));
}

// One agent's real-capacity view. `basis` is 'absolute' when a capacity is known, else 'percent': the caller then applies the fixed
// high-water share and `reason` says why. `belowReserve` is null when it cannot be told.
export function summarise({ used, jobs, openPrs, configured = null, options = ALLOWANCE_DEFAULTS }) {
  const usage = checkUsage(used);
  const learned = learnCapacity({ jobs, configured, options });
  const base = { used: usage.ok ? usage.used : null, capacity: learned.capacity, capacitySource: learned.source, confidence: learned.confidence, windows: learned.windows,
    remaining: null, need: null, reserve: null, belowReserve: null, basis: 'percent' };
  if (!usage.ok) return { ...base, reason: `${usage.reason}; the fixed share rule applies` };
  if (learned.capacity === null) return { ...base, reason: `${learned.note}; the fixed share rule applies` };
  const remaining = learned.capacity * (1 - usage.used), need = projectedNeed({ jobs, openPrs });
  const reserve = need + learned.capacity * options.reserve_margin;
  const result = { ...base, basis: 'absolute', remaining, need, reserve, belowReserve: remaining <= reserve, reason: learned.note };
  return { ...result, text: describe(result) };
}

// Ranking score per agent, higher is better. In the common unit when every agent has a capacity: remaining relative to need (the
// median remaining stands in for the scale, so an agent with no open work still orders by what it has left). When any agent has
// no capacity the percentages are all there is, and the old spare-share score (1 - projected use) is used for everyone.
export function headroomScores(entries) {
  const absolute = entries.length > 0 && entries.every(e => e.summary?.basis === 'absolute');
  if (!absolute) return Object.fromEntries(entries.map(e => [e.agent, e.legacy ?? 0]));
  const scale = median(entries.map(e => e.summary.remaining)) || 1;
  return Object.fromEntries(entries.map(e => [e.agent, e.summary.remaining / (e.summary.need + scale)]));
}

const tokensText = n => (Number.isFinite(n) ? (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`) + ' tokens' : 'unknown');
// "42% used of about 6.0M tokens a week (learned from 3 weekly windows); 3.5M left, reserve 0.4M"
export function describe(s) {
  if (!s || s.basis !== 'absolute') return s?.reason || 'capacity unknown';
  return `${Math.round(s.used * 100)}% used of about ${tokensText(s.capacity)} a week (${s.reason}); ${tokensText(s.remaining)} left, reserve ${tokensText(s.reserve)}`;
}

// The figures the dashboard and the MCP tools show per agent: used percent, learned capacity, remaining capacity, reserve amount, and why.
export function capacityView(s) {
  if (!s) return null;
  const round = n => (Number.isFinite(n) ? Math.round(n) : null);
  return { basis: s.basis, usedPercent: Number.isFinite(s.used) ? Math.round(s.used * 1000) / 10 : null, capacity: round(s.capacity), source: s.capacitySource, confidence: s.confidence, windows: s.windows,
    remaining: round(s.remaining), reserve: round(s.reserve), need: round(s.need), belowReserve: s.belowReserve, text: s.text ?? s.reason };
}

// One agent's capacity summary for a tick: the weekly use of its live window (null when unknown), its job history and the open pull requests that
// `owns` accepts (each is projected to need a review and a fix round before the reset). `settings` carries the optional starting capacity and reserve margin.
export function capacityFor({ name, used, jobs, settings, prs, owns }) {
  const options = { ...ALLOWANCE_DEFAULTS, reserve_margin: settings.reserve_margin ?? ALLOWANCE_DEFAULTS.reserve_margin };
  const openPrs = (prs || []).filter(owns).length;
  return summarise({ used, jobs, openPrs, configured: settings.starting_capacity?.[name] ?? null, options });
}

// The one definition of remaining capacity: capacity x unused share, where `used` may include cost already planned this tick.
export const remainingOf = (capacity, used) => capacity * (1 - used);

// Whether the cheaper model is kept: remaining capacity is within twice the reserve (what the open work needs plus the margin). Null when the
// capacity is not known, so the caller keeps the percentage threshold it has today.
export const lowOnCapacity = s => (s?.basis === 'absolute' ? s.remaining <= 2 * s.reserve : null);

// Takeover goes to the agent with the most remaining capacity relative to its need. `agents` lists { agent, mode, summary, legacy, eligible }
// in config order; true when another eligible agent scores strictly higher. Only when every capacity is known, so the comparison is in the
// common unit and never in percentages.
export function betterTaker(agent, agents) {
  if (!agents.every(a => a.summary?.basis === 'absolute')) return false;
  const scores = headroomScores(agents);
  return agents.some(a => a.agent !== agent && a.eligible && scores[a.agent] > scores[agent]);
}

// `candidates` are plain rows { agent, summary, legacy, eligible } in config order, built by the dispatcher (eligible: it may take work over now).
export const spareScoreOf = (candidates, agent) => headroomScores(candidates)[agent] ?? 0;
// True when `agent` may take over implementation work: no other eligible agent has more headroom.
export const mayTakeFrom = (candidates, agent) => !betterTaker(agent, candidates);

// How the review choice names an agent's headroom: its remaining capacity when known, else the old percentage estimate.
export function figure(name, m) {
  if (m?.capacity?.basis === 'absolute') return `${name} ${Math.round(m.capacity.remaining / 1000)}k tokens left`;
  return m?.known && Number.isFinite(m.projected) ? `${name} estimate ${Math.round(m.projected * 100)}% at its reset` : `${name} reading unknown`;
}
