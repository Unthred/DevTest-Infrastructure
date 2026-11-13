// Issue #1116: the per-agent allowance figures foreman_status and foreman_budget return. The dashboard's budget view already carries them
// (capacity: used percent, learned weekly capacity, remaining capacity, reserve, confidence); this only selects what to show.
export function budgetBrief(budget) {
  return Object.fromEntries(Object.entries(budget || {}).map(([agent, b]) => [agent, { mode: b.mode, reason: b.reason, used: b.used, projected: b.projected, capacity: b.capacity ?? null, readingStale: b.reading?.stale ?? null, readingAgeMinutes: b.reading?.ageMinutes ?? null }]));
}
// Issue #1163: when the allowance reading was taken, how old it is, where it came from and which provider limit each figure is. A reading
// older than the age limit says `stale: true` and is worded as stale, never as current.
const isoOf = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export function readingBrief(r) {
  if (!r) return null;
  const wording = r.stale ? `STALE: last reading ${r.ageMinutes === null ? 'at an unknown time' : `${r.ageMinutes} minutes ago`} (limit ${r.maxAgeMinutes} minutes); not current` : `current: ${r.ageMinutes} minutes old`;
  return { observedAt: isoOf(r.observedAt), ageMinutes: r.ageMinutes, source: r.source, sourceText: r.sourceText, stale: r.stale === true, status: wording,
    limits: (r.limits || []).map(l => ({ kind: l.kind, label: l.label, used: l.used, resetsAt: isoOf(l.resetsAt), expired: l.expired === true })),
    sessionLimit: r.sessionTracked ? 'tracked' : 'not reported by the provider' };
}
