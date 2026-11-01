// Interim same-provider review while every other agent is out of allowance (D-021, issue #81).
// Fake GitHub, fake jobs, fake clock: no model call, no network, no real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { outOfAllowance } from '../supervisor/interim.mjs';
import { resolveModel } from '../supervisor/models.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, interim_review: { enabled: true, decision: 'D-021', weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'opus', effort: 'high' }, review: { model: 'sonnet', effort: 'medium' }, 'interim-review': { model: 'haiku', effort: 'medium' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const manifest = { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] };

function world(t, { pulls = [pr(77, 'claude/issue-72-x', H(5))], out = { codex: 'codex job fa607a0d ran out of retries on usage limits' }, cfg = config(), register = REGISTER } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interim-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [], unlabels: [], merges: [], created: [], issues: [] };
  const gh = {
    pulls, issues: [],
    listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues, listMergedPulls: async () => [],
    comment: async (n, body) => calls.comments.push([n, body]), addLabel: async (n, l) => calls.labels.push([n, l]), removeLabel: async (n, l) => calls.unlabels.push([n, l]),
    hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {},
    createIssue: async (title, body) => { const number = 200 + calls.issues.length; calls.issues.push([number, title, body]); return number; },
    merge: async (n, head) => { const p = gh.pulls.find(x => x.number === n); if (!p || p.headRefOid !== head) throw new Error('head moved'); calls.merges.push([n, head]); }
  };
  const jobs = { active: [], states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const state = { out };
  const limitedOf = agent => (state.out[agent] ? { out: true, reason: state.out[agent] } : { out: false });
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register, clock: { now: () => NOW }, limitedOf, providerModels: { claude: manifest } });
  return { gh, jobs, team, calls, state };
}
const writeVerdict = (team, ticket, v) => { const d = path.join(team.dir, 'inbox', ticket); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify(v)); };
const finish = async (w, verdict) => {
  const [id, rec] = Object.entries(w.team.s.jobs).at(-1);
  writeVerdict(w.team, rec.ticket, { pr: rec.pr, headSha: rec.head, findings: [], commandsRun: ['node --test'], ...verdict });
  w.jobs.states[id].status = 'completed'; const report = { ingested: [] }; await w.team.ingest(report); return { id, rec, report };
};

test('out of allowance: provider windows, weekly threshold and the latest job are the only evidence', () => {
  const win = (type, utilization, resetsAt, status = 'allowed') => ({ type, utilization, resetsAt, status });
  const base = { provider: 'claude', now: NOW };
  assert.equal(outOfAllowance({ ...base, allowance: { status: 'rejected', windows: [win('five_hour', 1, NOW + 60000, 'rejected')] } }).out, true);
  // the used-up window has already reset: not out, even though the recorded status still says rejected
  assert.equal(outOfAllowance({ ...base, allowance: { status: 'rejected', windows: [win('five_hour', 1, NOW - 1, 'rejected'), win('seven_day', 0.76, NOW + 1e8)] } }).out, false);
  assert.match(outOfAllowance({ ...base, allowance: { status: 'allowed', windows: [win('seven_day', 0.97, NOW + 1e8)] } }).reason, /weekly use 97% >= 95%/);
  assert.equal(outOfAllowance({ ...base, allowance: { status: 'allowed', windows: [win('seven_day', 0.9, NOW + 1e8)] } }).out, false);
  // a bare status with no windows counts; an unknown status never does
  assert.equal(outOfAllowance({ ...base, allowance: { status: 'limit_reached', windows: [], observedAt: NOW - 1000 } }).out, true);
  assert.equal(outOfAllowance({ ...base, allowance: { status: 'weird', windows: [], observedAt: NOW } }).out, false);
  // the latest job: paused on a limit, or blocked after retries on usage limits (31 Oct Codex shape, its allowance showed no windows)
  const job = (status, lastEvent, updatedAt = NOW - 1000, id = 'a'.repeat(32)) => ({ id, provider: 'codex', status, lastEvent, updatedAt });
  const codex = { provider: 'codex', now: NOW, allowance: { status: 'allowed', windows: [] } };
  assert.equal(outOfAllowance({ ...codex, jobs: [job('paused_limit', 'usage_limit')] }).out, true);
  // review of 66876af: a transient rate limit pauses a job too, but is not an allowance limit; a passed reset is not evidence
  assert.equal(outOfAllowance({ ...codex, jobs: [job('paused_limit', 'transient_rate_limit')] }).out, false);
  assert.equal(outOfAllowance({ ...codex, jobs: [{ ...job('paused_limit', 'usage_limit'), resetAt: NOW - 1 }] }).out, false);
  assert.equal(outOfAllowance({ ...codex, jobs: [{ ...job('paused_limit', 'usage_limit'), resetAt: NOW + 60000 }] }).out, true);
  assert.equal(outOfAllowance({ ...codex, jobs: [job('blocked', 'retry_exhausted')], hadLimit: () => true }).out, true);
  assert.equal(outOfAllowance({ ...codex, jobs: [job('blocked', 'retry_exhausted')], hadLimit: () => false }).out, false);
  // 31 Oct Claude shape: paused on the five-hour limit, which the provider said resets at 21:40; after that it is not out
  const paused = { id: 'c'.repeat(32), provider: 'claude', status: 'paused_limit', lastEvent: 'usage_limit', updatedAt: NOW - 3600000 };
  const fiveHour = { status: 'rejected', observedAt: NOW - 3600000, windows: [win('five_hour', 1, NOW - 60000, 'rejected'), win('seven_day', 0.76, NOW + 1e8, 'allowed_warning')] };
  assert.equal(outOfAllowance({ provider: 'claude', now: NOW, jobs: [paused], allowance: fiveHour }).out, false);
  assert.equal(outOfAllowance({ provider: 'claude', now: NOW - 120000, jobs: [paused], allowance: fiveHour }).out, true);
  // a record older than the pause cannot clear it
  assert.equal(outOfAllowance({ provider: 'claude', now: NOW, jobs: [{ ...paused, updatedAt: NOW - 1000 }], allowance: fiveHour }).out, true);
  // a later successful job clears it; evidence older than a week does not count; other providers' jobs are ignored
  assert.equal(outOfAllowance({ ...codex, jobs: [job('paused_limit', 'usage_limit', NOW - 5000), job('completed', 'completed', NOW - 10, 'b'.repeat(32))] }).out, false);
  assert.equal(outOfAllowance({ ...codex, jobs: [job('paused_limit', 'usage_limit', NOW - 8 * 86400000)] }).out, false);
  assert.equal(outOfAllowance({ ...codex, jobs: [{ ...job('paused_limit', 'usage_limit'), provider: 'claude' }] }).out, false);
});

