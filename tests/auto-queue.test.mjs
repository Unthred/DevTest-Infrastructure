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

test('a prerequisite keeps an issue out until it closes', async t => {
  const open = world(t, { issues: [issue(8, '**Prerequisites:** #7.'), issue(7)] });
  assert.deepEqual(implemented(await open.team.plan()), [7], 'only the prerequisite is started');
  assert.match(open.team.exclusion(8, new Map(open.team.view.issues.map(i => [i.number, i])), []).text, /blocked by #7/);
  const closed = world(t, { issues: [issue(8, '**Prerequisites:** #7.'), issue(7, '', [], 'CLOSED')] });
  assert.deepEqual(implemented(await closed.team.plan()), [8]);
});

test('config order and agent assignment still win', async t => {
  const cfg = config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [20] } } });
  const plan = await world(t, { issues: [issue(5), issue(20), issue(30)], cfg }).team.plan();
  assert.deepEqual(plan.filter(a => a.type === 'implement').map(a => [a.agent, a.issue]).sort(), [['claude', 30], ['codex', 20]], 'listed issues go to their owners before the unlisted #5');
  // one slot each: the unlisted issue only follows the agent's own list
  const solo = config({ limits: { roles: { implementer: 1, reviewer: 1 }, overall: 1, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 25] } } });
  assert.deepEqual(implemented(await world(t, { issues: [issue(5), issue(25), issue(30)], cfg: solo }).team.plan()), [30]);
});

test('a follow-up for an open PR is excluded with the reason, and becomes eligible when the PR merges', async t => {
  const followUp = issue(9, 'Follow-up to PR #3: tidy up');
  const waiting = world(t, { issues: [followUp], pulls: [pr(3, 'feature/x')] });
  assert.deepEqual(implemented(await waiting.team.plan()), []);
  assert.deepEqual({ kind: 'pr-wait', text: 'waiting for PR #3 PR title 3 to merge' }, (({ kind, text }) => ({ kind, text }))(waiting.team.exclusion(9, new Map([[9, followUp]]), [pr(3, 'feature/x')])));
  const merged = world(t, { issues: [followUp], merged: [{ number: 3, headRefName: 'claude/issue-1-x', closingIssuesReferences: [] }] });
  assert.deepEqual(implemented(await merged.team.plan()), [9]);
});

test('a follow-up whose PR was closed without merging stays out and is reported as pr-closed', async t => {
  const followUp = issue(9, 'x\n<!-- devtest-split v1 pr=3 job=abc -->');
  const w = world(t, { issues: [followUp] });
  assert.deepEqual(implemented(await w.team.plan()), []);
  const ex = w.team.exclusion(9, new Map([[9, followUp]]), []);
  assert.equal(ex.kind, 'pr-closed'); assert.match(ex.text, /PR #3 was closed without merging/);
});

test('parsers: PR references are not issue prerequisites; PR phrasing variants are found', () => {
  assert.deepEqual(prerequisites('- **Prerequisites:** #1, PR #2, pull request #3, #4'), [1, 4]);
  assert.deepEqual(pullPrerequisites('Follow-up from PR #206: x', 'Split out of PR #207.\nPrerequisites: #1, PR #208\nWaits for pull request #209'), [206, 207, 209, 208]);
  assert.deepEqual(pullPrerequisites('Plain', 'mentions PR #5 in passing'), []);
});
