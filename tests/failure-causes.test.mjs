// Issue #1020: every failed job records one honest cause from a fixed list with the tokens it cost; per-cause figures per day and week on
// the dashboard, in foreman status and over the read-only MCP route; three jobs of one cause inside an hour draft a post-mortem into the Inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as F from '../supervisor/failcause.mjs';
import * as inboxStore from '../supervisor/inbox.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute, matchRoute } from '../supervisor/dashrender.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const NOW = 1_800_000_000_000, HOUR = 3600000, DAY = 86400000;
const H = n => String(n).repeat(40).slice(0, 40);
const job = (over = {}) => ({ id: 'j1', status: 'blocked', kind: 'review', lastEvent: 'incomplete', updatedAt: NOW, incompleteReason: { cause: 'postcondition_not_met', detail: 'the post-condition did not hold' },
  usage: { inputTokens: 1000, outputTokens: 500, costUsdEstimate: 2.5 }, ...over });
const okHost = { diskFreeMb: 50000, memAvailMb: 8000, swapUsedPct: 5 };

test('each cause in the fixed list is chosen from the job evidence', () => {
  const c = (o, expect) => assert.equal(F.classifyFailure({ host: okHost, ...o }).cause, expect, JSON.stringify(o).slice(0, 120));
  c({ job: job({ lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'git: write error: No space left on device' } }) }, 'environment');
  c({ job: job({ lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'the run ended with crash (exit 1)' } }), host: { ...okHost, diskFreeMb: 40 } }, 'environment');
  c({ job: job({ lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'x' } }), host: { ...okHost, memAvailMb: 100 } }, 'environment');
  c({ job: job({ lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'x' } }), host: { ...okHost, memAvailMb: 800, swapUsedPct: 95 } }, 'environment');
  c({ job: job({ lastEvent: 'network_error' }) }, 'environment');
  c({ job: job({ lastEvent: 'idle_timeout', status: 'failed' }) }, 'wedged');
  c({ job: job(), repeats: 2 }, 'deterministic');
  c({ job: job({ lastEvent: 'context_too_large' }) }, 'deterministic');
  c({ job: job({ kind: 'fix', status: 'failed' }), entry: { kind: 'fix', pr: 4 }, fixLimitReached: true }, 'review_disagreement');
  c({ job: job({ kind: 'implement', incompleteReason: { cause: 'postcondition_not_met', detail: 'stopped: prerequisite #991 is not done yet' } }) }, 'prerequisite_open');
  c({ job: job({ kind: 'implement', lastEvent: 'context_too_large' }), openPrerequisites: [991] }, 'prerequisite_open');
  c({ job: job({ status: 'completed' }), refusal: 'invalid-ticket' }, 'identity_evidence');
  c({ job: job({ incompleteReason: { cause: 'postcondition_not_met', detail: 'no writer record for the head' } }) }, 'identity_evidence');
  c({ job: job({ incompleteReason: { cause: 'postcondition_not_met', detail: 'validator fault: boom' } }) }, 'foreman_bug');
  c({ job: job({ lastEvent: 'usage_limit', status: 'blocked', incompleteReason: { cause: 'usage_limit', detail: 'x' } }) }, 'provider_limit');
  c({ job: job({ lastEvent: 'approval_required' }) }, 'homeowner_decision');
  c({ job: job() }, 'unclassified');
  for (const k of Object.keys(F.FAIL_CAUSES)) assert.ok(F.CAUSE_KEYS.includes(k));
  assert.equal(F.classifyFailure({ job: job() , host: okHost }).detail.length > 0, true);
});

test('a prerequisite stop is not mistaken for the disk even when the disk is low; error text outranks the readings', () => {
  const stop = job({ kind: 'implement', incompleteReason: { cause: 'postcondition_not_met', detail: 'blocked by #991' } });
  assert.equal(F.classifyFailure({ job: stop, host: { ...okHost, diskFreeMb: 10 } }).cause, 'prerequisite_open');
  const full = job({ lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'ENOSPC: no space left on device, write' } });
  assert.equal(F.classifyFailure({ job: full, host: okHost }).cause, 'environment', 'full disk named by the job even when the reading looks fine');
});

test('figures per cause per day and week, ordered by waste; old records fall out', () => {
  const s = {};
  const add = (id, cause, ago, tokens, cost, pr) => F.recordFailure(s, { job: id, at: NOW - ago, type: 'review', cause, detail: 'd', stop: 'x', agent: 'claude', pr, issue: null, inputTokens: tokens, outputTokens: 0, tokens, cost }, NOW);
  add('a', 'environment', HOUR, 100, 1, 1); add('b', 'environment', 2 * HOUR, 200, 2, 2); add('c', 'wedged', 3 * HOUR, 5000, 9, 3); add('d', 'wedged', 3 * DAY, 10, 0.5, 4); add('e', 'deterministic', 20 * DAY, 1, 1, 5);
  assert.equal(F.recordFailure(s, s.records.a, NOW), false, 'the same job is recorded once');
  const sum = F.summarize(s, { now: NOW });
  assert.deepEqual(sum.day.map(r => [r.cause, r.jobs, r.tokens, r.cost]), [['wedged', 1, 5000, 9], ['environment', 2, 300, 3]]);
  assert.deepEqual(sum.week.map(r => [r.cause, r.jobs]), [['wedged', 2], ['environment', 2]]);
  assert.deepEqual(sum.day[1].prs, [1, 2]);
  assert.equal(sum.week.some(r => r.cause === 'deterministic'), false, 'older than a week');
  assert.equal(sum.byDay[0].causes.length >= 1, true);
});

