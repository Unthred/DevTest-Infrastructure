// Issue #1158: merge, approve a decision proposal and record a review verdict from the Inbox, at the strong tier. Every action is checked against the
// gate it claims to change (the pull request state, the comments CI reads, the verdict store the merge step reads), not against its own message.
// A real Team, a real inbox folder and a real git repository for the decision register; fake GitHub; no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as inbox from '../supervisor/inbox.mjs';
import { Team, verdictKey } from '../supervisor/team.mjs';
import { keyOf } from '../supervisor/strongactions.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { decisionViolations, approvalsFrom } from '../supervisor/decisions.mjs';
import { confirmRefusal, isStrongAction, withHeads, liveHeadOf } from '../supervisor/strongtier.mjs';
import { tierOf, toApprovalRows, approveAllIds } from '../supervisor/approvals.mjs';
import { strongApproveHtml } from '../supervisor/strongcard-ui.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const PROPOSAL = '\n## D-099 — Merge on Fridays\n- Status: agent-proposal\n- Date: 2026-11-12\n- Source: issue 1\n- Decision: Merging on Fridays is allowed.\n';
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });
const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

// A git repository (git init, never a linked worktree) with main holding the register and a branch commit that adds a proposal.
function repo(t) {
  const dir = tmp(t, 'strong-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'DECISIONS.md'), REGISTER);
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'main');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'claude/issue-5-x');
  fs.writeFileSync(path.join(dir, 'docs', 'DECISIONS.md'), REGISTER + PROPOSAL);
  git(dir, 'commit', '-q', '-am', 'proposal');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

const cfg = (dir, repoPath) => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: repoPath, worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const GREEN = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];

function world(t, { poster = 'o' } = {}) {
  const r = repo(t), dir = tmp(t, 'strong-inbox-'), state = tmp(t, 'strong-state-');
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const calls = { merged: [], comments: [] };
  const gh = {
    pr: { number: 5, headRefName: 'claude/issue-5-x', headRefOid: r.head, isDraft: false, labels: [], mergeable: 'MERGEABLE', state: 'OPEN', statusCheckRollup: GREEN },
    comments: [],
    listPulls: async () => (gh.pr.state === 'OPEN' ? [gh.pr] : []), listIssues: async () => [], listMergedPulls: async () => [], board: async () => {},
    getPull: async n => (n === 5 ? { ...gh.pr } : null),
    merge: async (n, head) => { calls.merged.push([n, head]); if (head !== gh.pr.headRefOid) throw new Error('Head branch was modified'); gh.pr = { ...gh.pr, state: 'MERGED', merged: true }; },
    comment: async (n, body) => { calls.comments.push([n, body]); gh.comments.push({ login: poster, createdAt: 'x', url: `https://github.com/o/r/pull/5#issuecomment-${gh.comments.length + 1}`, id: gh.comments.length + 1, body }); },
    prComments: async () => gh.comments,
  };
  const make = () => new Team({ config: cfg(dir, r.dir), root: stateRoot(state), gh, jobs: { listActive: async () => [], get: async () => null }, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 5000 },
    providerModels: { claude: { aliases: ['opus'], pattern: '^claude-', efforts: ['low'] } } });
  return { r, dir, state, gh, calls, team: make(), reload: make, mcp: createInbox({ dir }) };
}

const item = (action, target = '5', reason = 'the homeowner decided') => ({ kind: 'action', title: `${action} ${target}`, action, target, reason });
// The overseer's proposal, picked up as pending (as a tick would).
function propose(w, it) {
  const sent = w.mcp.propose(it);
  assert.ok(sent.id, `proposal accepted: ${JSON.stringify(sent)}`);
  inbox.scan(w.dir, 1000);
  return sent.id;
}
const confirmFor = (w, extra = {}) => ({ typed: '5', shownHead: w.r.head, liveHead: w.r.head, ...extra });
async function approveAndTick(w, id, confirm = confirmFor(w)) {
  const d = inbox.decide(w.dir, id, 'approve', 2000, confirm);
  assert.equal(d.ok, true, d.reason);
  await w.team.processInbox(rep());
  return inbox.statusOf(w.dir, id);
}

