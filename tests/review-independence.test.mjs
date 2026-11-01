// Review independence by session and model, not provider (issue #152, amends D-021), plus the out-of-allowance evidence (issue #81).
// Fake GitHub, fake jobs, fake clock: no model call, no network, no real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, applyLocalOverride, validateTeamConfig, weeklyAtOf, touchesPaths } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { outOfAllowance } from '../supervisor/interim.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n\n## D-024 — z\n- Status: homeowner-approved\n- Date: 2026-11-01\n';
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' } }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const manifest = { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] };
const manifests = { claude: manifest, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };

function world(t, { pulls = [pr(77, 'claude/issue-72-x', H(5))], out = {}, cfg = config(), register = REGISTER } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ind-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register, clock: { now: () => NOW }, limitedOf, providerModels: manifests });
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


const writer = (w, over = {}) => { w.team.s.jobs.w1 = { kind: 'implement', agent: 'claude', key: '72', model: 'sonnet', branch: 'claude/issue-72-x', ingested: true, at: NOW - 5000, ...over }; };
const CODEX_OUT = { codex: 'codex weekly limit' };   // only claude can review, so its own review model is what is tested
const planFor = async (w, agent) => (await w.team.plan()).filter(a => a.agent === agent);

test('same provider, different model: a full review, then a merge with no post-merge entry', async t => {
  const w = world(t, { out: CODEX_OUT }); writer(w);   // claude wrote it on sonnet; claude reviews on opus
  const [act] = (await planFor(w, 'claude')).filter(a => a.type === 'review');
  assert.equal(act.pr, 77); assert.equal(act.interim, undefined);
  await w.team.execute(act);
  const spec = w.calls.created[0];
  assert.equal(spec.kind, 'review'); assert.equal(spec.model, 'opus');
  assert.match(spec.worktree, /DevTest-Infrastructure-claude-review$/); assert.deepEqual(spec.allowed_actions, ['read', 'test', 'update_issue']);
  assert.match(spec.scope, /^Independent review of PR #77/); assert.match(spec.prompt, /run the tests yourself/); assert.doesNotMatch(spec.prompt, /interim|D-021/);
  await finish(w, { verdict: 'PASS' });
  const v = w.team.s.verdicts['77:' + H(5)];
  assert.equal(v.reviewer, 'claude'); assert.equal(v.independent, true);
  assert.doesNotMatch(w.calls.comments.at(-1)[1], /interim|post-merge/i); assert.match(w.calls.comments.at(-1)[1], /independent review on `opus`/);
  const merge = (await w.team.plan()).find(a => a.type === 'merge');
  assert.ok(merge); assert.equal(merge.interim, undefined);
  await w.team.execute(merge);
  assert.deepEqual(w.calls.merges, [[77, H(5)]]);
  assert.deepEqual(w.team.s.postMerge, {}); assert.deepEqual(w.calls.labels, []);
  // no review is ever queued for the merged head
  w.gh.pulls = [];
  assert.deepEqual(await w.team.plan(), []);
});

test('same model: the review is refused at planning and at ingest, and a stored same-provider PASS does not merge', async t => {
  const cfg = config(); cfg.models.agents.claude.review = { model: 'sonnet', effort: 'medium' };   // reviews on the model that wrote it
  const w = world(t, { out: CODEX_OUT, cfg }); writer(w);
  assert.equal((await planFor(w, 'claude')).some(a => a.type === 'review'), false);
  assert.match(w.team.held.claude.review, /review refused: claude would review PR #77 on sonnet, the model that wrote it/);
  // a model that is not configured is unknown on both sides: not provably different, so refused
  const none = config(); delete none.models.agents.claude.review;
  const n = world(t, { out: CODEX_OUT, cfg: none }); writer(n, { model: null });
  assert.equal((await planFor(n, 'claude')).some(a => a.type === 'review'), false);
  // ingest: a job that ran on the writer's model records no verdict
  const x = world(t, { out: CODEX_OUT }); writer(x);
  await x.team.execute((await planFor(x, 'claude')).find(a => a.type === 'review'));
  x.team.s.jobs[Object.keys(x.team.s.jobs).at(-1)].model = 'sonnet';
  const { report } = await finish(x, { verdict: 'PASS' });
  assert.deepEqual(x.team.s.verdicts, {}); assert.match(report.ingested[0].error, /review refused/); assert.deepEqual(x.calls.comments, []);
  // a same-author PASS that was not recorded as independent never merges
  const y = world(t); y.team.s.verdicts['77:' + H(5)] = { verdict: 'PASS', reviewer: 'claude', job: 'j' };
  assert.equal((await y.team.plan()).some(a => a.type === 'merge'), false);
  // a different provider is independent even when models are unknown, and is preferred over the author's provider
  const z = world(t, { out: {} }); writer(z);
  const r = (await z.team.plan()).filter(a => a.type === 'review');
  assert.deepEqual(r.map(a => a.agent), ['codex']);
});

test('one-agent roster: validates, plans implement and review, and zero agents is refused', async t => {
  const solo = config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] } } });
  delete solo.models.agents.codex;
  assert.doesNotThrow(() => validateTeamConfig(solo));
  assert.throws(() => validateTeamConfig(config({ agents: {} })), /at least one agent/);
  const w = world(t, { cfg: solo, out: {}, pulls: [pr(77, 'claude/issue-72-x', H(5))] }); writer(w);
  w.gh.issues = [{ number: 5, title: 'Issue five here', state: 'OPEN', body: '', labels: [] }];
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => [a.agent, a.type]).sort(), [['claude', 'implement'], ['claude', 'review']]);
  // negative: with the same model for both roles, a one-agent roster cannot review itself
  const same = structuredClone(solo); same.models.agents.claude.review = { model: 'sonnet', effort: 'low' };
  const v = world(t, { cfg: same, out: {}, pulls: [pr(77, 'claude/issue-72-x', H(5))] }); writer(v);
  assert.equal((await v.team.plan()).some(a => a.type === 'review'), false);
});

