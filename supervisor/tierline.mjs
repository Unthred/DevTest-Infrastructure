// Issue #1417: the tier cut off when an agent's weekly allowance is short. Pure functions of an agent's weekly figures and the settings; nothing
// here reads or changes state. The cut off applies only to starting NEW implement work on an issue; work on an open pull request is never held.
import { SupervisorError } from './core.mjs';
import { readTier } from './tier.mjs';

// Defaults, overridable in budget.tier_line. "from" values are the first tier held; a share is a fraction of the week (0 to 1).
export const DEFAULT_TIER_LINE = { estimate_limit: 1, estimate_from_tier: 5, used_limit: 0.85, used_from_tier: 3, min_hours: 24 };
const KEYS = Object.keys(DEFAULT_TIER_LINE);
const SHARES = ['estimate_limit', 'used_limit'];
const TIERS = ['estimate_from_tier', 'used_from_tier'];
const pct = v => `${Math.round(v * 100)}%`;

export const tierLineSettings = settings => ({ ...DEFAULT_TIER_LINE, ...(settings?.tier_line || {}) });

// Refuses a malformed block at config load, with the key named.
export function validateTierLine(t) {
  if (t === undefined) return;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new SupervisorError('invalid budget config: tier_line');
  const bad = Object.keys(t).find(k => !KEYS.includes(k));
  if (bad) throw new SupervisorError(`invalid budget config: tier_line unknown key ${bad}`);
  for (const k of SHARES) if (k in t && !(Number.isFinite(t[k]) && t[k] >= 0 && t[k] <= 1)) throw new SupervisorError(`invalid budget config: tier_line.${k} must be a number from 0 to 1`);
  for (const k of TIERS) if (k in t && !(Number.isInteger(t[k]) && t[k] >= 0 && t[k] <= 6)) throw new SupervisorError(`invalid budget config: tier_line.${k} must be a whole tier from 0 to 6`);
  if ('min_hours' in t && !(Number.isFinite(t.min_hours) && t.min_hours >= 0 && t.min_hours <= 168)) throw new SupervisorError('invalid budget config: tier_line.min_hours must be 0 to 168');
}

// The cut off in force for one agent: { firstHeld, reason } where `firstHeld` is the lowest tier it may NOT start (null: none held).
// Both rules need more than min_hours to the weekly reset; the estimate rule needs the estimate strictly above its limit, the share rule
// needs the used share at or above its limit. When both apply the lower tier number wins. Unknown figures hold nothing (issue #680).
export function tierCutoff({ known, used, projected, hoursLeft }, cfg = DEFAULT_TIER_LINE) {
  const none = { firstHeld: null, reason: null };
  if (!known || !Number.isFinite(used) || !Number.isFinite(projected) || !Number.isFinite(hoursLeft) || hoursLeft <= cfg.min_hours) return none;
  const holds = [];
  if (projected > cfg.estimate_limit) holds.push({ from: cfg.estimate_from_tier, why: `the week would run out before its reset (estimate at reset ${pct(projected)})` });
  if (used >= cfg.used_limit) holds.push({ from: cfg.used_from_tier, why: `the week is ${pct(used)} used with more than ${cfg.min_hours}h to its reset` });
  if (!holds.length) return none;
  const first = holds.reduce((a, b) => (b.from < a.from ? b : a));
  return { firstHeld: first.from, reason: first.why };
}

// The hold text for an issue of `tier` on `agent`, or null when the agent may start it.
export function tierHold(cutoff, tier, agent) {
  if (!cutoff || cutoff.firstHeld === null || tier < cutoff.firstHeld) return null;
  return `waits for allowance: tier ${tier} is not started while ${agent}'s ${cutoff.reason}; tiers ${cutoff.firstHeld} to 6 wait`;
}

// One line for foreman_budget and the dashboard: the cut off in force, or that none is.
export function tierLineText(cutoff) {
  return cutoff?.firstHeld == null ? 'tier cut off: none (every tier may start)' : `tier cut off: tiers ${cutoff.firstHeld} to 6 wait (${cutoff.reason})`;
}

// Used by the planner before it starts new implement work on `issue` for `agent`: true when the cut off holds it, and the hold is recorded on the agent.
// Never asked for work on an open pull request, which the rule does not touch.
export function tierLineHeld(team, agent, issue) {
  const mode = team.modes?.[agent];
  if (mode?.mode !== 'normal') return false;   // reviews only or waiting already hold every implement, with their own reason
  const why = tierHold(mode.tierCutoff, readTier(issue).tier, agent);
  if (why) team.hold(agent, 'implement', `#${issue.number} ${why}`);
  return Boolean(why);
}
