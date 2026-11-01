// Team dashboard (issue #32): view model, attention and queue rules, cache/history writer, read-only server.
// No GitHub call and no model call anywhere in these tests; the "no gh" test proves the server cannot reach gh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pauseDisagreement, buildView } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';
import { MAX_SNAPSHOTS, appendSnapshot, compactIssues, compactPulls, readCache, readSnapshots, recordTick, redact, tickOutcome } from '../supervisor/dashdata.mjs';
import { handler, validateBind, currentView } from '../supervisor/dashserver.mjs';
import { Team } from '../supervisor/team.mjs';
import { addUsage, usageFromLine } from '../supervisor/usage.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/dashboard/paused-limit-1315.json', import.meta.url), 'utf8'));
delete fx._note;
const NOW = fx.updatedAt + 60000;          // one minute after the real pause
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `pr ${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN', body = '', labels = []) => ({ number: n, title: `issue ${n}`, state, body, labels });
const job = (over = {}) => ({ id: 'a'.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, ...over });

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  return root;
}
const view = (t, { jobs = [], cache, snapshots = [], state = {}, cfg = config(), now = NOW, events = [] } = {}) =>
  buildView({ config: cfg, root: setup(t), jobs, events, state, cache, snapshots, now });
const okTick = (at = NOW - 60000) => ({ at, status: 'ok', error: null, lastOkAt: at });
const ids = v => v.attention.map(a => a.id);

// ---- the pause-versus-allowance rule, with the real 13:15 case
test('the real 13:15 case: paused_limit while the provider reports 34% session and 18% week is flagged as a disagreement', async t => {
  assert.equal(pauseDisagreement(fx, fx.allowance, NOW).kind, 'disagrees');
  assert.match(pauseDisagreement(fx, fx.allowance, NOW).text, /5-hour 34%, weekly 18% used/);
  const v = await view(t, { jobs: [fx], cache: { tick: okTick(), pulls: [], issues: [issue(30)] } });
  assert.ok(ids(v).includes('pause-claude'));
  assert.equal(v.agents.find(a => a.name === 'claude').state, 'paused');
  const j = v.agents.find(a => a.name === 'claude').job;
  assert.equal(j.lastEvent, 'usage_limit'); assert.equal(j.resetAt, null); assert.equal(j.nextAttemptAt, fx.nextAttemptAt);
  assert.match(renderPage(v), /provider reports capacity left/);
});
test('a pause is consistent with a top-level rejected, blocked or exhausted allowance status (PR #36 review)', () => {
  for (const status of ['rejected', 'blocked', 'exhausted', 'limit_reached']) {
    const a = structuredClone(fx.allowance); a.status = status;
    assert.equal(pauseDisagreement(fx, a, NOW), null, status);
  }
  const ok = structuredClone(fx.allowance); ok.status = 'allowed';
  assert.equal(pauseDisagreement(fx, ok, NOW).kind, 'disagrees');
});
test('a pause is consistent with a genuinely exhausted window, a rejected status, or a Codex reached limit', () => {
  const full = structuredClone(fx.allowance); full.windows[0].utilization = 1;
  assert.equal(pauseDisagreement(fx, full, NOW), null);
  const rejected = structuredClone(fx.allowance); rejected.windows[0].status = 'rejected';
  assert.equal(pauseDisagreement(fx, rejected, NOW), null);
  assert.equal(pauseDisagreement(fx, { provider: 'codex', status: 'limit_reached', windows: [{ type: 'primary', utilization: 0.5, status: 'unknown' }] }, NOW), null);
});
test('no allowance data: the pause is called unverifiable, never a confirmed disagreement or an estimate', () => {
  assert.equal(pauseDisagreement(fx, null, NOW).kind, 'unverifiable');
  assert.equal(pauseDisagreement(fx, { provider: 'claude', windows: [] }, NOW).kind, 'unverifiable');
  assert.equal(pauseDisagreement(fx, { provider: 'claude', windows: [{ type: 'five_hour', utilization: null, status: 'allowed' }] }, NOW).kind, 'unverifiable');
});
test('only a usage_limit pause is judged; manual pauses, transient 429s and running jobs are not', () => {
  assert.equal(pauseDisagreement({ ...fx, lastEvent: 'transient_rate_limit' }, fx.allowance, NOW), null);
  assert.equal(pauseDisagreement({ ...fx, status: 'paused_manual', lastEvent: 'manual_pause' }, fx.allowance, NOW), null);
  assert.equal(pauseDisagreement({ ...fx, status: 'running' }, fx.allowance, NOW), null);
});
test('the freshest provider-reported allowance decides: a newer job record showing an exhausted window clears the flag', async t => {
  const newer = job({ id: 'b'.repeat(32), provider: 'claude', status: 'completed', createdAt: NOW - 5000, issue: 99,
    allowance: { provider: 'claude', status: 'rejected', windows: [{ type: 'five_hour', utilization: 1, resetsAt: NOW + 3600000, status: 'rejected' }], observedAt: NOW - 1000 } });
  const v = await view(t, { jobs: [fx, newer], cache: { tick: okTick(), pulls: [], issues: [] } });
  assert.ok(!ids(v).includes('pause-claude'));
});

// ---- attention rules
test('tick rules: failed tick shows time and (redacted) error; no tick for more than 10 minutes; never ticked', async t => {
  let v = await view(t, { cache: { tick: { at: NOW - 120000, status: 'error', error: 'gh pr list failed: HTTP 401 for alice@example.com' }, pulls: [], issues: [] } });
  const failed = v.attention.find(a => a.id === 'tick-failed');
  assert.match(failed.text, /2026-10-30T/); assert.match(failed.text, /HTTP 401/); assert.doesNotMatch(failed.text, /alice@example\.com/);
  v = await view(t, { cache: { tick: okTick(NOW - 11 * 60000), pulls: [], issues: [] } });
  assert.ok(ids(v).includes('tick-stale'));
  v = await view(t, { cache: { tick: okTick(NOW - 9 * 60000), pulls: [], issues: [] } });
  assert.ok(!ids(v).includes('tick-stale'));
  v = await view(t, {});
  assert.ok(ids(v).includes('no-tick'));
});
test('needs-homeowner issues, blocked jobs, and red CI are pinned; a superseded blocked job is not', async t => {
  const blocked = job({ id: 'c'.repeat(32), status: 'blocked', lastEvent: 'incomplete', issue: 5, updatedAt: NOW - 3600000 });
  const cache = { tick: okTick(), issues: [issue(5, 'OPEN', '', ['needs-homeowner'])], pulls: [pr(9, 'codex/issue-2-a', H(1), { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })] };
  const v = await view(t, { jobs: [blocked], cache });
  assert.ok(ids(v).includes('homeowner-5')); assert.ok(ids(v).includes(`job-${blocked.id}`)); assert.ok(ids(v).includes('ci-9'));
  assert.equal(v.agents.find(a => a.name === 'claude').state, 'blocked');
  const retry = job({ id: 'd'.repeat(32), status: 'running', issue: 5, createdAt: NOW - 1000 });
  const v2 = await view(t, { jobs: [blocked, retry], cache: { ...cache, issues: [issue(5)] } });
  assert.ok(!ids(v2).includes(`job-${blocked.id}`));
});
test('draft PRs with red CI are not alarms; green PRs are quiet', async t => {
  const v = await view(t, { cache: { tick: okTick(), issues: [], pulls: [pr(9, 'codex/issue-2-a', H(1), { isDraft: true, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }), pr(10, 'codex/issue-3-a', H(2))] } });
  assert.deepEqual(ids(v), []);
});
test('idle agent with work: flagged only when the same plan has stood, idle, for 9+ minutes (or the loop is off)', async t => {
  const cache = { tick: okTick(), pulls: [], issues: [issue(30), issue(5, 'OPEN', 'Prerequisites: #77'), issue(77)] };
  const snap = at => ({ at, status: 'ok', plan: [{ agent: 'claude', type: 'implement', ref: 30 }], agents: { claude: 'idle', codex: 'idle' } });
  let v = await view(t, { cache, snapshots: [snap(NOW - 600000), snap(NOW - 300000), snap(NOW - 10000)] });
  assert.deepEqual(v.plan.map(a => [a.agent, a.type, a.issue]), [['claude', 'implement', 30], ['codex', 'implement', 2]].filter(x => cache.issues.some(i => i.number === x[2])).map(x => x));
  assert.ok(ids(v).includes('idle-claude'));
  v = await view(t, { cache, snapshots: [snap(NOW - 60000)] });                 // just planned: the next tick will start it
  assert.ok(!ids(v).includes('idle-claude'));
  v = await view(t, { cache, snapshots: [snap(NOW - 600000), snap(NOW - 10000)], jobs: [job()] });   // busy agent is not idle
  assert.ok(!ids(v).includes('idle-claude'));
  v = await view(t, { cache, cfg: config({ enabled: false }) });
  assert.match(v.attention.find(a => a.id === 'idle-claude').text, /disabled/);
  assert.ok(!ids(v).includes('tick-stale'));
});

// ---- queue
test('queue reasons: waiting on CI, blocked by #n, awaiting review of sha, draft, CHANGES, ready to merge', async t => {
  const cache = { tick: okTick(), issues: [issue(30, 'OPEN', 'Prerequisites: #5'), issue(5), issue(2), issue(3, 'OPEN', '', ['needs-homeowner'])],
    pulls: [pr(11, 'claude/issue-5-x', H(1), { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }), pr(12, 'claude/issue-6-x', H(2), { isDraft: true }), pr(13, 'claude/issue-7-x', H(3)),
      pr(14, 'claude/issue-8-x', H(4)), pr(15, 'codex/issue-9-x', H(5)), pr(16, 'claude/issue-10-x', H(6), { mergeable: 'CONFLICTING' })] };
  const state = { verdicts: { [`14:${H(4)}`]: { verdict: 'CHANGES', reviewer: 'codex' }, [`15:${H(5)}`]: { verdict: 'PASS', reviewer: 'claude' }, [`16:${H(6)}`]: { verdict: 'PASS', reviewer: 'codex' } }, implemented: {}, jobs: {} };
  const v = await view(t, { cache, state });
  const q = (agent, ref) => v.queues[agent].find(i => i.ref === ref)?.reason;
  assert.equal(q('claude', 11), 'waiting on CI');
  assert.equal(q('claude', 12), 'draft');
  assert.match(q('claude', 13), /awaiting codex review of 3333333/);
  assert.match(q('claude', 14), /CHANGES from codex on 4444444; fix waits for a free slot/);
  assert.match(q('codex', 15), /PASS from claude; merges on the next tick/);
  assert.match(q('claude', 16), /PASS from codex but not mergeable \(conflicting\)/);
  assert.equal(q('claude', 30), 'blocked by #5');
  assert.equal(q('codex', 3), 'needs the homeowner');
  assert.match(q('codex', 2), /ready; waits behind review PR #13/);
  assert.match(v.queues.codex.find(i => i.type === 'review' && i.ref === 13).reason, /review PR #13 at 3333333 \(next\)/);
  assert.equal(v.queues.codex[0].next, true);          // the planned item is listed first
});
test('the queue is the dispatcher\'s own plan(): identical actions to Team.plan on the same data', async t => {
  const cache = { tick: okTick(), issues: [issue(30), issue(2)], pulls: [pr(13, 'claude/issue-7-x', H(3))] };
  const root = setup(t);
  const cfg = config({ agents: { ...config().agents, claude: { ...config().agents.claude, issues: [5, 30] } } });
  const v = await buildView({ config: cfg, root, jobs: [], events: [], state: {}, cache, snapshots: [], now: NOW });
  const team = new Team({ config: config(), root, gh: { listPulls: async () => cache.pulls, listIssues: async () => cache.issues.map(i => ({ ...i, labels: [] })) }, jobs: { listActive: async () => [] }, git: null });
  assert.deepEqual(v.plan, await team.plan());
});

// ---- usage never estimated
test('usage: allowance windows come from provider records; absent data is "unknown", not a guess', async t => {
  const codexJob = job({ id: 'e'.repeat(32), provider: 'codex', kind: 'review', issue: 7, status: 'completed', usage: { inputTokens: 1200, outputTokens: 300, costUsdEstimate: null },
    allowance: { provider: 'codex', status: 'allowed', windows: [{ type: 'primary', windowMinutes: 300, utilization: 0.46, resetsAt: NOW + 1000, status: 'unknown' }, { type: 'secondary', windowMinutes: 10080, utilization: 0.41, resetsAt: NOW + 5000, status: 'unknown' }], observedAt: NOW - 100 } });
  const v = await view(t, { jobs: [codexJob], cache: { tick: okTick(), pulls: [], issues: [] } });
  assert.deepEqual(v.usage.codex.windows.map(w => [w.label, w.utilization]), [['5-hour', 0.46], ['weekly', 0.41]]);
  assert.deepEqual(v.usage.claude.windows, []);
  const html = renderPage(v, { route: { page: 'usage' } });
  assert.match(html, /Allowance: <b>unknown<\/b>/); assert.match(html, /not billing/); assert.match(html, /1,200/);
  assert.match(html, /unknown/);
});

// ---- tokens
test('usageFromLine reads counts and the CLI cost estimate only; addUsage sums', () => {
  assert.deepEqual(usageFromLine(JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, total_cost_usd: 0.25, result: 'secret text' })), { inputTokens: 110, outputTokens: 5, costUsdEstimate: 0.25 });
  assert.deepEqual(usageFromLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 2 } })), { inputTokens: 7, outputTokens: 2, costUsdEstimate: null });
  // Real-format Codex event: cached input is a subset of input_tokens, never added.
  assert.deepEqual(usageFromLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9911, cached_input_tokens: 8960, output_tokens: 5 } })), { inputTokens: 9911, outputTokens: 5, costUsdEstimate: null });
  assert.equal(usageFromLine('not json'), null); assert.equal(usageFromLine(JSON.stringify({ type: 'assistant', usage: { input_tokens: 1 } })), null);
  assert.equal(usageFromLine(JSON.stringify({ type: 'result', usage: { input_tokens: -4, output_tokens: 'x' } })).inputTokens, 0);
  assert.deepEqual(addUsage({ inputTokens: 1, outputTokens: 2, costUsdEstimate: null }, { inputTokens: 3, outputTokens: 4, costUsdEstimate: 0.5 }), { inputTokens: 4, outputTokens: 6, costUsdEstimate: 0.5 });
});

// ---- graphs
test('graphs: allowance series with reset marks, jobs per day, verdicts, issue-to-merge hours, tokens per merged PR', async t => {
  const snap = (at, u, resetsAt) => ({ at, status: 'ok', plan: [], agents: {}, allowance: { claude: { observedAt: at, windows: [{ type: 'five_hour', utilization: u, resetsAt }] }, codex: null } });
  const merged = job({ id: 'f'.repeat(32), kind: 'implement', issue: 5, status: 'completed', usage: { inputTokens: 900, outputTokens: 100, costUsdEstimate: 1 } });
  const state = { verdicts: { [`1:${H(1)}`]: { verdict: 'PASS', reviewer: 'codex' }, [`2:${H(2)}`]: { verdict: 'CHANGES', reviewer: 'codex' } },
    mergeLog: [{ pr: 8, issue: 5, agent: 'claude', reviewer: 'codex', startedAt: NOW - 7200000, mergedAt: NOW }, { pr: 9, issue: 6, agent: 'codex', reviewer: 'claude', startedAt: null, mergedAt: NOW }],
    jobs: { [merged.id]: { kind: 'implement', issue: 5, agent: 'claude' } } };
  const v = await view(t, { jobs: [merged], state, cache: { tick: okTick(), pulls: [], issues: [] }, snapshots: [snap(NOW - 7200000, 0.9, NOW - 1800000), snap(NOW - 3600000, 0.95, NOW - 1800000), snap(NOW - 60000, 0.02, NOW + 9000000)] });
  assert.equal(v.graphs.allowance.claude.series['5-hour'].length, 3);
  // the reset is explained by the expiry of the first reading (issue #75): one expected-reset marker at the reported time, a new segment after it
  assert.deepEqual(v.graphs.allowance.claude.expected, [{ at: NOW - 1800000, window: '5-hour' }]);
  assert.equal(v.graphs.allowance.claude.series['5-hour'][2].gap, true);
  assert.equal(v.graphs.allowance.claude.resets.length, 0);
  assert.deepEqual(v.graphs.verdicts.codex, { PASS: 1, CHANGES: 1 });
  assert.equal(v.graphs.merges[0].hours, 2); assert.equal(v.graphs.merges[1].hours, null);
  assert.deepEqual(v.graphs.tokensPerPr.map(x => x.tokens), [1000, null]);
  assert.equal(Object.values(v.graphs.jobsPerDay)[0]['implement/completed'], 1);
  const html = renderPage(v, { route: { page: 'usage' } });
  assert.match(html, /<svg[^>]*aria-label="allowance used over time"/); assert.match(html, /class="reset expected"/);
  assert.match(html, /aria-label="tokens per merged PR"/); assert.match(html, /unknown/);
});

// ---- activity
test('recent activity: newest first, capped at 50, each linking to its PR or issue', async t => {
  const j = job({ kind: 'review', issue: 27 });
  const events = Array.from({ length: 80 }, (_, i) => ({ at: NOW - i * 1000, job: j.id, kind: i % 2 ? 'started' : 'completed' }));
  const v = await view(t, { jobs: [j], events, state: { verdicts: { [`27:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW + 5 } } }, cache: { tick: okTick(), pulls: [], issues: [] } });
  assert.equal(v.activity.length, 50);
  assert.match(v.activity[0].text, /codex: CHANGES on PR #27/); assert.equal(v.activity[0].link.url, 'https://github.com/o/r/pull/27');
  assert.ok(v.activity.every((r, i, a) => i === 0 || a[i - 1].at >= r.at));
});