const SO = { paths: ['supervisor/upgrade.mjs', 'network/**'], reviewer: 'codex' };
function soWorld(t, { files = ['supervisor/upgrade.mjs'], so = SO, out = {}, passed = true, register = REGISTER } = {}) {
  const cfg = config({ second_opinion: so }); if (!so) delete cfg.second_opinion;
  const w = world(t, { cfg, out, register }); writer(w);
  w.gh.listPullFiles = async () => files;
  if (passed) w.team.s.verdicts['77:' + H(5)] = { verdict: 'PASS', reviewer: 'claude', job: 'j', independent: true, at: NOW - 1000 };
  return w;
}

test('second opinion: a PR on a configured path gets one extra review from another provider and merge waits for it', async t => {
  const w = soWorld(t);
  let acts = await w.team.plan();
  assert.equal(acts.some(a => a.type === 'merge'), false, 'merge waits while the extra review can run');
  const extra = acts.find(a => a.type === 'review');
  assert.deepEqual([extra.agent, extra.pr, extra.secondOpinion], ['codex', 77, true]);
  await w.team.execute(extra);
  assert.match(w.calls.created[0].scope, /^Second-opinion review/); assert.match(w.calls.created[0].prompt, /second-opinion reviewer/);
  await finish(w, { verdict: 'PASS' });
  assert.equal(w.team.s.secondOpinions['77:' + H(5)].reviewer, 'codex');
  assert.equal(w.team.s.verdicts['77:' + H(5)].reviewer, 'claude', 'the primary PASS stays');
  acts = await w.team.plan();
  assert.ok(acts.some(a => a.type === 'merge')); assert.equal(acts.some(a => a.type === 'review'), false, 'one extra review only');
});

test('second opinion: CHANGES from the extra review rejects the head; it is not asked twice', async t => {
  const w = soWorld(t);
  await w.team.execute((await w.team.plan()).find(a => a.type === 'review'));
  await finish(w, { verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'upgrader skips the lock' }] });
  assert.equal(w.team.s.verdicts['77:' + H(5)].verdict, 'CHANGES');
  const acts = await w.team.plan();
  assert.equal(acts.some(a => a.type === 'merge'), false); assert.ok(acts.some(a => a.type === 'fix' && a.agent === 'claude'));
  assert.equal(acts.some(a => a.type === 'review'), false);
});

