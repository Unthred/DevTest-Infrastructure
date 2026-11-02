// Issue #297: the no-reviewer Needs you card names every review model tried and what approval would unblock; a conflicting PR with
// no reviewer gets a card too; a blocked-job card clears when its issue is closed, split or an epic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' }, review_candidates: [{ model: 'opus', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }] }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: 'claude/issue-72-x', headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], ...extra });
const MANIFESTS = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };

function world(t, { pulls, out = { codex: 'codex weekly limit' }, manifests = MANIFESTS, writers = ['opus', 'sonnet'], rebaseAttempts = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async () => null, listIssues: async () => [], listMergedPulls: async () => [] };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [], get: async () => null }, git: {}, register: REGISTER, clock: { now: () => NOW },
    limitedOf: a => (out[a] ? { out: true, reason: out[a] } : { out: false }), providerModels: manifests });
  writers.forEach((model, i) => { team.s.jobs[`w${i}`] = { kind: i ? 'fix' : 'implement', agent: 'claude', key: '72', model, branch: 'claude/issue-72-x', pr: pulls[0].number, ingested: true, at: NOW - 5000 }; });
  if (rebaseAttempts) team.s.rebaseAttempts[`${pulls[0].number}:${pulls[0].headRefOid}`] = rebaseAttempts;
  return team;
}
async function cards(t, team, { pulls, jobs = [], issues = [], splits = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-d-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const solo = config(); delete solo.agents.codex; delete solo.models.agents.codex;   // the page itself sees no usage limit, so Codex would count as available
  const v = await buildView({ config: solo, root, jobs, events: [], state: { jobs: team.s.jobs, splits, rebaseAttempts: team.s.rebaseAttempts }, register: REGISTER,
    cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues }, snapshots: [], now: NOW });
  return v.panels.needsYou;
}

test('#234 shape: the card names every Claude model and Codex, and the model whose approval unblocks', async t => {
  const pulls = [pr(234, H(2))], team = world(t, { pulls });
  const [u] = team.unreviewable(pulls);
  assert.deepEqual(u.tried.filter(x => x.startsWith('claude')), ['claude on opus: refused, it wrote this head', 'claude on sonnet: refused, it wrote this head']);
  assert.deepEqual(u.unblock, ['claude reviewing on haiku']);
  const [card] = (await cards(t, team, { pulls })).filter(a => a.id === 'noreviewer-234');
  assert.match(card.tried, /claude on opus: refused, it wrote this head/); assert.match(card.tried, /claude on sonnet: refused, it wrote this head/);
  assert.match(card.decision, /No configured review model can be approved/);   // the page has no manifests; haiku is named by the team-level check above
  assert.ok(u.tried.includes('codex: out of allowance (codex weekly limit)'));
});

test('no model can unblock it when every model of the provider wrote the head: the card says so', async t => {
  const pulls = [pr(234, H(2))], team = world(t, { pulls, manifests: { ...MANIFESTS, claude: { aliases: ['opus', 'sonnet'] } } });
  assert.deepEqual(team.unreviewable(pulls)[0].unblock, []); assert.deepEqual(team.unreviewable(pulls)[0].waits, ['codex']);
  const [card] = (await cards(t, team, { pulls })).filter(a => a.id === 'noreviewer-234');
  assert.match(card.decision, /No configured review model can be approved/); assert.doesNotMatch(card.decision, /Approving/);
});

test('#137 shape: a CONFLICTING PR with no reviewer gets a card that puts the rebase first', async t => {
  const pulls = [pr(137, H(5), { mergeable: 'CONFLICTING' })], team = world(t, { pulls });
  const [u] = team.unreviewable(pulls); assert.equal(u.conflicting, true); assert.equal(u.rebaseAttempts, 0);
  const [card] = (await cards(t, team, { pulls })).filter(a => a.id === 'noreviewer-137');
  assert.match(card.text, /conflicts with main/); assert.match(card.tried, /The rebase comes first \(0 of 2 attempts used/); assert.match(card.tried, /Foreman rebases it next/); assert.match(card.tried, /held for a reviewer/);
});

test('a conflicting PR whose rebase attempts are used up says it will not move by itself', async t => {
  const pulls = [pr(217, H(6), { mergeable: 'CONFLICTING' })], team = world(t, { pulls, rebaseAttempts: 2 });
  const [card] = (await cards(t, team, { pulls })).filter(a => a.id === 'noreviewer-217');
  assert.match(card.tried, /2 of 2 attempts used/); assert.match(card.tried, /will not rebase it again by itself/);
});

test('negative: a conflicting PR with an available reviewer, or a reviewed one, has no card', async t => {
  const pulls = [pr(137, H(5), { mergeable: 'CONFLICTING' })];
  const free = world(t, { pulls, out: {} }); assert.deepEqual(free.unreviewable(pulls), []);
  const done = world(t, { pulls }); done.s.verdicts['137:' + H(5)] = { verdict: 'PASS', reviewer: 'x', job: 'j' }; assert.deepEqual(done.unreviewable(pulls), []);
});

const blocked = (issue = 107) => ({ id: 'b'.repeat(32), provider: 'claude', kind: 'implement', issue, status: 'blocked', attempts: 1, lastEvent: 'retry_exhausted', createdAt: NOW - 3600000, updatedAt: NOW - 60000 });
test('a blocked implement job card shows while the issue is open, and clears when it is closed, split or an epic', async t => {
  const team = world(t, { pulls: [pr(1, H(1))] });
  const ids = async (issue, splits) => (await cards(t, team, { pulls: [], jobs: [blocked()], issues: [issue], splits })).filter(a => a.id === `job-${'b'.repeat(32)}`).length;
  const open = { number: 107, state: 'OPEN', labels: ['enhancement'] };
  assert.equal(await ids(open), 1);
  assert.equal(await ids({ ...open, state: 'CLOSED' }), 0, 'closed');
  assert.equal(await ids({ ...open, labels: ['enhancement', 'epic'] }), 0, 'epic');
  assert.equal(await ids(open, { 107: { status: 'accepted', implementJob: 'x' } }), 0, 'split accepted');
  assert.equal(await ids(open, { 107: { status: 'proposed', implementJob: 'x' } }), 1, 'a proposed split is not yet a split');
});
