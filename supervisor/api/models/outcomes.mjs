// Issue #1307: the outcomes model, GET /api/v1/outcomes?hours=N. For a time window (1 to 168 hours, default 24), which issues and pull
// requests had activity, the pegs each passed or bounced off in order, its laps and the bin it stands in. Built per request from the
// retained timeline and the dashboard view; no timer, nothing stored. Install is not a peg: Foreman records no install event per pull
// request, so this model cannot place one (see docs/api-contract.md). The mapping and the bin order live in supervisor/outcomes.mjs.
import { readTimeline } from '../../history.mjs';
import { buildOutcomes } from '../../outcomes.mjs';
import { badRequest } from '../router.mjs';

export const name = 'outcomes';
export const path = 'outcomes';
export const schema = 'outcomes.schema.json';

export const DEFAULT_HOURS = 24;
export const MIN_HOURS = 1;
export const MAX_HOURS = 168;
const HOUR_MS = 3600000;
const WHOLE_NUMBER = /^[0-9]{1,3}$/;
const iso = ms => new Date(ms).toISOString();

// An absent value is the default; anything but a whole number from 1 to 168 is refused.
export function hoursOf(query) {
  if (!Object.hasOwn(query, 'hours')) return DEFAULT_HOURS;
  const value = query.hours;
  const hours = WHOLE_NUMBER.test(value) ? Number(value) : NaN;
  return hours >= MIN_HOURS && hours <= MAX_HOURS ? hours : null;
}

// The builder works in epoch milliseconds; the contract shows UTC ISO strings.
const itemOf = item => ({ ...item, steps: item.steps.map(s => ({ ...s, at: iso(s.at) })), last_at: iso(item.last_at) });

export function build(view, context) {
  const hours = hoursOf(context.query);
  if (hours === null) return badRequest('invalid_hours', `hours must be a whole number from ${MIN_HOURS} to ${MAX_HOURS}.`);
  const window = { startMs: context.now - hours * HOUR_MS, endMs: context.now };
  const result = buildOutcomes({
    entries: readTimeline(context.root), needsYou: view.panels?.needsYou, window, prs: view.prs, issues: view.issues,
  });
  return { window: { hours, start: iso(window.startMs), end: iso(window.endMs) }, ...result, items: result.items.map(itemOf) };
}