test('second opinion: not configured, other paths, unreadable list, reviewer out of allowance or same provider as the writer', async t => {
  const merges = async w => (await w.team.plan()).filter(a => a.type === 'merge' || a.type === 'review').map(a => a.type);
  assert.deepEqual(await merges(soWorld(t, { so: null })), ['merge'], 'no config: no extra review');
  assert.deepEqual(await merges(soWorld(t, { files: ['docs/x.md'] })), ['merge'], 'path not touched');
  assert.deepEqual(await merges(soWorld(t, { out: { codex: 'weekly limit' } })), ['merge'], 'reviewer out of allowance: optional, no hold');
  assert.deepEqual(await merges(soWorld(t, { so: { ...SO, reviewer: 'claude' } })), ['merge'], 'same provider as the writer');
  const bad = soWorld(t); bad.gh.listPullFiles = async () => { throw new Error('gh down'); };
  assert.deepEqual(await merges(bad), ['review'], 'unreadable file list fails closed: merge held, extra review planned');
  assert.deepEqual(await merges(soWorld(t, { passed: false })), ['review'], 'primary review comes first, without a hold on a missing PASS');
  for (const badCfg of [{ paths: [], reviewer: 'codex' }, { paths: ['../x'], reviewer: 'codex' }, { paths: ['a'], reviewer: 'nobody' }, { paths: ['a'], reviewer: 'codex', x: 1 }, 'x'])
    assert.throws(() => validateTeamConfig(config({ second_opinion: badCfg })), /second_opinion/);
});

test('existing post-merge entries are dropped, except PRs touching second-opinion paths', async t => {
  const w = soWorld(t, { passed: false, out: {} });
  w.gh.pulls = [];
  w.team.s.postMerge[10] = { head: H(1), branch: 'claude/issue-1-x', author: 'claude', at: NOW };
  w.team.s.postMerge[11] = { head: H(2), branch: 'claude/issue-2-x', author: 'claude', at: NOW };
  w.team.s.postMerge[12] = { head: H(3), branch: 'claude/issue-3-x', author: 'claude', at: NOW, done: { verdict: 'PASS' } };
  w.gh.listPullFiles = async n => (n === 11 ? ['network/fw.mjs'] : ['docs/a.md']);
  assert.deepEqual((await w.team.plan()).filter(a => a.postMerge), [], 'a dry plan neither queues nor changes them');
  const report = {}; await w.team.pruneLegacyPostMerge(report);
  assert.deepEqual(Object.keys(w.team.s.postMerge).sort(), ['11', '12']); assert.deepEqual(report.droppedPostMerge, [10]);
  assert.equal(w.team.s.postMerge[11].secondOpinion, true);
  const post = (await w.team.plan()).filter(a => a.postMerge);
  assert.deepEqual(post.map(a => [a.agent, a.pr]), [['codex', 11]]);
  // without a second_opinion config every unfinished entry goes
  const n = soWorld(t, { so: null, passed: false }); n.team.s.postMerge[11] = { head: H(2), branch: 'claude/issue-2-x', author: 'claude', at: NOW };
  await n.team.pruneLegacyPostMerge({}); assert.deepEqual(n.team.s.postMerge, {});
});

test('post-merge CHANGES of a retained second-opinion entry opens one linked issue for the homeowner', async t => {
  const w = world(t, { out: {} });
  w.team.s.postMerge[77] = { head: H(5), branch: 'claude/issue-72-x', author: 'claude', at: NOW, secondOpinion: true };
  w.team.c.second_opinion = SO; w.gh.pulls = [];
  await w.team.execute((await w.team.plan()).find(a => a.agent === 'codex'));
  await finish(w, { verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'lease never released' }] });
  assert.equal(w.calls.issues.length, 1); assert.match(w.calls.issues[0][1], /Second-opinion review of merged PR #77/); assert.match(w.calls.issues[0][2], /lease never released/);
  assert.deepEqual(w.calls.labels.at(-1), [200, 'needs-homeowner']);
  assert.equal(w.team.s.postMerge[77].done.issue, 200);
});

