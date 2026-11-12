// Issue #1178: one app bar item per configured agent showing its weekly and 5 hour allowance. Pure data first (allowanceItems), then
// the markup (allowanceStat); the page helpers are passed in (the resetscard pattern) so this module imports nothing from the renderer.
// The figures are the budget view's reading (budgetview.mjs), so the bar, the Usage page and the MCP agree. No agent name is in here:
// the items follow the agent list the view was built from.
import { DEFAULT_BUDGET } from './budget.mjs';

const WEEKLY_KINDS = ['weekly_all', 'weekly_model'];
const SHORT_KIND = 'session_5h';
export const LEVEL_TEXT = { normal: 'OK', high: 'High', near: 'Near limit' };
const LEVEL_MARK = { normal: '', high: '▲', near: '■' };

// Same thresholds as the scheduler: budget high_water for "high water", exhausted_at for "near exhausted".
export const levelOf = (used, limits = {}) => {
  const near = limits.exhaustedAt ?? DEFAULT_BUDGET.exhausted_at, high = limits.highWater ?? DEFAULT_BUDGET.high_water;
  return used >= near ? 'near' : used >= high ? 'high' : 'normal';
};

// One window of the reading as { state: 'known', used, level, resetsAt } or { state: 'unknown', reason }. An expired window (its reset
// time has passed) is unknown: the old figure no longer describes anything.
function windowFigure(reading, kinds, label, limits) {
  if (!reading) return { state: 'unknown', reason: 'no allowance reading yet' };
  const all = reading.limits.filter(l => kinds.includes(l.kind));
  if (!all.length) return { state: 'unknown', reason: `${label} limit not reported by the provider` };
  const live = all.filter(l => !l.expired).sort((a, b) => b.used - a.used);
  if (!live.length) return { state: 'unknown', reason: `${label} window has reset; no new reading yet` };
  return { state: 'known', used: live[0].used, level: levelOf(live[0].used, limits), resetsAt: live[0].resetsAt };
}

// `view` needs agents (name), budget (per agent), budgetLimits ({ highWater, exhaustedAt }). Returns one plain item per agent.
export function allowanceItems(view) {
  return (view.agents || []).map(a => {
    const reading = view.budget?.[a.name]?.reading ?? null;
    const seen = reading && reading.limits.length > 0;
    return {
      agent: a.name,
      weekly: windowFigure(seen ? reading : null, WEEKLY_KINDS, 'weekly', view.budgetLimits),
      short: windowFigure(seen ? reading : null, [SHORT_KIND], '5 hour', view.budgetLimits),
      seen: Boolean(seen),
      ageMinutes: seen ? reading.ageMinutes : null,
      stale: seen ? reading.stale === true : false,
      maxAgeMinutes: reading?.maxAgeMinutes ?? null
    };
  });
}

const span = (cls, inner, attrs = '') => `<span class="${cls}"${attrs}>${inner}</span>`;

const figure = (h, label, f) => {
  const attrs = ` data-window="${label.key}" data-state="${f.state}"`;
  const key = span('al-k', h.esc(label.text));
  if (f.state !== 'known') return span('al-win', `${key} ${span('al-unknown', `unknown: ${h.esc(f.reason)}`)}`, attrs);
  const mark = LEVEL_MARK[f.level] ? `${span('al-mark', LEVEL_MARK[f.level]).replace('<span ', '<span aria-hidden="true" ')} ` : '';
  const pct = `<b class="al-pct">${Math.round(f.used * 100)}%</b>`;
  const parts = [key, `${mark}${pct}`, span('al-lvl', LEVEL_TEXT[f.level]), span('al-reset', `resets ${h.lt(f.resetsAt)}`)];
  return span('al-win', parts.join(' '), `${attrs} data-level="${f.level}"`);
};

const ageText = (h, item) => {
  if (!item.seen) return '';
  const age = item.ageMinutes === null ? 'age unknown' : `read ${h.dur(item.ageMinutes * 60000)} ago`;
  if (!item.stale) return span('al-age muted', h.esc(age), ' data-stale="false"');
  return span('al-age', `${h.badge('warning', 'Stale')} ${h.esc(age)}`, ' data-stale="true"');
};

// The editable bar item for one agent (issue #927: data-bar and data-bar-name make it movable, removable and restorable).
export function allowanceStat(h, item) {
  const id = `allowance-${item.agent}`;
  const why = item.stale
    ? `The last reading is older than the ${item.maxAgeMinutes} minute limit and is not current.`
    : "Weekly and 5 hour allowance used, from the provider's latest reading.";
  const body = [
    `<b class="al-name">${h.esc(item.agent)}</b>`,
    figure(h, { key: 'weekly', text: 'Week' }, item.weekly),
    figure(h, { key: 'short', text: '5h' }, item.short),
    ageText(h, item)
  ].join('');
  const bar = `data-bar="${h.esc(id)}" data-bar-name="${h.esc(`Allowance: ${item.agent}`)}" data-agent="${h.esc(item.agent)}"`;
  return `<div class="stat allowance-item" ${bar}><a class="al-link" href="/usage" title="${h.esc(why)}">${body}</a></div>`;
}

export const allowanceStats = (h, view) => allowanceItems(view).map(item => allowanceStat(h, item)).join('\n');
