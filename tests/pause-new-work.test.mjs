// Issue #250: a cap on open unmerged PRs pauses new implement jobs; repair and review work still runs; the dashboard says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';

const NOW = 1_800_000_000_000;
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = (cap, roles = { implementer: 1, reviewer: 1 }) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...(cap === undefined ? {} : { max_open_prs: cap }) },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5, 6] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = n => ({ number: n, title: `Issue ${n} title here`, state: 'OPEN', body: '', labels: [] });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';

function world(t, { cfg, pulls, issues = [issue(5), issue(6), issue(2)] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, listIssues: async () => issues, listMergedPulls: async () => [] };
  const jobs = { listActive: async () => [], get: async () => null };
  return new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1000 } });
}
const waiting = n => Array.from({ length: n }, (_, i) => pr(100 + i, `codex/issue-${200 + i}-x`, H(i + 1)));

test('below the cap implement jobs start', async t => {
  const team = world(t, { cfg: config(5), pulls: waiting(2) });
  const acts = await team.plan();
  assert.ok(acts.some(a => a.type === 'implement'), JSON.stringify(acts));
  assert.equal(team.pauseInfo(waiting(2)), null);
});

test('at the cap no implement job starts and the implementer slot takes review work', async t => {
  const pulls = waiting(2);
  const team = world(t, { cfg: config(2), pulls });
  const acts = await team.plan();
  assert.equal(acts.some(a => a.type === 'implement'), false, JSON.stringify(acts));
  // an agent's reviews share one review worktree (issue #302): one review per tick, the other PR waits for the next
  assert.deepEqual(acts.map(a => [a.agent, a.type]), [['claude', 'review']]);
  assert.deepEqual(team.pauseInfo(pulls), { open: 2, cap: 2 });
  assert.equal(team.pauseText(pulls), 'Paused new work: 2 open PRs (cap 2)');
  // the same world without a cap: the implementer slot goes to implement
  const free = world(t, { cfg: config(undefined), pulls });
  assert.ok((await free.plan()).some(a => a.type === 'implement'));
});

test('at the cap the implementer slot takes fix and rebase work for its own PRs', async t => {
  const own = pr(10, 'claude/issue-5-a', H(1), { mergeable: 'CONFLICTING' });
  const changes = pr(11, 'claude/issue-6-b', H(2));
  const team = world(t, { cfg: config(2, { implementer: 2, reviewer: 1 }), pulls: [own, changes] });
  team.s.verdicts[`11:${H(2)}`] = { verdict: 'CHANGES', reviewer: 'codex' };
  const acts = await team.plan();
  assert.equal(acts.some(a => a.type === 'implement'), false);
  assert.deepEqual(acts.map(a => a.type).sort(), ['fix', 'rebase']);
});

test('the cap counts only configured agents\' PRs, and falls back to no cap when unset', async t => {
  const pulls = [...waiting(1), pr(50, 'feature/other', H(9))];
  assert.equal(world(t, { cfg: config(2), pulls }).pauseInfo(pulls), null);
  assert.equal(world(t, { cfg: config(undefined), pulls: waiting(30) }).pauseInfo(waiting(30)), null);
});

test('the cap is read from config: validated and overridable in team.local.json', () => {
  assert.equal(validateTeamConfig(config(3)).limits.max_open_prs, 3);
  for (const bad of [0, -1, 1.5, '3', 101, null]) assert.throws(() => validateTeamConfig(config(bad)), /max_open_prs/, String(bad));
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.ok(Number.isSafeInteger(shipped.limits.max_open_prs));
  assert.equal(applyLocalOverride(shipped, { limits: { max_open_prs: 4 } }).limits.max_open_prs, 4);
});

const root = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pausedash-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); fs.chmodSync(r, 0o700); return r; };
const view = (t, cfg, pulls) => buildView({ config: cfg, root: root(t), jobs: [], events: [], state: {}, register: REGISTER,
  cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues: [] }, snapshots: [], now: NOW });

test('the dashboard shows "Paused new work: N open PRs (cap M)" at the cap and clears below it', async t => {
  const at = await view(t, config(2), waiting(2));
  const item = at.attention.find(a => a.id === 'paused-new-work');
  assert.equal(item?.text, 'Paused new work: 2 open PRs (cap 2)');
  const below = await view(t, config(2), waiting(1));
  assert.equal(below.attention.some(a => a.id === 'paused-new-work'), false);
  assert.equal((await view(t, config(undefined), waiting(9))).attention.some(a => a.id === 'paused-new-work'), false);
});

