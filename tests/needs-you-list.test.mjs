// Issue #414: Inbox lists only decisions the homeowner can act on now; parked and staged work is in Later; no label advice that starts held-back work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView, heldIssues } from '../supervisor/dashboard.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';
import { githubClient } from '../supervisor/github.mjs';
import { homeownerQuestion } from '../supervisor/homeowner-question.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const config = (limits = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...limits },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const iss = (number, body, labels = ['needs-homeowner'], state = 'OPEN') => ({ number, title: `issue ${number}`, state, body, labels });
const pr = (n, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], ...extra });
async function panels(t, { issues = [], pulls = [], state = {}, limits } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyl-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const v = await buildView({ config: config(limits), root, jobs: [], events: [], state, register: REGISTER, snapshots: [], now: NOW,
    cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues: compactIssues(issues) } });
  return v.panels;
}
const text = items => JSON.stringify(items);

test('parser: reads the question and the stated effect of each answer; no question mark or marker is no question', () => {
  assert.deepEqual(homeownerQuestion('x\n**Question:** Approve D-030? Yes: PRs #4 and #5 merge. No: they stay open.\n'), { question: 'Approve D-030?', yes: 'PRs #4 and #5 merge.', no: 'they stay open.' });
  const q = homeownerQuestion('**Decision first:** should the supervisor and team loop move into their own repository, since they serve several projects? Bring a proposal.');
  assert.match(q.question, /^should the supervisor .* projects\?$/); assert.equal(q.yes, null);
  assert.equal(homeownerQuestion('Question: this is a statement without one'), null); assert.equal(homeownerQuestion('Why. Is this a question?'), null);
});

