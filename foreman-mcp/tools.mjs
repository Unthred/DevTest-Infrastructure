// The tools. Each one is bounded. All but foreman_propose are read-only and derived from the dashboard's own view (which the dashboard builds with the
// planner's code), so an answer here cannot disagree with what the planner will do. foreman_propose writes one proposal file into the inbox
// directory and nothing else (issue #124); it cannot approve, run or change anything. No tool takes a lock, reads a transcript or calls a model.
import { redact, redactDeep } from './redact.mjs';
import { createInbox } from './inbox.mjs';
import { mismatches, needsYouGroups, rebaseStats, itemTimeline } from './insights.mjs';
import { hostActivity } from './source.mjs';

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

// Keeps the first `limit` entries of out[key], then as many as fit the output limit, so `shown` always equals the list length
// and a cut is stated (bounded() would otherwise halve the list after `shown` was set).
export function fitItems(out, key, limit, max = MAX_TEXT) {
  const all = Array.isArray(out?.[key]) ? out[key] : [];
  const want = Math.min(all.length, limit);
  const build = k => ({ ...out, shown: k, [key]: all.slice(0, k) });
  const fits = k => JSON.stringify(build(k), null, 1).length <= max - 400;
  let n = want;
  if (!fits(n)) { let lo = 1, hi = n; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; } n = lo; }
  const r = build(n);
  if (n < want) { r.truncated = true; r.truncatedNote = `only ${n} of ${want} requested entries fit the output limit; ask for a smaller limit`; }
  return r;
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const num = (x, lo, hi, dflt) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt; };