test('interim review is planned for the author only while every other agent is out, D-021 is approved and the author has allowance', async t => {
  const w = world(t);
  const [act] = (await w.team.plan()).filter(a => a.agent === 'claude');
  assert.equal(act.type, 'review'); assert.equal(act.pr, 77); assert.match(act.interim, /codex: codex job fa607a0d/);
  for (const [why, opts] of [
    ['the other agent has allowance', { out: {} }],
    ['the author is out too', { out: { codex: 'x', claude: 'y' } }],
    ['interim review disabled', { cfg: config({ interim_review: { enabled: false, decision: 'D-021' } }) }],
    ['not configured', { cfg: config({ interim_review: undefined }) }],
    ['D-021 not homeowner-approved', { register: REGISTER.replace('- Status: homeowner-approved\n- Date: 2026-10-31', '- Status: agent-proposal\n- Date: 2026-10-31') }],
    ['red CI', { pulls: [pr(77, 'claude/issue-72-x', H(5), { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })] }]]) {
    const v = world(t, opts);
    assert.equal((await v.team.plan()).some(a => a.agent === 'claude' && a.type === 'review'), false, why);
  }
});

test('interim review job: interim-review model, fresh review worktree, sceptical prompt, interim verdict', async t => {
  const w = world(t);
  const act = (await w.team.plan()).find(a => a.agent === 'claude');
  await w.team.execute(act);
  const spec = w.calls.created[0];
  assert.equal(spec.kind, 'review'); assert.equal(spec.model, 'haiku'); assert.equal(spec.effort, 'medium');
  assert.match(spec.worktree, /DevTest-Infrastructure-claude-review$/); assert.match(spec.scope, /^Interim \(D-021\) review of PR #77/);
  assert.match(spec.prompt, /interim reviewer \(D-021\)/); assert.deepEqual(spec.allowed_actions, ['read', 'test', 'update_issue']);
  await finish(w, { verdict: 'PASS' });
  const v = w.team.s.verdicts[`77:${H(5)}`];
  assert.equal(v.reviewer, 'claude'); assert.equal(v.interim, true);
  assert.match(w.calls.comments.at(-1)[1], /interim review \(D-021\) by `claude` on `haiku`/);
  // without an interim-review entry the review entry is used, never the strong implement entry
  const cfg = config(); delete cfg.models.agents.claude['interim-review'];
  const r = resolveModel({ modelsConfig: cfg.models, agent: 'claude', kind: 'interim-review', manifestModels: manifest, escalation: null, utilization: null });
  assert.equal(r.fields.model, 'sonnet');
});

test('interim PASS merges, labels post-merge-review, and the regular reviewer reviews the merged head once it has allowance', async t => {
  const w = world(t);
  await w.team.execute((await w.team.plan()).find(a => a.agent === 'claude'));
  await finish(w, { verdict: 'PASS' });
  const merge = (await w.team.plan()).find(a => a.type === 'merge');
  assert.equal(merge.interim, true); assert.equal(merge.reviewer, 'claude');
  await w.team.execute(merge);
  assert.deepEqual(w.calls.merges, [[77, H(5)]]);
  // a refused interim merge leaves no post-merge debt
  const v = world(t); v.team.s.verdicts[`77:${H(5)}`] = { verdict: 'PASS', reviewer: 'claude', job: 'j', interim: true };
  const m = (await v.team.plan()).find(a => a.type === 'merge'); v.gh.pulls[0].headRefOid = H(6);
  await assert.rejects(v.team.execute(m), /head moved/); assert.deepEqual(v.team.s.postMerge, {}); assert.deepEqual(w.calls.labels.at(-1), [77, 'post-merge-review']);
  assert.equal(w.team.s.postMerge[77].author, 'claude');
  // the merged PR leaves the open list; while codex is out no post-merge review starts
  w.gh.pulls = [];
  assert.equal((await w.team.plan()).some(a => a.agent === 'codex'), false);
  // codex is back: it reviews the merged head; the author never does
  w.state.out = {};
  const plan = await w.team.plan();
  const post = plan.find(a => a.agent === 'codex');
  assert.equal(post.postMerge, true); assert.equal(post.head, H(5)); assert.equal(plan.some(a => a.agent === 'claude' && a.postMerge), false);
  await w.team.execute(post);
  assert.match(w.calls.created.at(-1).prompt, /already merged/);
  await finish(w, { verdict: 'PASS' });
  assert.deepEqual(w.calls.unlabels, [[77, 'post-merge-review']]); assert.equal(w.team.s.postMerge[77].done.verdict, 'PASS');
  // the post-merge verdict is not a merge verdict, and the job is not planned again
  assert.equal(w.team.s.verdicts[`77:${H(5)}`].reviewer, 'claude');
  assert.equal((await w.team.plan()).some(a => a.postMerge), false);
});

test('post-merge CHANGES opens one linked issue for the homeowner and keeps the label', async t => {
  const w = world(t, { out: {} });
  w.team.s.postMerge[77] = { head: H(5), branch: 'claude/issue-72-x', author: 'claude', at: NOW };
  w.gh.pulls = [];
  await w.team.execute((await w.team.plan()).find(a => a.agent === 'codex'));
  await finish(w, { verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'lease never released' }] });
  assert.equal(w.calls.issues.length, 1); assert.match(w.calls.issues[0][1], /Post-merge review of PR #77/); assert.match(w.calls.issues[0][2], /lease never released/);
  assert.deepEqual(w.calls.labels.at(-1), [200, 'needs-homeowner']); assert.deepEqual(w.calls.unlabels, []);
  assert.equal(w.team.s.postMerge[77].done.issue, 200);
});

