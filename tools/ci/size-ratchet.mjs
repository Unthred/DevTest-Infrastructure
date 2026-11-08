// Issue #1067: compare the units now over a threshold with the committed baseline. Pure: no file or network access.
// Rule (docs/coding-standards.md, Enforcement): a baselined unit must not grow; a unit that newly crosses a threshold fails only in a
// file the baseline already lists as over the file threshold; anywhere else it is a warning. A unit that shrank lowers the baseline.

const fileOf = unit => unit.split('::')[0];

function grew(now, before) {
  return now.size > before.size || (now.excess ?? 0) > (before.excess ?? 0);
}

function shrank(now, before) {
  return now.size < before.size || (now.excess ?? 0) < (before.excess ?? 0);
}

const entry = o => ({ kind: o.kind, threshold: o.threshold, size: o.size, ...(o.excess !== undefined ? { excess: o.excess } : {}) });

// current: [{ unit, kind, threshold, size, excess?, line }]; baseline: { units: { [unit]: {kind, threshold, size, excess?} } }.
export function compare(current, baseline) {
  const known = baseline.units || {};
  const failures = [];
  const warnings = [];
  const shrinks = [];
  const next = {};
  const seen = new Set();
  for (const now of current) {
    seen.add(now.unit);
    const before = known[now.unit];
    if (before) {
      if (grew(now, before)) failures.push({ ...now, before: before.size, reason: 'grew' });
      else if (shrank(now, before)) shrinks.push({ ...now, before: before.size });
      next[now.unit] = grew(now, before) ? entry(before) : entry(now);   // a grown unit keeps its old size until the author fixes it
    } else if (now.kind !== 'file' && known[`${fileOf(now.unit)}::file`]) {
      failures.push({ ...now, before: 0, reason: 'crossed a threshold in a file already over the file threshold' });
    } else {
      warnings.push({ ...now, before: 0 });
    }
  }
  for (const [unit, before] of Object.entries(known)) {
    if (!seen.has(unit)) shrinks.push({ unit, kind: before.kind, threshold: before.threshold, size: 0, before: before.size, line: 1 });
  }
  return { failures, warnings, shrinks, units: next };
}

// The baseline to commit: every unit that is still over a threshold and was already in the baseline, at its current size.
export function updatedBaseline(base, result, stats) {
  const files = {};
  for (const unit of Object.keys(result.units)) { const f = fileOf(unit); if (stats[f]) files[f] = stats[f]; }
  const units = Object.fromEntries(Object.entries(result.units).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { version: 1, thresholds: base.thresholds, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))), units };
}

// A baseline listing every unit now over a threshold (used once to create it, or on request to reset it).
export function fullBaseline(current, stats, thresholds) {
  const units = Object.fromEntries(current.map(o => [o.unit, entry(o)]));
  return updatedBaseline({ thresholds }, { units }, stats);
}