test('config: interim_review is retired but tolerated with a warning; out_of_allowance sets the threshold', () => {
  const old = validateTeamConfig(config({ out_of_allowance: undefined, interim_review: { enabled: true, decision: 'D-021', weekly_at: 0.9 } }));
  assert.match(old.deprecations[0], /interim_review is retired/); assert.equal(weeklyAtOf(old), 0.9);
  const now = validateTeamConfig(config({ interim_review: undefined, out_of_allowance: { weekly_at: 0.8 } }));
  assert.deepEqual(now.deprecations, []); assert.equal(weeklyAtOf(now), 0.8);
  assert.equal(weeklyAtOf(validateTeamConfig(config({ interim_review: undefined, out_of_allowance: undefined }))), 0.95);
  for (const bad of [{ weekly_at: 2 }, { weekly_at: 0.5, x: 1 }, []]) assert.throws(() => validateTeamConfig(config({ interim_review: undefined, out_of_allowance: bad })), /out_of_allowance/);
  assert.deepEqual(applyLocalOverride(config({ interim_review: undefined }), { out_of_allowance: { weekly_at: 0.7 } }).out_of_allowance, { weekly_at: 0.7 });
  assert.throws(() => applyLocalOverride(config(), { out_of_allowance: { enabled: true } }), /only weekly_at/);
});

test('globs: ** crosses directories, * does not, regex characters are literal', () => {
  assert.equal(touchesPaths(['network/a/b.mjs'], ['network/**']), true);
  assert.equal(touchesPaths(['network/a/b.mjs'], ['network/*']), false);
  assert.equal(touchesPaths(['supervisor/upgrade.mjs'], ['supervisor/upgrade.mjs']), true);
  assert.equal(touchesPaths(['supervisorXupgrade.mjs'], ['supervisor.upgrade.mjs']), false);
  assert.equal(touchesPaths(['secrets/a.json'], ['**/*.json']), true);
});

// Review fix (PR #168): D-024 is an agent-proposal until the homeowner approves it; D-021 keeps binding meanwhile.
const UNAPPROVED = REGISTER.replace(/## D-024[\s\S]*/, '') + '\n## D-024 — z\n- Status: agent-proposal\n- Date: 2026-11-01\n';

test('until D-024 is homeowner-approved a same-provider independent PASS does not merge, and an opposite-provider PASS still does', async t => {
  const w = world(t, { register: UNAPPROVED, out: CODEX_OUT }); writer(w);
  w.team.s.verdicts['77:' + H(5)] = { verdict: 'PASS', reviewer: 'claude', job: 'j', independent: true, at: NOW - 1000 };
  assert.equal((await w.team.plan()).find(a => a.type === 'merge'), undefined);
  w.team.s.verdicts['77:' + H(5)] = { verdict: 'PASS', reviewer: 'codex', job: 'j', at: NOW - 1000 };
  assert.ok((await w.team.plan()).find(a => a.type === 'merge'));
  const ok = world(t, { out: CODEX_OUT }); writer(ok);
  ok.team.s.verdicts['77:' + H(5)] = { verdict: 'PASS', reviewer: 'claude', job: 'j', independent: true, at: NOW - 1000 };
  assert.ok((await ok.team.plan()).find(a => a.type === 'merge'), 'approved D-024: merges');
});

test('until D-024 is homeowner-approved the tick keeps queued post-merge reviews', async t => {
  for (const [register, kept] of [[UNAPPROVED, ['10']], [REGISTER, []]]) {
    const w = soWorld(t, { passed: false, out: {}, register }); w.gh.pulls = [];
    w.team.s.postMerge[10] = { head: H(1), branch: 'claude/issue-1-x', author: 'claude', at: NOW };
    w.gh.listPullFiles = async () => ['docs/a.md'];
    await w.team.tick({});
    assert.deepEqual(Object.keys(w.team.s.postMerge), kept);
  }
});
