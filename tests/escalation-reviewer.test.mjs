// Issue #316: a fix escalation must not turn the only independent reviewer into a writer of the PR (D-024 unchanged).
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
const claudeModels = (cands) => ({ implement: { model: 'sonnet', effort: 'medium' }, fix: { model: 'sonnet', effort: 'medium' }, strong: { model: 'opus', effort: 'high' }, review: { model: 'opus', effort: 'medium' }, review_candidates: cands });
const TWO = [{ model: 'opus', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }];
const config = ({ cands = TWO, codex = true } = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: claudeModels(cands), ...(codex ? { codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } : {}) } },
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
const escalatedFix = team => team.modelFor({ agent: 'claude', pr: 137, branch: PR.headRefName, key: 'k', escalated: true }, 'fix', {});

test('a fix that would remove the last reviewer keeps the cheaper model and says why', t => {
  const { team } = world(t, { out: { codex: 'codex weekly limit' } });
  const f = escalatedFix(team);
  assert.equal(f.model, 'sonnet'); assert.equal(f.escalationWithheld, true); assert.notEqual(f.modelSource, 'escalated');
  assert.match(f.modelReason, /escalation withheld.*codex cannot review now/);
  assert.match(team.escalationBlock(PR), /would make every configured review model a writer/);
  assert.equal(team.canEscalate(137, PR), false); assert.equal(team.escalationPending(137, PR), false);
});

test('repeated CHANGES verdicts escalate a normal fix, which is withheld the same way', t => {
  const { team } = world(t, { out: { codex: 'limit' } });
  team.s.verdicts['137:' + H(1)] = { verdict: 'CHANGES' }; team.s.verdicts['137:' + H(2)] = { verdict: 'CHANGES' };
  const f = team.modelFor({ agent: 'claude', pr: 137, branch: PR.headRefName, key: 'k' }, 'fix', {});
  assert.equal(f.model, 'sonnet'); assert.equal(f.escalationWithheld, true);
});

test('a second provider that is available lets the escalation run', t => {
  const { team } = world(t, { out: {} });
  const f = escalatedFix(team);
  assert.equal(f.model, 'opus'); assert.equal(f.modelSource, 'escalated'); assert.equal(f.escalationWithheld, undefined);
  assert.equal(team.escalationBlock(PR), null); assert.equal(team.canEscalate(137, PR), true);
});

test('no provider configured besides the writer: the escalation is withheld', t => {
  const { team } = world(t, { cfg: config({ codex: false }) });
  assert.equal(escalatedFix(team).model, 'sonnet');
  assert.match(team.escalationBlock(PR), /no other agent is configured to review/);
});

test('a fix that would not remove the last reviewer is escalated even with the other provider out', t => {
  // a third configured review model that no writer used keeps an independent reviewer
  const { team } = world(t, { cfg: config({ cands: [...TWO, { model: 'haiku', effort: 'low' }] }), out: { codex: 'limit' } });
  assert.equal(escalatedFix(team).model, 'opus'); assert.equal(team.escalationBlock(PR), null);
});

test('a PR that already has no possible reviewer is not changed by the guard', t => {
  const { team } = world(t, { out: { codex: 'limit' }, writers: ['sonnet', 'opus'] });
  assert.equal(team.strandsReviewer(PR, 'claude', 'opus'), null);
});

test('only escalation is withheld: implement, rebase and review model choice are unchanged', t => {
  const { team } = world(t, { out: { codex: 'limit' } });
  assert.equal(team.modelFor({ agent: 'claude', key: '9' }, 'implement', {}).model, 'sonnet');
  assert.equal(team.modelFor({ agent: 'claude', pr: 137, branch: PR.headRefName, key: 'k' }, 'fix', {}).modelSource, 'configured');
});
