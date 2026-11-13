// Issue #1162: advice on each limit reset the homeowner holds. A pure decision over plain data: no clock, file or network.
//
// A reset sets a limit back to full but does not move the window's natural reset time, so its value falls the nearer that time is: only what
// Foreman could spend before the natural reset is worth restoring. Per reset the verdict is one of
//   use_now | hold | lost_cause | use_before_expiry
// and the figures behind it are always given: tokens restored, tokens Foreman could spend at full pace before the natural reset, that usable
// share, and the hours left. Only the homeowner can apply a reset (claude.ai); Foreman advises.
import { tokensText } from './capacitycheck.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MIN_FIVE_HOUR_LEFT = 2;
const HELD_MODES = new Set(['reviews_only', 'waiting']);

const round = value => (Number.isFinite(value) ? Math.round(value) : null);
const percent = share => `${Math.round(share * 100)}%`;
const spanText = hours => (hours >= 48 ? `${Math.round(hours / 24 * 10) / 10} days` : `${Math.max(0, Math.round(hours * 10) / 10)} hours`);

const isWeeklyType = type => /^seven_day|week|secondary/.test(type || '');
const scopeMatches = (scope, model) => scope === 'all' || String(model).toLowerCase().includes(scope);
export const modelsInScope = (scope, models) => (models || []).filter(model => scopeMatches(scope, model));

// What is holding the agent back, from its allowance mode: 'five_hour' (the short window is used up), 'weekly' (reserve, reviews only or exhausted), or null.
export function heldBy(view, exhaustedAt, now) {
  const short = view.shortWindow;
  if (short && short.used >= exhaustedAt && short.resetsAt > now) return 'five_hour';
  if (HELD_MODES.has(view.mode) || view.capacity?.belowReserve === true) return 'weekly';
  return null;
}

const figures = ({ restore = null, spendable = null, hoursLeft = null }) => ({
  restoreTokens: round(restore),
  spendableTokens: round(spendable),
  usableShare: Number.isFinite(restore) && restore > 0 && Number.isFinite(spendable) ? Math.min(1, spendable / restore) : null,
  hoursLeft: Number.isFinite(hoursLeft) ? Math.max(0, Math.round(hoursLeft * 10) / 10) : null,
});

const verdict = (kind, why, fig = figures({}), extra = {}) => ({ verdict: kind, why, figures: fig, ...extra });

// Hours of full-pace work whose tokens equal `share` of what the reset restores: the point from which "held" makes it worth using.
const hoursForShare = (share, restore, pace) => (pace > 0 ? (share * restore) / pace : null);

function judgeWeekly(rec, ctx) {
  const { view, window, capacity, pace, settings, held, queued } = ctx;
  const label = rec.scope === 'all' ? 'weekly' : `weekly ${rec.scope}`;
  if (!window) return verdict('hold', `${rec.scope === 'all' ? 'the weekly window is not reported' : `the provider reports no ${rec.scope} window, so this scope cannot be measured`}`);
  const hoursLeft = (window.resetsAt - ctx.now) / HOUR;
  if (!(capacity > 0)) return verdict('hold', `the ${label} capacity is not learned yet, so what a reset would restore cannot be sized`, figures({ hoursLeft }));
  const restore = capacity * window.used;
  if (!(pace > 0)) return verdict('hold', 'no job history yet to measure how fast Foreman spends', figures({ restore, hoursLeft }));
  const fig = figures({ restore, spendable: pace * hoursLeft, hoursLeft });
  const share = fig.usableShare;
  const facts = `would restore ${tokensText(restore)}; Foreman could spend ${tokensText(fig.spendableTokens)} at full pace in ${spanText(hoursLeft)} (${percent(share ?? 0)} usable)`;
  if (!(restore > 0)) return verdict('hold', `nothing is used in the ${label} window, so a reset restores nothing`, fig);
  const needHours = hoursForShare(settings.usable_share, restore, pace);
  const wait = needHours ? `worth it when held with about ${spanText(needHours)} to go` : 'worth it when held with more of the window to go';
  if (!held) return verdict('hold', `${view.name} is not held by its allowance; ${wait}`, fig);
  if (held !== 'weekly') return verdict('hold', `${view.name} is held by its five hour window, which a weekly reset does not lift`, fig);
  if (!queued) return verdict('hold', `${view.name} has no queued work waiting; ${wait}`, fig);
  if (share < settings.usable_share) return verdict('hold', `a reset ${facts}; below ${percent(settings.usable_share)}; ${wait}`, fig);
  return verdict('use_now', `held by allowance with work queued; a reset ${facts}`, fig);
}

function judgeFiveHour(rec, ctx) {
  const { view, window, capacity, pace, settings, held, now } = ctx;
  if (!window) return verdict('hold', rec.scope === 'all' ? 'the five hour window is not reported' : `the provider reports no ${rec.scope} five hour window, so this scope cannot be measured`);
  const hoursLeft = (window.resetsAt - now) / HOUR;
  const weeklyRoom = capacity > 0 && Number.isFinite(view.used) ? capacity * (1 - view.used) : null;
  const rawSpend = pace > 0 ? pace * hoursLeft : null;
  const spendable = rawSpend !== null && weeklyRoom !== null ? Math.min(rawSpend, weeklyRoom) : rawSpend;
  const fig = figures({ spendable, hoursLeft });
  const heldHere = rec.scope === 'all' ? held === 'five_hour' : window.used >= settings.exhausted_at;
  if (!heldHere) return verdict('hold', `${view.name} is not held by its five hour window; worth it when that window is used up with at least ${MIN_FIVE_HOUR_LEFT} hours left`, fig);
  if (hoursLeft < MIN_FIVE_HOUR_LEFT) return verdict('hold', `only ${spanText(hoursLeft)} of the five hour window remain; worth it with at least ${MIN_FIVE_HOUR_LEFT} hours left`, fig);
  if (!Number.isFinite(view.used)) return verdict('hold', 'the weekly window is not reported, so it is not known to have room', fig);
  if (view.used >= settings.exhausted_at) return verdict('hold', `the weekly window is used up (${percent(view.used)}), so a five hour reset would free nothing`, fig);
  return verdict('use_now', `held by its five hour window with ${spanText(hoursLeft)} left and the weekly window at ${percent(view.used)}`, fig);
}

