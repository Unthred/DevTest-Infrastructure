// Issue #244: an implement job that ran out of context is not restarted with the same scope. One cheap read-only session drafts a
// split, it is posted on the issue, raised as a Inbox item, and "Accept split" files the children. Fake GitHub, jobs and clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, readSplitDraft } from '../supervisor/team.mjs';
import { stateRoot, LeaseHeld } from '../supervisor/core.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const cfg = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const ID = 'a'.repeat(32);

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [], created: [], issues: [] };
  const gh = { issues: [{ number: 23, title: 'Big issue', state: 'OPEN', body: '', labels: [] }],
    listPulls: async () => [], getPull: async () => null, listIssues: async () => gh.issues, board: async () => {}, merged: [], listMergedPulls: async () => [],
    comment: async (n, body) => calls.comments.push([n, body]), addLabel: async (n, l) => calls.labels.push([n, l]), removeLabel: async (n, l) => { (calls.removed ||= []).push([n, l]); },
    findIssueByMarker: async marker => gh.issues.find(i => i.body?.includes(marker))?.number || null,
    createIssue: async (title, body) => { const number = 100 + gh.issues.length; gh.issues.push({ number, title, state: 'OPEN', body, labels: [] }); calls.issues.push([number, title, body]); return number; } };
  const jobs = { seq: 0, states: { [ID]: { id: ID, status: 'blocked', lastEvent: 'context_too_large', attempts: 1, usage: { inputTokens: 3000000, outputTokens: 700000, costUsdEstimate: 2 } } },
    listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: cfg(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1000 } });
  team.s.jobs[ID] = { kind: 'implement', agent: 'claude', key: '23', issue: 23, branch: 'claude/issue-23-big', ingested: true, at: 1 };
  team.s.implemented[23] = 1; team.save();
  return { gh, jobs, team, calls, dir };
}
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });
const draftFile = (team, ticket, data) => { const d = path.join(team.dir, 'inbox', ticket); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'split-draft.json'), typeof data === 'string' ? data : JSON.stringify(data)); };
const GOOD = { children: [{ title: 'Part one', scope: 'The first half' }, { title: 'Part two', scope: 'The second half' }] };

test('no same-scope restart: a context_too_large stop starts one read-only split draft, never another implement job', async t => {
  const w = world(t);
  await w.team.notifyBlocked(rep());
  assert.equal(w.calls.created.length, 1);
  const spec = w.calls.created[0];
  assert.equal(spec.kind, 'split'); assert.deepEqual(spec.allowed_actions, ['read']); assert.equal(spec.issue, 23); assert.equal(spec.postcondition.kind, 'split_drafted');
  assert.match(spec.prompt, /split-draft\.json/); assert.doesNotMatch(spec.prompt, /open \(or update\) a pull request/);
  assert.equal(w.team.s.splits[23].status, 'drafting'); assert.equal(w.team.s.splits[23].wasted.tokens, 3700000); assert.equal(w.team.s.splits[23].wasted.cost, 2);
  assert.deepEqual(w.calls.comments, [], 'nothing is posted until the draft exists');
  // Later ticks never repeat it, and the planner does not offer the issue again.
  await w.team.notifyBlocked(rep()); await w.team.notifyBlocked(rep());
  assert.equal(w.calls.created.length, 1);
  assert.ok(!(await w.team.plan()).some(a => a.type === 'implement' && a.issue === 23));
});

test('the split draft is posted on the issue and a Inbox item is raised', async t => {
  const w = world(t);
  await w.team.notifyBlocked(rep());
  const [draftId, rec] = Object.entries(w.team.s.jobs).find(([, r]) => r.kind === 'split');
  draftFile(w.team, rec.ticket, GOOD);
  w.jobs.states[draftId].status = 'completed';
  const r = rep(); await w.team.ingest(r);
  assert.equal(w.team.s.splits[23].status, 'proposed'); assert.equal(w.team.s.splits[23].children.length, 2);
  const post = w.calls.comments.find(([n]) => n === 23)[1];
  assert.match(post, /Part one.*first half/s); assert.match(post, /Part two/); assert.match(post, /accept-split 23/); assert.match(post, /3,700,000 tokens/);
  assert.deepEqual(w.calls.labels, [[23, 'needs-homeowner']]);
  assert.equal(w.team.s.unblock.flags[23]['split:23'].kind, 'split');
  // Re-ingesting posts nothing twice.
  await w.team.ingest(rep()); assert.equal(w.calls.comments.filter(([n]) => n === 23).length, 1);
});

