// Estimated finish time for each queued issue / open PR (issue #156). Pure and model-free: it reads only Foreman's own job
// records, the verdict history, the planner's queues and the allowance forecast, and never calls GitHub or a provider.
//
// Method (all of it is shown on hover as the "basis"):
//  - Step durations come from completed job records: updatedAt - createdAt, per step type. The "ci" step is the gap between a
//    producing job (implement, continue, fix, ci-fix, rebase) ending and the next review of the same PR starting.
//  - p50 and p90 use the nearest-rank percentile of the recorded samples, so the same history always gives the same numbers.
//  - A type with fewer than MIN_SAMPLES recorded jobs gives "no estimate yet" for any item that needs it. Nothing is guessed.
//  - Fix rounds: pFix is the share of reviewed PRs that ever got a CHANGES verdict. The p50 path includes a fix round (fix, CI,
//    re-review) when pFix >= 50%, the p90 path when pFix >= 10%.
//  - Queue: items are placed in queue order into role slots (implementer, reviewer) and the overall cap; jobs already running
//    hold their slot for the rest of their typical duration. Merge happens on the next tick after the last step.
//  - Allowance: a step by an agent that is out of allowance, or whose forecast runs out before the step would start, moves to
//    the agent's reset time and the estimate says so.
import { MIN_UPGRADE_INTERVAL_MS } from './upgrade.mjs';
import { checksState } from './team.mjs';

export const MIN_SAMPLES = 5;
export const TICK_MS = 5 * 60000;
export const FIX_P50_AT = 0.5, FIX_P90_AT = 0.1;
const ACTIVE = ['queued', 'running', 'paused_limit', 'paused_manual'];
const PRODUCERS = ['implement', 'continue', 'fix', 'cifix', 'rebase'];
export const STEP_LABEL = { implement: 'implement', continue: 'continue', review: 'review', 'interim-review': 'interim review', fix: 'fix', cifix: 'CI fix', rebase: 'rebase', ci: 'CI' };
const roleOf = step => (step === 'ci' ? null : step === 'review' || step === 'interim-review' ? 'reviewer' : 'implementer');

// Nearest-rank percentile of a numeric list.
export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

// Per step type: { n, p50, p90 } from completed job records (and the CI gaps between them).
export function stepStats(jobs, state = {}) {
  const samples = {};
  const add = (type, ms) => { if (Number.isFinite(ms) && ms > 0) (samples[type] ||= []).push(ms); };
  const done = jobs.filter(j => j.status === 'completed' && Number.isFinite(j.createdAt) && Number.isFinite(j.updatedAt) && j.updatedAt > j.createdAt);
  const typeOf = j => { const r = state.jobs?.[j.id]; const k = r?.kind || j.kind; return k === 'review' && (r?.interim === true || r?.modelSource === 'interim-review') ? 'interim-review' : k; };
  for (const j of done) { const t = typeOf(j); if (STEP_LABEL[t] && t !== 'ci') add(t, j.updatedAt - j.createdAt); }
  // CI gap: producer ends -> first later review of the same PR starts. Fix, ci-fix and rebase jobs name the PR in `issue`.
  const prOf = j => (['fix', 'cifix', 'rebase', 'review'].includes(state.jobs?.[j.id]?.kind || j.kind) ? j.issue : state.jobs?.[j.id]?.pr ?? null);
  const reviews = done.filter(j => (state.jobs?.[j.id]?.kind || j.kind) === 'review');
  for (const p of done.filter(j => PRODUCERS.includes(state.jobs?.[j.id]?.kind || j.kind))) {
    const pr = prOf(p); if (pr == null) continue;
    const next = reviews.filter(r => r.issue === pr && r.createdAt >= p.updatedAt).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) add('ci', next.createdAt - p.updatedAt);
  }
  return Object.fromEntries(Object.entries(samples).map(([t, v]) => [t, { n: v.length, p50: percentile(v, 0.5), p90: percentile(v, 0.9) }]));
}