// The expiry rules, applied on top of the verdict for a reset that can lapse.
function withExpiry(rec, base, ctx) {
  const left = Number.isFinite(rec.expiry) ? rec.expiry - ctx.now : null;
  if (left === null) return { ...base, expiring: false, daysToExpiry: null };
  const expiring = left <= ctx.settings.expiry_warn_days * DAY;
  const daysToExpiry = Math.max(0, Math.floor(left / DAY));
  if (left <= 0) return { ...verdict('lost_cause', 'this reset has expired', base.figures), expiring: false, daysToExpiry: 0, expired: true };
  const lapsesFirst = left <= Math.max(0, ctx.nextUsefulAt - ctx.now);
  if (base.verdict === 'hold' && lapsesFirst) {
    return { ...base, verdict: 'use_before_expiry', why: `it lapses in ${spanText(left / HOUR)}, before the advice expects it to be worth using; ${base.why}`, expiring, daysToExpiry };
  }
  if (base.verdict === 'lost_cause' && expiring) {
    return { ...base, verdict: 'use_before_expiry', why: `${base.why}. It lapses in ${spanText(left / HOUR)}: use it for your own work or lose it`, expiring, daysToExpiry };
  }
  return { ...base, expiring, daysToExpiry };
}

// "3 left, 17 weeks: one every 5 weeks keeps them all" for several resets of one kind (null for a single one). The earliest expiry sets the deadline.
export function spacingText(group, now) {
  const dated = group.filter(r => Number.isFinite(r.expiry) && r.expiry > now);
  if (group.length < 2 || dated.length !== group.length) return null;
  const days = (Math.min(...dated.map(r => r.expiry)) - now) / DAY;
  const every = Math.floor(days / group.length);
  const span = days >= 14 ? `${Math.round(days / 7)} weeks` : `${Math.floor(days)} days`;
  if (every < 1) return `${group.length} left, ${span}: they lapse faster than one a day; use them as soon as each helps`;
  const gap = every >= 7 ? `${Math.floor(every / 7)} week${Math.floor(every / 7) === 1 ? '' : 's'}` : `${every} day${every === 1 ? '' : 's'}`;
  return `${group.length} left, ${span}: one every ${gap} keeps them all`;
}

// One agent's advice. `view` is its budget view; `windows` are the provider's reported windows (for model scoped resets); `models` are the model names in its config.
export function adviseAgent({ records, name, view, windows = [], models = [], pace = null, settings, now }) {
  const available = records.filter(r => r.agent === name && r.state === 'available');
  const held = heldBy(view, settings.exhausted_at, now);
  const queued = Object.keys(view.held || {}).length > 0;
  const capacity = view.capacity?.capacity ?? null;
  const weekly = Number.isFinite(view.used) && Number.isFinite(view.resetsAt) ? { used: view.used, resetsAt: view.resetsAt } : null;
  const short = view.shortWindow && Number.isFinite(view.shortWindow.resetsAt) ? view.shortWindow : null;
  const nextUsefulAt = weekly?.resetsAt ?? now + 7 * DAY;
  return available.map(rec => {
    const base = { name, view: { ...view, name }, capacity, pace, settings, held, queued, now };
    let advice;
    if (rec.scope !== 'all' && !modelsInScope(rec.scope, models).length) {
      advice = verdict('lost_cause', `does not help Foreman: no ${rec.scope} model is in ${name}'s model config, so Foreman's jobs never spend it`);
    } else {
      const scoped = rec.scope === 'all' ? null : windows.filter(w => Number.isFinite(w.resetsAt) && w.resetsAt > now && Number.isFinite(w.utilization) && String(w.type).toLowerCase().includes(rec.scope));
      const pick = limit => (scoped ? scoped.find(w => isWeeklyType(w.type) === (limit === 'weekly')) : null);
      const scopedWindow = pick(rec.limit);
      const window = scoped ? (scopedWindow && { used: scopedWindow.utilization, resetsAt: scopedWindow.resetsAt }) : rec.limit === 'weekly' ? weekly : short && { used: short.used, resetsAt: short.resetsAt };
      const ctx = { ...base, window };
      advice = rec.limit === 'weekly' ? judgeWeekly(rec, ctx) : judgeFiveHour(rec, ctx);
    }
    const group = available.filter(r => r.limit === rec.limit && r.scope === rec.scope);
    return { id: rec.id, agent: name, limit: rec.limit, scope: rec.scope, expiry: rec.expiry, ...withExpiry(rec, advice, { now, settings, nextUsefulAt }), spacing: spacingText(group, now) };
  });
}

// The verdicts that raise a Needs you item.
export const NOTIFY_VERDICTS = new Set(['use_now', 'use_before_expiry']);