test('a same-agent PASS without the interim flag, or with D-021 withdrawn, never merges', async t => {
  const w = world(t);
  w.team.s.verdicts[`77:${H(5)}`] = { verdict: 'PASS', reviewer: 'claude', job: 'j' };
  assert.equal((await w.team.plan()).some(a => a.type === 'merge'), false);
  const v = world(t, { register: REGISTER.replace('- Status: homeowner-approved\n- Date: 2026-10-31', '- Status: agent-proposal\n- Date: 2026-10-31') });
  v.team.s.verdicts[`77:${H(5)}`] = { verdict: 'PASS', reviewer: 'claude', job: 'j', interim: true };
  assert.equal((await v.team.plan()).some(a => a.type === 'merge'), false);
});

test('interim_review config: validated fail-closed; team.local.json may set only enabled and weekly_at', () => {
  for (const bad of [{ enabled: 'yes', decision: 'D-021' }, { enabled: true, decision: 'D-020' }, { enabled: true, decision: 'D-021', weekly_at: 2 }, { enabled: true, decision: 'D-021', extra: 1 }])
    assert.throws(() => validateTeamConfig(config({ interim_review: bad })), /interim_review/);
  const out = applyLocalOverride(config(), { interim_review: { enabled: false, weekly_at: 0.9 } });
  assert.deepEqual(out.interim_review, { enabled: false, decision: 'D-021', weekly_at: 0.9 });
  assert.throws(() => applyLocalOverride(config(), { interim_review: { decision: 'D-001' } }), /only enabled and weekly_at/);
  assert.throws(() => applyLocalOverride(config({ interim_review: undefined }), { interim_review: { enabled: true } }), /not configured/);
});
