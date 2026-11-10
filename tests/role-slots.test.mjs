// Concurrency by role, not by agent (issue #148): one implementer slot and one reviewer slot, filled by whichever agent has allowance.
// Fake GitHub, fake jobs, fake clock: no model call, no network, no real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, applyLocalOverride, validateTeamConfig, roleOfType } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const limits = (over = {}) => ({ roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...over });
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: limits(),
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } },
    codex: { implement: { model: 'big', effort: 'high' }, review: { model: 'mid', effort: 'medium' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5, 6] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN') => ({ number: n, title: `Issue ${n} title here`, state, body: '', labels: [] });
const manifest = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: ['big', 'mid'], efforts: ['low', 'medium', 'high'] } };

function world(t, { pulls = [], issues = [issue(5), issue(6), issue(2)], out = {}, cfg = config(), active = [], inboxJob = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inbox = inboxJob ? path.join(dir, 'inbox') : null;
  if (inbox) {
    fs.mkdirSync(path.join(inbox, 'status'), { recursive: true });
    const status = { id: inboxJob.id, state: 'running', lane: 'inbox', ...(inboxJob.adopted === false ? {} : { adopt: { id: inboxJob.id, rec: { kind: 'inbox' } } }) };
    fs.writeFileSync(path.join(inbox, 'status', `${inboxJob.id}.json`), JSON.stringify(status));
  }
  const calls = { created: [] };
  const gh = { pulls, issues, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues, listMergedPulls: async () => [],
    comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { active, states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const limitedOf = agent => (out[agent] ? { out: true, reason: out[agent] } : { out: false });
  const teamConfig = inbox ? { ...cfg, inbox: { dir: inbox } } : cfg;
  const team = new Team({
    config: teamConfig,
    root: stateRoot(path.join(dir, 'state')),
    gh,
    jobs,
    git,
    register: REGISTER,
    clock: { now: () => 1_800_000_000_000 },
    limitedOf,
    providerModels: manifest
  });
  return { gh, jobs, team, calls };
}
// Record a running job the way the dispatcher does, so the slot it holds is known.
const running = (w, id, kind, agent, extra = {}) => {
  w.jobs.active.push({ id, provider: w.team.c.agents[agent].provider, status: 'running' });
  w.team.s.jobs[id] = { kind, agent, key: String(extra.issue ?? extra.pr), ingested: false, ...extra };
};
// A recorded implementer job: who wrote the head, on which model (what Foreman's job records hold).
const written = (agent, model, branch = 'claude/issue-72-x') => ({ kind: 'implement', agent, key: '1', model, branch, ingested: true, at: 1 });
const codexOut = { codex: 'codex weekly limit' };

test('one agent in allowance: an implement job and a review on another model run at the same time, each with its role model', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut });
  w.team.s.jobs.w0 = written('claude', 'sonnet');
  const report = await w.team.tick();
  assert.deepEqual(w.calls.created.map(s => [s.provider, s.kind]).sort(), [['claude', 'implement'], ['claude', 'review']]);
  const by = Object.fromEntries(w.calls.created.map(s => [s.kind, s]));
  assert.deepEqual([by.implement.model, by.implement.effort], ['sonnet', 'high']);
  assert.deepEqual([by.review.model, by.review.effort], ['opus', 'low']);   // the review entry, a different model from the one that wrote the PR
  assert.equal(report.actions.length, 2);
});

test('negative: two implement jobs never run at once with implementer: 1, even from two agents', async t => {
  const w = world(t);   // claude owns #5, #6 and codex owns #2, nothing is out of allowance
  const acts = await w.team.plan();
  assert.equal(acts.filter(a => a.type === 'implement').length, 1);
  assert.equal(acts[0].agent, 'claude');   // team.json order breaks the tie
  // with the slot busy, no further implement job is planned
  const busy = world(t); running(busy, 'a', 'implement', 'claude', { issue: 5 });
  assert.deepEqual(await busy.team.plan(), []);
  // a repair job holds the same slot as an implement job
  const fixing = world(t); running(fixing, 'f', 'fix', 'codex', { pr: 9 });
  assert.deepEqual(await fixing.team.plan(), []);
  // two slots allow two, never the same issue twice
  const two = world(t, { cfg: config({ limits: limits({ roles: { implementer: 2, reviewer: 1 } }) }) });
  const issues = (await two.team.plan()).filter(a => a.type === 'implement').map(a => a.issue);
  assert.equal(new Set(issues).size, issues.length); assert.equal(issues.length, 2);
});

