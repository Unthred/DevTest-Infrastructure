// Issue #1116: the per-agent allowance figures foreman_status and foreman_budget return. The dashboard's budget view already carries them
// (capacity: used percent, learned weekly capacity, remaining capacity, reserve, confidence); this only selects what to show.
export function budgetBrief(budget) {
  return Object.fromEntries(Object.entries(budget || {}).map(([agent, b]) => [agent, { mode: b.mode, reason: b.reason, used: b.used, projected: b.projected, capacity: b.capacity ?? null }]));
}
