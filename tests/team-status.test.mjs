// `team status` (issue #39): one fixture per section, the "nothing to start" reasons, staleness fallback and redaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildStatus, currentStatus, refreshIfStale, renderStatus, readLeases } from '../supervisor/teamstatus.mjs';
import { validateTeamConfig } from '../supervisor/team.mjs';
import { atomicJson } from '../supervisor/core.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const MIN = 60000;
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
const config = () => validateTeamConfig({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `pr ${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN', body = '', labels = []) => ({ number: n, title: `issue ${n}`, state, body, labels });
const job = (over = {}) => ({ id: 'a'.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, ...over });
const tick = (at = NOW - MIN, status = 'ok', error = null) => ({ at, status, error, lastOkAt: at });
const status = (o = {}) => buildStatus({ config: config(), root: '/nonexistent', jobs: [], events: [], state: {}, snapshots: [], leases: [], now: NOW, tz: 'UTC',
  cache: { tick: tick(), fetchedAt: NOW - MIN, pulls: [], issues: [issue(30), issue(5), issue(2), issue(3)], merged: [] }, ...o });
const text = s => renderStatus(s);

test('1. agents: running, paused with restart time, idle, with job kind and reference', async () => {
  const s = await status({ jobs: [job(), job({ id: 'b'.repeat(32), provider: 'codex', kind: 'review', issue: 36, status: 'paused_limit', lastEvent: 'usage_limit', nextAttemptAt: NOW + 90 * MIN })] });
  assert.equal(s.agents.find(a => a.name === 'claude').text, 'running: implementing issue #30');
  assert.equal(s.agents.find(a => a.name === 'codex').text, 'paused: reviewing PR #36, restarts about 13:30');
  assert.match((await status()).agents[0].text, /^idle: about to start implement #30/);
});

test('2. next: the dispatcher plan is shown as agent → action', async () => {
  const s = await status({ cache: { tick: tick(), fetchedAt: NOW - MIN, pulls: [pr(36, 'claude/issue-32-x', H(1))], issues: [issue(2)] } });
  assert.ok(s.next.plan.some(p => p.text === 'codex → review PR #36'), JSON.stringify(s.next));
  assert.match(text(s), /codex → review PR #36/);
});
test('2. next: plain reasons why nothing will start', async () => {
  // waiting on review: PR open, CI pending
  let s = await status({ cache: { tick: tick(), fetchedAt: NOW - MIN, pulls: [pr(36, 'claude/issue-30-x', H(1), { statusCheckRollup: [{ status: 'IN_PROGRESS' }] })], issues: [issue(30)] } });
  assert.ok(s.next.waiting.some(w => w.agent === 'claude' && /PR #36: waiting on CI/.test(w.text)), JSON.stringify(s.next));
  // blocked by a prerequisite
  s = await status({ cache: { tick: tick(), fetchedAt: NOW - MIN, pulls: [], issues: [issue(2, 'OPEN', 'Prerequisites: #9'), issue(9)] } });
  assert.ok(s.next.waiting.some(w => w.agent === 'codex' && /issue #2: blocked by #9/.test(w.text)), JSON.stringify(s.next));
  // agent busy
  s = await status({ jobs: [job()] });
  assert.ok(s.next.waiting.some(w => w.agent === 'claude' && /busy with its current job/.test(w.text)));
  // nothing left
  s = await status({ cache: { tick: tick(), fetchedAt: NOW - MIN, pulls: [], issues: [] } });
  assert.ok(s.next.waiting.every(w => /no work is waiting/.test(w.text)));
  // loop switched off
  const off = await buildStatus({ config: { ...config(), enabled: false }, root: '/x', jobs: [], events: [], state: {}, snapshots: [], leases: [], now: NOW, tz: 'UTC', cache: { tick: { at: NOW, status: 'disabled' }, pulls: [], issues: [] } });
  assert.match(text(off), /switched off/);
});

test('3. problems: failed tick, consecutive failures, red CI, conflicts, blocked job, stale lease', async () => {
  const snaps = [3, 2, 1].map(i => ({ at: NOW - i * 5 * MIN, status: 'error', plan: [], agents: {} }));
  const s = await status({
    cache: { tick: tick(NOW - 5 * MIN, 'error', 'gh pr list failed: boom'), fetchedAt: NOW - MIN, issues: [issue(30)],
      pulls: [pr(7, 'claude/issue-30-x', H(1), { statusCheckRollup: red }), pr(8, 'codex/issue-2-x', H(2), { mergeable: 'CONFLICTING' })] },
    snapshots: snaps, jobs: [job({ id: 'c'.repeat(32), status: 'blocked', lastEvent: 'retry_exhausted', updatedAt: NOW - MIN })], leases: [{ job: 'd'.repeat(32), at: NOW }] });
  const t = s.problems.map(p => p.text).join('\n');
  assert.match(t, /Last tick failed.*gh pr list failed: boom/);
  assert.match(t, /3 ticks in a row have failed/);
  assert.match(t, /CI is red on PR #7/);
  assert.match(t, /PR #8 has merge conflicts/);
  assert.match(t, /is blocked: retry_exhausted/);
  assert.match(t, /1 lease\(s\) held with nothing running/);
});
test('3. problems: paused job is listed, and a pause that disagrees with the reported allowance is flagged', async () => {
  const al = { provider: 'claude', observedAt: NOW - MIN, windows: [{ type: 'five_hour', utilization: 0.34, resetsAt: NOW + 3600000 }] };
  const s = await status({ jobs: [job({ status: 'paused_limit', lastEvent: 'usage_limit', nextAttemptAt: NOW + 30 * MIN, allowance: al })] });
  const t = s.problems.map(p => p.text).join('\n');
  assert.match(t, /claude is paused on a usage limit; restart planned about 12:30/);
  assert.match(t, /provider reports capacity left: 5-hour 34% used/);
});
test('3. problems: a healthy state has none, and a live lease is not stale', async () => {
  const s = await status({ jobs: [job()], leases: [{ job: 'a'.repeat(32), at: NOW }] });
  assert.deepEqual(s.problems, []);
  assert.match(text(s), /Problems\n {2}none/);
});

test('4. pull requests: ready / draft / conflicting, CI state, latest verdict (current or older commit)', async () => {
  const state = { verdicts: { [`10:${H(1)}`]: { verdict: 'PASS', reviewer: 'codex', at: NOW - MIN }, [`11:${H(2)}`]: { verdict: 'CHANGES', reviewer: 'claude', at: NOW - MIN } } };
  const s = await status({ state, cache: { tick: tick(), fetchedAt: NOW - MIN, issues: [], pulls: [
    pr(10, 'claude/issue-30-x', H(1)), pr(11, 'codex/issue-2-x', H(3), { statusCheckRollup: red }), pr(12, 'codex/issue-3-x', H(4), { isDraft: true, statusCheckRollup: [] }), pr(13, 'claude/issue-5-x', H(5), { mergeable: 'CONFLICTING' })] } });
  const by = n => s.pulls.find(p => p.number === n);
  assert.deepEqual([by(10).status, by(10).ci, by(10).verdict.verdict, by(10).verdict.current], ['ready', 'green', 'PASS', true]);
  assert.deepEqual([by(11).ci, by(11).verdict.current, by(11).verdict.head], ['red', false, '2222222']);
  assert.deepEqual([by(12).status, by(12).ci, by(12).verdict], ['draft', 'not run', null]);
  assert.equal(by(13).status, 'conflicting');
  assert.match(text(s), /#11 ready, CI red, claude said CHANGES on an older commit \(2222222\)/);
});

test('5. merged today uses the local day and includes the dispatcher log', async () => {
  const s = await status({ state: { mergeLog: [{ pr: 99, mergedAt: NOW - 5 * MIN }] },
    cache: { tick: tick(), fetchedAt: NOW - MIN, pulls: [], issues: [], merged: [
      { number: 1, title: 'today', mergedAt: '2026-10-30T09:30:00Z' }, { number: 2, title: 'yesterday', mergedAt: '2026-10-29T23:59:00Z' }, { number: 99, title: 'dup', mergedAt: new Date(NOW - 5 * MIN).toISOString() }] } });
  assert.deepEqual(s.mergedToday.map(m => m.number), [1, 99]);
  assert.match(text(s), /#1 at 09:30: today/);
  assert.match(text(await status()), /Merged today\n {2}nothing yet/);
});

test('6. schedule: interval, last, next and minutes until', async () => {
  const s = await status({ cache: { tick: tick(NOW - 2 * MIN), fetchedAt: NOW - MIN, pulls: [], issues: [] } });
  assert.deepEqual(s.schedule, { intervalMinutes: 5, lastTickAt: NOW - 2 * MIN, lastTickStatus: 'ok', nextTickAt: NOW + 3 * MIN, minutesUntilNext: 3 });
  assert.match(text(s), /last tick: 11:58 \(ok\)\n {2}next tick: 12:03 \(in 3 minutes\)/);
  const late = await status({ cache: { tick: tick(NOW - 9 * MIN), fetchedAt: NOW - MIN, pulls: [], issues: [] } });
  assert.match(text(late), /next tick: was due at 11:56 \(4 minutes overdue\)/);
  assert.match(text(await status({ cache: null })), /last tick: never recorded/);
});

test('staleness: a fresh cache makes no gh call; a stale one makes exactly one call per section and survives failures', async () => {
  const calls = [];
  const gh = { listPulls: async () => (calls.push('pulls'), [pr(1, 'claude/issue-30-x', H(1))]), listIssues: async () => (calls.push('issues'), [issue(30)]), listMergedPulls: async () => (calls.push('merged'), [{ number: 2, title: 't', mergedAt: '2026-10-30T10:00:00Z' }]) };
  const fresh = await refreshIfStale({ cache: { fetchedAt: NOW - MIN, pulls: [], issues: [] }, gh, now: NOW });
  assert.deepEqual(calls, []); assert.deepEqual(fresh.notes, []);
  const stale = await refreshIfStale({ cache: { fetchedAt: NOW - 30 * MIN, pulls: [], issues: [] }, gh, now: NOW });
  assert.deepEqual(calls, ['pulls', 'issues', 'merged']);
  assert.equal(stale.cache.pulls[0].number, 1); assert.equal(stale.cache.merged[0].number, 2);
  const broken = { listPulls: async () => { throw new Error('gh pr list failed: offline'); }, listIssues: gh.listIssues, listMergedPulls: gh.listMergedPulls };
  const kept = await refreshIfStale({ cache: { fetchedAt: NOW - 30 * MIN, pulls: [{ number: 5 }], issues: [] }, gh: broken, now: NOW });
  assert.equal(kept.cache.pulls[0].number, 5); assert.match(kept.notes[0], /Could not refresh pull requests.*offline/);
  const none = await refreshIfStale({ cache: null, gh: null, now: NOW });
  assert.match(none.notes[0], /No GitHub data/);
});

test('no secrets, e-mail addresses or raw provider output reach the output', async () => {
  const token = 'ghp_' + 'A1b2C3d4'.repeat(4);
  const s = await status({ cache: { tick: tick(NOW - MIN, 'error', `boom for a@b.example with ${token}`), fetchedAt: NOW - MIN, issues: [], pulls: [pr(1, 'claude/issue-30-x', H(1), { title: `see ${token} x@y.example` })] } });
  const out = JSON.stringify(s) + text(s);
  assert.doesNotMatch(out, /ghp_|@b\.example|@y\.example/);
});

test('currentStatus and the CLI read state from disk, make no gh call with --no-github, and --json is parseable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const now = Date.now();
  atomicJson(path.join(root, 'dashboard', 'cache.json'), { schema: 1, tick: tick(now - MIN), fetchedAt: now - MIN, pulls: [], issues: [], merged: [] });
  fs.mkdirSync(path.join(root, 'leases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'leases', 'k'), JSON.stringify({ job: 'f'.repeat(32), at: now }));
  assert.deepEqual(readLeases(root), [{ job: 'f'.repeat(32), at: now }]);
  const s = await currentStatus({ root, config: JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8')), now, tz: 'UTC' });
  assert.equal(s.schedule.lastTickStatus, 'ok');
  const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
  const run = (...a) => spawnSync('node', [cli, 'team', 'status', ...a, '--state-root', root, '--no-github'], { encoding: 'utf8' });
  const j = run('--json'); assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).repository, 'Unthred/DevTest-Infrastructure');
  const h = run(); assert.equal(h.status, 0, h.stderr); assert.match(h.stdout, /=== What each agent is doing[\s\S]*=== Schedule/);
});

test('install and upgrade scripts both provide a team-status wrapper that delegates to the current ai-supervisor', () => {
  for (const f of ['install-supervisor.sh', 'upgrade-supervisor.sh']) {
    const s = fs.readFileSync(new URL(`../tools/${f}`, import.meta.url), 'utf8');
    assert.match(s, /status_cmd=\/root\/bin\/team-status/); assert.match(s, /exec \/root\/bin\/ai-supervisor team status "\$@"/);
    assert.equal(spawnSync('bash', ['-n', new URL(`../tools/${f}`, import.meta.url).pathname]).status, 0);
  }
});

test('idle reasons (#50): each idle agent states why in plain words', async () => {
  const idle = async (cache, state = {}, agent = 'codex') => (await status({ cache: { tick: tick(), fetchedAt: NOW - MIN, merged: [], ...cache }, state })).agents.find(a => a.name === agent);
  // fix limit reached -> waiting for homeowner, with a link
  let a = await idle({ pulls: [pr(41, 'codex/issue-2-x', H(1))], issues: [issue(2), issue(3, 'CLOSED')] }, { verdicts: { [`41:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'claude' } }, fixAttempts: { [`41:${H(0)}`]: 2 } });
  assert.match(a.text, /waiting for homeowner: fix limit reached on #41/); assert.equal(a.idleReason.links[0].url, 'https://github.com/o/r/pull/41');
  // only work is a draft whose issue is closed -> not continuable
  a = await idle({ pulls: [pr(28, 'codex/issue-3-x', H(2), { isDraft: true })], issues: [issue(2, 'CLOSED'), issue(3, 'CLOSED')] });
  assert.match(a.text, /only work is draft #28/);
  // continue limit reached
  a = await idle({ pulls: [pr(28, 'codex/issue-3-x', H(2), { isDraft: true })], issues: [issue(2, 'CLOSED'), issue(3)] }, { continueAttempts: { 28: 2 } });
  assert.match(a.text, /waiting for homeowner: continue limit reached on draft #28/);
  // a continuable draft is planned, not reported as stuck
  a = await idle({ pulls: [pr(28, 'codex/issue-3-x', H(2), { isDraft: true })], issues: [issue(2, 'CLOSED'), issue(3)] });
  assert.match(a.text, /about to start continue #3/);
  // all issues blocked by #3
  a = await idle({ pulls: [], issues: [issue(2, 'OPEN', 'Prerequisites: #3'), issue(3, 'OPEN', 'Prerequisites: #77'), issue(77)] });
  assert.match(a.text, /all issues blocked by #3, #77/);
  // waiting for review of #29
  a = await idle({ pulls: [pr(29, 'codex/issue-2-x', H(3))], issues: [issue(2), issue(3, 'CLOSED')] });
  assert.match(a.text, /waiting for review of #29/);
  // needs-homeowner label; nothing assigned
  a = await idle({ pulls: [], issues: [issue(2, 'OPEN', '', ['needs-homeowner']), issue(3, 'CLOSED')] });
  assert.match(a.text, /waiting for homeowner: #2 needs the homeowner/);
  a = await idle({ pulls: [], issues: [issue(2, 'CLOSED'), issue(3, 'CLOSED')] });
  assert.match(a.text, /no open issue or pull request is assigned/);
  // a running agent has no idle reason; the terminal rendering carries the reason
  const s = await status({ jobs: [job()] }); assert.equal(s.agents.find(x => x.name === 'claude').idleReason, null);
  assert.match(text(await status({ cache: { tick: tick(), fetchedAt: NOW - MIN, merged: [], pulls: [], issues: [issue(2, 'CLOSED'), issue(3, 'CLOSED')] } })), /codex: idle: no open issue/);
});
