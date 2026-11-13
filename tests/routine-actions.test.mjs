// Issue #1157: extra_fix_round, close_superseded and resume_breaker. Fake GitHub, fake jobs, fake clock: no model call, no network.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { validateItem, ACTIONS, allStatuses } from '../supervisor/inbox.mjs';
import { checkProposal } from '../foreman-mcp/inbox.mjs';
import { decisionCard } from '../supervisor/decisiontable.mjs';
import { decisionHtml } from '../supervisor/decisioncard-ui.mjs';
import { resolveClick, recordClick } from '../supervisor/decisionclick.mjs';
import * as breaker from '../supervisor/breaker.mjs';
import { parseSuperseders } from '../supervisor/routineactions.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], red = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const cfg = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const pull = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], ...extra });

function world(t, { pulls = [], issues = [], existing = [], third = false, inboxDir = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine1157-')); removeLater(dir);
  const calls = { comments: [], closed: [], saved: [], created: [] };
  const known = new Set([...pulls.map(p => p.number), ...issues.map(i => i.number), ...existing]);
  const gh = { pulls, issues, listPulls: async () => gh.pulls, listIssues: async () => gh.issues, getPull: async n => (known.has(n) ? { number: n } : null), getIssue: async n => (known.has(n) ? { number: n } : null),
    listMergedPulls: async () => [], comment: async (n, body) => calls.comments.push([n, body]), addLabel: async () => {}, hasComment: async (n, text) => calls.comments.some(c => c[0] === n && c[1].includes(text)),
    saveBranch: async (name, sha) => { calls.saved.push([name, sha]); return 'created'; }, closeItem: async (n, kind) => { calls.closed.push([n, kind]); gh.pulls = gh.pulls.filter(p => p.number !== n); gh.issues = gh.issues.filter(i => i.number !== n); } };
  const jobs = { states: {}, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'running', provider: spec.provider }; return { id }; } };
  const config = cfg();
  if (inboxDir) config.inbox = { dir: inboxDir };
  if (third) config.agents.gemini = { provider: 'gemini', branch_prefix: 'gemini/', issues: [] };   // a third worker keeps an independent reviewer available
  const team = new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1000 } });
  return { gh, jobs, team, calls };
}
const apply = (w, item) => w.team.applyInboxAction(item, {});
const fixActs = async w => (await w.team.plan()).filter(a => a.type === 'fix');
// A churned PR at the fix limit: the fix loop is stopped twice over.
const churned = (t, third = false, inboxDir = null) => {
  const w = world(t, { pulls: [pull(38, 'claude/issue-23-x', H(3))], third, inboxDir });
  [['The cache key ignores the branch name entirely'], ['The retry loop never backs off after a failure'], ['The dashboard card shows a stale timestamp forever']]
    .forEach((texts, i) => { w.team.s.verdicts[`38:${H(i + 1)}`] = { verdict: 'CHANGES', reviewer: 'codex', at: i + 1, findings: texts.map(text => ({ kind: 'blocking', text })) }; });
  w.team.s.fixAttempts[`38:${H(2)}`] = 2;
  return w;
};

