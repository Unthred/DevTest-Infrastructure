// Issue #1163: how old an allowance reading is, where it came from, which provider limit each figure belongs to, and whether a
// refresh is owed before a job is admitted. Pure functions over plain data: no clock, no file, no probe. The probe that carries a
// refresh out is probe.mjs; the tick that asks for it is team.probesDue.
import { isWeekly } from './capacity.mjs';

const MINUTE = 60000;
export const DEFAULT_READING_MAX_AGE_MINUTES = 60;
// A reading this young is not refreshed again just because the agent is near its reserve.
export const MIN_REFRESH_AGE_MS = 5 * MINUTE;
const SOURCE_TEXT = { job: 'job run', probe: 'probe', 'session-log': 'local session log' };

// Which provider limit one window is: the 5 hour session, the weekly limit over all models, or a weekly limit for one model.
export function limitKind(w) {
  const type = String(w?.type || '');
  if (type === 'five_hour' || w?.windowMinutes === 300) return { kind: 'session_5h', label: '5 hour session', detail: 'session limit' };
  const model = /^seven_day_(.+)$/.exec(type);
  if (model) return { kind: 'weekly_model', label: `weekly, ${model[1].replace(/_/g, ' ')} only`, detail: `${model[1].replace(/_/g, ' ')} only` };
  if (isWeekly(w)) return { kind: 'weekly_all', label: 'weekly, all models', detail: 'all models' };
  return { kind: 'other', label: type.replace(/_/g, ' ') || 'limit', detail: '' };
}

export const maxAgeMs = settings => (Number.isFinite(settings?.reading_max_age_minutes) ? settings.reading_max_age_minutes : DEFAULT_READING_MAX_AGE_MINUTES) * MINUTE;

// A reading with no usable time is as stale as one can be: its age is unknown, so it is never shown as current.
export const readingAgeMs = (allowance, now) => (Number.isFinite(allowance?.observedAt) && allowance.observedAt > 0 ? Math.max(0, now - allowance.observedAt) : null);
export const isStale = (allowance, now, settings) => {
  const age = readingAgeMs(allowance, now);
  return age === null || age >= maxAgeMs(settings);
};

// What the budget output and the Usage page show for one agent's reading. `limits` always names the 5 hour session, so a provider
// that does not report it reads "not reported" rather than saying nothing.
export function readingInfo(allowance, now, settings) {
  const age = readingAgeMs(allowance, now);
  const limits = (allowance?.windows || []).filter(w => Number.isFinite(w?.utilization))
    .map(w => ({ ...limitKind(w), used: w.utilization, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null, expired: Number.isFinite(w.resetsAt) && w.resetsAt <= now }));
  const session = limits.some(l => l.kind === 'session_5h');
  return { observedAt: age === null ? null : allowance.observedAt, ageMinutes: age === null ? null : Math.floor(age / MINUTE),
    source: allowance?.source || (allowance ? 'job' : null), sourceText: SOURCE_TEXT[allowance?.source || 'job'] || 'provider report', stale: !allowance || isStale(allowance, now, settings),
    maxAgeMinutes: Math.round(maxAgeMs(settings) / MINUTE), limits, sessionTracked: session };
}

// Is a refresh owed before the next admission on this agent? `capacity` is capacityFor's summary (belowReserve true when the remaining
// capacity has fallen to the reserve; basis 'percent' when no capacity is known, then the high-water share stands in for it).
// Returns { reason: 'stale' | 'reserve' } or null. A live used-up window is the caller's business (D-019: no provider call then).
export function refreshDue({ allowance, capacity = null, used = null, now, settings }) {
  if (isStale(allowance, now, settings)) return { reason: 'stale' };
  const near = capacity?.basis === 'absolute' ? capacity.belowReserve === true : Number.isFinite(used) && used >= (settings?.high_water ?? 0.85);
  return near && readingAgeMs(allowance, now) >= MIN_REFRESH_AGE_MS ? { reason: 'reserve' } : null;
}

// The fields the Usage page adds to one agent's card (see readingcard.mjs).
export function usageReading(allowance, now, settings) {
  const r = readingInfo(allowance, now, settings);
  const kinds = r.limits.map(l => l.label);
  return { stale: r.stale, maxAgeMinutes: r.maxAgeMinutes, sessionTracked: r.sessionTracked, kinds };
}

// Is any work waiting for an agent to take? The last pass's cache lists the open pull requests and issues. An idle repository owes no refresh.
export const workWaiting = cache => (cache?.pulls?.length || 0) + (cache?.issues?.length || 0) > 0;