test('three jobs of one cause inside an hour make a post-mortem item the inbox accepts; two, or a spread-out three, do not', () => {
  const s = {}; const mk = (id, ago, cause = 'environment') => F.recordFailure(s, { job: id, at: NOW - ago, type: 'review', cause, detail: 'disk nearly full: 40 MB free', stop: 'crash', agent: 'claude', pr: 40, issue: null, inputTokens: 5, outputTokens: 5, tokens: 10, cost: 1.25 }, NOW);
  mk('a', 50 * 60000); mk('b', 20 * 60000);
  assert.deepEqual(F.postmortemsDue(s, { now: NOW }), []);
  mk('c', 5 * 60000, 'wedged'); assert.deepEqual(F.postmortemsDue(s, { now: NOW }), [], 'a different cause does not count');
  mk('d', 1 * 60000);
  const due = F.postmortemsDue(s, { now: NOW }); assert.equal(due.length, 1); assert.equal(due[0].cause, 'environment'); assert.equal(due[0].records.length, 3);
  const item = F.postmortemItem(due[0]);
  assert.equal(inboxStore.validateItem(item).ok, true, inboxStore.validateItem(item).reason);
  assert.match(item.body, /Tokens spent: 30/); assert.match(item.body, /\$3\.75/); assert.match(item.body, /PR #40/); assert.match(item.body, /First failure: .*\n- Last failure/);
  F.markDrafted(s, due[0].records, NOW); assert.deepEqual(F.postmortemsDue(s, { now: NOW }), [], 'drafted once');
  const spread = {}; for (const [id, ago] of [['x', 3 * HOUR], ['y', 90 * 60000], ['z', 1000]]) F.recordFailure(spread, { job: id, at: NOW - ago, type: 'review', cause: 'wedged', detail: 'd', stop: 's', pr: 1, issue: null, inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0 }, NOW);
  assert.deepEqual(F.postmortemsDue(spread, { now: NOW }), []);
});

test('readHost returns numbers or nulls and never throws', () => {
  const h = F.readHost(os.tmpdir()); for (const k of ['diskFreeMb', 'memAvailMb', 'swapUsedPct']) assert.ok(h[k] === null || Number.isFinite(h[k]), k);
  assert.deepEqual(F.readHost('/no/such/dir/at/all', { meminfo: '/no/such/file' }), { diskFreeMb: null, memAvailMb: null, swapUsedPct: null });
});

// ---- through the Team ----
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = inboxDir => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 }, ...(inboxDir ? { inbox: { dir: inboxDir } } : {}),
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const prOf = (n, branch, head) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });
function world(t, { inbox = true, host = okHost } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failcause-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inboxDir = path.join(dir, 'inbox'); fs.mkdirSync(inboxDir);
  const gh = { pulls: [prOf(40, 'codex/issue-30-x', H(1))], listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null,
    listIssues: async () => [{ number: 5, title: 'Five', state: 'OPEN', body: 'Prerequisites: #4', labels: [] }, { number: 4, title: 'Four', state: 'OPEN', body: '', labels: [] }],
    listMergedPulls: async () => [], comment: async () => {}, hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {}, addLabel: async () => {}, removeLabel: async () => {} };
  const jobs = { states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, create: async () => ({ id: 'x'.repeat(32) }) };
  const team = new Team({ config: config(inbox ? inboxDir : null), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: '## D-020 — x\n- Status: homeowner-approved\n',
    clock: { now: () => NOW }, hostReader: () => host, eventKinds: () => [] });
  return { dir, inboxDir, gh, jobs, team };
}
const add = (w, id, entry, j) => { w.team.s.jobs[id] = { agent: 'claude', ticket: 'a'.repeat(32), key: id, at: NOW - 1000, ingested: false, ...entry }; w.jobs.states[id] = { id, updatedAt: NOW - 1000, ...j }; };

