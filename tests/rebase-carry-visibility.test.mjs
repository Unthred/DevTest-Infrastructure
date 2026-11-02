// Issue #296: a successful carry is visible (dashboard row, PR detail, team status), no review starts while a carry can still
// succeed, skipped checks do not block a carry, and the real failing case behind the early carried:false attempts is pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team, validateTeamConfig, carryRecordOf } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { buildStatus, renderStatus } from '../supervisor/teamstatus.mjs';
import { checkRebase } from '../supervisor/rebasecheck.mjs';
import { rangeEqual } from '../supervisor/rangediff.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pending = [{ status: 'IN_PROGRESS' }];
const cfgRaw = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const pr = (n, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: 'claude/issue-5-x', headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green, ...extra });
const PASS = { verdict: 'PASS', reviewer: 'codex', job: 'j1', findings: [], commandsRun: ['x'], at: 1 };

function world(t, { pulls, equal = true, resolved = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryv-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [] };
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async (n, b) => calls.comments.push([n, b]), hasComment: async (n, m) => calls.comments.some(([x, b]) => x === n && b.includes(m)) };
  const jobs = { states: { r1: { status: 'completed' } }, listActive: async () => [], get: async id => jobs.states[id] || null, create: async () => ({ id: 'a'.repeat(32) }) };
  const git = { checkRebase: async () => ({ commits: [], missing: [], resolvedConflicts: resolved }), ensureWorktree: async o => o.path, worktreeFor: async () => null, rangeEqual: async () => equal };
  const team = new Team({ config: cfgRaw(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: '', clock: { now: () => NOW }, limitedOf: () => ({ out: false }) });
  team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  return { team, calls, gh };
}

test('a recorded carry shows old head, new head and evidence on the dashboard row, the PR detail page and team status', async t => {
  const w = world(t, { pulls: [pr(10, H(2))] });
  await w.team.ingest({ ingested: [], skipped: [] });
  const state = JSON.parse(JSON.stringify(w.team.s));
  assert.equal(state.verdicts[`10:${H(2)}`].carriedFrom, H(1));
  const cache = { tick: { at: NOW, status: 'ok', lastOkAt: NOW }, fetchedAt: NOW, pulls: [pr(10, H(2))], issues: [], merged: [] };
  const cfg = validateTeamConfig(cfgRaw());
  const view = await buildView({ config: cfg, root: '/nonexistent', jobs: [], events: [], state, cache, snapshots: [], now: NOW });
  const row = view.prs.find(p => p.number === 10);
  assert.deepEqual([row.carry.oldHead, row.carry.newHead, row.carry.valid], [H(1), H(2), true]);
  assert.deepEqual(row.carry.evidence, { resolvedConflicts: false, patchUnchanged: true, ci: 'green' });
  assert.ok(row.timeline.some(e => /verdict carried from 1111111 to 2222222 over a clean rebase: no conflict resolved, patch unchanged, CI green/.test(e.text)), JSON.stringify(row.timeline));
  assert.match(view.queues.claude.find(q => q.ref === 10).reason, /carried from 1111111 to 2222222 over a clean rebase: no conflict resolved, patch unchanged, CI green/);
  const html = renderRoute(view, { page: 'pr', id: 10 }, {}).html;
  assert.match(html, /Carried verdict/); assert.match(html, /1111111 → 2222222/); assert.match(html, /no conflict resolved: yes; patch unchanged: yes; CI: green/);
  const s = await buildStatus({ config: cfg, root: '/nonexistent', jobs: [], events: [], state, snapshots: [], leases: [], now: NOW, tz: 'UTC', cache });
  assert.deepEqual(s.pulls[0].verdict.carry, { oldHead: '1111111', newHead: '2222222', valid: true, evidence: { resolvedConflicts: false, patchUnchanged: true, ci: 'green' } });
  assert.match(renderStatus(s), /verdict carried from 1111111 to 2222222 \(no conflict resolved: yes, patch unchanged: yes, CI green\)/);
});

test('negative: an uncarried verdict shows no carry; a record that does not match the head is shown as invalid', async t => {
  assert.equal(carryRecordOf({ ...PASS }, pr(10, H(2))), null);
  const w = world(t, { pulls: [pr(10, H(2))] });
  await w.team.ingest({ ingested: [], skipped: [] });
  const entry = w.team.s.verdicts[`10:${H(2)}`];
  assert.equal(carryRecordOf(entry, pr(10, H(2))).valid, true);
  assert.equal(carryRecordOf(entry, pr(10, H(3))).valid, false);
  assert.equal(carryRecordOf({ ...entry, carry: { ...entry.carry, evidence: { ...entry.carry.evidence, ci: 'red' } } }, pr(10, H(2))).valid, false);
});

