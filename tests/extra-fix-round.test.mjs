// Issue #1339: the approved inbox action extra_fix_round, through the real entry points: an inbox item is approved on the dashboard path and one
// team inbox pass applies it; then the team planner and the job start run. PR #1146 is the churned pull request (a CHANGES verdict and 3 fix
// rounds at a fix limit of 3). Fake GitHub, fake jobs, fake clock: no model call and no network.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { checkProposal, EXTRA_FIX_MODEL_MAX as MCP_MODEL_MAX } from '../foreman-mcp/inbox.mjs';
import { inboxToolDefs } from '../foreman-mcp/inbox-tools.mjs';
import * as grantModule from '../supervisor/extrafixround.mjs';

const N = 1146;
const BRANCH = 'claude/issue-23-x';
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const config = inboxDir => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const pull = (head, extra = {}) => ({ number: N, title: 'a pull request', headRefName: BRANCH, headRefOid: head, baseRefName: 'main', isDraft: false,
  mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], ...extra });

function world(t, { pulls = [pull(H(3))] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extrafix1339-'));
  removeLater(dir);
  const inboxDir = path.join(dir, 'inbox');
  for (const d of ['items', 'status']) fs.mkdirSync(path.join(inboxDir, d), { recursive: true });
  const created = [];
  const gh = { pulls, listPulls: async () => gh.pulls, listIssues: async () => [], listMergedPulls: async () => [],
    getPull: async () => null, getIssue: async () => null, comment: async () => {}, addLabel: async () => {}, hasComment: async () => false };
  const jobs = { states: {}, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => {
      const id = (++jobs.seq).toString(16).padStart(32, '0');
      created.push(spec);
      jobs.states[id] = { id, status: 'running' };
      return { id };
    } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: config(inboxDir), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1000 } });
  return { dir, inboxDir, gh, jobs, team, created };
}

// A churned pull request at the fix limit: three CHANGES rounds that keep returning different findings, and 3 fix rounds.
function churned(t) {
  const w = world(t);
  const findings = ['The cache key ignores the branch name', 'The retry loop never backs off after a failure', 'The dashboard card shows a stale timestamp'];
  findings.forEach((text, i) => {
    w.team.s.verdicts[`${N}:${H(i + 1)}`] = { verdict: 'CHANGES', reviewer: 'codex', at: i + 1, findings: [{ kind: 'blocking', text }] };
  });
  w.team.s.fixAttempts[`${N}:${H(2)}`] = 3;
  return w;
}
// The same pull request stopped by red CI at the fix limit, no verdict at all.
function redCi(t) {
  const w = world(t, { pulls: [pull(H(3), { statusCheckRollup: red })] });
  w.team.s.fixAttempts[`${N}:${H(2)}`] = 3;
  w.team.s.unblock.escalated[N] = true;   // the escalated final round was already used
  return w;
}
// The claude fix model is haiku, which is also its review model; its aliases are opus, sonnet, haiku and fable.
const refusedOrdinary = w => {
  w.team.c.models = { agents: { claude: { fix: { model: 'haiku' }, review: { model: 'haiku' } } } };
  w.team.providerModels = { claude: { aliases: ['opus', 'sonnet', 'haiku', 'fable'], efforts: ['low'] } };
  return w;
};
const withModels = w => {
  w.team.c.models = { agents: { claude: { fix: { model: 'sonnet' }, review: { model: 'haiku' } } } };
  w.team.providerModels = { claude: { aliases: ['opus', 'sonnet', 'haiku', 'fable'], efforts: ['low'] } };
  return w;
};