// ---- writer: cache and bounded history, no secrets
test('recordTick stores a compact cache and a snapshot; issue bodies and comments are never persisted', t => {
  const root = setup(t);
  const prs = [pr(1, 'claude/issue-5-x', H(1), { body: 'PR BODY SECRET', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci', detailsUrl: 'https://x/y?token=abc' }] })];
  const issues = [issue(5, 'OPEN', 'Prerequisites: #2\nlong private description with token ghp_abcdefghijklmnop1234', ['needs-homeowner'])];
  const team = { c: config(), view: { prs, issues } };
  recordTick(root, { now: NOW, status: 'ok', team, jobs: [fx], actions: [{ agent: 'claude', type: 'implement', issue: 5 }] });
  const raw = fs.readFileSync(path.join(root, 'dashboard', 'cache.json'), 'utf8');
  assert.doesNotMatch(raw, /SECRET|ghp_|description|detailsUrl|token=abc/);
  const cache = readCache(root);
  assert.deepEqual(cache.issues[0].prerequisites, [2]); assert.equal(cache.issues[0].body, undefined); assert.equal(cache.tick.status, 'ok');
  const snaps = readSnapshots(root);
  assert.equal(snaps.length, 1); assert.deepEqual(snaps[0].redCi, [1]); assert.equal(snaps[0].agents.claude, 'paused'); assert.deepEqual(snaps[0].plan, [{ agent: 'claude', type: 'implement', ref: 5 }]);
  assert.equal(snaps[0].allowance.claude.windows[0].utilization, 0.34);
  assert.equal(fs.statSync(path.join(root, 'dashboard', 'cache.json')).mode & 0o077, 0);
  // a failed tick keeps the last good GitHub data and records the error, without appending a snapshot
  recordTick(root, { now: NOW + 1, status: 'error', error: 'boom ghp_abcdefghijklmnop1234 bob@example.com' });
  const after = readCache(root);
  assert.equal(after.tick.status, 'error'); assert.equal(after.tick.lastOkAt, NOW); assert.equal(after.pulls.length, 1);
  assert.doesNotMatch(JSON.stringify(after), /ghp_|bob@/); assert.equal(readSnapshots(root).length, 1);
  recordTick(root, { now: NOW + 2, status: 'disabled' });
  assert.equal(readCache(root).tick.status, 'disabled'); assert.equal(readSnapshots(root).length, 1);
});
test('a tick that skipped an action is recorded as an error with the reason, not as ok (PR #36 review)', async t => {
  const root = setup(t);
  const team = { c: config(), view: { prs: [], issues: [] } };
  recordTick(root, { now: NOW, status: 'ok', team, jobs: [fx] });
  assert.deepEqual(tickOutcome({ skipped: [] }), { status: 'ok' });
  const out = tickOutcome({ skipped: [{ what: 'claude implement #5', reason: 'lease conflict' }] });
  assert.equal(out.status, 'error'); assert.match(out.error, /1 action\(s\) skipped: claude implement #5: lease conflict/);
  recordTick(root, { now: NOW + 1, ...out, team, jobs: [fx], actions: [] });
  const cache = readCache(root);
  assert.equal(cache.tick.status, 'error'); assert.match(cache.tick.error, /lease conflict/); assert.equal(cache.tick.lastOkAt, NOW);
  assert.equal(readSnapshots(root).at(-1).status, 'error');
  const v = await buildView({ config: config(), root, jobs: [fx], events: [], state: {}, cache, snapshots: readSnapshots(root), now: NOW + 2 });
  assert.ok(v.attention.some(i => i.id === 'tick-failed' && /lease conflict/.test(i.text)));
});
test('history retention is bounded by age and size and survives a rewrite', t => {
  const root = setup(t);
  const DAY = 86400000, base = Date.UTC(2026, 9, 30, 12, 0, 0);       // the later appends use 12:30, outside the first five minutes of the hour (the trim window)
  for (let i = 0; i < 3000; i++) appendSnapshot(root, { at: base - 60 * DAY + i * 60000, status: 'ok', plan: [], agents: {}, allowance: {}, redCi: [], pad: 'x'.repeat(100) }, base - 60 * DAY + i * 60000);
  appendSnapshot(root, { at: base, status: 'ok', plan: [], agents: {}, allowance: {}, redCi: [] }, Date.UTC(2026, 9, 30, 12, 30, 0));
  assert.equal(readSnapshots(root).length, 3001);                      // not yet trimmed: not the hourly check
  appendSnapshot(root, { at: base + 1, status: 'ok', plan: [], agents: {}, allowance: {}, redCi: [] }, Date.UTC(2026, 9, 30, 13, 0, 30));
  const kept = readSnapshots(root);
  assert.equal(kept.length, 2); assert.ok(kept.every(s => s.at >= base - 35 * DAY)); assert.ok(kept.length <= MAX_SNAPSHOTS);
});
test('redact removes emails, tokens, bearer values and long opaque strings but keeps commit ids', () => {
  const sha = 'a'.repeat(40);
  const out = redact(`x me@home.org ghp_1234567890abcdef Bearer abcdefghijkl sk-abcdefghijkl ${'Z'.repeat(45)} ${sha} \u0000z`, 500);
  assert.doesNotMatch(out, /me@home|ghp_|abcdefghijkl|ZZZZ|\u0000/); assert.match(out, new RegExp(sha));
  assert.equal(compactPulls([{ number: 1, title: 't', headRefName: 'b', headRefOid: H(1), baseRefName: 'main', url: 'https://u' }])[0].statusCheckRollup.length, 0);
  assert.deepEqual(compactIssues([{ number: 2, title: 't', state: 'OPEN', labels: [{ name: 'x' }].map(l => l.name), body: 'no prereq line' }])[0].prerequisites, []);
  const many = Array.from({ length: 50 }, (_, k) => k + 100);
  const c = compactIssues([{ number: 2, title: 't', state: 'OPEN', labels: [], body: `Prerequisites: ${many.map(n => '#' + n).join(', ')} mail me@home.org` }])[0];
  assert.deepEqual(c.prerequisites, many); assert.doesNotMatch(JSON.stringify(c), /me@home/);
});

// ---- server
test('bind validation: only a private LAN IPv4 on a documented port', () => {
  for (const bad of ['0.0.0.0', '127.0.0.1', '8.8.8.8', 'localhost', '::', '192.168.1.0', '192.168.1.255', '172.32.0.1', '300.1.1.1', '', undefined]) assert.throws(() => validateBind(bad, 8731), /dashboard host/);
  assert.throws(() => validateBind('192.168.1.5', 80), /port/); assert.throws(() => validateBind('192.168.1.5', NaN), /port/);
  for (const good of ['192.168.13.1', '10.0.0.5', '172.16.0.9', '172.31.255.1']) assert.deepEqual(validateBind(good, 8731), { host: good, port: 8731 });
});
async function withServer(t, { jobs = [], cache, state, snapshots, cfg = config() } = {}) {
  const root = setup(t);
  for (const j of jobs) { fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }); fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j)); }
  if (cache) { fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true }); fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache)); }
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', handler({ root, config: cfg, host: '127.0.0.1', port, now: () => NOW }));
  t.after(() => server.close());
  const get = (p, opts = {}) => new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }); req.on('error', reject); req.end(); });
  return { get, root };
}
test('server: serves a self-contained, escaped page with only same-origin script; GET/HEAD only; wrong Host refused', async t => {
  const evil = '<script>alert(1)</script>';
  const s = await withServer(t, { jobs: [fx], cache: { tick: okTick(), pulls: [pr(1, 'claude/issue-5-x', H(1))].map(p => ({ ...p, title: evil })), issues: [{ ...issue(5), title: evil }] } });
  const r = await s.get('/');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/html/);
  assert.doesNotMatch(r.body, /<script(?![^>]*src="\/static\/(?:app|early)\.js")/i); assert.doesNotMatch(r.body, /\son\w+=/i);
  assert.match((await s.get('/work')).body, /&lt;script&gt;/);
  assert.match(r.body, /http-equiv="refresh" content="60"/);
  assert.doesNotMatch(r.body, /(?:src|href)="(?:https?:)?\/\/(?!github\.com\/o\/r\/)/); assert.doesNotMatch(r.body, /@import|url\(/i);
  assert.match(r.headers['content-security-policy'], /default-src 'none'; script-src 'self'/); assert.doesNotMatch(r.headers['content-security-policy'], /unsafe-eval|script-src[^;]*unsafe-inline/); assert.match(r.headers['cache-control'], /no-store/);
  assert.doesNotMatch(r.body, /sessionId|prompt|@[a-z0-9-]+\.[a-z]{2,}/i);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await s.get('/', { method })).status, 405);
  assert.equal((await s.get('/', { method: 'HEAD' })).body, '');
  assert.equal((await s.get('/', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await s.get('/api/resume?job=1')).status, 404); assert.equal((await s.get('/healthz')).body, 'ok\n');
  const json = JSON.parse((await s.get('/api/view.json')).body);
  assert.ok(json.attention.some(a => a.id === 'pause-claude'));
});
test('server: loading the page makes no GitHub or model call (gh and provider CLIs are never started)', async t => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nogh-')); t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const marker = path.join(bin, 'called');
  // git is not faked: the page reads the decision register from the local origin/main ref (D-021).
  for (const name of ['gh', 'claude', 'codex', 'curl']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> ${marker}\nexit 1\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  const s = await withServer(t, { jobs: [fx], cache: { tick: okTick(), pulls: [], issues: [issue(30)] } });
  assert.equal((await s.get('/')).status, 200); assert.equal((await s.get('/api/view.json')).status, 200);
  assert.equal(fs.existsSync(marker), false);
});
test('server: unreadable state gives a generic 500 with no detail leaked', async t => {
  const s = await withServer(t, { cfg: { schema_version: 9 } });
  const r = await s.get('/'); assert.equal(r.status, 500); assert.doesNotMatch(r.body, /schema|team config/);
});
test('the dashboard modules import no GitHub client, process spawner or network client', () => {
  for (const f of ['dashboard', 'dashdata', 'dashrender', 'dashserver']) {
    const src = fs.readFileSync(new URL(`../supervisor/${f}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /child_process|github\.mjs|node:https|fetch\(|node:net/, f);
  }
});
test('a lone issue is "next: implement" when its agent has nothing ahead of it', async t => {
  const v = await view(t, { cache: { tick: okTick(), issues: [issue(2)], pulls: [] } });
  assert.equal(v.queues.codex[0].reason, 'next: implement'); assert.equal(v.queues.codex[0].next, true);
});

// ---- verdict fixes on 2e35220
test('delivered work: the page plans and queues what team tick would, with an open issue whose PR already merged excluded', async t => {
  const root = setup(t);
  const issues = [issue(5, 'OPEN', ''), issue(30, 'OPEN', '')];
  const delivered = new Set([5]);
  recordTick(root, { now: NOW, status: 'ok', team: { c: config(), view: { prs: [], issues }, delivered }, jobs: [], actions: [] });
  const cache = readCache(root);
  assert.deepEqual(cache.delivered, [5]);
  const cfg = config({ agents: { ...config().agents, claude: { ...config().agents.claude, issues: [5, 30] } } });
  const v = await buildView({ config: cfg, root, jobs: [], events: [], state: {}, cache, snapshots: [], now: NOW });
  assert.ok(!v.plan.some(a => a.issue === 5), 'issue 5 is not planned');
  assert.ok(v.plan.some(a => a.issue === 30), 'the next issue is planned instead');
  assert.ok(!Object.values(v.queues).flat().some(q => q.type === 'issue' && q.ref === 5));
  // without the delivered data the old behaviour would have planned #5
  const bare = await buildView({ config: cfg, root, jobs: [], events: [], state: {}, cache: { ...cache, delivered: [] }, snapshots: [], now: NOW });
  assert.ok(bare.plan.some(a => a.issue === 5));
  // a failed tick keeps the last delivered list
  recordTick(root, { now: NOW + 1, status: 'error', error: 'x' });
  assert.deepEqual(readCache(root).delivered, [5]);
});
test('recent activity includes every recorded tick in the 50-event ordering, not only the last three', async t => {
  const snapshots = Array.from({ length: 10 }, (_, i) => ({ at: NOW - (10 - i) * 1000, status: 'ok', plan: [] }));
  const v = await view(t, { snapshots, cache: { tick: okTick(), pulls: [], issues: [] } });
  assert.equal(v.activity.filter(r => /^tick ok/.test(r.text)).length, 10);
  const many = Array.from({ length: 80 }, (_, i) => ({ at: NOW - i * 1000, status: 'ok', plan: [] }));
  assert.equal((await view(t, { snapshots: many, cache: { tick: okTick(), pulls: [], issues: [] } })).activity.length, 50);
});

test('needs-homeowner survives the issue label cap for attention and queue planning', async t => {
  const labels = [...Array.from({ length: 10 }, (_, i) => `label-${i}`), 'needs-homeowner'];
  const cached = compactIssues([issue(32, 'OPEN', '', labels)]);
  assert.equal(cached[0].labels.length, 10);
  assert.ok(cached[0].labels.includes('needs-homeowner'));
  const v = await view(t, { cache: { tick: okTick(), pulls: [], issues: cached } });
  assert.ok(v.attention.some(a => a.id === 'homeowner-32'));
  assert.ok(!v.plan.some(a => a.issue === 32));
});

test('recent activity retains a failed tick after a later successful tick', async t => {
  const snapshots = [{ at: NOW - 2000, status: 'error', plan: [] }, { at: NOW - 1000, status: 'ok', plan: [] }];
  const v = await view(t, { snapshots, cache: { tick: okTick(NOW - 1000), pulls: [], issues: [] } });
  assert.deepEqual(v.activity.filter(r => r.text.startsWith('tick ')).map(r => r.text), ['tick ok, nothing to dispatch', 'tick error']);
});

test('dashboard serve applies team.local.json: the page reports the effective enabled state, not the shipped one (CLI path)', async t => {
  const { spawn } = await import('node:child_process');
  const ip = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address) && !/\.(0|255)$/.test(i.address))?.address;
  if (!ip) return t.skip('no private LAN IPv4 on this machine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.equal(shipped.enabled, false);
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, 'dashboard', 'serve', '--state-root', root, '--host', ip, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { out += d; if (/listening/.test(out)) resolve(); });
    child.stderr.on('data', d => { out += d; });
    child.once('exit', () => reject(new Error(`dashboard exited: ${out}`)));
  });
  const view = await new Promise((resolve, reject) => http.get({ host: ip, port, path: '/api/view.json' }, res => {
    let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
  }).on('error', reject));
  assert.equal(view.teamEnabled, true);
});
test('#104 an issue no agent owns is not planned and raises no attention item', async t => {
  const v = await view(t, { cache: { tick: okTick(), pulls: [], issues: [issue(77)] } });
  assert.ok(!ids(v).includes('unowned'));
  assert.ok(!v.plan.some(a => a.issue === 77));
});