test('merge: merges at the confirmed head, says so, and records a homeowner override', async t => {
  const w = world(t), id = propose(w, item('merge_pr'));
  const st = await approveAndTick(w, id);
  assert.deepEqual(w.calls.merged, [[5, w.r.head]], 'merged with the confirmed head as --match-head-commit');
  assert.equal(st.state, 'done'); assert.match(st.result, /was merged at/); assert.doesNotMatch(st.result, /only recorded/);
  assert.equal((await w.gh.getPull(5)).merged, true, 'the gate changed: GitHub shows it merged');
  assert.equal(w.team.s.merged[5], w.r.head);
  assert.deepEqual({ by: st.strong.by, why: st.strong.why, head: st.strong.head, kind: st.strong.override.kind, hasTime: Number.isFinite(st.strong.at) }, { by: 'homeowner', why: 'the homeowner decided', head: w.r.head, kind: 'merge', hasTime: true });
  assert.deepEqual(st.confirm.head, w.r.head);
});
test('merge: a head that moved after approval is refused and nothing is merged', async t => {
  const w = world(t), id = propose(w, item('merge_pr'));
  assert.equal(inbox.decide(w.dir, id, 'approve', 2000, confirmFor(w)).ok, true);
  w.gh.pr = { ...w.gh.pr, headRefOid: 'f'.repeat(40) };
  await w.team.processInbox(rep());
  const st = inbox.statusOf(w.dir, id);
  assert.equal(st.state, 'refused'); assert.match(st.reason, /new head/); assert.deepEqual(w.calls.merged, []); assert.equal(w.gh.pr.state, 'OPEN');
});
test('merge: GitHub refusing the merge ends refused; a merge GitHub does not show fails loudly', async t => {
  const a = world(t), idA = propose(a, item('merge_pr'));
  a.gh.merge = async () => { throw new Error('Pull request is not mergeable'); };
  const stA = await approveAndTick(a, idA); assert.equal(stA.state, 'refused'); assert.match(stA.reason, /GitHub refused the merge/);
  const b = world(t), idB = propose(b, item('merge_pr'));
  b.gh.merge = async () => {};
  const stB = await approveAndTick(b, idB); assert.equal(stB.state, 'failed'); assert.match(stB.reason, /does not show it merged/);
});
test('merge: a supervisor that cannot read the result back refuses before merging anything', async t => {
  const w = world(t), id = propose(w, item('merge_pr')); delete w.gh.getPull;
  const st = await approveAndTick(w, id);
  assert.equal(st.state, 'failed'); assert.deepEqual(w.calls.merged, []);
});

