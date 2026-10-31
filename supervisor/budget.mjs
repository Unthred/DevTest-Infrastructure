// Allowance-aware scheduling (issue #56). Pure functions over what the providers themselves reported (the allowance record
// each job stores), the supervisor's own job records (token counts) and the dashboard snapshot history. No model call, no
// GitHub call, no write. Provider-agnostic (D-012): nothing here names a provider.
//
// Per agent and tick it computes the weekly burn (used, time to reset, rate, projection at reset) and a scheduling mode:
//   normal        every job type may start;
//   reviews_only  only reviews and fixes on the agent's own PRs (review, fix, cifix, rebase); no implement or continue.
//                 Its unstarted implementation work may go to an agent with headroom. Latched until the weekly reset.
//   waiting       nothing starts: a window is used up, or the provider reports paid overage in use. Waits for the reset.
// Paid overage and credits are never enabled or relied on: an agent that has nothing left waits.
import { SupervisorError } from './core.mjs';

export const HOUR = 3600000;
export const DEFAULT_BUDGET = { enabled: true, projected_limit: 1, high_water: 0.85, high_water_min_hours: 24, recent_hours: 24, exhausted_at: 0.995 };
export const REVIEWS_ONLY_TYPES = new Set(['review', 'fix', 'cifix', 'rebase']);
const WEEK_MINUTES = 10080;
const EXHAUSTED_STATUS = ['rejected', 'blocked', 'exhausted', 'limit_reached'];
const KEYS = ['enabled', 'projected_limit', 'high_water', 'high_water_min_hours', 'recent_hours', 'exhausted_at', 'can_take_over'];

export function validateBudgetConfig(b, agentNames) {
  if (b === undefined) return;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SupervisorError('invalid budget config');
  const bad = Object.keys(b).find(k => !KEYS.includes(k));
  if (bad) throw new SupervisorError(`invalid budget config: unknown key ${bad}`);
  const num = (k, lo, hi) => { if (k in b && !(Number.isFinite(b[k]) && b[k] >= lo && b[k] <= hi)) throw new SupervisorError(`invalid budget config: ${k}`); };
  if ('enabled' in b && typeof b.enabled !== 'boolean') throw new SupervisorError('invalid budget config: enabled');
  num('projected_limit', 0.5, 1.5); num('high_water', 0.5, 1); num('high_water_min_hours', 0, 168); num('recent_hours', 1, 168); num('exhausted_at', 0.9, 1);
  if ('can_take_over' in b && !(Array.isArray(b.can_take_over) && b.can_take_over.every(n => agentNames.includes(n))))
    throw new SupervisorError('invalid budget config: can_take_over must list configured agents');
}
export const budgetSettings = config => ({ ...DEFAULT_BUDGET, ...(config?.budget || {}) });
// Whether an agent's role lets it take another agent's implementation work. Default: every agent may.
export const mayTakeOver = (config, agent) => (Array.isArray(config?.budget?.can_take_over) ? config.budget.can_take_over.includes(agent) : true);

export const isWeekly = w => /^seven_day|week/.test(w?.type || '') || (Number.isFinite(w?.windowMinutes) && w.windowMinutes >= 10000);
const live = (allowance, now) => (allowance?.windows || []).filter(w => Number.isFinite(w.utilization) && Number.isFinite(w.resetsAt) && w.resetsAt > now);
const top = ws => [...ws].sort((a, b) => b.utilization - a.utilization)[0] || null;
// The weekly window that matters (the most used one when a provider reports several), or null when unknown or already reset.
export const weeklyWindow = (allowance, now) => top(live(allowance, now).filter(isWeekly));
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sameReset = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 10 * 60000;
const tokens = j => (j?.usage ? (j.usage.inputTokens || 0) + (j.usage.outputTokens || 0) : 0);