test('a review on another model fills the reviewer slot while the same agent implements; a second review waits', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5)), pr(78, 'claude/issue-73-x', H(6))], out: codexOut });
  w.team.s.jobs.w0 = written('claude', 'sonnet', 'claude/issue-72-x'); w.team.s.jobs.w1 = written('claude', 'sonnet', 'claude/issue-73-x');
  running(w, 'i', 'implement', 'claude', { issue: 5 });
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => [a.agent, a.type, a.pr]), [['claude', 'review', 77]]);
  const full = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut });
  full.team.s.jobs.w0 = written('claude', 'sonnet');
  running(full, 'i', 'implement', 'claude', { issue: 5 }); running(full, 'r', 'review', 'claude', { pr: 76 });
  assert.deepEqual(await full.team.plan(), []);   // both slots busy (and overall 2 reached)
});

test('the reviewer slot is not blocked by an implementer job, and a review does not block implementing', async t => {
  const w = world(t, { pulls: [pr(10, 'codex/issue-2-x', H(1))] });
  running(w, 'r', 'review', 'claude', { pr: 3 });
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => a.type), ['implement']);   // the review slot is taken; the implementer slot is free
  assert.ok(roleOfType('review') === 'reviewer' && ['implement', 'continue', 'fix', 'cifix'].every(k => roleOfType(k) === 'implementer') && roleOfType('rebase') === 'rebaser');
});

test('with both agents available a review goes to the other provider first, though the author provider could review on another model', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))] });
  const rev = (await w.team.plan()).filter(a => a.type === 'review');
  assert.deepEqual(rev.map(a => a.agent), ['codex']);
});

test('overall is still honoured across the slots', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut, cfg: config({ limits: limits({ overall: 1 }) }) });
  assert.equal((await w.team.plan()).length, 1);
  const full = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut }); running(full, 'a', 'implement', 'claude', { issue: 5 }); running(full, 'b', 'implement', 'claude', { issue: 6 });
  assert.deepEqual(await full.team.plan(), []);
});

test('the same issue or worktree is not planned twice: an unfinished job for it blocks a duplicate', async t => {
  const w = world(t, { issues: [issue(5)], cfg: config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } }, limits: limits({ roles: { implementer: 2, reviewer: 1 } }) }) });
  w.team.s.jobs.old = { kind: 'implement', agent: 'claude', key: '5', ingested: false };
  assert.deepEqual(await w.team.plan(), []);
  const unusable = world(t, { issues: [issue(5)] }); unusable.team.s.unusable['implement:5'] = { worktree: '/x', at: 1_800_000_000_000 - 1000 };
  assert.equal((await unusable.team.plan()).filter(a => a.issue === 5).length, 0);
});

test('limits.roles is validated; per_agent is deprecated, mapped to both slots and reported on the tick', async t => {
  assert.deepEqual(validateTeamConfig(config()).deprecations, []);
  validateTeamConfig(config({ limits: limits({ roles: { implementer: 1, reviewer: 9 } }) }));   // no fixed ceiling (#344)
  for (const bad of [{ implementer: 0, reviewer: 1 }, { implementer: 1 }, { implementer: 1, reviewer: 1, extra: 1 }, [], 'x'])
    assert.throws(() => validateTeamConfig(config({ limits: limits({ roles: bad }) })), /roles/);
  const old = config({ limits: { per_agent: 2, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } });
  const c = validateTeamConfig(old);
  assert.deepEqual(c.limits.roles, { implementer: 2, reviewer: 2 }); assert.match(c.deprecations[0], /per_agent is deprecated/);
  assert.throws(() => validateTeamConfig(config({ limits: { per_agent: 0, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } })), /per_agent/);
  assert.throws(() => validateTeamConfig(config({ limits: { overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } })), /roles/);
  const w = world(t, { cfg: old });
  const report = await w.team.tick({ dryRun: true });
  assert.ok(report.warnings.some(x => /per_agent is deprecated/.test(x.warning)));
  assert.equal((await world(t).team.tick({ dryRun: true })).warnings, undefined);
  // roles wins over a stale per_agent
  assert.deepEqual(validateTeamConfig(config({ limits: limits({ per_agent: 3 }) })).limits.roles, { implementer: 1, reviewer: 1 });
});

