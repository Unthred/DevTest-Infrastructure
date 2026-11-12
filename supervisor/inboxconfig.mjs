// Issue #1154 requirement 5: an Inbox job that changes a setting and ends before it is back as it was. Foreman records the team limits when the
// job starts and compares them with the live configuration when the job ends (the configuration is re-read each tick). Pure.
const scalar = v => ['number', 'string', 'boolean'].includes(typeof v);

export const limitsSnapshot = limits => Object.fromEntries(Object.entries(limits || {}).filter(([, v]) => scalar(v)));

// Settings whose value now differs from the snapshot: [{ key, was, now }]. A key that was absent has was null.
export function changedLimits(before, limits) {
  const now = limitsSnapshot(limits), changes = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(now)])) {
    if (before?.[key] !== now[key]) changes.push({ key, was: before?.[key] ?? null, now: now[key] ?? null });
  }
  return changes.slice(0, 20);
}

// The changes still in force against the live limits, with the value now in force.
export const stillChanged = (changes, limits) => (changes || []).map(c => ({ ...c, now: limits?.[c.key] ?? null })).filter(c => c.now !== c.was);