// Weekly readings over time for one agent, from the dashboard snapshots (one per tick) plus the newest record.
export function weeklyHistory(snapshots, agent, current = null) {
  const out = new Map();
  const add = al => { const w = top((al?.windows || []).filter(x => isWeekly(x) && Number.isFinite(x.utilization) && Number.isFinite(x.resetsAt))); if (w && Number.isFinite(al.observedAt)) out.set(al.observedAt, { at: al.observedAt, used: w.utilization, resetsAt: w.resetsAt }); };
  for (const s of snapshots || []) add(s?.allowance?.[agent]);
  if (current) add(current);
  return [...out.values()].sort((a, b) => a.at - b.at);
}
// Recent burn in fraction-of-allowance per hour, from readings of the same weekly window over the last `hours`.
// Needs two readings at least two hours apart; otherwise null (the window average is used alone).
export function recentRate(history, resetsAt, now, hours) {
  const pts = history.filter(p => sameReset(p.resetsAt, resetsAt) && now - p.at <= hours * HOUR && p.at <= now);
  if (pts.length < 2) return null;
  const span = (pts.at(-1).at - pts[0].at) / HOUR;
  return span >= 2 ? Math.max(0, (pts.at(-1).used - pts[0].used) / span) : null;
}

// Estimated weekly fraction one job of `kind` costs, from recent tokens per job: (fraction per token) x (typical tokens).
// Fraction per token: the median, over this provider's finished jobs in the current weekly window, of the rise in reported
// weekly use since the previous job's reading divided by the job's tokens. Interactive use in between also counts, so the
// estimate errs high. Needs two such samples; otherwise null, and a null cost never blocks a job (nothing is "known").
export function jobCosts(jobs, weekly, now) {
  if (!weekly) return { perToken: null, typical: {}, cost: () => null };
  const windowStart = weekly.resetsAt - (weekly.windowMinutes || WEEK_MINUTES) * 60000;
  const readings = jobs.filter(j => j.allowance && Number.isFinite(j.allowance.observedAt) && j.allowance.observedAt >= windowStart && j.allowance.observedAt <= now)
    .map(j => ({ j, w: top((j.allowance.windows || []).filter(x => isWeekly(x) && Number.isFinite(x.utilization) && sameReset(x.resetsAt, weekly.resetsAt))) }))
    .filter(r => r.w).sort((a, b) => a.j.allowance.observedAt - b.j.allowance.observedAt);
  const samples = [];
  for (let i = 1; i < readings.length; i++) {
    const t = tokens(readings[i].j), d = readings[i].w.utilization - readings[i - 1].w.utilization;
    if (t > 0 && d >= 0) samples.push(d / t);
  }
  const perToken = samples.length >= 2 ? median(samples) : null;
  const done = jobs.filter(j => tokens(j) > 0).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const typical = {};
  for (const kind of new Set(done.map(j => j.kind || 'job'))) typical[kind] = median(done.filter(j => (j.kind || 'job') === kind).slice(0, 10).map(tokens));
  const any = median(done.slice(0, 10).map(tokens));
  return { perToken, typical, cost: kind => (perToken === null ? null : perToken * (typical[kind] ?? any ?? NaN)) || null };
}

const pct = v => `${Math.round(v * 100)}%`;
const hrs = h => (h >= 48 ? `${Math.round(h / 24 * 10) / 10} days` : `${Math.round(h)}h`);