test('team.local.json: roles override merges per role; a local per_agent still works (with a warning)', () => {
  const base = config();
  const merged = validateTeamConfig(applyLocalOverride(base, { limits: { roles: { reviewer: 2 } } }));
  assert.deepEqual(merged.limits.roles, { implementer: 1, reviewer: 2 });
  const legacy = validateTeamConfig(applyLocalOverride(base, { limits: { per_agent: 2 } }));
  assert.deepEqual(legacy.limits.roles, { implementer: 2, reviewer: 2 }); assert.equal(legacy.deprecations.length, 1);
  assert.throws(() => validateTeamConfig(applyLocalOverride(base, { limits: { roles: { reviewer: 0 } } })), /roles/);
});

test('repair work outranks a new implement across agents: a rejected or red PR of the second-listed agent is not starved', async t => {
  // codex PR #10 has a CHANGES verdict on its head; claude (listed first) has implementable issues
  const rejected = world(t, { pulls: [pr(10, 'codex/issue-2-x', H(1))] });
  rejected.team.s.verdicts[`10:${H(1)}`] = { verdict: 'CHANGES', reviewer: 'claude', findings: [{ kind: 'blocking', text: 'x' }], at: 1_800_000_000_000 - 1000 };
  const a = await rejected.team.plan();
  assert.deepEqual(a.filter(x => x.type !== 'review').map(x => [x.agent, x.type, x.pr]), [['codex', 'fix', 10]]);
  // the same for a red CI check
  const red = world(t, { pulls: [pr(10, 'codex/issue-2-x', H(1), { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' }] })] });
  const b = (await red.team.plan()).filter(x => x.type !== 'review');
  assert.deepEqual(b.map(x => [x.agent, x.type]), [['codex', 'cifix']]);
  // and a conflicting PR
  const conflict = world(t, { pulls: [pr(10, 'codex/issue-2-x', H(1), { mergeable: 'CONFLICTING' })] });
  assert.deepEqual((await conflict.team.plan()).filter(x => x.type !== 'review').map(x => [x.agent, x.type]), [['claude', 'implement'], ['codex', 'rebase']]);   // issue #460: the rebase has its own slot, so new work starts beside it
  // with no repair pending, the first agent's implement still wins the tie (owner order)
  const none = world(t);
  assert.deepEqual((await none.team.plan()).map(x => [x.agent, x.type]), [['claude', 'implement']]);
});

// ---- review follow-ups (issue #154)
test('per_agent only: loadTeamConfig then new Team reports the mapped-deprecation text once, not the "ignored because roles is set" text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-load-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(file, JSON.stringify(config({ limits: { per_agent: 2, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } })));
  const { loadTeamConfig } = await import('../supervisor/team.mjs');
  const loaded = loadTeamConfig(file, dir);
  const w = world(t, { cfg: loaded });
  assert.equal(w.team.c.deprecations.length, 1);
  assert.match(w.team.c.deprecations[0], /mapped to limits\.roles/);
  assert.doesNotMatch(w.team.c.deprecations[0], /ignored because/);
  assert.deepEqual(w.team.c.limits.roles, { implementer: 2, reviewer: 2 });
  // negative: an explicit roles next to per_agent is still reported as ignored, also after a second validation
  const both = validateTeamConfig(validateTeamConfig(config({ limits: limits({ per_agent: 3 }) })));
  assert.match(both.deprecations[0], /ignored because limits\.roles is set/);
});

test('a partial local roles override on an older shipped file with per_agent takes the other role from per_agent', () => {
  const shipped = config({ limits: { per_agent: 2, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } });
  const c = validateTeamConfig(applyLocalOverride(shipped, { limits: { roles: { implementer: 1 } } }));
  assert.deepEqual(c.limits.roles, { implementer: 1, reviewer: 2 });
  assert.throws(() => validateTeamConfig(applyLocalOverride(config({ limits: { overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } }), { limits: { roles: { implementer: 1 } } })), /roles/);   // no source for the missing role
});

test('an owner at its usage limit does not start its own implement job; the other agent takes it', async t => {
  // roles 3/1: a third implementer slot would otherwise go to codex's own #2 (issue #187); claude's #5 and #6 fill two.
  const w = world(t, { cfg: config({ limits: limits({ roles: { implementer: 3, reviewer: 1 }, overall: 4 }) }), out: codexOut });
  const plan = await w.team.plan();
  assert.ok(!plan.some(a => a.agent === 'codex' && a.type === 'implement'));
  assert.deepEqual(plan.filter(a => a.agent === 'claude' && a.type === 'implement').map(a => a.issue).sort(), [5, 6]);
});

test('#1123: a limited repair is held before allocation, so a ready agent receives the slot', async t => {
  const failed = [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'project-contract' }];
  const w = world(t, { pulls: [pr(1117, 'codex/issue-1117-x', H(7), { statusCheckRollup: failed })], issues: [issue(5)], out: codexOut });
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => [a.agent, a.type, a.issue]), [['claude', 'implement', 5]]);
  assert.match(w.team.held.codex.cifix, /out of allowance/);
  assert.ok(!acts.some(a => a.agent === 'codex'), 'a limited action is never planned');
});

test('#1123: a parked repair is held before allocation, so a ready agent receives the slot', async t => {
  const failed = [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'project-contract' }];
  const w = world(t, { pulls: [pr(1117, 'codex/issue-1117-x', H(7), { statusCheckRollup: failed })], issues: [issue(5)] });
  w.team.s.infra = { parked: { codex: { cause: 'provider_outage' } } };
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => [a.agent, a.type, a.issue]), [['claude', 'implement', 5]]);
  assert.match(w.team.held.codex.cifix, /parked after an infrastructure fault: provider outage/);
  assert.ok(!acts.some(a => a.agent === 'codex'), 'a parked action is never planned');
});