test('a job killed by a full disk records environment; a job stopped on an open prerequisite records prerequisite open', async t => {
  const w = world(t, { host: { ...okHost, diskFreeMb: 12 } });
  add(w, 'disk', { kind: 'review', pr: 40, head: H(1) }, job({ id: 'disk', status: 'failed', lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'the run ended with crash (exit 1)' } }));
  const w2 = world(t);
  add(w2, 'pre', { kind: 'implement', issue: 5 }, job({ id: 'pre', kind: 'implement', status: 'blocked', lastEvent: 'context_too_large', incompleteReason: undefined }));
  const report = { ingested: [], skipped: [] }, report2 = { ingested: [], skipped: [] };
  await w.team.ingest(report); await w2.team.ingest(report2);
  const d = w.team.s.failCauses.records.disk; assert.equal(d.cause, 'environment'); assert.match(d.detail, /12 MB free/); assert.equal(d.tokens, 1500); assert.equal(d.cost, 2.5); assert.equal(d.pr, 40);
  const p = w2.team.s.failCauses.records.pre; assert.equal(p.cause, 'prerequisite_open'); assert.match(p.detail, /#4/); assert.equal(p.issue, 5);
  await w.team.ingest(report); assert.equal(Object.keys(w.team.s.failCauses.records).length, 1, 'recorded once');
  const status = await w.team.breakerStatus(); assert.equal(status.failCauses.week[0].cause, 'environment');
});

test('a successful job records no failure cause', async t => {
  const w = world(t);
  add(w, 'ok', { kind: 'review', pr: 40, head: H(1) }, job({ id: 'ok', status: 'blocked' }));
  w.team.s.verdicts['40:ok'] = { verdict: 'CHANGES', job: 'ok', reviewer: 'claude' };   // the review delivered its verdict
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.deepEqual(w.team.s.failCauses.records, {});
});

test('three environment failures inside an hour put one post-mortem draft in the Inbox; it is not repeated', async t => {
  const w = world(t, { host: { ...okHost, diskFreeMb: 12 } });
  for (const [i, id] of ['a', 'b', 'c'].entries()) add(w, id, { kind: 'review', pr: 40 + i, head: H(1) }, job({ id, status: 'failed', lastEvent: 'crash', updatedAt: NOW - (3 - i) * 60000, incompleteReason: { cause: 'crash', detail: 'x' } }));
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report);
  assert.equal(report.postmortems?.length, 1, JSON.stringify(report.skipped));
  const items = fs.readdirSync(path.join(w.inboxDir, 'items')); assert.equal(items.length, 1);
  const item = JSON.parse(fs.readFileSync(path.join(w.inboxDir, 'items', items[0]), 'utf8'));
  assert.equal(item.kind, 'issue_draft'); assert.match(item.title, /environment/); assert.match(item.body, /PR #40, PR #41, PR #42/);
  inboxStore.scan(w.inboxDir, NOW); assert.equal(inboxStore.allStatuses(w.inboxDir).filter(s => s.state === 'pending').length, 1, 'the inbox takes it as a pending card');
  add(w, 'd', { kind: 'review', pr: 43, head: H(1) }, job({ id: 'd', status: 'failed', lastEvent: 'crash', updatedAt: NOW - 1000, incompleteReason: { cause: 'crash', detail: 'x' } }));
  await w.team.ingest(report); assert.equal(fs.readdirSync(path.join(w.inboxDir, 'items')).length, 1, 'one more failure alone does not draft again');
});

test('with no inbox configured nothing is drafted and nothing fails', async t => {
  const w = world(t, { inbox: false, host: { ...okHost, diskFreeMb: 12 } });
  for (const [i, id] of ['a', 'b', 'c'].entries()) add(w, id, { kind: 'review', pr: 40 + i, head: H(1) }, job({ id, status: 'failed', lastEvent: 'crash', updatedAt: NOW - 60000, incompleteReason: { cause: 'crash', detail: 'x' } }));
  const report = { ingested: [], skipped: [] }; await w.team.ingest(report);
  assert.equal(report.postmortems, undefined); assert.equal(Object.keys(w.team.s.failCauses.records).length, 3);
});

test('the dashboard view and the read-only tool carry the per-cause figures', async t => {
  const s = {}; F.recordFailure(s, { job: 'a', at: NOW - HOUR, type: 'review', cause: 'wedged', detail: 'd', stop: 'x', pr: 7, issue: null, inputTokens: 10, outputTokens: 5, tokens: 15, cost: 1.5 }, NOW);
  const w = world(t); w.team.s.failCauses = { records: s.records, drafted: {} };
  const bview = await buildView({ config: config(), root: w.team.root, jobs: [], events: [], state: w.team.s, register: '', cache: { tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 }, pulls: [], issues: [] }, snapshots: [], now: NOW });
  const view = bview;
  const text = renderRoute(bview, matchRoute('/')).html;
  assert.match(text, /wedged \(no activity\)/); assert.match(text, /PR #7/);
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}), getPath: async p => { assert.match(p, /^\/api\/failure-causes\.json\?days=3$/); return view.breaker.failCauses; } });
  const out = await tools.call('foreman_failure_causes', { days: 3 }); assert.equal(out.isError, false); assert.equal(JSON.parse(out.text).week[0].cause, 'wedged');
  assert.equal((await tools.call('foreman_status')).isError, false);
});
