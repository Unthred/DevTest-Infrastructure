// Issue #1151: one source for why a planned action is held by the host. The tick records the host pressure verdict in state; every
// planning run (the tick, the dashboard, foreman_plan, foreman_why_blocked) calls overlayHostHold on the plan it just made, so the
// reason on each surface is the same text and is the host's, not a leftover allowance-mode or slot hold the planner noted earlier.
import { activeHostHold } from './hostpressure.mjs';

// Marks every planned job start with the host pressure reason and makes it the hold recorded for that agent and type. Merges are not
// jobs and are not held. With no hold in force it only clears the per-agent table. Returns the actions it was given.
export function overlayHostHold(team, actions) {
  team.hostHolds = {};
  const hold = activeHostHold(team.s, team.clock.now());
  if (!hold) return actions;
  const fresh = new Set();   // agents whose earlier planner holds were replaced: the host's reason is why they wait, not a hold for other work
  for (const act of actions) {
    if (act.type === 'merge' || !act.agent) continue;
    act.heldBy = hold.reason;
    act.chosenBecause = act.why;   // the planner's own reason for picking it, kept apart from the reason it waits
    act.why = hold.reason;         // foreman_status, foreman_review_order and the Next card read `why` for a planned action
    team.hostHolds[act.agent] = hold.reason;
    team.held[act.agent] = { ...(fresh.has(act.agent) ? team.held[act.agent] : {}), [act.type]: hold.reason };
    fresh.add(act.agent);
    if (act.pr != null) team.heldPr[`${act.agent}:${act.type}:${act.pr}`] = hold.reason;
  }
  return actions;
}

// The why-fields of a Next card entry (dashboard panels.next): the host's reason first, then a reassignment, then the reason this agent was chosen (a review's, or the choice core's for any other job; issue #1346).
export function nextWhyFields(a, redact) {
  if (a.heldBy) return { ...(a.reassignedFrom ? { reassignedFrom: a.reassignedFrom } : {}), why: redact(a.heldBy, 300) };
  if (a.reassignedFrom) return { reassignedFrom: a.reassignedFrom, why: redact(a.reassignReason, 300) };
  return a.why ? { why: redact(a.why, 700) } : {};
}

// "; held: <reason>" for an agent whose next job the host is holding, otherwise an empty string.
export const hostHoldNote = (team, agent) => (team.hostHolds?.[agent] ? `; held: ${team.hostHolds[agent]}` : '');

// Appends the note to each queue entry that is the agent's next job.
export function annotateQueues(team, queues) {
  for (const [agent, items] of Object.entries(queues || {})) {
    const note = hostHoldNote(team, agent);
    if (note) for (const item of items) if (item.next) item.reason += note;
  }
  return queues;
}