const proposal = () => ({ kind: 'action', title: 't', action: 'extra_fix_round', target: String(N), reason: 'r' });
// One inbox pass: writes the proposal, approves it as the dashboard does, runs the team's inbox pass and returns the item's final status.
async function ask(w, extra = {}) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const item = { ...proposal(), title: `Extra fix round ${N}`, reason: 'the homeowner pressed Extra fix round', ...extra };
  fs.writeFileSync(path.join(w.inboxDir, 'items', `${id}.json`), JSON.stringify(item));
  inbox.scan(w.inboxDir, Date.now());
  assert.equal(inbox.decide(w.inboxDir, id, 'approve', Date.now()).ok, true);
  await w.team.processInbox({});
  return inbox.allStatuses(w.inboxDir).find(s => s.id === id);
}
const fixActs = async (w, type = 'fix') => (await w.team.plan()).filter(a => a.type === type);
const endJobs = w => {
  for (const job of Object.values(w.jobs.states)) job.status = 'completed';
  for (const record of Object.values(w.team.s.jobs)) record.ingested = true;
};

test('a churned PR #1146 at the fix limit: one fix job is planned, starting it spends the grant, the next plan has none', async t => {
  const w = churned(t);
  assert.ok(w.team.churned(N));
  assert.equal((await fixActs(w)).length, 0, 'stopped by the churn rule and the fix limit before the grant');
  const status = await ask(w);
  assert.equal(status.state, 'done');
  assert.match(status.result, /one more fix job at 3333333/);
  assert.deepEqual([w.team.s.extraFix[N].head, w.team.s.extraFix[N].agent, w.team.s.extraFix[N].spent], [H(3), 'claude', false]);
  const acts = await fixActs(w);
  assert.equal(acts.length, 1);
  assert.ok(!acts[0].escalated, 'a plain round, not the escalated final round');
  const logged = w.team.s.unblock.log.at(-1);
  assert.equal(logged.target, N);
  assert.match(logged.why, /homeowner approved on the dashboard: the homeowner pressed Extra fix round/);
  await w.team.runAction(acts[0], {});
  assert.equal(w.created.filter(s => s.kind === 'fix').length, 1, 'exactly one fix job started');
  assert.equal(w.team.s.extraFix[N].spent, true, 'starting the job spends the grant');
  endJobs(w);
  assert.equal((await fixActs(w)).length, 0, 'the limits stop fix jobs again');
});

test('a red CI PR #1146 at the fix limit: one CI fix job is planned and spent', async t => {
  const w = redCi(t);
  assert.equal((await fixActs(w, 'cifix')).length, 0, 'at the limit before the grant');
  assert.equal((await ask(w)).state, 'done');
  const acts = await fixActs(w, 'cifix');
  assert.equal(acts.length, 1);
  assert.ok(!acts[0].escalated);
  await w.team.runAction(acts[0], {});
  assert.equal(w.created.filter(s => s.kind === 'cifix').length, 1);
  assert.equal(w.team.s.extraFix[N].spent, true);
  endJobs(w);
  assert.equal((await fixActs(w, 'cifix')).length, 0, 'the fix limit applies again');
});

test('the ordinary model is refused: the grant picks sonnet, the gate allows it, the planner returns one fix job on sonnet', async t => {
  const w = refusedOrdinary(churned(t));
  assert.match(w.team.writeBlock(pullOf(w)), /haiku.*review model/, 'before the grant the ordinary model is refused');
  assert.equal((await fixActs(w)).length, 0);
  const status = await ask(w);
  assert.equal(status.state, 'done', status.reason);
  assert.equal(w.team.s.extraFix[N].model, 'sonnet');
  assert.equal(w.team.writeBlock(pullOf(w)), null, 'the write gate judges the granted model');
  const acts = await fixActs(w);
  assert.equal(acts.length, 1, 'exactly one fix job is planned');
  await w.team.runAction(acts[0], {});
  assert.equal(w.created.at(-1).model, 'sonnet', 'the job really runs on the granted model');
  assert.equal(w.team.s.extraFix[N].spent, true);
});
const pullOf = w => w.gh.pulls[0];

