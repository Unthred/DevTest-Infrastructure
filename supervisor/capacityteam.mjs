// Issue #1116: how the dispatcher's decisions use the capacity summaries (capacity.mjs): ranking rows, the implement rank, the model context
// and the "out for takeover" reason. Plain data in, plain data out; the dispatcher gathers the inputs.
import { lowOnCapacity } from './capacity.mjs';
import { reserveRefusal } from './capacityrule.mjs';
import { REVIEWS_ONLY_TYPES } from './budget.mjs';

// One row per agent in config order. `mayTake(name)` says whether the agent's role and usage limit let it take work over now.
// At or below its reserve an agent is not eligible: it starts no implement work, so it cannot take any either.
export function candidateRows(names, modes, mayTake) {
  return names.map(agent => {
    const m = modes?.[agent];
    const eligible = m?.mode === 'normal' && m.known === true && mayTake(agent) && !reserveRefusal(m, 'implement', REVIEWS_ONLY_TYPES);
    return { agent, summary: m?.capacity, legacy: m?.known && Number.isFinite(m.projected) ? 1 - m.projected : 0, eligible };
  });
}

// Lower is preferred when several agents could fill the same slot (not reviews, which the dispatcher ranks itself). An implement ranks after
// repairs; the owner before an agent taking over; an out owner last. Among implements the agent with the most remaining capacity relative to
// its need comes first: the capacity term stays under 1, so the order above it still holds.
export function workRank(act, ownerOut, spare) {
  const implement = act.type === 'implement';
  const capacityTerm = implement ? 0.5 * (1 - Math.tanh(spare)) : 0;
  return (implement ? 10 : 0) + (act.reassignedFrom ? 1 : 0) + (implement && !act.reassignedFrom && ownerOut ? 20 : 0) + capacityTerm;
}

// The model context from the capacity: the cheaper model is kept on remaining capacity when it is known, else the percentage decides as before.
export function modelCapacity(mode, capacity) {
  const capacityLow = lowOnCapacity(capacity);
  if (capacityLow === null) return { capacityLow };
  return { capacityLow, low: (!!mode && mode !== 'normal') || capacityLow };
}

// An agent in normal mode at or below its reserve (the last day before the reset, where it is not reviews-only) starts no implement work, so
// it counts as out and its ready issues move. Null when the reserve does not hold it.
export function reserveOut(m) {
  const refusal = m ? reserveRefusal(m, 'implement', REVIEWS_ONLY_TYPES) : null;
  return refusal ? { why: `starts no new implement work (${refusal.slice(0, 160)})`, until: m.resetsAt ?? null } : null;
}
