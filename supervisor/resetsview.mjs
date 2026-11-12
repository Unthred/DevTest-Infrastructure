// Issue #1159: what the Usage page shows about the limit resets the homeowner holds. Pure: the stored records, the models config, the
// budget view and the applied-reset events in; plain rows out. No clock, no file, no network.
import { expiryTime } from './limitresets.mjs';

export const EXPIRY_WARN_DAYS = 14;
const DAY = 86400000;
const HOUR = 3600000;
const LIMIT_LABEL = { weekly: 'weekly limit', five_hour: 'five-hour limit' };

// Every model name the agent's config can use, lower case: the job-type entries, strong, low and the review candidates.
export function modelsOf(config, agent) {
  const table = config?.models?.agents?.[agent] || {};
  const entries = Object.values(table).flatMap(e => (Array.isArray(e) ? e : [e]));
  return [...new Set(entries.map(e => (typeof e?.model === 'string' ? e.model.toLowerCase() : null)).filter(Boolean))];
}
// Whether a scope ('all' or a family such as fable) covers a model in the list. 'all' covers whatever model the agent runs.
export const scopeCovers = (scope, models) => scope === 'all' || models.some(m => m.includes(scope));

// Days left to the expiry (whole days, rounded up) and the colour: amber within 14 days, red once expired, none without an expiry.
export function expiryOf(expires, now) {
  const end = expiryTime(expires);
  if (end === null) return { expiresAt: null, daysLeft: null, severity: 'info', text: 'no expiry recorded' };
  if (end < now) return { expiresAt: end, daysLeft: 0, severity: 'action', text: `expired ${expires}` };
  // Calendar days: a reset that expires on the 8th has 0 days left on the 8th and 14 on the 25th before, whatever the hour.
  const daysLeft = Math.round((Date.parse(`${expires}T00:00:00Z`) - Math.floor(now / DAY) * DAY) / DAY);
  const severity = daysLeft <= EXPIRY_WARN_DAYS ? 'warning' : 'ok';
  return { expiresAt: end, daysLeft, severity, text: `expires ${expires}, ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` };
}

const tokensText = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const hoursText = h => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.max(1, Math.round(h))}h`);

// "Helps Foreman now": yes only when the scope covers a model Foreman runs for this agent AND the agent is held by allowance.
// Otherwise the reason. `budget` is the agent's budget view (mode, used, hoursLeft, capacity, shortWindow).
export function helpsForeman({ reset, models, budget, expiry, now }) {
  const no = why => ({ yes: false, text: why });
  if (reset.usedAt) return no('already used');
  if (expiry.severity === 'action') return no('expired');
  if (!scopeCovers(reset.scope, models)) {
    return no(`covers ${reset.scope} only; Foreman runs ${models.length ? models.join(' and ') : 'no model set in its config'}`);
  }
  if (!budget || budget.mode === 'normal') return no('Foreman is not held by allowance now, so a reset would free nothing');
  if (reset.limit === 'five_hour') {
    const left = budget.shortWindow?.resetsAt > now ? (budget.shortWindow.resetsAt - now) / HOUR : null;
    const resets = left === null ? '' : ` resets in ${hoursText(left)}`;
    return { yes: true, text: `yes: Foreman is held (${budget.label || budget.mode}); the five-hour window${resets}; tokens restored not known` };
  }
  const cap = budget.capacity?.capacity;
  const restore = Number.isFinite(cap) && Number.isFinite(budget.used) ? cap * budget.used : null;
  const upTo = reset.scope === 'all' ? 'about' : 'up to about';
  const size = restore === null ? 'tokens restored not known (no learned capacity yet)' : `${upTo} ${tokensText(restore)} tokens restored`;
  const left = Number.isFinite(budget.hoursLeft) ? `; ${hoursText(budget.hoursLeft)} to the natural weekly reset, which a reset does not move` : '';
  return { yes: true, text: `yes: Foreman is held (${budget.label || budget.mode}); ${size}${left}` };
}

// The view for the card: per agent with at least one record or applied event, its available resets, used resets and applied events.
export function resetsView({ resets, config, budget, applied, agents, now }) {
  const byAgent = {};
  for (const r of resets) {
    if (!agents.includes(r.agent)) continue;
    const models = modelsOf(config, r.agent);
    const expiry = expiryOf(r.expires, now);
    const row = { id: r.id, agent: r.agent, limit: r.limit, limitLabel: LIMIT_LABEL[r.limit] || r.limit, scope: r.scope, expires: r.expires, ...expiry,
      usedAt: r.usedAt ?? null, helps: helpsForeman({ reset: r, models, budget: budget?.[r.agent], expiry, now }) };
    (byAgent[r.agent] ||= { resets: [], applied: [] }).resets.push(row);
  }
  for (const [agent, events] of Object.entries(applied || {})) {
    if (events.length && agents.includes(agent)) (byAgent[agent] ||= { resets: [], applied: [] }).applied = events;
  }
  return { agents, byAgent };
}
