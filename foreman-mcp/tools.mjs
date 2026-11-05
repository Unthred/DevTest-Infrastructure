// The tools. Each one is read-only, bounded and derived from the dashboard's own view (which the dashboard builds with the planner's code), so
// an answer here cannot disagree with what the planner will do. No tool writes, takes a lock, reads a transcript or calls a model.
import { redact, redactDeep } from './redact.mjs';

export const MAX_TEXT = 24000;      // characters of one tool result
export const CALLS_PER_MINUTE = 30; // rate limit for all tools together

// Shrinks a JSON-like value until its text fits: arrays are cut (halved) from the largest down, and the cut is stated.
export function bounded(value, max = MAX_TEXT) {
  let v = value, text = JSON.stringify(v, null, 1);
  for (let i = 0; i < 40 && text.length > max; i++) {
    let best = null;
    const walk = (node, set) => { if (Array.isArray(node)) { if (node.length > 1 && (!best || JSON.stringify(node).length > best.size)) best = { size: JSON.stringify(node).length, node, set }; node.forEach((x, k) => walk(x, y => { node[k] = y; })); } else if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], y => { node[k] = y; }); };
    v = structuredClone(v); walk(v, () => {});
    if (!best) { v = { truncated: true, note: 'the result is larger than the output limit', preview: text.slice(0, max - 200) }; break; }
    best.node.length = Math.max(1, Math.floor(best.node.length / 2));
    if (!v.truncated) v = Array.isArray(v) ? { truncated: true, note: 'lists were shortened to fit the output limit', items: v } : { ...v, truncated: true, truncatedNote: 'lists were shortened to fit the output limit' };
    text = JSON.stringify(v, null, 1);
  }
  return text.length > max ? JSON.stringify({ truncated: true, preview: text.slice(0, max - 100) }) : text;
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const num = (x, lo, hi, dflt) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt; };

