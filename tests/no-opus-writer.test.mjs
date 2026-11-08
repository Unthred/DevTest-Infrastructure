// Issue #368: Opus is never given an implementer or fix job, for any config (not only when it is also a review model), on every writing
// kind, on the escalation path, on the exception path, with a clear held reason when no permitted writer is available.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { isOpusModel } from '../supervisor/models.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const S = { model: 'sonnet', effort: 'medium' }, R = { model: 'haiku', effort: 'medium' }, O = { model: 'opus', effort: 'medium' };
// Review models are haiku only: Opus is NOT a review model here, which is the gap D-026 alone left open.
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: S, fix: S, 'ci-fix': S, rebase: S, continue: S, review: R, review_candidates: [R], ...over }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [72] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const PR = { number: 137, title: 't', headRefName: 'claude/issue-72-x', headRefOid: H(5), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green };
const manifests = { claude: { aliases: ['opus', 'sonnet', 'haiku'], pattern: '^claude-', efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };
function world(t, over, pr = PR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-opus-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const team = new Team({ config: config(over), root: stateRoot(path.join(dir, 'state')), gh: { listPulls: async () => [pr], listIssues: async () => [{ number: 72, state: 'OPEN', title: 'x', body: '', labels: [], assignees: [] }] }, jobs: { listActive: async () => [], list: async () => [] }, git: {}, register: REGISTER, clock: { now: () => NOW }, limitedOf: () => ({ out: false }), providerModels: manifests });
  team.s.jobs.w0 = { kind: 'implement', agent: 'claude', key: '72', model: 'sonnet', branch: PR.headRefName, pr: 137, ingested: true, at: NOW - 5000 };
  return team;
}
const act = (over = {}) => ({ agent: 'claude', pr: 137, branch: PR.headRefName, key: 'k', ...over });

test('isOpusModel judges the name: alias, full id, any case; not other models', () => {
  for (const m of ['opus', 'Opus', 'claude-opus-4-1', 'claude-opus-5-5']) assert.equal(isOpusModel(m), true, m);
  for (const m of ['sonnet', 'haiku', 'claude-sonnet-5-5', null, undefined, 5]) assert.equal(isOpusModel(m), false, String(m));
});

test('bad config: an Opus entry that is not a review model is refused for every writing kind', t => {
  for (const [key, kinds] of [['implement', ['implement']], ['continue', ['continue']], ['fix', ['fix']], ['ci-fix', ['cifix']], ['rebase', ['rebase']]]) {
    const team = world(t, { [key]: O });
    for (const kind of kinds) {
      const f = team.modelFor(act(), kind, {});
      assert.match(f.writeRefusal, /no permitted writer.*Opus is never given/, kind);
      assert.doesNotMatch(f.writeRefusal, /review model/);
    }
  }
});

test('bad config: a full Opus model id is refused as well', t => {
  const team = world(t, { fix: { model: 'claude-opus-4-1', effort: 'medium' } });
  assert.match(team.modelFor(act(), 'fix', {}).writeRefusal, /claude-opus-4-1/);
});

test('escalation: the final round and a twice-CHANGES PR keep the configured model, and an Opus fix entry stays refused', t => {
  const ok = world(t, { strong: O });
  ok.s.verdicts['137:' + H(1)] = { verdict: 'CHANGES' }; ok.s.verdicts['137:' + H(2)] = { verdict: 'CHANGES' };
  for (const a of [act(), act({ escalated: true })]) { const f = ok.modelFor(a, 'fix', {}); assert.equal(f.model, 'sonnet'); assert.equal(f.writeRefusal, undefined); }
  ok.s.escalations['fix:k'] = { reason: 'x' };
  assert.equal(ok.modelFor(act(), 'fix', {}).model, 'sonnet', 'the strong entry is never used');
  const bad = world(t, { fix: O });
  assert.ok(bad.modelFor(act({ escalated: true }), 'fix', {}).writeRefusal);
  assert.ok(world(t, { 'ci-fix': O }).modelFor(act({ escalated: true }), 'cifix', {}).writeRefusal);
});

test('the writing guard cannot be skipped by an act flag', t => {
  const team = world(t, { fix: O });
  assert.ok(team.modelFor(act({ noWriteGuard: true }), 'fix', {}).writeRefusal);
});

test('reviews may still use Opus (control)', t => {
  const team = world(t, { review: O, review_candidates: [O] });
  const f = team.modelFor(act(), 'review', {});
  assert.equal(f.model, 'opus'); assert.equal(f.writeRefusal, undefined);
});

test('planner: an Opus implementer is held with a clear reason and no implement is planned; control: Sonnet plans it', async t => {
  const bad = world(t, { implement: O }, { ...PR, number: 999, headRefName: 'codex/other' });
  assert.equal((await bad.plan()).some(a => a.type === 'implement'), false);
  assert.match(bad.held.claude.implement, /no permitted writer.*Opus is never given/);
  const ok = world(t, {}, { ...PR, number: 999, headRefName: 'codex/other' });
  assert.equal((await ok.plan()).some(a => a.type === 'implement'), true);
});

test('planner: an Opus fix or ci-fix entry plans no fix; control: Sonnet plans one', async t => {
  const verdict = team => { team.s.verdicts[`137:${PR.headRefOid}`] = { verdict: 'CHANGES', reviewer: 'codex' }; return team; };
  assert.equal((await verdict(world(t, { fix: O })).plan()).some(a => a.type === 'fix'), false);
  assert.equal((await verdict(world(t)).plan()).some(a => a.type === 'fix'), true);
  const red = { ...PR, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' }] };
  assert.equal((await world(t, { 'ci-fix': O }, red).plan()).some(a => a.type === 'cifix'), false);
  assert.equal((await world(t, {}, red).plan()).some(a => a.type === 'cifix'), true);
});

test('bad config: an Opus name the manifest rejects is still refused, not run on the CLI default', t => {
  for (const model of ['Opus', 'opus[1m]', 'OPUS-4']) for (const kind of ['implement', 'fix', 'ci-fix', 'rebase', 'continue']) {
    const key = kind === 'ci-fix' ? 'ci-fix' : kind;
    const team = world(t, { [key]: { model, effort: 'medium' } });
    const f = team.modelFor(act(), kind === 'ci-fix' ? 'cifix' : kind, {});
    assert.match(f.writeRefusal, /no permitted writer.*Opus is never given/, `${model} ${kind}`);
  }
});

test('bad config: a writing entry with no usable model is pinned to a non-Opus model, never left to the CLI default', t => {
  for (const kind of ['implement', 'fix']) {
    const f = world(t, { [kind]: { effort: 'high' } }).modelFor(act(), kind, {});
    assert.equal(f.model, 'sonnet', kind); assert.equal(f.writeRefusal ?? null, null); assert.match(f.modelWarning, /no model pinned/);
  }
  assert.equal(world(t, { fix: { model: 'nonsense', effort: 'high' } }).modelFor(act(), 'fix', {}).model, 'sonnet');
});

test('an unpinned writer is never pinned to a review model of its agent (D-026)', t => {
  const fable = { model: 'fable', effort: 'medium' };
  const team = world(t, { fix: { effort: 'high' }, review: fable, review_candidates: [fable] });
  team.providerModels.claude = { ...manifests.claude, aliases: ['fable', 'opus', 'sonnet', 'haiku'] };
  const f = team.modelFor(act(), 'fix', {});
  assert.equal(f.model, 'sonnet'); assert.equal(f.writeRefusal ?? null, null);
  // every non-Opus alias is a review model: refused with a clear reason, not run on the review model or the CLI default
  const only = world(t, { fix: { effort: 'high' }, review: fable, review_candidates: [fable] });
  only.providerModels.claude = { ...manifests.claude, aliases: ['fable', 'opus'] };
  assert.match(only.modelFor(act(), 'fix', {}).writeRefusal, /no permitted writer.*review model/);
});