test('an issue with a stated question appears with the question and the effect of each answer; one without does not', async t => {
  const p = await panels(t, { issues: [iss(50, 'Question: Approve decision D-030? Yes: PRs #4 and #5 merge. No: they stay open.'), iss(51, 'Nothing to answer here.')] });
  const card = p.needsYou.find(a => a.id === 'homeowner-50');
  assert.ok(card); assert.match(card.text, /Approve decision D-030\?/); assert.match(card.decision, /Yes: PRs #4 and #5 merge\./); assert.match(card.decision, /No: they stay open\./);
  assert.ok(!p.needsYou.some(a => a.id === 'homeowner-51'), 'no answerable question: not in Inbox');
  assert.ok(p.later.some(l => l.number === 51), 'it is listed as Later, quietly');
  const np = await panels(t, { issues: [iss(52, 'Question: Should the team move to a new repository?'), iss(53, 'Question: Should it move? Yes: it moves.')] });
  for (const n of [52, 53]) assert.ok(!np.needsYou.some(a => a.id === `homeowner-${n}`), `#${n} does not state both answer effects: not in Inbox`);
  assert.match(np.later.find(l => l.number === 52).waits, /does not state what each answer does/);
});

test('#37 appears even when it is outside the first 200 issues the list call returns', async t => {
  const calls = [];
  const all = Array.from({ length: 260 }, (_, i) => ({ number: 400 - i, title: `i${400 - i}`, state: 'OPEN', body: '', labels: [] }));
  all.push({ number: 37, title: 'Team loop', state: 'OPEN', body: '**Decision first:** should the team loop move into its own repository, given it serves several projects? Yes: a new repository is created. No: it stays here.', labels: [{ name: 'needs-homeowner' }] });
  const gh = args => { calls.push(args); const lim = Number(args[args.indexOf('--limit') + 1]), st = args[args.indexOf('--state') + 1];
    return JSON.stringify(all.filter(i => st === 'all' || i.state.toLowerCase() === st).sort((a, b) => b.number - a.number).slice(0, lim).map(i => ({ ...i, labels: i.labels.map(l => (typeof l === 'string' ? { name: l } : l)) }))); };
  const issues = await githubClient({ repository: 'o/r' }, gh).listIssues();
  assert.ok(issues.length > 200); const i37 = issues.find(i => i.number === 37); assert.ok(i37, '#37 was fetched'); assert.deepEqual(i37.labels, ['needs-homeowner']);
  const p = await panels(t, { issues });
  assert.ok(p.needsYou.some(a => a.id === 'homeowner-37' && /own repository/.test(a.text)));
});

test('#376 and #373 are Later, not Inbox, and say what they wait for and what ends the wait', async t => {
  const issues = [iss(375, 'stage 3', [], 'OPEN'), iss(376, 'Stage 4.\n\nPrerequisites: #375\n\nBring a recommendation to the homeowner.'), iss(373, 'Stage 1. Depends on: nothing.')];
  const pulls = [pr(1, H(1)), pr(2, H(2))];
  const p = await panels(t, { issues, pulls, limits: { max_open_prs: 2 } });
  for (const n of [376, 373]) assert.ok(!p.needsYou.some(a => a.ref?.n === n || a.id === `homeowner-${n}`), `#${n} is not in Inbox`);
  const l376 = p.later.find(l => l.number === 376), l373 = p.later.find(l => l.number === 373);
  assert.match(l376.waits, /#375/); assert.match(l376.ends, /#375 closing/);
  assert.match(l373.waits, /open PR backlog/); assert.match(l373.waits, /cap 2/); assert.match(l373.ends, /Foreman ends the wait/);
  const parked = await panels(t, { issues: [iss(60, 'x', ['parked'])] });
  assert.match(parked.later.find(l => l.number === 60).ends, /removing the parked label/); assert.equal(parked.needsYou.length, 0);
  const both = await panels(t, { issues: [iss(61, 'Question: Is this wanted now?', ['parked', 'needs-homeowner'])] });
  assert.ok(both.later.some(l => l.number === 61)); assert.ok(!both.needsYou.some(a => a.id === 'homeowner-61'), 'parked wins');
});

test("PR #222's shape (fix limit reached, no CHANGES on the current head) is not a decision; with CHANGES on the current head it is", async t => {
  const state = { fixAttempts: { [`222:${H(1)}`]: 2 }, verdicts: {} };
  const labelled = { labels: ['needs-homeowner'] };
  const waiting = await panels(t, { pulls: [pr(222, H(2), labelled)], state });
  assert.ok(!waiting.needsYou.some(a => /^(fixlimit|escalating|homeowner-pr|reviewlimit)-222$/.test(a.id)), text(waiting.needsYou));
  const rejected = await panels(t, { pulls: [pr(222, H(2), labelled)], state: { ...state, verdicts: { [`222:${H(2)}`]: { verdict: 'CHANGES', reviewer: 'codex' } } } });
  assert.ok(rejected.needsYou.some(a => a.id === 'fixlimit-222'));
});

test('the stock "Foreman stopped work" text is used only when state records that Foreman applied the label', async t => {
  const q = 'Question: Approve D-030? Yes: a. No: b.';
  const unknown = (await panels(t, { issues: [iss(70, q)] })).needsYou.find(a => a.id === 'homeowner-70');
  assert.doesNotMatch(unknown.tried, /Foreman stopped work/); assert.match(unknown.tried, /no record of who applied it/);
  const known = (await panels(t, { issues: [iss(70, q)], state: { unblock: { flags: { 70: { 'job:x': { kind: 'job' } } } } } })).needsYou.find(a => a.id === 'homeowner-70');
  assert.match(known.tried, /Foreman labelled this issue needs-homeowner and starts no new job/);
  const flagged = (await panels(t, { issues: [iss(71, 'no question')], state: { unblock: { flags: { 71: { 'job:x': { kind: 'job' } } } } } })).needsYou.find(a => a.id === 'homeowner-71');
  assert.ok(flagged, 'a Foreman-applied label with a recorded cause is a decision'); assert.match(flagged.decision, /removes the label itself once/);
});

test('no item tells the homeowner to remove a label where removal would start held-back work', async t => {
  const issues = [iss(80, 'Question: Is this wanted now? Yes: go. No: stay.'), iss(81, 'x'), iss(82, 'x', ['parked']), iss(83, 'Question: Is the epic still wanted? Yes: it stays. No: close it.', ['needs-homeowner', 'epic'])];
  const p = await panels(t, { issues, state: { splits: { 84: { status: 'proposed', children: [1], implementJob: 'j' } } } });
  const all = [...p.needsYou, ...p.later];
  for (const item of all) { const s = text(item); assert.doesNotMatch(s, /remove the needs-homeowner label so the team can continue/i); assert.doesNotMatch(s, /or remove the label/i); }
  const c80 = p.needsYou.find(a => a.id === 'homeowner-80'); assert.match(c80.decision, /eligible for Foreman to start/);
  assert.match(p.needsYou.find(a => a.id === 'homeowner-83').decision, /does not start work/);
  assert.match(p.later.find(l => l.number === 82).ends, /Foreman then treats it as eligible/);
  assert.match(p.later.find(l => l.number === 81).ends, /would make it eligible for Foreman to start/);
});

test('heldIssues ignores closed issues and issues whose split is being drafted', () => {
  const cache = { issues: [iss(1, 'Question: Is this open?', ['needs-homeowner'], 'CLOSED'), iss(2, 'Question: Is this split wanted?')] };
  assert.deepEqual(heldIssues({ cache, splitting: new Set([2]) }), []);
});