const PLAN_CAUTION = 'The circuit breaker is applied by a real tick, not to this plan: plannedActions may include actions a tick would drop.';
// Issue #675: reports every halted cause (count and entries, not only the oldest) and a failed breaker evaluation.
// A global halt has no types field: it stops every new job, so say so rather than leave null (issue #753).
const GLOBAL_TYPES = ['every new job'];
export function breakerHaltOf(b) {
  const h = b?.halt, error = b?.error ?? null;
  if (!h) return error ? { halted: false, error, note: 'Breaker evaluation failed; existing halts stay in force.' } : { halted: false };
  return { halted: true, scope: h.scope ?? null, cause: h.cause ?? null, count: h.count ?? 1, entries: (h.entries || []).slice(0, 8).map(e => ({ cause: e.cause ?? null, types: e.types ?? (e.cause === '@global' ? GLOBAL_TYPES : null), since: e.since ?? null })), error, caution: PLAN_CAUTION };
}
export function createTools({ source, readHost, readActivity = hostActivity, getPath = null, reports = null, inbox = createInbox({ dir: null }), now = Date.now }) {
  const calls = [];   // times of recent calls, for the rate limit
  const withView = async fn => { const r = await source.get(); return { ...fn(r.view), viewAgeSeconds: Math.round(r.ageMs / 1000), ...(r.stale ? { stale: true, staleBecause: r.error } : {}) }; };
  const reviewQueues = view => Object.fromEntries(Object.entries(view.queues || {}).map(([agent, items]) => [agent, (items || []).filter(i => i.type === 'review').sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.ref - b.ref).map(i => ({ order: i.order ?? null, pr: i.ref, next: !!i.next, title: i.title, reason: i.reason }))]));

  const defs = [
    { name: 'foreman_status', description: 'Foreman health: tick state, installed and main version, role slots, circuit breaker, per-agent allowance mode and idle reason, the planned next actions, running jobs and the count of Needs you items.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => withView(v => ({
        health: v.health, freshness: v.freshness, tick: { ...v.tick, at: iso(v.tick?.at), lastOkAt: iso(v.tick?.lastOkAt) }, nextTick: v.nextTick, version: v.version, teamEnabled: v.teamEnabled,
        slots: (v.slots || []).map(s => s.text), capNotes: v.capNotes, breaker: v.breaker ? { halt: v.breaker.halt, error: v.breaker.error ?? null, byCause: (v.breaker.byCause || []).slice(0, 8) } : null,
        agents: (v.agents || []).map(a => ({ name: a.name, state: a.state, idle: a.idleReason?.text ?? null })),
        budget: Object.fromEntries(Object.entries(v.budget || {}).map(([k, b]) => [k, { mode: b.mode, reason: b.reason, used: b.used, projected: b.projected }])),
        planned: (v.plan || []).map(a => ({ type: a.type, agent: a.agent ?? null, pr: a.pr ?? null, issue: a.issue ?? null, why: a.why ?? null })),
        running: (v.jobs || []).filter(j => ['running', 'queued', 'paused_limit', 'paused_manual'].includes(j.status)).map(j => ({ id: j.fullId, kind: j.kind, ref: j.ref, agent: j.agent, status: j.status, startedAt: iso(j.startedAt) })),
        needsYouCount: v.health?.count ?? v.panels?.needsYou?.length ?? (v.attention || []).filter(a => a.severity === 'action').length })) },
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
          out.needsYou = (v.attention || []).filter(a => a.ref?.n === n && (kind === 'pr' ? a.ref?.kind === 'pull' : a.ref?.kind === 'issue')).map(a => ({ text: a.text, tried: a.tried, action: a.action, severity: a.severity }));
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
    { name: 'foreman_plan', description: 'What the planner would do, as the dashboard recomputes it per request from the last tick\'s cached GitHub data (not a live dry run, and before the circuit breaker is applied): planned actions, why work waits, the open-PR cap and the next tick time. breakerHalt says when the breaker has halted jobs, in which case plannedActions may list actions a real tick would drop.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => withView(v => ({ plannedActions: v.plan || [], breakerHalt: breakerHaltOf(v.breaker), nextTickAt: v.nextTickAt ?? null, nextWhy: v.panels?.nextWhy ?? null, capNotes: v.capNotes ?? [], next: v.panels?.next ?? [], note: 'A live "team tick --dry-run" is not offered: it needs the state root, which this account cannot read.' })) },
    { name: 'foreman_host', description: 'Tower load average, memory and swap, plus (sampled over about half a second) swap in and out per second, disk wait (CPU iowait, blocked processes, busy percent per disk) and the top processes by memory with their swap, all from /proc. Short process names only, never command lines.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => { const base = readHost(); return { ...base, activity: await Promise.resolve().then(() => readActivity()).catch(() => null), readAt: iso(now()) }; } },
    { name: 'foreman_reports', description: 'Reports that hand-run sessions left for the overseer. With no name: the list (name, time, size, and whether it carries the finished marker), newest first. With a name: that one report as text (redacted, truncated if long), headed STATUS: finished or STATUS: UNFINISHED. A report is finished only when its last line is <!-- foreman-report: finished -->; one without it may be half written. Reads one fixed folder only.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'a report name from the list, for example speedup.md' } }, additionalProperties: false },
      run: args => { if (!reports) throw new Error('reports are not available on this server'); return args.name === undefined ? reports.list() : reports.read(args.name, MAX_TEXT - 400); } },
    { name: 'foreman_job_outcome', description: 'One job: what it was asked to do, what it did (tool counts, last message), whether any work was pushed (evidence), how it ended (status, post-condition and why not), its cost, and a redacted log tail. Give the full job id or a unique prefix of at least 6 characters (see foreman_jobs). Read-only, no model call.', inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 6, maxLength: 32, pattern: '^[a-f0-9]{6,32}$' } }, required: ['id'], additionalProperties: false },
      run: async args => {
        const id = String(args.id || '');
        if (!/^[a-f0-9]{6,32}$/.test(id)) throw new Error('give the job id (6 to 32 hex characters) from foreman_jobs');
        if (!getPath) throw new Error('job outcomes are not available on this server');
        let full = id;
        if (id.length < 32) { const r = await source.get(); const hits = (r.view.jobs || []).filter(j => String(j.fullId || '').startsWith(id)); if (hits.length !== 1) throw new Error(hits.length ? 'that prefix matches more than one job; give more characters' : 'no job with that id in the recent jobs (give the full 32-character id for an older job)'); full = hits[0].fullId; }
        return await getPath(`/api/jobs/${full}/outcome.json`);
      } },
    { name: 'foreman_discarded', description: 'Every result Foreman threw away in the last 7 days (a review refused at ingestion, a review that ended with no verdict, a job that failed after spending), newest first, with the cause and the cost (usage equivalent, not a charge). Optional limit (default 50, at most 200; if that many would not fit the output limit, fewer are returned and the cut is stated).', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
      run: async args => { if (!getPath) throw new Error('discarded results are not available on this server'); const out = await getPath('/api/discarded.json'); const limit = num(args.limit, 1, 200, 50); return fitItems(out, 'items', limit); } },
    { name: 'foreman_installs', description: 'Install history: what is installed against main, the pending install and whether it is draining (jobs still running), the last pre-check failure with the failing test names and excerpt, any rollback latch or refusal, the version each Foreman process (Foreman, dashboard, workers) is running, and recent install records. Optional limit on the records (default 15). Read-only, no model call.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 40 } }, additionalProperties: false },
      run: async args => { if (!getPath) throw new Error('install history is not available on this server'); const out = await getPath('/api/installs.json'); return { ...out, recent: (out.recent || []).slice(0, num(args.limit, 1, 40, 15)) }; } },
    { name: 'foreman_breaker_history', description: 'Every circuit-breaker trip, newest first: the cause, the wasted jobs and PRs, tokens and cost (usage equivalent, not a charge), when it tripped and when it was cleared (or that it is still halted). Optional limit (default 20). Read-only.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
      run: async args => { if (!getPath) throw new Error('breaker history is not available on this server'); const out = await getPath('/api/breaker.json'); const limit = num(args.limit, 1, 100, 20); return { ...out, shown: Math.min(out.trips?.length || 0, limit), trips: (out.trips || []).slice(0, limit) }; } },
    { name: 'foreman_diagnostics', description: 'The data behind the dashboard Diagnostics tab, for the last 7 days: tick gaps and late ticks, job turnaround, verdict lag, idle time by cause, pass statistics, the wake state and the host recorder summary by day (the hourly samples are left out). Shows where the cycle loses time. Read-only, no model call.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => { if (!getPath) throw new Error('diagnostics are not available on this server'); const out = await getPath('/api/diagnostics.json'); const { hourly, ...recorder } = out.recorder || {}; return { ...out, recorder: { ...recorder, hourlySamplesOmitted: Array.isArray(hourly) ? hourly.length : 0 }, from: iso(out.from), to: iso(out.to), generatedAt: iso(out.generatedAt) }; } },
    { name: 'foreman_waste', description: 'Tokens and cost (usage equivalent, not a charge) wasted on jobs that left no usable result, grouped by failure cause, in total and per day (UTC). Optional days (1 to 30, default 7; the record holds the last 7 days). Read-only.', inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
      run: async args => { if (!getPath) throw new Error('waste figures are not available on this server'); return getPath(`/api/waste.json?days=${num(args.days, 1, 30, 7)}`); } },
    { name: 'foreman_config', description: 'The configuration Foreman uses now (shipped team.json plus the team.local.json override) with secrets removed, and a list of every setting that differs from the shipped default. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => { if (!getPath) throw new Error('the configuration is not available on this server'); return getPath('/api/config.json'); } },
    { name: 'foreman_budget', description: 'Per agent allowance and scheduling: the mode and why it holds (or what holds it), when it ends, the weekly window (used, reset time, hours left), the rate behind the estimate and where the rate came from, the estimate at reset (for information only, it never sets a mode), typical job costs, and the thresholds in force (when the dashboard serves its configuration). Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => { const cfg = getPath ? await getPath('/api/config.json').catch(() => null) : null; return withView(v => ({
        agents: Object.fromEntries(Object.entries(v.budget || {}).map(([name, b]) => [name, {
          mode: b.mode, label: b.label ?? null, why: b.reason ?? null, endsAt: iso(b.until), known: b.known,
          weekly: { used: b.used, resetsAt: iso(b.resetsAt), hoursLeft: Number.isFinite(b.hoursLeft) ? Math.round(b.hoursLeft * 10) / 10 : null },
          rate: { perHour: b.ratePerHour, source: b.rateSource, estimateAtReset: b.projected, runsOutAt: iso(b.runsOutAt), note: 'The estimate is for information only; it does not set a mode (issue #680).' },
          shortWindow: b.shortWindow ? { used: b.shortWindow.used, resetsAt: iso(b.shortWindow.resetsAt) } : null, overage: !!b.overage, creditsAvailable: !!b.creditsAvailable, typicalJobCost: b.jobCost ?? {}, heldJobTypes: b.held ?? {},
        }])),
        thresholds: cfg?.effective?.budget ? { enabled: cfg.effective.budget.enabled ?? null, highWater: cfg.effective.budget.high_water ?? null, highWaterMinHours: cfg.effective.budget.high_water_min_hours ?? null, exhaustedAt: cfg.effective.budget.exhausted_at ?? null, recentHours: cfg.effective.budget.recent_hours ?? null, canTakeOver: cfg.effective.budget.can_take_over ?? null } : null,
        note: 'Figures are the provider\'s own allowance readings; job costs are usage equivalents, not charges.' })); } },
    { name: 'foreman_tests', description: 'Test-slot use: slots in use and free, the runs holding a slot, the queue with how long each waits, and the last 7 days of refused runs (no headroom or no free slot in time), timed-out runs, memory-killed runs and orphaned processes (survived SIGKILL), with the reason. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => { if (!getPath) throw new Error('test-slot figures are not available on this server'); return getPath('/api/tests.json'); } },
    { name: 'foreman_ticks', description: 'Recent Foreman ticks, newest first: when, what started it, duration, status, the actions planned, errors, GitHub calls and no-op passes; plus the ticks skipped in the last 24 hours with the reason. Optional limit (default 20, at most 100). Read-only.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
      run: async args => { if (!getPath) throw new Error('tick records are not available on this server'); return getPath(`/api/ticks.json?limit=${num(args.limit, 1, 100, 20)}`); } },
    { name: 'foreman_item_timeline', description: 'One pull request or issue across its jobs, reviews, fixes, rebases and merge, oldest first, with agent, status, duration and cost (usage equivalent, not a charge). For a pull request the jobs of its issue are included. Optional limit (default 60, at most 200). Read-only.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['pr', 'issue'] }, number: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['kind', 'number'], additionalProperties: false },
      run: args => {
        const n = Number(args.number), kind = args.kind;
        if (!Number.isInteger(n) || n < 1 || !['pr', 'issue'].includes(kind)) throw new Error('give kind "pr" or "issue" and a positive integer number');
        return withView(v => itemTimeline(v, kind, n, { limit: num(args.limit, 1, 200, 60) }));
      } },
    { name: 'foreman_mismatches', description: 'Records that disagree with reality, read from the dashboard view: an issue recorded as implemented with no pull request or job, a review that finished with no verdict recorded, stale needs-homeowner labels, and holds kept by old jobs. Each has the evidence. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => withView(v => mismatches(v, now())) },
    { name: 'foreman_needs_you', description: 'The Needs you items grouped by cause, with the count, the pull requests or issues involved and the action asked for each group, so a cluster of one cause shows as one decision. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => withView(v => needsYouGroups(v)) },
    { name: 'foreman_rebase_stats', description: 'Rebases per merged pull request, reviews per merged pull request, and the time from first recorded activity to merge (mean and median), for all merged pull requests the view holds and, with splitAt (ISO date), before and after that time, so a change to the rebase policy can be measured. Read-only.', inputSchema: { type: 'object', properties: { splitAt: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
      run: args => withView(v => rebaseStats(v, { splitAt: args.splitAt === undefined ? null : String(args.splitAt), limit: args.limit })) },
    ...(inbox.enabled ? [
      { name: 'foreman_propose', description: 'Propose one item for the homeowner to approve on the Foreman dashboard. kind "prompt": a task to run as a supervised Foreman job (it cannot merge, approve reviews or widen its limits). kind "issue_draft": an issue to post as the homeowner. kind "action": one named job action (new_review_attempt with a PR number, reopen with an issue number, close_job, stop_job or resume_job with an 8-character job id) plus a reason. This only writes a proposal; nothing happens until the homeowner approves it, and you cannot approve it. Secret-shaped text, AI attribution text, oversized items and unknown fields are refused. Read the outcome with foreman_proposal_status.',
        inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['prompt', 'issue_draft', 'action'] }, title: { type: 'string', maxLength: 200 }, action: { type: 'string', enum: ['new_review_attempt', 'reopen', 'close_job', 'stop_job', 'resume_job'], description: 'kind action: the named action' }, target: { type: 'string', maxLength: 12, description: 'kind action: PR or issue number, or 8-character job id' }, reason: { type: 'string', maxLength: 300, description: 'kind action: why' }, prompt: { type: 'string', maxLength: 8000, description: 'kind prompt: the task text' }, body: { type: 'string', maxLength: 8000, description: 'kind issue_draft: the issue body' }, why: { type: 'string', maxLength: 400, description: 'optional: why this is proposed' } }, required: ['kind', 'title'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, run: args => inbox.propose(args) },
      { name: 'foreman_proposal_status', description: 'The state of a proposal made with foreman_propose: waiting, pending (awaiting the homeowner), refused (with the reason), rejected, approved, running, done or failed, with the result summary once there is one.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, required: ['id'], additionalProperties: false }, run: args => inbox.status(args.id) },
    ] : []),
  ];

  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  return {
    list: () => defs.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations: annotations || READ_ONLY })),
    has: name => defs.some(d => d.name === name),
    async call(name, args = {}) {
      const def = defs.find(d => d.name === name);
      if (!def) { const e = new Error(`unknown tool: ${String(name).slice(0, 60)}`); e.code = -32602; throw e; }
      const t = now(); while (calls.length && t - calls[0] > 60000) calls.shift();
      if (calls.length >= CALLS_PER_MINUTE) return { isError: true, text: `rate limit: more than ${CALLS_PER_MINUTE} calls in a minute; try again shortly` };
      calls.push(t);
      // Layering: reports.read redacts before it truncates, so a secret cannot straddle the cut. This second
      // redaction is a deliberate backstop for every string-returning tool, not the primary control; the slice only bounds length.
      try { const out = await def.run(args && typeof args === 'object' ? args : {}); return { isError: false, text: typeof out === 'string' ? redact(out).slice(0, MAX_TEXT) : bounded(redactDeep(out)) }; }
      catch (error) { return { isError: true, text: bounded(redactDeep({ error: String(error?.message || error).slice(0, 400) })) }; }
    },
  };
}