test('#1123: both limited agents leave a healthy tick with no planned work', async t => {
  const w = world(t, { issues: [issue(5), issue(2)], out: { claude: 'Claude limit', codex: 'Codex limit' } });
  const report = await w.team.tick();
  assert.deepEqual(report.actions, []);
  assert.deepEqual(w.calls.created, []);
  assert.equal(report.skipped.length, 0);
  assert.match(w.team.held.claude.implement, /out of allowance/);
  assert.match(w.team.held.codex.implement, /out of allowance/);
});

test('#1123: an Inbox job uses only its lane with and without an adopted job record', async t => {
  for (const adopted of [false, true]) {
    const id = `${adopted ? 'a' : 'b'}`.repeat(32);
    const w = world(t, {
      issues: [issue(5)],
      active: [{ id, provider: 'claude', status: 'running' }],
      inboxJob: { id, adopted }
    });
    if (adopted) w.team.s.jobs[id] = { kind: 'inbox', agent: 'claude', key: 'prompt' };
    assert.deepEqual((await w.team.plan()).map(a => [a.type, a.issue]), [['implement', 5]], adopted ? 'adopted' : 'unadopted');
  }
});

test('#1133: an Inbox job between creation and adoption uses only its lane', async t => {
  const id = 'c'.repeat(32);
  const w = world(t, {
    issues: [issue(5)],
    active: [{ id, provider: 'claude', status: 'running' }],
    inboxJob: { id, adopted: false }
  });
  assert.deepEqual((await w.team.plan()).map(action => [action.type, action.issue]), [['implement', 5]]);
});

test('#1133: the transient Inbox record counts toward its provider Inbox cap', async t => {
  const id = 'd'.repeat(32);
  const cfg = config({ limits: limits({ provider_roles: { claude: { inbox: 1 } } }) });
  const w = world(t, {
    cfg,
    active: [{ id, provider: 'claude', status: 'running' }],
    inboxJob: { id, adopted: false }
  });
  assert.equal(await w.team.providerRoleFull('claude', 'inbox'), true);
});

test('#1133: an unadopted Inbox record is matched to its own active job', async t => {
  const id = 'e'.repeat(32);
  const cfg = config({ limits: limits({ provider_roles: { claude: { inbox: 1 } } }) });
  const w = world(t, {
    cfg,
    active: [
      { id: 'other-running-job', provider: 'codex', status: 'running' },
      { id, provider: 'claude', status: 'running' }
    ],
    inboxJob: { id, adopted: false }
  });
  assert.equal(await w.team.providerRoleFull('claude', 'inbox'), true);
  assert.equal(await w.team.providerRoleFull('codex', 'inbox'), false);
});

test('#1133: a limited agent keeps its allowance hold when a slot is full', async t => {
  const w = world(t, {
    pulls: [pr(77, 'codex/issue-2-x', H(7), { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })],
    issues: [issue(5)],
    out: { codex: 'Codex limit' }
  });
  running(w, 'running-implement', 'implement', 'claude', { issue: 5 });
  await w.team.plan();
  assert.match(w.team.held.codex.cifix, /out of allowance/);
  assert.doesNotMatch(w.team.held.codex.cifix, /slot full/);
});

