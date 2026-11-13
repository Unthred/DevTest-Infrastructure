// Issue #1332: the approved inbox action resume_breaker. It resumes one breaker scope through the same function the CLI command
// `team breaker resume` uses (breaker.resume), then adds who, channel and why to the newest entry of the breaker's resume record.
// A scope that is not halted ends the item failed with a reason and changes nothing. Only the top halt cause is offered on the dashboard card.
// This module imports nothing from the team module: the team passes itself in.
import { SupervisorError } from './core.mjs';
import * as breaker from './breaker.mjs';

const isGlobal = scope => scope === '@global' || scope === 'global';

// Whether the scope names a halt that is in force now. Checked before breaker.resume, which stamps a clear time even when nothing was halted.
function halted(state, scope) {
  if (scope === 'all') return Boolean(state.global) || Object.keys(state.halts).length > 0;
  if (isGlobal(scope)) return Boolean(state.global);
  return Object.hasOwn(state.halts, scope);
}

// Who approved and through which channel, read from the approved item's status. A decision-card click and an approved overseer proposal differ.
export function approvalOf(status) {
  if (status?.click) return { by: 'homeowner', channel: 'decision card on the dashboard' };
  if (status?.source === 'homeowner_command') return { by: 'homeowner', channel: 'dashboard command' };
  return { by: 'homeowner', channel: 'overseer proposal approved on the dashboard' };
}

// Returns null for every other action, so the team's inbox pass can try it before its own switch.
export function resumeBreakerApproved(team, { action, target, reason }, status) {
  if (action !== 'resume_breaker') return null;
  const state = breaker.normalize(team.s.breaker);
  if (!halted(state, target)) throw new SupervisorError(`no breaker halt for ${target} (it was already resumed or never tripped); nothing changed`);
  const cleared = breaker.resume(state, target, team.clock.now());
  const { by, channel } = approvalOf(status);
  Object.assign(state.resumes.at(-1), { by, channel, why: reason });
  team.save();
  return `circuit breaker resumed: ${cleared.join(', ')} (${channel})`;
}
