// Issue #1067: compare the units now over a threshold with the committed baseline. Pure: no file or network access.
// Rule (docs/coding-standards.md, Enforcement): a baselined unit must not grow; a unit that newly crosses a threshold fails only in a
// file the baseline already lists as over the file threshold; anywhere else it is a warning. A unit that shrank lowers the baseline.

const fileOf = unit => unit.split('::')[0];

function grew(now, before) {
  return now.size > before.size;
}

function shrank(now, before) {
  return now.size < before.size;
}

// A long line's key (start-of-text hash plus an ordinal) shifts when a line is deleted or its start is edited. Pair each current
// long line with a baseline one without trusting the ordinal: first by equal hash, longest with longest, then the leftovers in the
// same file, longest with longest. A line paired this way fails only if it is longer than its partner.
const isLong = o => o.kind === 'long-line';
const hashOf = unit => unit.replace(/#\d+$/, '');

function pairGroup(nows, befores, alias) {
  const byLen = (a, b) => b.size - a.size;
  nows.sort(byLen);
  befores.sort(byLen);
  const n = Math.min(nows.length, befores.length);
  for (let i = 0; i < n; i++) alias.set(nows[i].unit, befores[i].unit);
  return { nows: nows.slice(n), befores: befores.slice(n) };
}

function pairLongLines(current, known) {
  const alias = new Map();
  const files = new Map();
  const slot = f => files.get(f) || files.set(f, { nows: [], befores: [] }).get(f);
  for (const now of current.filter(isLong)) slot(fileOf(now.unit)).nows.push(now);
  for (const [unit, b] of Object.entries(known)) if (isLong(b)) slot(fileOf(unit)).befores.push({ unit, size: b.size });
  for (const { nows, befores } of files.values()) {
    const groups = new Map();
    const group = h => groups.get(h) || groups.set(h, { nows: [], befores: [] }).get(h);
    for (const o of nows) group(hashOf(o.unit)).nows.push(o);
    for (const o of befores) group(hashOf(o.unit)).befores.push(o);
    const left = { nows: [], befores: [] };
    for (const g of groups.values()) {
      const rest = pairGroup(g.nows, g.befores, alias);
      left.nows.push(...rest.nows);
      left.befores.push(...rest.befores);
    }
    pairGroup(left.nows, left.befores, alias);
  }
  return alias;
}

const entry = o => ({ kind: o.kind, threshold: o.threshold, size: o.size });

// current: [{ unit, kind, threshold, size, line }]; baseline: { units: { [unit]: {kind, threshold, size} } }.
export function compare(current, baseline) {
  const known = baseline.units || {};
  const failures = [];
  const warnings = [];
  const shrinks = [];
  const next = {};
  const seen = new Set();
  const alias = pairLongLines(current, known);
  for (const now of current) {
    const baseKey = alias.get(now.unit) || now.unit;
    seen.add(baseKey);
    const before = known[baseKey];
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