test('#1123: the 21:01 slot state gives Claude the freed work in the same tick', async t => {
  const failed = [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'project-contract' }];
  const cfg = config({ limits: limits({ roles: { implementer: 2, reviewer: 1 }, overall: 3 }) });
  const pulls = [
    pr(1117, 'codex/issue-1117-x', H(7), { statusCheckRollup: failed }),
    pr(1114, 'codex/issue-1114-x', H(4))
  ];
  const w = world(t, { cfg, pulls, issues: [issue(1119)], out: codexOut });
  w.team.s.verdicts[`1114:${H(4)}`] = { verdict: 'CHANGES', reviewer: 'claude' };
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => [a.agent, a.type, a.issue]), [['claude', 'implement', 1119]]);
  assert.match(w.team.held.codex.cifix, /out of allowance/);
  assert.match(w.team.held.codex.fix, /out of allowance/);
});

test('load spreads: with one PR from each agent and ready issues, the second slot goes to the agent without a job this tick', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-1-a', H(1)), pr(11, 'codex/issue-3-b', H(2))] });
  w.team.s.jobs.w1 = written('claude', 'sonnet', 'claude/issue-1-a'); w.team.s.jobs.w2 = written('codex', 'big', 'codex/issue-3-b');
  const plan = await w.team.plan();
  const rv = plan.find(a => a.type === 'review'), im = plan.find(a => a.type === 'implement');
  assert.ok(rv && im);
  assert.notEqual(rv.agent, im.agent);
});

test('issue #187: the tie-break spreads load: claude reviews codex\'s PR, so the implement slot goes to codex, not to claude again', async t => {
  const w = world(t, { pulls: [pr(11, 'codex/issue-3-b', H(2))] });
  w.team.s.jobs.w2 = written('codex', 'big', 'codex/issue-3-b');
  const plan = await w.team.plan();
  assert.deepEqual(plan.map(a => [a.agent, a.type, a.pr ?? a.issue]), [['claude', 'review', 11], ['codex', 'implement', 2]]);
});

test('issue #187: validating twice, or a structuredClone of a validated config, gives the same deprecation text', () => {
  const perAgent = config({ limits: { per_agent: 2, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } });
  const once = validateTeamConfig(perAgent);
  assert.match(once.deprecations[0], /mapped to limits.roles/);
  for (const again of [validateTeamConfig(once), validateTeamConfig(structuredClone(once))]) {
    assert.deepEqual(again.deprecations, once.deprecations); assert.deepEqual(again.limits.roles, { implementer: 2, reviewer: 2 });
  }
  // negative: an explicit, different roles block still wins and says so
  const both = validateTeamConfig(config({ limits: { per_agent: 2, roles: { implementer: 1, reviewer: 3 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } }));
  assert.match(both.deprecations[0], /ignored because limits.roles is set/); assert.deepEqual(both.limits.roles, { implementer: 1, reviewer: 3 });
});

test('issue #379: validation does not mutate its input; per_agent next to an equal explicit roles block still says remove it', () => {
  const lim = over => ({ overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...over });
  const raw = config({ limits: lim({ per_agent: 2 }) }), before = structuredClone(raw);
  const out = validateTeamConfig(raw);
  assert.deepEqual(raw, before); assert.equal('deprecations' in raw, false); assert.equal('roles' in raw.limits, false);
  assert.deepEqual(out.limits.roles, { implementer: 2, reviewer: 2 }); assert.notEqual(out, raw);
  // the validated copy is still idempotent
  assert.deepEqual(validateTeamConfig(structuredClone(out)).deprecations, out.deprecations);
  // explicit roles equal to per_agent: roles wins, the hint to remove per_agent is kept (as before issue #187)
  const same = config({ limits: lim({ per_agent: 2, roles: { implementer: 2, reviewer: 2 } }) });
  const sameBefore = structuredClone(same);
  const s = validateTeamConfig(same);
  assert.match(s.deprecations[0], /ignored because limits.roles is set; remove it/); assert.deepEqual(same, sameBefore);
  assert.deepEqual(validateTeamConfig(validateTeamConfig(same)).deprecations, s.deprecations);
  // negative: an invalid config still throws and leaves the input as it was
  const bad = config({ limits: lim({ per_agent: 0 }) }), badBefore = structuredClone(bad);
  assert.throws(() => validateTeamConfig(bad), /per_agent/); assert.deepEqual(bad, badBefore);
});
