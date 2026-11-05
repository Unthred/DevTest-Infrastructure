// Issue #619: a low-allowance fix-round re-review uses the `low` entry only when it is independent of the PR's writers.
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
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const S = { model: 'sonnet', effort: 'medium' }, O = { model: 'opus', effort: 'medium' };
const config = (agentModels = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: S, fix: S, review: O, review_candidates: [O], low: { model: 'sonnet', effort: 'low' }, ...agentModels } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = { number: 533, title: 't', headRefName: 'claude/issue-1-x', headRefOid: H(5), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green };
const manifests = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] } };

function world(t, { cfg = config(), writer = 'sonnet', mode = 'reviews_only' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'low-rr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => [pr], getPull: async () => pr, listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {}, hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: '1'.repeat(32) }) };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => NOW }, limitedOf: () => ({ out: false }), providerModels: manifests });
  team.modes = { claude: { mode } };
  team.s.jobs.w1 = { kind: 'fix', agent: 'claude', key: '1', model: writer, branch: pr.headRefName, pr: pr.number, head: pr.headRefOid, ingested: true, at: NOW - 5000 };
  return team;
}
const act = (over = {}) => ({ agent: 'claude', pr: pr.number, branch: pr.headRefName, head: pr.headRefOid, key: 'k', reReview: true, ...over });

test('#619: Sonnet wrote the fixes and low is Sonnet: the re-review uses the independent candidate (Opus)', t => {
  assert.equal(world(t).modelFor(act(), 'review', {}).model, 'opus');
});

test('#619: the low entry is still used when it is independent of the writer', t => {
  const f = world(t, { writer: 'opus' }).modelFor(act(), 'review', {});
  assert.deepEqual([f.model, f.effort], ['sonnet', 'low']);
});

test('#619: a full review (not a re-review) and a normal-mode re-review keep the candidate rule', t => {
  assert.equal(world(t).modelFor(act({ reReview: false }), 'review', {}).model, 'opus');
  assert.equal(world(t, { writer: 'opus', mode: 'normal' }).modelFor(act(), 'review', {}).model, 'opus');
});

test('#619: the planner holds a review no candidate can pass, before any job exists', async t => {
  const team = world(t, { cfg: config({ review_candidates: [S], review: S }), writer: 'sonnet' });
  assert.match(team.reviewRefusal('claude', pr, 'k'), /the model that wrote it/);
  assert.equal(world(t).reviewRefusal('claude', pr, 'k'), null);
});

test('#619: no candidate list: the low entry is used as before', t => {
  const f = world(t, { cfg: (() => { const c = config(); delete c.models.agents.claude.review_candidates; return c; })() }).modelFor(act(), 'review', {});
  assert.equal(f.effort, 'low');
});
