// Issue #212: every open issue is eligible by default; team.local.json only orders and assigns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, prerequisites, pullPrerequisites, EXCLUDING_LABELS } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } }, ...over });
const issue = (n, body = '', labels = [], state = 'OPEN') => ({ number: n, title: `Issue ${n}`, state, body, labels });
const pr = (n, branch, extra = {}) => ({ number: n, title: `PR title ${n}`, headRefName: branch, headRefOid: H(n % 9), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'IN_PROGRESS' }], ...extra });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';

function world(t, { issues = [], pulls = [], merged = [], cfg = config() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoq-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, listIssues: async () => issues, listMergedPulls: async () => merged };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'a'.repeat(32) }) };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1000 } });
  return { team };
}
const implemented = plan => plan.filter(a => a.type === 'implement').map(a => a.issue);

test('a new unlabelled issue in no list becomes eligible without a config edit', async t => {
  const w = world(t, { issues: [issue(7)] });
  assert.deepEqual(implemented(await w.team.plan()), [7]);
});

test('each excluding label keeps an issue out; an unrelated label does not', async t => {
  assert.deepEqual(EXCLUDING_LABELS, ['epic', 'tracking', 'parked', 'needs-homeowner']);
  for (const label of EXCLUDING_LABELS) {
    const w = world(t, { issues: [issue(7, '', [label])] });
    assert.deepEqual(implemented(await w.team.plan()), [], label);
    assert.equal(w.team.exclusion(7, new Map([[7, issue(7, '', [label])]]), []).kind, 'label');
  }
  assert.deepEqual(implemented(await world(t, { issues: [issue(7, '', ['enhancement', 'bug'])] }).team.plan()), [7]);
});

test('the old Prerequisites line no longer keeps an issue out; only the Depends on line does (issue #1103)', async t => {
  const old = world(t, { issues: [issue(8, '**Prerequisites:** #7.'), issue(7)] });
  assert.deepEqual(implemented(await old.team.plan()), [7, 8]);
  const line = world(t, { issues: [issue(8, 'Depends on: #7'), issue(7)] });
  assert.deepEqual(implemented(await line.team.plan()), [7], 'only the prerequisite is started');
  assert.match(line.team.exclusion(8, new Map(line.team.view.issues.map(i => [i.number, i])), []).text, /#7 still open/);
});

test('config order and agent assignment still win', async t => {
  const cfg = config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [20] } } });
  const plan = await world(t, { issues: [issue(5), issue(20), issue(30)], cfg }).team.plan();
  assert.deepEqual(plan.filter(a => a.type === 'implement').map(a => [a.agent, a.issue]).sort(), [['claude', 30], ['codex', 20]], 'listed issues go to their owners before the unlisted #5');
  // one slot each: the unlisted issue only follows the agent's own list
  const solo = config({ limits: { roles: { implementer: 1, reviewer: 1 }, overall: 1, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 25] } } });
  assert.deepEqual(implemented(await world(t, { issues: [issue(5), issue(25), issue(30)], cfg: solo }).team.plan()), [30]);
});

test('follow-up wording and the split marker no longer hold an issue (issue #1103)', async t => {
  const w = world(t, { issues: [issue(9, 'Follow-up to PR #3: tidy up\n<!-- devtest-split v1 pr=4 job=abc -->')], pulls: [pr(3, 'feature/x')] });
  assert.deepEqual(implemented(await w.team.plan()), [9]);
});

test('parsers: PR references are not issue prerequisites; PR phrasing variants are found', () => {
  assert.deepEqual(prerequisites('- **Prerequisites:** #1, PR #2, pull request #3, #4'), [1, 4]);
  assert.deepEqual(pullPrerequisites('Follow-up from PR #206: x', 'Split out of PR #207.\nPrerequisites: #1, PR #208\nWaits for pull request #209'), [206, 207, 209, 208]);
  assert.deepEqual(pullPrerequisites('Plain', 'mentions PR #5 in passing'), []);
});

test('prerequisites parse the "Prerequisites (note):" form', () => {
  assert.deepEqual(prerequisites('**Prerequisites (do not start before these are closed):** #30, #31'), [30, 31]);
  assert.deepEqual(pullPrerequisites('x', '**Prerequisites (wait):** PR #9'), [9]);
});

test('an issue is eligible even when excluding labels do not exist in the repository', async t => {
  const w = world(t, { issues: [issue(7)] });
  w.team.gh.listLabels = async () => [];
  assert.deepEqual(implemented(await w.team.plan()), [7]);
});