test('approve: posts the homeowner-approval comment CI reads, and the decision then reads as homeowner-approved', async t => {
  const w = world(t), id = propose(w, item('approve_decision'));
  const st = await approveAndTick(w, id);
  assert.equal(st.state, 'done'); assert.match(st.result, /D-099 is approved on pull request #5/);
  assert.match(w.calls.comments[0][1], /^homeowner-approval: D-099$/m);
  const approvals = approvalsFrom(await w.gh.prComments(5), 'o');
  assert.ok(approvals.has('D-099'));
  const flipped = (REGISTER + PROPOSAL).replace('Status: agent-proposal', 'Status: homeowner-approved').replace('Source: issue 1', `Source: ${w.gh.comments[0].url}`);
  assert.deepEqual(decisionViolations(REGISTER, flipped, approvals), [], 'with the recorded comment the register change is accepted');
  assert.notDeepEqual(decisionViolations(REGISTER, flipped, new Map()), [], 'without it the same change is refused');
});
test('approve: the real CI validator accepts the flipped entry only with the comment this action posted', async t => {
  const w = world(t), id = propose(w, item('approve_decision'));
  await approveAndTick(w, id);
  const flipped = (REGISTER + PROPOSAL).replace('Status: agent-proposal', 'Status: homeowner-approved').replace('Source: issue 1', `Source: ${w.gh.comments[0].url}`);
  fs.writeFileSync(path.join(w.r.dir, 'docs', 'DECISIONS.md'), flipped); git(w.r.dir, 'commit', '-q', '-am', 'approve');
  const file = path.join(tmp(t, 'strong-approvals-'), 'approvals.json');
  const run = comments => { fs.writeFileSync(file, JSON.stringify(comments)); return spawnSync(process.execPath, [path.resolve('tools/ci/validate-decision-status.mjs'), w.r.base, 'HEAD', file], { cwd: w.r.dir, encoding: 'utf8', env: { ...process.env, REPO_OWNER: 'o' } }); };
  assert.equal(run(w.gh.comments).status, 0);
  assert.equal(run([]).status, 1, 'no approval comment: CI fails the same change');
});
test('approve: a comment that is not read as the owner\'s approval is a failure, a repeat is refused, and a PR with no proposal is refused', async t => {
  const wrong = world(t, { poster: 'someone-else' }), idW = propose(wrong, item('approve_decision'));
  const stW = await approveAndTick(wrong, idW); assert.equal(stW.state, 'failed'); assert.match(stW.reason, /not read as o's homeowner-approval/);
  const w = world(t), id1 = propose(w, item('approve_decision', '5', 'first'));
  await approveAndTick(w, id1);
  const id2 = propose(w, item('approve_decision', '5', 'second'));
  const st2 = await approveAndTick(w, id2); assert.equal(st2.state, 'refused'); assert.match(st2.reason, /already has your homeowner-approval/); assert.equal(w.calls.comments.length, 1);
  const none = world(t); git(none.r.dir, 'checkout', '-q', 'main'); none.gh.pr.headRefOid = git(none.r.dir, 'rev-parse', 'HEAD');
  const idN = propose(none, item('approve_decision')); const stN = await approveAndTick(none, idN, { typed: '5', shownHead: none.gh.pr.headRefOid, liveHead: none.gh.pr.headRefOid });
  assert.equal(stN.state, 'refused'); assert.match(stN.reason, /adds no decision proposal/); assert.deepEqual(none.calls.comments, []);
});

test('verdict: the gate key used here is the one the review gate uses', () => { assert.equal(keyOf(5, 'a'.repeat(40)), verdictKey(5, 'a'.repeat(40))); });
test('verdict: a homeowner PASS is stored where the merge step reads it, survives a restart, and makes the head merge-eligible', async t => {
  const w = world(t);
  const pr = await w.gh.getPull(5);
  assert.equal(w.team.mergeVerdict(pr), null, 'before: nothing lets the merge step merge this head');
  const id = propose(w, item('verdict_pass'));
  const st = await approveAndTick(w, id);
  assert.equal(st.state, 'done'); assert.match(st.result, /review gate holds your PASS verdict/);
  const v = w.team.mergeVerdict(pr);
  assert.equal(v?.verdict, 'PASS'); assert.equal(v.homeowner, true);
  assert.equal(w.reload().mergeVerdict(pr)?.homeowner, true, 'a new Team reading the saved state sees it');
  assert.ok(!(await w.team.plan()).some(a => a.type === 'review' && a.pr === 5), 'the head is no longer waiting for a review');
});
test('verdict: a homeowner CHANGES replaces and archives an earlier PASS, and the gate no longer lets the head merge', async t => {
  const w = world(t), pr = await w.gh.getPull(5);
  assert.equal(await approveAndTick(w, propose(w, item('verdict_pass'))).then(s => s.state), 'done');
  assert.ok(w.team.mergeVerdict(pr));
  const st = await approveAndTick(w, propose(w, item('verdict_changes', '5', 'it is wrong')));
  assert.equal(st.state, 'done');
  assert.equal(w.team.mergeVerdict(pr), null);
  assert.equal(w.team.s.verdicts[`5:${w.r.head}`].verdict, 'CHANGES');
  const again = await approveAndTick(w, propose(w, item('verdict_changes', '5', 'again')));
  assert.equal(again.state, 'refused'); assert.match(again.reason, /already has your CHANGES verdict/);
});
test('verdict: a homeowner CHANGES gives the fix loop a blocking finding and a public comment, and a fix job is planned from it', async t => {
  const w = world(t);
  const st = await approveAndTick(w, propose(w, item('verdict_changes', '5', 'the retry path loses the head')));
  assert.equal(st.state, 'done');
  const entry = w.team.s.verdicts[`5:${w.r.head}`];
  assert.deepEqual(entry.findings, [{ kind: 'blocking', text: 'Homeowner verdict: the retry path loses the head' }]);
  const posted = w.calls.comments.filter(([n]) => n === 5).map(c => c[1]).join('\n');
  assert.match(posted, /CHANGES/); assert.match(posted, /the retry path loses the head/); assert.ok(posted.includes(w.r.head));
  const fix = (await w.team.plan()).find(a => a.type === 'fix' && a.pr === 5);
  assert.ok(fix, 'the planner starts a fix round for the rejected head');
  assert.ok(w.team.s.verdicts[fix.key].findings.some(f => f.kind === 'blocking' && /retry path/.test(f.text)), 'the fix job has text to correct');
});
test('verdict: a CHANGES whose public comment fails records nothing', async t => {
  const w = world(t);
  w.gh.comment = async () => { throw new Error('boom'); };
  const st = await approveAndTick(w, propose(w, item('verdict_changes', '5', 'x')));
  assert.equal(st.state, 'failed');
  assert.equal(w.team.s.verdicts[`5:${w.r.head}`], undefined);
});
test('verdict: for a head that is not the confirmed one nothing is recorded', async t => {
  const w = world(t), id = propose(w, item('verdict_pass'));
  assert.equal(inbox.decide(w.dir, id, 'approve', 2000, confirmFor(w)).ok, true);
  w.gh.pr = { ...w.gh.pr, headRefOid: 'e'.repeat(40) };
  await w.team.processInbox(rep());
  assert.equal(inbox.statusOf(w.dir, id).state, 'refused'); assert.deepEqual(w.team.s.verdicts, {});
});

test('strong confirm: a wrong typed number, a moved head, a lowered tier and no confirmation are all refused and leave the item pending', t => {
  const w = world(t), id = propose(w, item('merge_pr'));
  const refuse = (confirm, re) => { const r = inbox.decide(w.dir, id, 'approve', 2000, confirm); assert.equal(r.ok, false); assert.match(r.reason, re); assert.equal(inbox.statusOf(w.dir, id).state, 'pending'); };
  refuse(null, /strong action/);
  refuse(confirmFor(w, { typed: '6' }), /does not match pull request 5/);
  refuse(confirmFor(w, { typed: '' }), /does not match/);
  refuse(confirmFor(w, { liveHead: 'd'.repeat(40) }), /new head since this card was shown/);
  refuse(confirmFor(w, { liveHead: null }), /cannot be read/);
  refuse(confirmFor(w, { shownHead: '' }), /did not show a head/);
  refuse(confirmFor(w, { tier: 'click' }), /cannot be lowered/);
  assert.equal(inbox.decide(w.dir, id, 'approve', 2000, confirmFor(w, { typed: ' 5 ', tier: 'strong' })).ok, true);
});
test('strong confirm: the tier cannot be lowered by a request, an unknown field or another kind; the overseer can propose but never approve', t => {
  const w = world(t);
  assert.equal(inbox.validateItem({ ...item('merge_pr'), tier: 'click' }).ok, false, 'a tier field is an unknown field');
  assert.equal(inbox.validateItem({ ...item('merge_pr'), kind: 'control' }).ok, false, 'a strong action is not a hold-back control');
  assert.throws(() => w.mcp.propose({ ...item('merge_pr'), tier: 'click' }), /unknown argument: tier/);
  const id = propose(w, item('merge_pr'));
  assert.equal(inbox.statusOf(w.dir, id).state, 'pending', 'proposing never approves');
  assert.equal(inbox.decide(w.dir, id, 'approve', 2000).ok, false, 'a bare approve (as Approve all would send) is refused');
  assert.equal(tierOf('action', 'merge_pr'), 'strong'); assert.equal(tierOf('action', 'reopen'), 'click');
  const rows = toApprovalRows(inbox.pendingCards(w.dir));
  assert.deepEqual(rows.map(r => r.tier), ['strong']); assert.deepEqual(approveAllIds(rows), []);
});
test('strong confirm: rejecting needs no confirmation, and an undo clears the recorded confirmation', t => {
  const w = world(t), a = propose(w, item('verdict_pass')), b = propose(w, item('merge_pr'));
  assert.equal(inbox.decide(w.dir, a, 'reject', 2000).ok, true);
  assert.equal(inbox.decide(w.dir, b, 'approve', 2000, confirmFor(w)).ok, true);
  assert.equal(inbox.undo(w.dir, b, 3000).ok, true);
  assert.equal(inbox.statusOf(w.dir, b).confirm, undefined);
});
test('strong confirm: a status approved by some other path, without a recorded confirmation, does nothing', async t => {
  const w = world(t), id = propose(w, item('merge_pr'));
  inbox.finish(w.dir, id, { state: 'approved', decision: 'approve', decidedAt: 2000 }, 2000);
  await w.team.processInbox(rep());
  assert.equal(inbox.statusOf(w.dir, id).state, 'refused'); assert.deepEqual(w.calls.merged, []);
});

test('the card shows the head and asks for the number; without a readable head it offers no Approve', () => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const head = 'ab'.repeat(20);
  const html = strongApproveHtml(esc, { id: 'c'.repeat(32), kind: 'action', action: 'merge_pr', target: '5', head });
  assert.ok(html.includes(`<code>${head}</code>`)); assert.match(html, /name="confirm"/); assert.match(html, /name="head" value="a{0}ab/); assert.match(html, /name="tier" value="strong"/);
  assert.ok(!/Approve<\/button>/.test(strongApproveHtml(esc, { id: 'c'.repeat(32), kind: 'action', action: 'merge_pr', target: '5', head: null })));
  assert.deepEqual(withHeads([{ action: 'merge_pr', target: '5' }, { action: 'reopen', target: '5' }], [{ number: 5, headRefOid: head }]).map(c => c.head), [head, undefined]);
  assert.equal(liveHeadOf({ panels: { needsYou: [{ inbox: { id: 'x', head } }] } }, 'x'), head);
  assert.ok(['merge_pr', 'approve_decision', 'verdict_pass', 'verdict_changes'].every(isStrongAction) && !isStrongAction('reopen'));
  assert.equal(confirmRefusal({ target: '5' }, { typed: '5', shownHead: head, liveHead: head }), null);
});
