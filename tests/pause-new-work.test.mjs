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
  // both the reviewer slot and the implementer slot take a review (one per PR)
  assert.deepEqual(acts.map(a => [a.agent, a.type]).sort(), [['claude', 'review'], ['claude', 'review']]);
  assert.equal(new Set(acts.map(a => a.pr)).size, 2);
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