test('extra_fix_round: a churned PR at the fix limit gets exactly one fix job, then the stop returns', async t => {
  const w = churned(t);
  assert.ok(w.team.churned(38)); assert.equal((await fixActs(w)).length, 0, 'stopped before the grant');
  const text = await apply(w, { action: 'extra_fix_round', target: '38', reason: 'homeowner pressed it' });
  assert.match(text, /one more fix job/);
  assert.equal(w.team.s.extraFix[38].spent, false); assert.equal(w.team.s.extraFix[38].head, H(3));
  const acts = await fixActs(w);
  assert.equal(acts.length, 1); assert.ok(!acts[0].escalated, 'a plain round, not the escalated final round');
  assert.equal(w.team.s.unblock.log.at(-1).target, 38, 'recorded in the unblock log');
  assert.match(w.team.s.unblock.log.at(-1).why, /homeowner approved on the dashboard: homeowner pressed it/);
  await w.team.runAction(acts[0], {});
  assert.equal(w.calls.created.filter(s => s.kind === 'fix').length, 1, 'one fix job was started');
  assert.equal(w.team.s.extraFix[38].spent, true);
  // The job ends without a new head; the limits apply again and no second round starts.
  for (const id of Object.keys(w.jobs.states)) w.jobs.states[id].status = 'completed';
  for (const rec of Object.values(w.team.s.jobs)) rec.ingested = true;
  assert.equal((await fixActs(w)).length, 0, 'the churn stop and the fix limit are back');
  await assert.rejects(apply(w, { action: 'extra_fix_round', target: '38', reason: 'again' }), /already had its extra fix round at this head/);
});
test('extra_fix_round: works past the fix limit alone, with no churn, and by red CI', async t => {
  const w = world(t, { pulls: [pull(40, 'codex/issue-2-x', H(5), { statusCheckRollup: red })] });
  w.team.s.fixAttempts[`40:${H(4)}`] = 2; w.team.s.unblock.escalated[40] = true;   // the escalated final round was already used
  assert.equal((await w.team.plan()).filter(a => a.type === 'cifix').length, 0);
  await apply(w, { action: 'extra_fix_round', target: '40', reason: 'ci' });
  const [act] = (await w.team.plan()).filter(a => a.type === 'cifix');
  assert.ok(act && !act.escalated);
  await w.team.runAction(act, {});
  assert.equal(w.team.s.extraFix[40].spent, true);
});
test('extra_fix_round refusals: no rejection, a fix job running, stale target, unknown worker, a repeat', async t => {
  const ok = churned(t);
  const noVerdict = world(t, { pulls: [pull(41, 'claude/issue-23-y', H(6))] });
  await assert.rejects(apply(noVerdict, { action: 'extra_fix_round', target: '41', reason: 'x' }), /no CHANGES verdict or red CI/);
  assert.equal(noVerdict.team.s.extraFix?.[41], undefined, 'nothing recorded');
  await assert.rejects(apply(ok, { action: 'extra_fix_round', target: '99', reason: 'x' }), /not open; nothing changed/);
  await assert.rejects(apply(ok, { action: 'extra_fix_round', target: '38', model: 'nobody', reason: 'x' }), /nobody is not a model claude may write with/);
  ok.team.s.jobs.aaaaaaaa = { kind: 'fix', pr: 38, agent: 'claude', at: 5 }; ok.jobs.states.aaaaaaaa = { id: 'aaaaaaaa', status: 'running' };
  await assert.rejects(apply(ok, { action: 'extra_fix_round', target: '38', reason: 'x' }), /fix job running/);
  assert.equal(ok.team.s.extraFix?.[38], undefined);
  ok.jobs.states.aaaaaaaa.status = 'completed';
  await apply(ok, { action: 'extra_fix_round', target: '38', reason: 'x' });
  await assert.rejects(apply(ok, { action: 'extra_fix_round', target: '38', reason: 'x' }), /already had its extra fix round/);
});
test('extra_fix_round: the branch author writes the round (D-011); another agent is refused and nothing is recorded', async t => {
  const w = churned(t, true);
  w.team.s.jobs.bbbbbbbb = { kind: 'fix', pr: 38, agent: 'codex', at: 5, ingested: true }; w.jobs.states.bbbbbbbb = { id: 'bbbbbbbb', status: 'completed' };
  await assert.rejects(apply(w, { action: 'extra_fix_round', target: '38', model: 'codex', reason: 'x' }), /codex cannot write this fix: PR #38 is claude's branch.*D-011/);
  assert.equal(w.team.s.extraFix?.[38], undefined);
  await apply(w, { action: 'extra_fix_round', target: '38', reason: 'x' });
  assert.equal(w.team.s.extraFix[38].agent, 'claude', 'the author, whoever wrote the last round');
  const acts = await fixActs(w);
  assert.equal(acts.length, 1); assert.equal(acts[0].agent, 'claude');
  const named = churned(t);
  await apply(named, { action: 'extra_fix_round', target: '38', model: 'claude', reason: 'x' });
  assert.equal(named.team.s.extraFix[38].agent, 'claude');
});
// The writer's models: sonnet (the configured fix model), fable, haiku (a review model, never a writer) and opus (never a writer).
const withModels = w => {
  w.team.c.models = { agents: { claude: { fix: { model: 'sonnet' }, review: { model: 'haiku' } } } };
  w.team.providerModels = { claude: { aliases: ['opus', 'sonnet', 'haiku', 'fable'], efforts: ['low'] } };
  return w;
};
test('extra_fix_round: a model of the author agent; default differs from the last fix round; the job runs on it', async t => {
  const w = withModels(churned(t));
  w.team.s.jobs.cccccccc = { kind: 'fix', pr: 38, agent: 'claude', model: 'sonnet', at: 5 }; w.jobs.states.cccccccc = { id: 'cccccccc', status: 'completed' };
  const text = await apply(w, { action: 'extra_fix_round', target: '38', reason: 'x' });
  assert.equal(w.team.s.extraFix[38].model, 'fable', 'the last round ran on sonnet, so the default is another allowed model (not haiku or opus)');
  assert.match(text, /on fable/);
  const [act] = await fixActs(w);
  await w.team.runAction(act, {});
  assert.equal(w.calls.created.at(-1).model, 'fable');
  const free = withModels(churned(t));
  await apply(free, { action: 'extra_fix_round', target: '38', reason: 'x' });
  assert.equal(free.team.s.extraFix[38].model, undefined, 'no earlier round on a model: the agent keeps its ordinary model');
});
test('extra_fix_round: a requested model must be an allowed writer model of the author', async t => {
  const w = withModels(churned(t));
  await assert.rejects(apply(w, { action: 'extra_fix_round', target: '38', model: 'haiku', reason: 'x' }), /may not write this fix on haiku/);
  await assert.rejects(apply(w, { action: 'extra_fix_round', target: '38', model: 'opus', reason: 'x' }), /not a model claude may write with/);
  assert.equal(w.team.s.extraFix?.[38], undefined);
  await apply(w, { action: 'extra_fix_round', target: '38', model: 'fable', reason: 'x' });
  assert.equal(w.team.s.extraFix[38].model, 'fable');
});
test('extra_fix_round: a fix job waiting_on counts as running, and a rebase leaves the grant unspent', async t => {
  const w = churned(t);
  w.team.s.jobs.dddddddd = { kind: 'fix', pr: 38, agent: 'claude', at: 5 }; w.jobs.states.dddddddd = { id: 'dddddddd', status: 'waiting_on' };
  await assert.rejects(apply(w, { action: 'extra_fix_round', target: '38', reason: 'x' }), /fix job running/);
  w.jobs.states.dddddddd.status = 'completed';
  await apply(w, { action: 'extra_fix_round', target: '38', reason: 'x' });
  await w.team.runAction({ type: 'rebase', pr: 38, head: H(3), base: 'main', branch: 'claude/issue-23-x', key: '38:r', agent: 'claude' }, {});
  assert.equal(w.calls.created.at(-1).kind, 'rebase', 'the rebase job really started');
  assert.equal(w.team.s.extraFix[38].spent, false, 'a rebase job never uses the grant');
});
test('extra_fix_round: a new head ends an unused grant', async t => {
  const w = churned(t);
  await apply(w, { action: 'extra_fix_round', target: '38', reason: 'x' });
  w.gh.pulls = [pull(38, 'claude/issue-23-x', H(9))];
  assert.equal((await fixActs(w)).length, 0, 'the grant named the old head');
});

test('close_superseded: a PR is saved under saved/, commented and closed once', async t => {
  const w = world(t, { pulls: [pull(50, 'claude/issue-23-x', H(7))], issues: [{ number: 60, state: 'OPEN', labels: [] }] });
  const text = await apply(w, { action: 'close_superseded', target: '50', superseded_by: '60, 61', reason: 'replaced by the new design' }).catch(e => e);
  assert.match(String(text.message), /#61 not found/, 'a superseding item that does not exist refuses, nothing closed');
  assert.deepEqual(w.calls.closed, []); assert.deepEqual(w.calls.saved, []); assert.deepEqual(w.calls.comments, []);
  w.gh.getPull = async n => ({ number: n });
  const done = await apply(w, { action: 'close_superseded', target: '50', superseded_by: '60, 61', reason: 'replaced by the new design' });
  assert.match(done, /pull request #50 closed, superseded by #60, #61; branch saved/);
  assert.equal(w.calls.saved.length, 1); assert.match(w.calls.saved[0][0], /^saved\/pr-50-claude-issue-23-x-7777777$/); assert.equal(w.calls.saved[0][1], H(7));
  assert.deepEqual(w.calls.closed, [[50, 'pull']]);
  assert.match(w.calls.comments[0][1], /Closed as superseded by #60, #61\./); assert.match(w.calls.comments[0][1], /saved\/pr-50/); assert.match(w.calls.comments[0][1], /replaced by the new design/);
  assert.match(w.team.s.unblock.log.at(-1).what, /closed the pull request as superseded/);
  await assert.rejects(apply(w, { action: 'close_superseded', target: '50', superseded_by: '60', reason: 'again' }), /not open; nothing changed/);
  assert.equal(w.calls.closed.length, 1, 'applies once');
});
test('close_superseded: an issue is closed with no branch save; refusals change nothing', async t => {
  const w = world(t, { issues: [{ number: 70, state: 'OPEN', labels: [] }, { number: 71, state: 'CLOSED', labels: [] }], existing: [80] });
  await apply(w, { action: 'close_superseded', target: '70', superseded_by: '80', reason: 'duplicate' });
  assert.deepEqual(w.calls.saved, []); assert.deepEqual(w.calls.closed, [[70, 'issue']]);
  await assert.rejects(apply(w, { action: 'close_superseded', target: '71', superseded_by: '80', reason: 'x' }), /not open/);
  assert.throws(() => parseSuperseders('', 5), /must list/); assert.throws(() => parseSuperseders('5', 5), /cannot supersede itself/);
  assert.throws(() => parseSuperseders('1,2,3,4,5,6', 9), /more than 5/); assert.throws(() => parseSuperseders('abc', 9), /must list/);
  const busy = world(t, { pulls: [pull(90, 'claude/issue-23-z', H(8))], existing: [91] });
  busy.team.s.jobs.cccccccc = { kind: 'fix', pr: 90, agent: 'claude' }; busy.jobs.states.cccccccc = { id: 'cccccccc', status: 'running' };
  await assert.rejects(apply(busy, { action: 'close_superseded', target: '90', superseded_by: '91', reason: 'x' }), /running job/);
  assert.deepEqual(busy.calls.closed, []); assert.deepEqual(busy.calls.saved, []);
});

test('resume_breaker: resumes a tripped scope with who and why; a stale scope does nothing and says so', async t => {
  const w = world(t);
  w.team.s.breaker = breaker.normalize({ halts: { postcondition_not_met: { cause: 'postcondition_not_met', since: 1, types: ['fix'], jobs: 2, tokens: 0, cost: 0, prs: [], trippedBy: 'cause' } } });
  assert.ok(breaker.haltView(w.team.s.breaker));
  const text = await apply(w, { action: 'resume_breaker', target: 'postcondition_not_met', reason: 'cause fixed' });
  assert.match(text, /resumed: postcondition_not_met/);
  assert.equal(breaker.haltView(w.team.s.breaker), null);
  const entry = w.team.s.breaker.resumes.at(-1);
  assert.equal(entry.scope, 'postcondition_not_met'); assert.match(entry.by, /homeowner/); assert.equal(entry.why, 'cause fixed'); assert.equal(entry.at, 1000);
  await assert.rejects(apply(w, { action: 'resume_breaker', target: 'postcondition_not_met', reason: 'again' }), /no breaker halt for postcondition_not_met.*nothing changed/);
  assert.equal(w.team.s.breaker.resumes.length, 1);
});

test('the inbox accepts the three actions with their optional fields and refuses wrong shapes (foreman_propose too)', () => {
  const base = { kind: 'action', title: 't', reason: 'because' };
  for (const a of ['extra_fix_round', 'close_superseded', 'resume_breaker']) assert.ok(a in ACTIONS);
  assert.equal(validateItem({ ...base, action: 'extra_fix_round', target: '38', model: 'codex' }).ok, true);
  assert.equal(validateItem({ ...base, action: 'extra_fix_round', target: '38' }).ok, true);
  assert.equal(validateItem({ ...base, action: 'close_superseded', target: '38', superseded_by: '60, 61' }).ok, true);
  assert.match(validateItem({ ...base, action: 'close_superseded', target: '38' }).reason, /superseded_by/);
  assert.match(validateItem({ ...base, action: 'extra_fix_round', target: '38', superseded_by: '5' }).reason, /only accepted with close_superseded/);
  assert.match(validateItem({ ...base, action: 'close_superseded', target: '38', superseded_by: '5', model: 'x' }).reason, /only accepted with extra_fix_round/);
  assert.equal(validateItem({ ...base, action: 'resume_breaker', target: '@global' }).ok, true);
  assert.equal(validateItem({ ...base, action: 'resume_breaker', target: 'postcondition_not_met' }).ok, true);
  assert.match(validateItem({ ...base, action: 'resume_breaker', target: 'bad scope!' }).reason, /breaker scope/);
  assert.match(validateItem({ ...base, action: 'extra_fix_round', target: 'abc' }).reason, /pull request number/);
  assert.equal(validateItem({ kind: 'control', title: 't', reason: 'r', action: 'extra_fix_round', target: '38' }).ok, false, 'never a control item: it needs the click');
  assert.equal(checkProposal({ ...base, action: 'extra_fix_round', target: '38', model: 'codex' }).ok, true);
  assert.equal(checkProposal({ ...base, action: 'close_superseded', target: '38', superseded_by: '60' }).ok, true);
  assert.equal(checkProposal({ ...base, action: 'resume_breaker', target: 'postcondition_not_met' }).ok, true);
  assert.equal(checkProposal({ ...base, action: 'close_superseded', target: '38' }).ok, false);
  assert.equal(checkProposal({ ...base, action: 'extra_fix_round', target: '38', superseded_by: '5' }).ok, false);
});

test('cards: fix limit, churn and breaker cards offer the new routine controls; a click records an approved action with its input', () => {
  const ctx = { parked: new Set(), appConfigured: false };
  const fix = decisionCard({ id: 'fixlimit-38', text: 'x', ref: { kind: 'pull', n: 38 } }, ctx);
  assert.deepEqual(fix.controls.map(c => c.action), ['extra_fix_round', 'close_superseded']);
  assert.deepEqual(decisionCard({ id: 'churn-38', text: 'x', ref: { kind: 'pull', n: 38 } }, ctx).controls.map(c => c.action), ['extra_fix_round', 'close_superseded']);
  assert.deepEqual(decisionCard({ id: 'breaker-halt', text: 'x', scope: 'fix:failed:timeout', ref: null }, ctx).controls.map(c => [c.action, c.target]), [['resume_breaker', 'fix:failed:timeout']], 'a real halt key holds colons');
  const longKey = 'review:no-verdict:postcondition_not_met';
  assert.equal(decisionCard({ id: 'breaker-halt', text: 'x', scope: longKey, ref: null }, ctx).controls.length, 1, 'a per-cause key');
  assert.equal(checkProposal({ kind: 'action', title: 't', action: 'resume_breaker', target: 'fix:failed:timeout', reason: 'r' }).ok, true, 'foreman_propose takes it');
  assert.equal(validateItem({ kind: 'action', title: 't', action: 'resume_breaker', target: longKey, reason: 'r' }).ok, true);
  assert.deepEqual(decisionCard({ id: 'breaker-halt', text: 'x', ref: null }, ctx).controls, [], 'no scope, no control');
  assert.deepEqual(decisionCard({ id: 'breaker-halt', text: 'x', scope: 'bad scope!', ref: null }, ctx).controls, []);
  const html = decisionHtml({ id: 'fixlimit-38', card: fix });
  assert.doesNotMatch(html, /<select/, 'the worker is always the branch author, so no choice is offered');
  assert.match(html, /name="superseded_by" required/);
  const view = { panels: { needsYou: [{ id: 'fixlimit-38', card: fix }] } };
  assert.equal(resolveClick(view, { card: 'fixlimit-38', control: 'close_superseded', supersededBy: 'x' }).status, 400);
  assert.equal(resolveClick(view, { card: 'fixlimit-38', control: 'close_superseded', supersededBy: '12; rm' }).status, 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine1157-inbox-')); removeLater(dir);
  const sup = resolveClick(view, { card: 'fixlimit-38', control: 'close_superseded', supersededBy: '12, 13' });
  assert.equal(recordClick(dir, sup, 5000).ok, true);
  const mod = resolveClick(view, { card: 'fixlimit-38', control: 'extra_fix_round' });
  assert.equal(recordClick(dir, mod, 5000).ok, true);
  const sts = allStatuses(dir);
  assert.equal(sts.length, 2); assert.ok(sts.every(s => s.state === 'approved' && s.kind === 'action' && s.click.by === 'homeowner' && s.decidedAt === 5000));
  assert.ok(sts.find(s => s.click.action === 'close_superseded').click.reason.includes('pressed Close as superseded on the fixlimit card'));
});

test('end to end: a clicked extra_fix_round and a clicked close_superseded are applied once by the next tick pass, and a repeat changes nothing', async t => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine1157-e2e-')); removeLater(inboxDir);
  const w = churned(t, false, inboxDir);
  w.gh.pulls.push(pull(55, 'codex/issue-2-z', H(6))); w.gh.getPull = async n => ({ number: n });
  const ctx = { parked: new Set(), appConfigured: false };
  const view = { panels: { needsYou: [{ id: 'fixlimit-38', card: decisionCard({ id: 'fixlimit-38', text: 'x', ref: { kind: 'pull', n: 38 } }, ctx) }, { id: 'fixlimit-55', card: decisionCard({ id: 'fixlimit-55', text: 'x', ref: { kind: 'pull', n: 55 } }, ctx) }] } };
  assert.equal(recordClick(inboxDir, resolveClick(view, { card: 'fixlimit-38', control: 'extra_fix_round' }), 5000).ok, true);
  assert.equal(recordClick(inboxDir, resolveClick(view, { card: 'fixlimit-55', control: 'close_superseded', supersededBy: '38' }), 5000).ok, true);
  await w.team.processInbox({});
  const states = allStatuses(inboxDir);
  assert.deepEqual(states.map(x => x.state), ['done', 'done']);
  assert.equal(w.team.s.extraFix[38].spent, false); assert.deepEqual(w.calls.closed, [[55, 'pull']]);
  assert.equal((await fixActs(w)).length, 1, 'the next planning pass has exactly the one granted fix job');
  await w.team.processInbox({});
  assert.deepEqual(w.calls.closed, [[55, 'pull']], 'a repeat pass applies nothing again');
  // The same click again is a stale target: the item ends failed with the reason and nothing changes.
  assert.equal(recordClick(inboxDir, resolveClick(view, { card: 'fixlimit-55', control: 'close_superseded', supersededBy: '38' }), 6000).ok, true);
  await w.team.processInbox({});
  const failed = allStatuses(inboxDir).filter(x => x.state === 'failed');
  assert.equal(failed.length, 1); assert.match(failed[0].reason, /not open; nothing changed/); assert.equal(w.calls.closed.length, 1);
});
test('the published foreman_propose schema lists the routine actions and their fields', async () => {
  const { withRoutineActions } = await import('../foreman-mcp/proposeschema.mjs');
  const tool = { name: 'foreman_propose', description: 'd', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['reopen'] }, target: { type: 'string', maxLength: 12 } } } };
  const out = withRoutineActions(tool);
  assert.deepEqual(out.inputSchema.properties.action.enum, ['reopen', 'extra_fix_round', 'close_superseded', 'resume_breaker']);
  assert.equal(out.inputSchema.properties.target.maxLength, 160); assert.ok(out.inputSchema.properties.model); assert.ok(out.inputSchema.properties.superseded_by);
  assert.equal(withRoutineActions({ name: 'other' }).name, 'other');
});