test('planner: while the carry waits for CI no review starts for that head; once CI is green the carry lands and still no review runs', async t => {
  const pulls = [pr(10, H(2), { statusCheckRollup: pending })];
  const w = world(t, { pulls });
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.equal(w.team.s.jobs.r1.carry.state, 'pending');
  assert.equal(w.team.carryPending(pulls[0]), true);
  assert.deepEqual((await w.team.plan()).filter(a => a.pr === 10), []);
  // CI turns green but the retry has not run yet: the planner still starts no review for the head
  pulls[0].statusCheckRollup = green;
  assert.deepEqual((await w.team.plan()).filter(a => a.type === 'review' && a.pr === 10), []);
  assert.deepEqual(w.team.unreviewable(pulls), []);
  await w.team.retryCarries({ ingested: [], skipped: [] });
  assert.equal(w.team.s.verdicts[`10:${H(2)}`].carriedFrom, H(1));
  assert.equal((await w.team.plan()).find(a => a.pr === 10)?.type, 'merge');
});

test('planner: once the carry is refused (red CI or a moved head) the pending hold ends and a review is due', async t => {
  const pulls = [pr(10, H(2), { statusCheckRollup: pending })];
  const w = world(t, { pulls });
  await w.team.ingest({ ingested: [], skipped: [] });
  pulls[0].headRefOid = H(3); pulls[0].statusCheckRollup = green;   // the head moved again
  await w.team.retryCarries({ ingested: [], skipped: [] });
  assert.equal(w.team.s.jobs.r1.carry.state, 'refused');
  assert.equal(w.team.carryPending(pulls[0]), false);
  assert.equal((await w.team.plan()).find(a => a.agent === 'codex')?.type, 'review');
});

test('D-025 "required CI": skipped and neutral checks do not block a carry; a failed or pending check does', async t => {
  const skipped = [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'validate' }, { status: 'COMPLETED', conclusion: 'SKIPPED', name: 'optional' }, { status: 'COMPLETED', conclusion: 'NEUTRAL', name: 'info' }];
  const ok = world(t, { pulls: [pr(10, H(2), { statusCheckRollup: skipped })] });
  await ok.team.ingest({ ingested: [], skipped: [] });
  assert.equal(ok.team.s.verdicts[`10:${H(2)}`].carriedFrom, H(1));
  const bad = world(t, { pulls: [pr(10, H(2), { statusCheckRollup: [...skipped, { status: 'COMPLETED', conclusion: 'FAILURE', name: 'validate-2' }] })] });
  await bad.team.ingest({ ingested: [], skipped: [] });
  assert.equal(bad.team.s.verdicts[`10:${H(2)}`], undefined); assert.equal(bad.team.s.jobs.r1.carry.reason, 'CI on the new head is red');
});

test('real case (PR #255, 1862f20 to 09e4840): main edited the line next to the PR hunk, the rebase resolved a conflict, so nothing is carried; the early carried:false refusals were correct', t => {
  // The nine pre-#293 attempts all followed a CONFLICTING-PR rebase (no `behind` flag in the planned action) whose patch really
  // changed. Rebuilt in real git: main edits the line next to the PR's change, the rebase resolves it, the context differs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } }).trim();
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  w('d.mjs', 'const cleanLinks = links => links.map(l => ({ text: redact(String(l.text), 60) }));\nfunction attentionItems({ a, names }) {\n  return 1;\n}\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); w('d.mjs', 'const cleanLinks = links => links.map(l => ({ text: redact(String(l.text), 60) }));\nfunction attentionItems({ a, names, gated = null }) {\n  return 1;\n}\n'); g('commit', '-qam', 'feature'); const old = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main'); w('d.mjs', 'const cleanLinks = links => links.map(l => ({ text: redact(String(l.text), 140) }));\nfunction attentionItems({ a, names }) {\n  return 1;\n}\n'); g('commit', '-qam', 'main edits the neighbouring line; the rebase resolves the conflict');
  g('checkout', '-q', 'feat');
  assert.throws(() => g('rebase', '-q', 'main'));   // adjacent edits conflict: the rebase has to resolve it
  w('d.mjs', 'const cleanLinks = links => links.map(l => ({ text: redact(String(l.text), 140) }));\nfunction attentionItems({ a, names, gated = null }) {\n  return 1;\n}\n'); g('add', '.');
  execFileSync('git', ['-C', dir, '-c', 'core.editor=true', 'rebase', '--continue'], { env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } });
  const now = g('rev-parse', 'HEAD');
  const args = { repoPath: dir, base: 'main', oldHead: old, newHead: now };
  const check = checkRebase(args);
  assert.equal(check.missing.length, 0); assert.equal(check.resolvedConflicts, true, 'the rebase resolved a conflict');
  assert.equal(rangeEqual(args), false, 'the patch context changed: no carry, full review');
});