// Chance that a reviewed PR needed a fix round, from the verdict history: PRs with any CHANGES / PRs with any verdict.
export function fixChance(state = {}) {
  const byPr = new Map();
  for (const [key, v] of Object.entries(state.verdicts || {})) { const pr = key.split(':')[0]; byPr.set(pr, (byPr.get(pr) || false) || v?.verdict === 'CHANGES'); }
  return { prs: byPr.size, p: byPr.size ? [...byPr.values()].filter(Boolean).length / byPr.size : null };
}

// ---- formatting
const part = (ms, tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', ...opts }).format(new Date(ms));
const hhmm = (ms, tz) => part(ms, tz, { hour: '2-digit', minute: '2-digit' });
const dayKey = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
export function clock(ms, now, tz) { return dayKey(ms, tz) === dayKey(now, tz) ? hhmm(ms, tz) : `${part(ms, tz, { weekday: 'short' })} ${hhmm(ms, tz)}`; }
const dur = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
export function rangeText(a, b, now, tz) {
  const x = clock(a, now, tz), y = clock(b, now, tz);
  if (x === y) return `est. ${x}`;
  return `est. ${x}–${dayKey(a, tz) === dayKey(b, tz) ? hhmm(b, tz) : y}`;
}

// Where each agent's allowance blocks work. Returns { from, until } per agent, or null: steps starting in [from, until) move to until.
export function allowanceGates(budget = {}, now) {
  const out = {};
  for (const [agent, b] of Object.entries(budget)) {
    if (!b) continue;
    const reset = Number.isFinite(b.until) ? b.until : Number.isFinite(b.resetsAt) ? b.resetsAt : null;
    if (b.mode && b.mode !== 'normal' && reset > now) out[agent] = { from: now, until: reset, mode: b.mode, implementerOnly: b.mode === 'reviews_only' };
    else if (Number.isFinite(b.runsOutAt) && Number.isFinite(b.resetsAt) && b.runsOutAt < b.resetsAt && b.resetsAt > now) out[agent] = { from: Math.max(now, b.runsOutAt), until: b.resetsAt, mode: 'forecast', implementerOnly: false };
  }
  return out;
}

// A wait the dispatcher knows about but that is not part of any one issue: the self-upgrade rate limit (issue #47 / #134).
export function globalWaits({ upgrade = null, now, tz }) {
  const waits = [];
  const last = upgrade?.lastUpgradeAt;
  if (Number.isFinite(last) && last + MIN_UPGRADE_INTERVAL_MS > now) {
    const at = last + MIN_UPGRADE_INTERVAL_MS;
    waits.push({ kind: 'upgrade', at, text: `upgrade waiting, next try ${clock(at, now, tz)}` });
  }
  return waits;
}

// The remaining step chain of an item and why it is waiting, from the state the queue shows.
function chainOf(item, ctx) {
  const { pr, checks, verdict } = item;
  if (item.kind === 'issue') return { steps: ['implement', 'ci', 'review'], note: 'not started' };
  if (pr.isDraft) return { steps: ['continue', 'ci', 'review'], note: 'draft' };
  if (checks === 'red') return { steps: ['cifix', 'ci', 'review'], note: 'CI failing' };
  if (checks === 'pending') return { steps: ['ci', 'review'], note: 'CI running', wait: { kind: 'ci', text: 'CI running' } };
  if (checks === 'none') return { steps: ['ci', 'review'], note: 'no CI checks reported', wait: { kind: 'ci', text: 'CI not reported yet' } };
  if (verdict?.verdict === 'CHANGES') return { steps: ['fix', 'ci', 'review'], note: 'CHANGES verdict' };
  if (verdict?.verdict === 'PASS') return pr.mergeable === 'MERGEABLE' ? { steps: [], note: 'PASS; merges on the next tick' } : { steps: null, note: `PASS but not mergeable (${String(pr.mergeable || 'unknown').toLowerCase()})` };
  return { steps: ['review'], note: 'waiting for a review' };
}

// inputs: { queues, pulls, issues, jobs, state, budget, config, now, tz, upgrade }
export function estimateQueue({ queues = {}, pulls = [], jobs = [], state = {}, budget = {}, config, now, tz = 'UTC', upgrade = null }) {
  const stats = stepStats(jobs, state), fix = fixChance(state), gates = allowanceGates(budget, now);
  const agents = Object.keys(config.agents);
  const L = config.limits || {}, cap = { implementer: L.roles?.implementer ?? 1, reviewer: L.roles?.reviewer ?? 1, overall: L.overall ?? 2 };
  const has = t => (stats[t]?.n ?? 0) >= MIN_SAMPLES;
  const typical = (t, q) => stats[t][q];
  const pullOf = new Map(pulls.map(p => [p.number, p]));

  // Items in queue order: next first, then lowest ref; one item per issue (not yet in a PR) and per open PR.
  const items = [];
  const seen = new Set();
  const all = Object.entries(queues).flatMap(([agent, q]) => q.map(i => ({ ...i, agent })));
  all.sort((a, b) => (b.next - a.next) || (a.ref - b.ref));
  for (const i of all) {
    if (i.type === 'review') continue;
    const key = `${i.type}:${i.ref}`;
    if (seen.has(key)) continue; seen.add(key);
    if (i.type === 'pr') {
      const p = pullOf.get(i.ref); if (!p) continue;
      const v = Object.entries(state.verdicts || {}).filter(([k]) => k === `${p.number}:${p.headRefOid}`).map(([, x]) => x)[0] || null;
      items.push({ kind: 'pr', ref: i.ref, agent: i.agent, title: i.title, reason: i.reason, pr: p, checks: checksState(p.statusCheckRollup), verdict: v });
    } else {
      if (/^PR open|^reassigned.*PR #\d+ open/.test(i.reason)) continue;   // the open PR is its own item
      if (/^(blocked by|needs the homeowner)/.test(i.reason)) { items.push({ kind: 'issue', ref: i.ref, agent: i.agent, title: i.title, reason: i.reason, blocked: i.reason }); continue; }
      items.push({ kind: 'issue', ref: i.ref, agent: i.agent, title: i.title, reason: i.reason });
    }
  }

  // Slot timelines per quantile: when each slot next frees. Running jobs hold their slot for the rest of their typical time.
  const running = jobs.filter(j => ACTIVE.includes(j.status));
  const out = { generatedAt: now, timeZone: tz, stats, fixChance: fix, waits: globalWaits({ upgrade, now, tz }), items: {} };
  const sim = q => {
    const roleFree = { implementer: Array(cap.implementer).fill(now), reviewer: Array(cap.reviewer).fill(now) };
    const overallFree = Array(cap.overall).fill(now);
    const take = arr => arr.indexOf(Math.min(...arr));
    for (const j of running) {
      const step = state.jobs?.[j.id]?.kind || j.kind, role = roleOf(step) || 'implementer';
      const left = has(step) ? Math.max(TICK_MS, typical(step, q) - (now - j.createdAt)) : TICK_MS;
      if (j.status === 'paused_limit' && Number.isFinite(j.nextAttemptAt)) { const e = j.nextAttemptAt + (has(step) ? typical(step, q) : 0); roleFree[role][take(roleFree[role])] = e; overallFree[take(overallFree)] = e; continue; }
      roleFree[role][take(roleFree[role])] = now + left; overallFree[take(overallFree)] = now + left;
    }
    const byItem = new Map();
    for (const it of items) {
      if (it.blocked) { byItem.set(it, { blocked: true }); continue; }
      const c = it.kind === 'pr' ? chainOf(it, {}) : { steps: ['implement', 'ci', 'review'], note: it.reason };
      it.chain = c;
      if (c.steps === null) { byItem.set(it, { noPath: true }); continue; }
      let steps = [...c.steps];
      const withFix = q === 'p50' ? (fix.p ?? 0) >= FIX_P50_AT : (fix.p ?? 0) >= FIX_P90_AT;
      if (withFix && steps.includes('review')) steps = [...steps, 'fix', 'ci', 'review'];
      const missing = [...new Set(steps.filter(s => !has(s)))];
      if (missing.length) { byItem.set(it, { missing }); continue; }
      let t = now, start = null, moved = null;
      const author = it.agent, reviewer = (queues && agents.find(a => a !== author)) || author;
      const runningHere = running.find(j => j.issue === it.ref && (it.kind === 'issue' ? ['implement', 'continue'] : ['review', 'fix', 'cifix', 'rebase', 'continue']).includes(state.jobs?.[j.id]?.kind || j.kind));
      steps.forEach((s, idx) => {
        const role = roleOf(s), who = role === 'reviewer' ? reviewer : author, d = typical(s, q);
        if (idx === 0 && runningHere) { t = Math.max(now, runningHere.createdAt + d); start ??= runningHere.createdAt; return; }
        if (role === null) { t += d; return; }
        const ri = take(roleFree[role]), oi = take(overallFree);
        let s0 = Math.max(t, roleFree[role][ri], overallFree[oi]);
        const g = gates[who];
        if (g && s0 >= g.from && s0 < g.until && !(g.implementerOnly && role === 'reviewer')) { s0 = g.until; moved ??= { agent: who, at: g.until, mode: g.mode }; }
        start ??= s0;
        t = s0 + d; roleFree[role][ri] = t; overallFree[oi] = t;
      });
      byItem.set(it, { start: start ?? now, finish: t + TICK_MS, moved, steps });
    }
    return byItem;
  };
  const p50 = sim('p50'), p90 = sim('p90');

  for (const it of items) {
    const a = p50.get(it), b = p90.get(it), id = `${it.kind}:${it.ref}`;
    const base = { kind: it.kind, ref: it.ref, agent: it.agent, waits: [] };
    if (a.blocked) { out.items[id] = { ...base, status: 'blocked', text: `no estimate: ${a.blocked ? it.blocked : ''}`, basis: [it.blocked] }; continue; }
    if (a.noPath) { out.items[id] = { ...base, status: 'stuck', text: `no estimate: ${it.chain.note}`, basis: [it.chain.note] }; continue; }
    const miss = [...new Set([...(a.missing || []), ...(b.missing || [])])];
    if (miss.length) {
      out.items[id] = { ...base, status: 'no-estimate', text: 'no estimate yet', missing: miss, basis: [`needs at least ${MIN_SAMPLES} recorded jobs of: ${miss.map(t => `${STEP_LABEL[t]} (${stats[t]?.n ?? 0} so far)`).join(', ')}`] };
      continue;
    }
    const waits = [];
    if (it.chain?.wait) waits.push({ kind: it.chain.wait.kind, text: it.chain.wait.text });
    const mv = a.moved || b.moved;
    if (mv) waits.push({ kind: 'allowance', at: mv.at, text: `${mv.agent} allowance: after ${clock(mv.at, now, tz)} reset` });
    if (!a.steps.length) {
      out.items[id] = { ...base, status: 'estimated', start: now, finish: { p50: now + TICK_MS, p90: now + TICK_MS }, text: rangeText(now + TICK_MS, now + TICK_MS, now, tz), waits, basis: [it.chain.note] };
      continue;
    }
    const fin50 = a.finish, fin90 = Math.max(b.finish, fin50);
    const pos = items.filter(x => !p50.get(x).blocked).indexOf(it) + 1;
    const basis = [
      `Queue position ${pos} of ${items.filter(x => !p50.get(x).blocked).length}; role slots ${cap.implementer} implementer / ${cap.reviewer} reviewer, overall cap ${cap.overall}.`,
      `Steps left (p50 path): ${a.steps.map(s => STEP_LABEL[s]).join(' → ')}${b.steps.length > a.steps.length ? `; p90 adds a fix round (${Math.round((fix.p ?? 0) * 100)}% of ${fix.prs} reviewed PRs needed one)` : ''}.`,
      `Typical durations (p50/p90): ${[...new Set([...a.steps, ...b.steps])].map(s => `${STEP_LABEL[s]} ${dur(stats[s].p50)}/${dur(stats[s].p90)} (n=${stats[s].n})`).join('; ')}.`,
      ...waits.map(w => `Wait: ${w.text}.`)
    ];
    const text = rangeText(fin50, fin90, now, tz) + (mv ? ` (after ${clock(mv.at, now, tz)} reset)` : '');
    out.items[id] = { ...base, status: 'estimated', start: a.start, finish: { p50: fin50, p90: fin90 }, text, waits, basis };
  }
  return out;
}