export function createTools({ source, readHost, reports = null, now = Date.now }) {
  const calls = [];   // times of recent calls, for the rate limit
  const withView = async fn => { const r = await source.get(); return { ...fn(r.view), viewAgeSeconds: Math.round(r.ageMs / 1000), ...(r.stale ? { stale: true, staleBecause: r.error } : {}) }; };
  const reviewQueues = view => Object.fromEntries(Object.entries(view.queues || {}).map(([agent, items]) => [agent, (items || []).filter(i => i.type === 'review').sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.ref - b.ref).map(i => ({ order: i.order ?? null, pr: i.ref, next: !!i.next, title: i.title, reason: i.reason }))]));

  const defs = [
    { name: 'foreman_status', description: 'Foreman health: tick state, installed and main version, role slots, circuit breaker, per-agent allowance mode and idle reason, the planned next actions, running jobs and the count of Needs you items.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => withView(v => ({
        health: v.health, freshness: v.freshness, tick: { ...v.tick, at: iso(v.tick?.at), lastOkAt: iso(v.tick?.lastOkAt) }, nextTick: v.nextTick, version: v.version, teamEnabled: v.teamEnabled,
        slots: (v.slots || []).map(s => s.text), capNotes: v.capNotes, breaker: v.breaker ? { halt: v.breaker.halt, global: v.breaker.global ?? null, byCause: (v.breaker.byCause || []).slice(0, 8) } : null,
        agents: (v.agents || []).map(a => ({ name: a.name, state: a.state, idle: a.idleReason?.text ?? null })),
        budget: Object.fromEntries(Object.entries(v.budget || {}).map(([k, b]) => [k, { mode: b.mode, reason: b.reason, used: b.used, projected: b.projected }])),
        planned: (v.plan || []).map(a => ({ type: a.type, agent: a.agent ?? null, pr: a.pr ?? null, issue: a.issue ?? null, why: a.why ?? null })),
        running: (v.jobs || []).filter(j => ['running', 'queued', 'paused_limit', 'paused_manual'].includes(j.status)).map(j => ({ id: j.fullId, kind: j.kind, ref: j.ref, agent: j.agent, status: j.status, startedAt: iso(j.startedAt) })),
        needsYouCount: (v.attention || []).length })) },
    { name: 'foreman_review_order', description: 'The order in which each reviewer will review waiting pull requests, taken from the planner\'s own queue, with the reason each one waits or is held; plus open pull requests that are not queued for review and why.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => withView(v => {
        const q = reviewQueues(v), queued = new Set(Object.values(q).flat().map(i => i.pr));
        const notQueued = (v.prs || []).filter(p => p.status === 'open' && !queued.has(p.number)).map(p => {
          const reasons = Object.entries(v.queues || {}).flatMap(([agent, items]) => (items || []).filter(i => i.type === 'pr' && i.ref === p.number).map(i => `${agent}: ${i.reason}`));
          return { pr: p.number, title: p.title, head: String(p.head || '').slice(0, 7), checks: p.checks, verdict: p.verdict, needsHomeowner: !!p.needsHomeowner, why: reasons.length ? reasons : ['no queue entry; see foreman_why_blocked'] };
        });
        return { reviewers: q, plannedReviews: (v.plan || []).filter(a => a.type === 'review').map(a => ({ agent: a.agent, pr: a.pr, why: a.why ?? null })), notQueued };
      }) },
    { name: 'foreman_why_blocked', description: 'Why a pull request or issue is not moving: its state, queue entries, Needs you items, waits and exclusions.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['pr', 'issue'] }, number: { type: 'integer', minimum: 1 } }, required: ['kind', 'number'], additionalProperties: false },
      run: args => {
        const n = Number(args.number), kind = args.kind;
        if (!Number.isInteger(n) || n < 1 || !['pr', 'issue'].includes(kind)) throw new Error('give kind "pr" or "issue" and a positive integer number');
        return withView(v => {
          const out = { kind, number: n };
          const queueItems = Object.entries(v.queues || {}).flatMap(([agent, items]) => (items || []).filter(i => i.ref === n && (kind === 'pr' ? ['pr', 'review'].includes(i.type) : i.type === 'issue')).map(i => ({ agent, type: i.type, order: i.order ?? null, next: !!i.next, reason: i.reason })));
          out.queue = queueItems;
          out.needsYou = (v.attention || []).filter(a => a.ref?.n === n && (kind === 'pr' ? a.ref?.kind === 'pr' : a.ref?.kind === 'issue')).map(a => ({ text: a.text, tried: a.tried, action: a.action, severity: a.severity }));
          if (kind === 'pr') { const p = (v.prs || []).find(x => x.number === n); out.found = !!p; if (p) out.pr = { title: p.title, status: p.status, head: p.head, checks: p.checks, verdict: p.verdict, awaitingReview: p.awaitingReview, reviewRounds: p.reviewRounds, fixRounds: p.fixRounds, rebaseRounds: p.rebaseRounds, needsHomeowner: p.needsHomeowner, issue: p.issue, jobs: (p.jobs || []).slice(0, 8) }; }
          else { const i = (v.issues || []).find(x => x.number === n); out.found = !!i || queueItems.length > 0; if (i) out.issue = { title: i.title, state: i.state, labels: i.labels }; out.excluded = (v.excluded || []).filter(e => e.number === n); out.waits = (v.panels?.later || []).filter(l => l.number === n).map(l => ({ waits: l.waits, ends: l.ends })); }
          return out;
        });
      } },
    { name: 'foreman_jobs', description: 'Recent job records with tokens and cost (usage equivalent, not a charge). No transcripts. Optional filters: status, ref (issue or PR number), id (full job id).', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, status: { type: 'string' }, ref: { type: 'integer' }, id: { type: 'string' } }, additionalProperties: false },
      run: args => withView(v => {
        const limit = num(args.limit, 1, 100, 20);
        let rows = (v.jobs || []).filter(j => (!args.status || j.status === String(args.status)) && (!args.ref || j.ref === Number(args.ref)) && (!args.id || String(j.fullId || '').startsWith(String(args.id))));
        const total = rows.length, cost = rows.reduce((a, j) => a + (Number.isFinite(j.cost) ? j.cost : 0), 0), tokens = rows.reduce((a, j) => a + (Number.isFinite(j.tokens) ? j.tokens : 0), 0);
        rows = rows.slice(0, limit).map(j => ({ id: j.fullId, kind: j.kind, ref: j.ref, agent: j.agent, model: j.model, effort: j.effort, status: j.status, attempts: j.attempts, startedAt: iso(j.startedAt), elapsedSeconds: Number.isFinite(j.elapsedMs) ? Math.round(j.elapsedMs / 1000) : null, tokens: j.tokens, inTokens: j.inTokens, outTokens: j.outTokens, costUsdEquivalent: j.cost, transcriptAvailable: !!j.hasTranscript, summary: j.desc }));
        return { matching: total, shown: rows.length, totalTokens: tokens, totalCostUsdEquivalent: Math.round(cost * 100) / 100, note: 'Cost is the provider CLI\'s own usage estimate, not a cash charge. Transcripts are not available through this server.', jobs: rows };
      }) },
    { name: 'foreman_plan', description: 'What the planner will do on its next tick, as the dashboard computed it from the same code (not a separate dry run): planned actions, why work waits, the open-PR cap and the next tick time.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => withView(v => ({ plannedActions: v.plan || [], nextTickAt: v.nextTickAt ?? null, nextWhy: v.panels?.nextWhy ?? null, capNotes: v.capNotes ?? [], next: v.panels?.next ?? [], note: 'A live "team tick --dry-run" is not offered: it needs the state root, which this account cannot read.' })) },
    { name: 'foreman_host', description: 'Tower load average, memory and swap, from /proc.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => ({ ...readHost(), readAt: iso(now()) }) },
    { name: 'foreman_reports', description: 'Reports that hand-run sessions left for the overseer. With no name: the list (name, time, size), newest first. With a name: that one report as text (redacted, truncated if long). Reads one fixed folder only.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'a report name from the list, for example speedup.md' } }, additionalProperties: false },
      run: args => { if (!reports) throw new Error('reports are not available on this server'); return args.name === undefined ? reports.list() : reports.read(args.name, MAX_TEXT - 400); } },
  ];

  return {
    list: () => defs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })),
    has: name => defs.some(d => d.name === name),
    async call(name, args = {}) {
      const def = defs.find(d => d.name === name);
      if (!def) { const e = new Error(`unknown tool: ${String(name).slice(0, 60)}`); e.code = -32602; throw e; }
      const t = now(); while (calls.length && t - calls[0] > 60000) calls.shift();
      if (calls.length >= CALLS_PER_MINUTE) return { isError: true, text: `rate limit: more than ${CALLS_PER_MINUTE} calls in a minute; try again shortly` };
      calls.push(t);
      try { const out = await def.run(args && typeof args === 'object' ? args : {}); return { isError: false, text: typeof out === 'string' ? redact(out).slice(0, MAX_TEXT) : bounded(redactDeep(out)) }; }
      catch (error) { return { isError: true, text: bounded(redactDeep({ error: String(error?.message || error).slice(0, 400) })) }; }
    },
  };
}
