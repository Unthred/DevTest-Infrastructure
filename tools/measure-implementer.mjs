#!/usr/bin/env node
// Issue #460: the implementer-time figures of its evidence, from the supervisor's job and event records. Prints JSON.
// Usage: node tools/measure-implementer.mjs --from ISO --to ISO [--jobs DIR] [--events DIR]
// Method: a job runs from each `started` event to the next event that ends a run; it is queued from `created` to its first `started`.
// "before" counts rebases on the implementer slot (implement, continue, fix, cifix, rebase); "after" is a replay of the same records
// with rebases on their own rebaser slot, so only implement, continue, fix and cifix occupy the implementer. Reviews never occupy it.
// Idle with work queued = minutes when no job of that view runs while at least one is queued. Busy shares are of the window.
import fs from 'node:fs';
import path from 'node:path';
const END = new Set(['completed', 'incomplete', 'usage_limit', 'manual_stop', 'manual_pause', 'approval_required', 'retry_exhausted', 'auth_error', 'leases_released']);
const BEFORE = new Set(['implement', 'continue', 'fix', 'cifix', 'rebase']);
const AFTER = new Set(['implement', 'continue', 'fix', 'cifix']);
const min = ms => Math.round(ms / 600) / 100;
const merge = iv => { const out = []; for (const [a, b] of [...iv].sort((x, y) => x[0] - y[0])) { if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b); else out.push([a, b]); } return out; };
const total = iv => iv.reduce((s, [a, b]) => s + (b - a), 0);
const clip = (iv, from, to) => iv.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);
const subtract = (iv, minus) => { let cur = iv; for (const [c, d] of minus) cur = cur.flatMap(([a, b]) => (d <= a || c >= b) ? [[a, b]] : [[a, Math.max(a, c)], [Math.min(b, d), b]].filter(([x, y]) => y > x)); return cur; };

// jobs: [{ id, kind }]; events: [{ at, job, kind }]. Returns the figures for the window [from, to] (ms).
export function measure(jobs, events, from, to) {
  const kindOf = new Map(jobs.map(j => [j.id, j.kind])), by = new Map();
  for (const e of [...events].sort((a, b) => a.at - b.at)) { if (!by.has(e.job)) by.set(e.job, []); by.get(e.job).push(e); }
  const runs = [], queued = [];
  for (const [id, evs] of by) {
    const kind = kindOf.get(id); if (!kind) continue;
    const created = evs.find(e => e.kind === 'created')?.at, first = evs.find(e => e.kind === 'started')?.at;
    if (created != null) queued.push({ kind, iv: [created, first ?? to] });
    let open = null;
    for (const e of evs) { if (e.kind === 'started' && open == null) open = e.at; else if (END.has(e.kind) && open != null) { runs.push({ kind, iv: [open, e.at] }); open = null; } }
    if (open != null) runs.push({ kind, iv: [open, to] });
  }
  const view = set => {
    const run = merge(clip(runs.filter(r => set.has(r.kind)).map(r => r.iv), from, to)), q = merge(clip(queued.filter(r => set.has(r.kind)).map(r => r.iv), from, to));
    return { busyMinutes: min(total(run)), idleWithWorkQueuedMinutes: min(total(subtract(q, run))), idleMinutes: min(to - from - total(run)) };
  };
  const share = {}; for (const k of BEFORE) share[k] = min(total(merge(clip(runs.filter(r => r.kind === k).map(r => r.iv), from, to))));
  const jobMinutes = Object.values(share).reduce((s, v) => s + v, 0);
  const pct = v => jobMinutes ? Math.round(v / jobMinutes * 1000) / 10 : 0;
  return { windowMinutes: min(to - from), before: view(BEFORE), after: view(AFTER), implementerMinutesByKind: share,
    sharePercentOfImplementerJobMinutes: { rebase: pct(share.rebase), fix: pct(share.fix + share.cifix), newWork: pct(share.implement + share.continue) } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2), get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = process.env.AI_SUPERVISOR_DIR ?? '/mnt/cache/ai-supervisor', jd = get('--jobs') ?? path.join(root, 'jobs'), ed = get('--events') ?? path.join(root, 'events');
  const to = Date.parse(get('--to') ?? new Date().toISOString()), from = Date.parse(get('--from') ?? new Date(to - 6 * 3600e3).toISOString());
  if (!(from < to)) { console.error('--from must be before --to'); process.exit(2); }
  const jobs = fs.readdirSync(jd).filter(f => f.endsWith('.json')).flatMap(f => { try { const j = JSON.parse(fs.readFileSync(path.join(jd, f), 'utf8')); return [{ id: j.id ?? f.slice(0, -5), kind: j.kind }]; } catch { return []; } });
  const events = fs.readdirSync(ed).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(ed, f), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }));
  console.log(JSON.stringify({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...measure(jobs, events, from, to) }, null, 2));
}