test('a missing, malformed or oversized draft raises no split item; the failure is recorded', async t => {
  for (const bad of [null, '{not json', { children: [] }, { children: [{ title: 'only one', scope: 's' }] }, { children: [{ title: 'a', scope: 'b' }, { title: 'x'.repeat(500), scope: 'b' }] }, { children: [{ title: 'a', scope: 'b\nc' }, { title: 'd', scope: 'e' }] }]) {
    const w = world(t);
    await w.team.notifyBlocked(rep());
    const [draftId, rec] = Object.entries(w.team.s.jobs).find(([, r]) => r.kind === 'split');
    if (bad !== null) draftFile(w.team, rec.ticket, bad);
    w.jobs.states[draftId].status = 'completed';
    await w.team.ingest(rep());
    assert.equal(w.team.s.splits[23].status, 'failed', JSON.stringify(bad));
    assert.deepEqual(w.calls.labels, []); assert.deepEqual(w.calls.comments, []);
    await assert.rejects(w.team.acceptSplit(23), /no proposed split/);
  }
  assert.match(readSplitDraft(os.tmpdir(), 'nope').error, /missing/);
});

test('Accept split files the children once, queues them for the same agent, and clears the label', async t => {
  const w = world(t);
  await w.team.notifyBlocked(rep());
  const [draftId, rec] = Object.entries(w.team.s.jobs).find(([, r]) => r.kind === 'split');
  draftFile(w.team, rec.ticket, GOOD); w.jobs.states[draftId].status = 'completed'; await w.team.ingest(rep());
  const filed = await w.team.acceptSplit(23);
  assert.equal(filed.length, 2); assert.equal(w.calls.issues.length, 2);
  assert.match(w.calls.issues[0][2], /Part 1 of 2 of #23/); assert.equal(w.calls.issues[0][1], 'Part one');
  assert.deepEqual(w.team.s.unblock.queued.claude, filed);
  assert.equal(w.team.s.splits[23].status, 'accepted');
  assert.match(w.calls.comments.at(-1)[1], /Split accepted/);
  await assert.rejects(w.team.acceptSplit(23), /no proposed split/, 'a second accept files nothing');
  assert.equal(w.calls.issues.length, 2);
  // The children are dispatchable; the original is not.
  const plan = await w.team.plan();
  assert.ok(plan.some(a => a.type === 'implement' && a.issue === filed[0]));
  assert.ok(!plan.some(a => a.type === 'implement' && a.issue === 23));
  // The needs-homeowner label Foreman added is removed once the split is accepted.
  await w.team.clearStale(rep());
  assert.deepEqual(w.calls.removed, [[23, 'needs-homeowner']]);
});

test('Accept split survives a crash half way: a child already filed is found by its marker, not filed twice', async t => {
  const w = world(t);
  await w.team.notifyBlocked(rep());
  const [draftId, rec] = Object.entries(w.team.s.jobs).find(([, r]) => r.kind === 'split');
  draftFile(w.team, rec.ticket, GOOD); w.jobs.states[draftId].status = 'completed'; await w.team.ingest(rep());
  const create = w.gh.createIssue; let n = 0;
  w.gh.createIssue = async (...a) => { if (++n === 2) throw new Error('gh down'); return create(...a); };
  await assert.rejects(w.team.acceptSplit(23), /gh down/);
  assert.equal(w.team.s.splits[23].status, 'proposed');
  w.gh.createIssue = create;
  const filed = await w.team.acceptSplit(23);
  assert.equal(filed.length, 2); assert.equal(w.calls.issues.length, 2, 'two issues in total, not three');
});

test('issue #302: a split draft blocked by a live review job holding the lease waits; it is not a skipped item', async t => {
  const w = world(t);
  const HOLD = 'bc'.repeat(16); w.jobs.states[HOLD] = { id: HOLD, status: 'running', kind: 'review', worktree: '/p/wt' }; w.jobs.alive = async () => true;
  const real = w.jobs.create; let free = false;
  w.jobs.create = async spec => { if (!free) throw new LeaseHeld(HOLD); return real(spec); };
  const r = rep(); const guard = async (what, fn) => { try { await fn(); } catch (e) { r.skipped.push({ what, reason: e.message }); } };
  await w.team.notifyBlocked(r, guard);
  assert.equal(r.skipped.length, 0); assert.equal(r.waiting.length, 1); assert.match(r.waiting[0].reason, /waiting for job bcbcbcbc \(running\)/);
  assert.equal(w.team.s.splits[23], undefined, 'nothing is recorded, so the split is retried once the lease is free');
  free = true; await w.team.notifyBlocked(r, guard);
  assert.equal(w.calls.created.length, 1); assert.equal(w.team.s.splits[23].status, 'drafting');
});