test('when no fix job could be planned the action refuses and records no grant', async t => {
  const w = churned(t);
  w.team.c.models = { agents: { claude: { fix: { model: 'haiku' }, review: { model: 'haiku' } } } };
  w.team.providerModels = { claude: { aliases: ['opus', 'haiku'], efforts: ['low'] } };
  const status = await ask(w);
  assert.equal(status.state, 'failed');
  assert.match(status.reason, /claude may not write this fix/);
  assert.equal(w.team.s.extraFix?.[N], undefined, 'nothing recorded');
  assert.equal((await fixActs(w)).length, 0);
});

test('the default is a model different from the last fix round where the writer rules leave one, else the ordinary model', async t => {
  const w = withModels(churned(t));
  w.team.s.jobs.cccccccc = { kind: 'fix', pr: N, agent: 'claude', model: 'sonnet', at: 5, ingested: true };
  w.jobs.states.cccccccc = { id: 'cccccccc', status: 'completed' };
  assert.match((await ask(w)).result, /on fable/);
  assert.equal(w.team.s.extraFix[N].model, 'fable', 'not sonnet (the last round), not haiku (a review model), not opus');
  const [act] = await fixActs(w);
  await w.team.runAction(act, {});
  assert.equal(w.created.at(-1).model, 'fable');
  const free = withModels(churned(t));
  assert.equal((await ask(free)).state, 'done');
  assert.equal(free.team.s.extraFix[N].model, undefined, 'no earlier round on a model: the ordinary model');
  const only = withModels(churned(t));
  only.team.providerModels = { claude: { aliases: ['sonnet'], efforts: ['low'] } };
  only.team.s.jobs.cccccccc = { kind: 'fix', pr: N, agent: 'claude', model: 'sonnet', at: 5, ingested: true };
  only.jobs.states.cccccccc = { id: 'cccccccc', status: 'completed' };
  assert.equal((await ask(only)).state, 'done');
  assert.equal(only.team.s.extraFix[N].model, undefined, 'no other model is left: the ordinary model again');
});

