// Issue #316 (homeowner decision 2 Nov 2026): no writing job escalates to a stronger model, none runs on a configured review model, and none
// runs when it would leave the PR with no available independent reviewer (D-024 unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const claudeModels = (cands, fix = { model: 'sonnet', effort: 'medium' }) => ({ implement: { model: 'sonnet', effort: 'medium' }, fix, 'ci-fix': fix, rebase: fix, strong: { model: 'opus', effort: 'high' }, review: { model: 'opus', effort: 'medium' }, review_candidates: cands });
const ONE = [{ model: 'opus', effort: 'medium' }];
const config = ({ cands = ONE, codex = true, fix } = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: claudeModels(cands, fix), ...(codex ? { codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } : {}) } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, ...(codex ? { codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } : {}) },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const PR = { number: 137, title: 't', headRefName: 'claude/issue-72-x', headRefOid: H(5), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green };
const manifests = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };

function world(t, { cfg = config(), out = {}, writers = ['sonnet'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-rev-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => [PR] };
  const state = { out };
  const limitedOf = agent => (state.out[agent] ? { out: true, reason: state.out[agent] } : { out: false });
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs: {}, git: {}, register: REGISTER, clock: { now: () => NOW }, limitedOf, providerModels: manifests });
  writers.forEach((model, i) => { team.s.jobs['w' + i] = { kind: i ? 'fix' : 'implement', agent: 'claude', key: '72', model, branch: PR.headRefName, pr: 137, ingested: true, at: NOW - 5000 + i }; });
  return { team, state };
}
const act = (over = {}) => ({ agent: 'claude', pr: 137, branch: PR.headRefName, key: 'k', ...over });
// A fix with no configured model runs on the CLI default, which is not provably different from any reviewer: that is the stranding case.
const UNKNOWN = { effort: 'medium' };

test('a fix that would remove the last reviewer is refused, not given another model', t => {
  const { team } = world(t, { cfg: config({ fix: UNKNOWN }), out: { codex: 'codex weekly limit' } });
  const f = team.modelFor(act(), 'fix', {});
  assert.match(f.writeRefusal, /would make every configured review model a writer.*codex cannot review now/);
  assert.equal(f.modelSource, 'configured');
  assert.match(team.writeBlock(PR), /codex cannot review now/);
  assert.equal(team.canEscalate(137, PR), false); assert.equal(team.escalationPending(137, PR), false);
});

test('the same check covers cifix, continue and rebase', t => {
  const { team } = world(t, { cfg: config({ fix: UNKNOWN }), out: { codex: 'limit' } });
  for (const kind of ['cifix', 'continue', 'rebase']) assert.ok(team.modelFor(act(), kind, {}).writeRefusal, kind);
});

test('a fix that would not remove the last reviewer runs on its configured model', t => {
  const { team } = world(t, { out: { codex: 'limit' } });
  const f = team.modelFor(act(), 'fix', {});
  assert.equal(f.model, 'sonnet'); assert.equal(f.writeRefusal, undefined); assert.equal(team.writeBlock(PR), null);
});

test('a second provider that is available lets the job run', t => {
  const { team } = world(t, { cfg: config({ fix: UNKNOWN }), out: {} });
  assert.equal(team.modelFor(act(), 'fix', {}).writeRefusal, undefined); assert.equal(team.canEscalate(137, PR), true);
});

test('a provider out of allowance counts as unavailable; a waiting one too', t => {
  const { team } = world(t, { cfg: config({ fix: UNKNOWN }), out: { codex: 'limit' } });
  assert.ok(team.writeBlock(PR));
  team.limitedOf = () => ({ out: false }); team.modes = { codex: { mode: 'waiting' } };
  assert.ok(team.writeBlock(PR), 'waiting for a reset is unavailable');
});

test('no provider configured besides the writer: the job is refused', t => {
  const { team } = world(t, { cfg: config({ codex: false, fix: UNKNOWN }) });
  assert.match(team.writeBlock(PR), /no other agent is configured to review/);
});

test('a configured review model is never given writing work, whatever its escalation or allowance state', t => {
  const { team } = world(t, { cfg: config({ fix: { model: 'opus', effort: 'medium' } }) });
  for (const kind of ['fix', 'cifix', 'rebase']) assert.match(team.modelFor(act(), kind, {}).writeRefusal, /review model/, kind);
  const impl = world(t, { cfg: (() => { const c = config(); c.models.agents.claude.implement = { model: 'opus' }; return c; })() }).team;
  assert.match(impl.modelFor({ agent: 'claude', key: '9' }, 'implement', {}).writeRefusal, /review model/);
});

test('no repair job escalates to the strong entry, even after two CHANGES or at the fix limit', t => {
  const { team } = world(t);
  team.s.verdicts['137:' + H(1)] = { verdict: 'CHANGES' }; team.s.verdicts['137:' + H(2)] = { verdict: 'CHANGES' };
  for (const a of [act(), act({ escalated: true })]) { const f = team.modelFor(a, 'fix', {}); assert.equal(f.model, 'sonnet'); assert.notEqual(f.modelSource, 'escalated'); }
});

test('a PR that already has no possible reviewer is not changed by the guard', t => {
  const { team } = world(t, { out: { codex: 'limit' }, writers: ['sonnet', 'opus'] });
  assert.equal(team.strandsReviewer(PR, 'claude', 'opus'), null);
});

test('the planner starts no fix for a PR whose writer would strand it, and the dashboard shows why', async t => {
  const { team } = world(t, { cfg: config({ fix: UNKNOWN }), out: { codex: 'limit' } });
  team.gh.listIssues = async () => []; team.jobs.listActive = async () => []; team.jobs.list = async () => [];
  team.s.verdicts[`137:${PR.headRefOid}`] = { verdict: 'CHANGES', reviewer: 'codex' };
  assert.equal((await team.plan()).some(a => a.type === 'fix'), false);
});

test('control: with the other provider available the same PR does get a fix planned', async t => {
  const { team } = world(t, { cfg: config({ fix: UNKNOWN }), out: {} });
  team.gh.listIssues = async () => []; team.jobs.listActive = async () => []; team.jobs.list = async () => [];
  team.s.verdicts[`137:${PR.headRefOid}`] = { verdict: 'CHANGES', reviewer: 'codex' };
  assert.equal((await team.plan()).some(a => a.type === 'fix'), true);
});
