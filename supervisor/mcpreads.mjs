// Issue #635: two more bounded, redacted, read-only records for the Foreman MCP tools (D-030), served by the dashboard's GET handler because the
// MCP account cannot read the state root: the failure cost by cause over time (foreman_waste) and the effective configuration with its
// difference from the shipped default (foreman_config). They only read and make no model call.
import fs from 'node:fs';
import { redact, KEY } from './redact.mjs';

const DAY_MS = 86400000;
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const round2 = n => Math.round(n * 100) / 100;

// Waste (tokens and usage-equivalent cost) by cause, per UTC day, newest day first, from the circuit breaker's own waste record
// (the last 7 days, at most 1000 records). `days` limits how many of those days are returned.
export function wasteByCause(state, { now = Date.now(), days = 7 } = {}) {
  const all = Object.values(state?.breaker?.waste || {}).filter(w => w && typeof w === 'object' && Number.isFinite(w.at));
  const span = Math.min(30, Math.max(1, Math.trunc(Number(days)) || 7)), from = now - span * DAY_MS;
  const rows = all.filter(w => w.at >= from);
  const add = (m, key, w) => { const e = m.get(key) || { jobs: 0, tokens: 0, cost: 0 }; e.jobs++; e.tokens += Number.isFinite(w.tokens) ? w.tokens : 0; e.cost += Number.isFinite(w.cost) ? w.cost : 0; m.set(key, e); };
  const causes = new Map(), byDay = new Map();
  for (const w of rows) {
    const cause = redact(w.cause || 'unknown', 120), day = iso(w.at).slice(0, 10);
    add(causes, cause, w);
    if (!byDay.has(day)) byDay.set(day, new Map());
    add(byDay.get(day), cause, w);
  }
  const out = m => [...m].map(([cause, e]) => ({ cause, jobs: e.jobs, tokens: e.tokens, costUsdEquivalent: round2(e.cost) })).sort((a, b) => b.costUsdEquivalent - a.costUsdEquivalent || b.tokens - a.tokens || a.cause.localeCompare(b.cause));
  const sum = k => rows.reduce((n, w) => n + (Number.isFinite(w[k]) ? w[k] : 0), 0);
  return {
    from: iso(from), to: iso(now), days: span, jobs: rows.length, totalTokens: sum('tokens'), totalCostUsdEquivalent: round2(sum('cost')),
    note: 'Waste is a finished job that spent tokens and left no usable result. Cost is the provider CLI usage estimate, not a charge. The record covers the last 7 days and at most 1000 entries, so a longer span shows no more.',
    byCause: out(causes), byDay: [...byDay].sort((a, b) => b[0].localeCompare(a[0])).map(([day, m]) => ({ day, causes: out(m) })),
  };
}

// ---- configuration ----
const SECRET_KEY = new RegExp(KEY, 'i');   // anywhere in the key: webhook_secret, githubToken
// Every string passes through the shared redaction; a key that names a secret loses its value; an alert command keeps its program only.
export function scrubConfig(value, key = '', depth = 0) {
  if (depth > 12) return '[too deep]';
  if (SECRET_KEY.test(key) && value != null && typeof value !== 'boolean' && typeof value !== 'number') return '[removed]';
  if (key === 'command' && Array.isArray(value)) return value.length ? [redact(String(value[0]), 200), `[${value.length - 1} argument(s) removed]`] : [];
  if (typeof value === 'string') return redact(value, 300);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => scrubConfig(v, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubConfig(v, k, depth + 1)]));
  return value;
}
const leaves = (v, prefix = '', out = new Map()) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  else out.set(prefix, v);
  return out;
};
// Where the effective value differs from the shipped one: changed, added by the local file, or removed.
export function configDiff(shipped, effective) {
  const a = leaves(shipped), b = leaves(effective), keys = new Set([...a.keys(), ...b.keys()]), out = [];
  for (const k of [...keys].sort()) {
    const had = a.has(k), has = b.has(k);
    if (had && has && JSON.stringify(a.get(k)) === JSON.stringify(b.get(k))) continue;
    out.push({ path: k, shipped: had ? a.get(k) : undefined, effective: has ? b.get(k) : undefined, change: !had ? 'added' : !has ? 'removed' : 'changed' });
  }
  return out;
}
// `effective` is the merged configuration the dashboard uses; `shippedFile` is the reviewed team.json in the installed version.
export function configView({ effective, shippedFile, localOverridePresent = null, configError = null }) {
  let shipped = null; try { shipped = JSON.parse(fs.readFileSync(shippedFile, 'utf8')); } catch { /* reported below */ }
  const clean = scrubConfig(effective);
  const diff = shipped ? configDiff(scrubConfig(shipped), clean) : [];
  return {
    note: 'The configuration Foreman uses now: shipped team.json plus the team.local.json override. Secret-named keys and alert command arguments are removed and every string is redacted.',
    localOverridePresent, ...(configError ? { configError: redact(configError, 300), configErrorNote: 'The local file is invalid; this is the last good configuration.' } : {}),
    shippedReadable: !!shipped, differsFromShipped: diff.length, differences: diff.slice(0, 200), effective: clean,
  };
}