test('a requested model must be a writer model of the author; 30 characters are accepted, 31 are not', async t => {
  const w = withModels(churned(t));
  const refusals = [['opus', /opus is not a model claude may write with/], ['haiku', /may not write this fix on haiku.*review models/],
    ['nobody', /nobody is not a model/]];
  for (const [model, why] of refusals) {
    const status = await ask(w, { model });
    assert.equal(status.state, 'failed', model);
    assert.match(status.reason, why, model);
  }
  assert.equal(w.team.s.extraFix?.[N], undefined, 'every refusal changed nothing');
  const long30 = 'm'.repeat(30);
  assert.equal(inbox.validateItem({ ...proposal(), model: long30 }).ok, true);
  const tooLong = inbox.validateItem({ ...proposal(), model: 'm'.repeat(31) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /model is longer than 30 characters/);
  assert.equal(checkProposal({ ...proposal(), model: long30 }).ok, true);
  assert.match(checkProposal({ ...proposal(), model: 'm'.repeat(31) }).error, /longer than 30/);
  assert.equal(inbox.EXTRA_FIX_MODEL_MAX, MCP_MODEL_MAX);
  const schema = inboxToolDefs({ enabled: true }).find(d => d.name === 'foreman_propose').inputSchema.properties;
  assert.equal(schema.model.maxLength, 30);
  assert.ok(schema.action.enum.includes('extra_fix_round'));
});

test('a model is accepted for no other action, and an allowed requested model is used by the job', async t => {
  const other = { ...proposal(), action: 'new_review_attempt', model: 'sonnet' };
  assert.match(inbox.validateItem(other).reason, /model is only accepted with extra_fix_round/);
  assert.match(checkProposal(other).error, /model is only accepted with extra_fix_round/);
  const w = withModels(churned(t));
  assert.equal((await ask(w, { model: 'fable' })).state, 'done');
  assert.equal(w.team.s.extraFix[N].model, 'fable');
  const [act] = await fixActs(w);
  await w.team.runAction(act, {});
  assert.equal(w.created.at(-1).model, 'fable');
});

test('a model naming the codex agent on a claude branch is refused with the D-011 reason', async t => {
  const w = withModels(churned(t));
  const status = await ask(w, { model: 'codex' });
  assert.equal(status.state, 'failed');
  assert.match(status.reason, /codex cannot write this fix: PR #1146 is claude's branch and each agent works only in its own worktree \(D-011\)/);
  assert.equal(w.team.s.extraFix?.[N], undefined);
});

test('refused with nothing changed: a waiting fix job, a calm PR, a closed PR, a foreign branch, a repeat at one head', async t => {
  const w = churned(t);
  w.team.s.jobs.dddddddd = { kind: 'fix', pr: N, agent: 'claude', at: 5 };
  w.jobs.states.dddddddd = { id: 'dddddddd', status: 'waiting_on' };
  assert.match((await ask(w)).reason, /fix job that has not ended \(dddddddd\)/, 'a job parked waiting counts as running');
  w.jobs.states.dddddddd.status = 'running';
  assert.match((await ask(w)).reason, /fix job that has not ended/);
  assert.equal(w.team.s.extraFix?.[N], undefined);
  w.jobs.states.dddddddd.status = 'completed';
  assert.equal((await ask(w)).state, 'done');
  const repeat = await ask(w);
  assert.match(repeat.reason, /already had its extra fix round at this head and it has not started yet/, 'a second request at the same head');
  const calm = world(t);
  assert.match((await ask(calm)).reason, /no CHANGES verdict or red CI on its current head/);
  assert.equal(calm.team.s.extraFix?.[N], undefined);
  const closed = churned(t);
  closed.gh.pulls = [];
  assert.match((await ask(closed)).reason, /PR #1146 is not open; nothing changed/);
  const foreign = world(t, { pulls: [pull(H(3), { headRefName: 'someone/else', statusCheckRollup: red })] });
  assert.match((await ask(foreign)).reason, /not a Foreman pull request/);
});

test('a rebase leaves the grant unspent, a new head ends an unused grant, and the limits then stop fix jobs again', async t => {
  const w = churned(t);
  assert.equal((await ask(w)).state, 'done');
  await w.team.runAction({ type: 'rebase', pr: N, head: H(3), base: 'main', branch: BRANCH, key: `${N}:r`, agent: 'claude' }, {});
  assert.equal(w.created.at(-1).kind, 'rebase', 'the rebase job really started');
  assert.equal(w.team.s.extraFix[N].spent, false, 'a rebase never uses the grant');
  endJobs(w);
  assert.equal((await fixActs(w)).length, 1, 'the grant is still open after the rebase');
  w.gh.pulls = [pull(H(9))];
  const finding = { kind: 'blocking', text: 'A new finding about the retry delay' };
  w.team.s.verdicts[`${N}:${H(9)}`] = { verdict: 'CHANGES', reviewer: 'codex', at: 9, findings: [finding] };
  assert.equal((await fixActs(w)).length, 0, 'the unused grant named the old head, so the limits stop the new one');
  assert.equal((await ask(w)).state, 'done', 'the new head may be granted its own round');
});

test('a review job never spends the grant', async t => {
  const w = churned(t);
  assert.equal((await ask(w)).state, 'done');
  const state = w.team.s;
  grantModule.spendGrant(state, { type: 'review', pr: N, head: H(3) });
  assert.equal(state.extraFix[N].spent, false);
  grantModule.spendGrant(state, { type: 'fix', pr: N, head: H(9) });
  assert.equal(state.extraFix[N].spent, false, 'another head does not spend it');
  grantModule.spendGrant(state, { type: 'fix', pr: N, head: H(3) });
  assert.equal(state.extraFix[N].spent, true);
});

test('the module imports nothing from the team module', () => {
  const source = fs.readFileSync(new URL('../supervisor/extrafixround.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '\.\/team\.mjs'/);
  assert.doesNotMatch(source, /import\(['"]\.\/team\.mjs/);
});