// One agent's weekly burn and mode. `latched` is the mode the dispatcher recorded earlier this window (team state).
export function assessAgent({ allowance, jobs = [], history = [], settings = DEFAULT_BUDGET, now, latched = null }) {
  const out = { mode: 'normal', reason: null, until: null, known: false, used: null, resetsAt: null, hoursLeft: null, ratePerHour: null, rateSource: null, projected: null, runsOutAt: null,
    shortWindow: null, observedAt: allowance?.observedAt ?? null, overage: allowance?.billing?.usingOverage === true, creditsAvailable: allowance?.billing?.creditsAvailable === true, costs: { perToken: null, typical: {}, cost: () => null } };
  if (settings.enabled === false) { out.reason = 'allowance-aware scheduling is switched off'; return out; }
  if (!allowance || !Array.isArray(allowance.windows)) { out.reason = 'no allowance reported yet'; return out; }
  const windows = live(allowance, now), weekly = top(windows.filter(isWeekly)), short = top(windows.filter(w => !isWeekly(w)));
  if (short) out.shortWindow = { used: short.utilization, resetsAt: short.resetsAt };
  if (weekly) {
    const windowH = (weekly.windowMinutes || WEEK_MINUTES) / 60, hoursLeft = (weekly.resetsAt - now) / HOUR;
    const average = weekly.utilization / Math.max(1, windowH - hoursLeft);
    const recent = recentRate(history, weekly.resetsAt, now, settings.recent_hours);
    const rate = Math.max(average, recent ?? 0);
    Object.assign(out, { known: true, used: weekly.utilization, resetsAt: weekly.resetsAt, hoursLeft, ratePerHour: rate, rateSource: recent !== null && recent > average ? 'recent' : 'window average',
      projected: weekly.utilization + rate * hoursLeft, runsOutAt: weekly.utilization >= 1 ? now : rate > 0 ? now + ((1 - weekly.utilization) / rate) * HOUR : null, costs: jobCosts(jobs, weekly, now) });
  } else out.reason = windows.length ? 'no weekly window reported' : 'no current allowance reading (window reset since the last report)';
  const fresh = windows.length > 0 || (Number.isFinite(out.observedAt) && now - out.observedAt < 7 * 24 * HOUR);
  const latest = windows.length ? Math.max(...windows.map(w => w.resetsAt)) : null;
  // waiting: nothing may start
  if (out.overage && fresh) return { ...out, mode: 'waiting', until: latest, reason: 'the provider reports paid overage in use; nothing starts (overage and credits are never used)' };
  if (weekly && weekly.utilization >= settings.exhausted_at) return { ...out, mode: 'waiting', until: weekly.resetsAt, reason: `weekly ${pct(weekly.utilization)}: used up; waits for the reset` };
  if (short && short.utilization >= settings.exhausted_at) return { ...out, mode: 'waiting', until: short.resetsAt, reason: `short window ${pct(short.utilization)}: used up; waits for its reset` };
  if (EXHAUSTED_STATUS.includes(allowance.status) && windows.length) return { ...out, mode: 'waiting', until: latest, reason: 'the provider reports the limit reached; waits for the reset' };
  if (!weekly) return out;
  // reviews_only: projected to run out before the reset, or at or above the high-water mark with more than a day to go
  const fig = `weekly ${pct(out.used)}, projected ${pct(out.projected)} at reset (${hrs(out.hoursLeft)} left, ${out.rateSource})`;
  if (out.projected > settings.projected_limit) return { ...out, mode: 'reviews_only', until: weekly.resetsAt, reason: `${fig}: runs out before the reset at the current rate` };
  if (out.used >= settings.high_water && out.hoursLeft > settings.high_water_min_hours) return { ...out, mode: 'reviews_only', until: weekly.resetsAt, reason: `${fig}: at or above ${pct(settings.high_water)} with more than ${settings.high_water_min_hours}h to go` };
  // Hysteresis: once reviews-only in a weekly window, stay so until that window resets ("ownership goes back at the reset").
  if (latched?.mode === 'reviews_only' && sameReset(latched.until, weekly.resetsAt)) return { ...out, mode: 'reviews_only', until: weekly.resetsAt, reason: `${latched.reason || fig}; held until the weekly reset` };
  return { ...out, reason: fig };
}

// Whether `agent` may start a job of `type`: its mode allows the type, and the estimated cost fits in what is left, keeping a
// reserve for the opposite-agent reviews still pending on it (reviews themselves draw on that reserve).
export function admits(a, type, pendingReviews = 0) {
  if (!a) return { ok: true };
  if (a.mode === 'waiting') return { ok: false, why: a.reason };
  if (a.mode === 'reviews_only' && !REVIEWS_ONLY_TYPES.has(type)) return { ok: false, why: `reviews only: ${a.reason}` };
  if (!a.known) return { ok: true };
  const cost = a.costs.cost(type), review = a.costs.cost('review');
  if (cost === null) return { ok: true };
  const reserve = type === 'review' ? 0 : pendingReviews * (review || 0);
  if (a.used + cost + reserve >= 1) return { ok: false, why: `a ${type} job (about ${pct(cost)} of the weekly allowance${reserve ? ` plus ${pct(reserve)} kept for ${pendingReviews} pending review(s)` : ''}) would run into the weekly limit at ${pct(a.used)}` };
  return { ok: true };
}

export const MODE_LABEL = { normal: 'normal', reviews_only: 'reviews only', waiting: 'waiting for reset' };
// "codex: reviews only until Wed 07:18 — weekly 92%, projected 184% at reset (3.5 days left, window average): …"
export function modeLine(agent, a, tz) {
  const when = a.until ? ` until ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(a.until)).replace(',', '')}` : '';
  return `${agent}: ${MODE_LABEL[a.mode]}${a.mode === 'normal' ? '' : when}${a.reason ? ` — ${a.reason}` : ''}`;
}