// ---- issue #320: PRs that wait on the homeowner or an unstarted prerequisite issue must not deadlock the cap
const withBody = (n, body, state = 'OPEN') => ({ ...issue(n), body, state });
const parked = n => Array.from({ length: n }, (_, i) => pr(100 + i, `codex/issue-${200 + i}-x`, H(i + 1), { labels: ['needs-homeowner'] }));

test('deadlock case: PRs waiting on an unstarted prerequisite do not fill the cap, so implement starts', async t => {
  const issues = [withBody(5, ''), withBody(6, ''), ...[0, 1].map(i => withBody(200 + i, 'Prerequisites: #5')), ];
  const pulls = [0, 1].map(i => pr(100 + i, `codex/issue-${200 + i}-x`, H(i + 1)));
  // issue 5 is open and has no PR: both PRs wait on it
  const team = world(t, { cfg: config(2), pulls, issues });
  assert.equal(team.pauseInfo(pulls, issues), null);
  assert.ok((await team.plan()).some(a => a.type === 'implement'));
  // once #5 has a PR of its own it counts again, and the pair counts against the cap
  const withFive = [...pulls, pr(9, 'claude/issue-5-a', H(7))];
  assert.deepEqual(team.pauseInfo(withFive, issues), { open: 3, cap: 2 });
  // and once #5 is closed the prerequisite no longer parks them
  const closed = issues.map(i => i.number === 5 ? { ...i, state: 'CLOSED' } : i);
  assert.deepEqual(team.pauseInfo(pulls, closed), { open: 2, cap: 2 });
});

test('normal cap case is unchanged: ordinary open PRs are counted and pause new work', async t => {
  const pulls = waiting(3);
  const team = world(t, { cfg: config(3), pulls });
  assert.deepEqual(team.pauseInfo(pulls, []), { open: 3, cap: 3 });
  assert.equal(team.capDeadlock(pulls, []), null);   // CI green, no verdict: they can still be reviewed
});

test('a needs-homeowner PR is parked and the text says so', async t => {
  const pulls = [...waiting(1), ...parked(2).map((p, i) => ({ ...p, number: 300 + i, headRefName: `codex/issue-${300 + i}-x` }))];
  const team = world(t, { cfg: config(1), pulls });
  assert.deepEqual(team.pauseInfo(pulls, []), { open: 1, cap: 1, parked: 2 });
  assert.match(team.pauseText(pulls, []), /2 more waiting on you/);
});

// Only one agent exists, so nobody independent may review its PRs (the review gate is unchanged): nothing can progress.
const sameModel = cap => { const cfg = config(cap); delete cfg.agents.claude; return cfg; };
const authored = n => Array.from({ length: n }, (_, i) => pr(100 + i, `codex/issue-${200 + i}-x`, H(i + 1)));

test('Needs you item: appears when the cap blocks all work and no PR can progress, and clears when one can', async t => {
  const stuck = await view(t, sameModel(2), authored(2));
  const item = stuck.attention.find(a => a.id === 'cap-deadlock');
  assert.ok(item, JSON.stringify(stuck.attention.map(a => a.id)));
  assert.match(item.text, /#100, #101/);
  assert.match(item.action, /merge or close/);
  assert.equal(item.severity, 'action');
  // normal cap case: reviewable PRs (a different model exists) can progress, so only the info line shows
  const normal = await view(t, config(2), authored(2));
  assert.equal(normal.attention.some(a => a.id === 'cap-deadlock'), false);
  assert.ok(normal.attention.some(a => a.id === 'paused-new-work'));
  // below the cap the item is gone
  assert.equal((await view(t, sameModel(2), authored(1))).attention.some(a => a.id === 'cap-deadlock'), false);
  // a draft can still be continued, so it is not a deadlock
  const withDraft = [...authored(1), pr(101, 'codex/issue-201-x', H(2), { isDraft: true })];
  assert.equal((await view(t, sameModel(2), withDraft)).attention.some(a => a.id === 'cap-deadlock'), false);
});
