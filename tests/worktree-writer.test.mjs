// An inbox job that pushes to a branch of its own naming: the writer of that head is proven by git's reflog in the job's worktree, bound to
// the exact head SHA; a claim in text is not evidence; any later commit starts unknown again. Real git (git init, no linked worktree).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { findWorktreeWriter } from '../supervisor/worktreewriter.mjs';

const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const CANDIDATES = [{ model: 'opus', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const config = repo => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: repo, worktree_base: path.dirname(repo),
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' }, review_candidates: CANDIDATES }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const manifests = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };
const NOW = Date.now();
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x.test' } }).trim();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-writer-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'f'), '1\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const commit = (msg, body = '2\n') => { fs.writeFileSync(path.join(repo, 'f'), body); git(repo, 'commit', '-q', '-am', msg); return git(repo, 'rev-parse', 'HEAD'); };
  return { dir, repo, commit };
}
function world(t, repo, pulls) {
  const gh = { pulls, issues: [], listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {}, hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'x'.repeat(32) }) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-state-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const team = new Team({ config: config(repo), root: stateRoot(root), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => NOW }, providerModels: manifests, headWriterOf: () => null });
  team.s.jobs.i1 = { kind: 'inbox', agent: 'claude', key: 'a1b2c3d4', model: 'sonnet', branch: 'claude/inbox-a1b2c3d4', inboxId: 'a1b2c3d4' + '0'.repeat(24), worktree: repo, ingested: true, at: NOW - 600000, endedAt: NOW + 60000 };
  return { team, gh };
}
const pr = (head, branch = 'claude/issue-640-rebase-guard') => ({ number: 683, title: 't', headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });

test('module: a commit entry for the exact head inside the window is evidence; outside the window, a reset, a foreign repo or an unknown sha is not', t => {
  const f = fixture(t); const head = f.commit('work');
  const win = { worktree: f.repo, head, from: NOW - 600000, to: NOW + 60000, repoPath: f.repo };
  assert.equal(findWorktreeWriter(win)?.head, head);
  assert.equal(findWorktreeWriter({ ...win, from: NOW + 3600000, to: NOW + 7200000 }), null, 'outside the run window');
  const other = fixture(t);
  assert.equal(findWorktreeWriter({ ...win, repoPath: other.repo }), null, 'a directory of another repository proves nothing');
  assert.equal(findWorktreeWriter({ ...win, head: 'a'.repeat(40) }), null);
  // A head that reached the worktree by a reset (somebody else's commit) has no commit entry.
  const o = fixture(t); const theirs = o.commit('theirs'); const mine = fixture(t);
  git(mine.repo, 'fetch', '-q', o.repo, 'main'); git(mine.repo, 'reset', '-q', '--hard', theirs);
  assert.equal(findWorktreeWriter({ worktree: mine.repo, head: theirs, from: NOW - 600000, to: NOW + 60000, repoPath: mine.repo }), null);
});

test('an inbox job on a self-named branch: writer known at the exact head; another Claude model may review, the same model is refused', async t => {
  const f = fixture(t); const head = f.commit('work'); const w = world(t, f.repo, [pr(head)]);
  w.team.recordHeadWriters(w.gh.pulls);
  assert.equal(w.team.s.headWriters[`683:${head}`].source, 'worktree-reflog');
  assert.deepEqual(w.team.writersOf(w.gh.pulls[0]), [{ provider: 'claude', model: 'sonnet' }]);
  assert.equal(w.team.independenceRefusal('claude', 'opus', w.gh.pulls[0]), null);
  assert.equal(w.team.independenceRefusal('claude', 'sonnet', w.gh.pulls[0]), 'it wrote this head');
});

test('a further commit by something else on that branch is unknown again', async t => {
  const f = fixture(t); const head = f.commit('work'); const w = world(t, f.repo, [pr(head)]);
  w.team.recordHeadWriters(w.gh.pulls);
  // The head moves to a commit made elsewhere (no entry in the job's worktree).
  const o = fixture(t); const elsewhere = o.commit('elsewhere', '3\n');
  w.gh.pulls = [pr(elsewhere)]; w.team.recordHeadWriters(w.gh.pulls);
  assert.equal(w.team.s.headWriters[`683:${head}`], undefined, 'the old record is dropped');
  assert.deepEqual(w.team.writersOf(w.gh.pulls[0]), [{ provider: 'claude', model: null }]);
  assert.equal(w.team.independenceRefusal('claude', 'opus', w.gh.pulls[0]), 'writer unknown');
});

test('a job-less head with no evidence stays unknown', async t => {
  const f = fixture(t); f.commit('work'); const o = fixture(t); const head = o.commit('hand', '4\n'); const w = world(t, f.repo, [pr(head)]);
  delete w.team.s.jobs.i1; w.team.recordHeadWriters(w.gh.pulls);
  assert.deepEqual(w.team.writersOf(w.gh.pulls[0]), [{ provider: 'claude', model: null }]);
});

test('a claim in the commit message or the job summary alone is not evidence', async t => {
  const f = fixture(t); const o = fixture(t); const head = o.commit('hand', '5\n');
  const w = world(t, f.repo, [pr(head)]);
  f.commit(`Written by inbox job a1b2c3d4, head ${head}`, '6\n');   // the job's worktree names the sha in a message, but never committed it
  Object.assign(w.team.s.jobs.i1, { summary: `I pushed ${head}`, result: `head ${head} was written by me` });
  w.team.recordHeadWriters(w.gh.pulls);
  assert.equal(w.team.s.headWriters[`683:${head}`], undefined);
  assert.equal(w.team.independenceRefusal('claude', 'opus', w.gh.pulls[0]), 'writer unknown');
});

test('a job of another provider or without a recorded model proves nothing', async t => {
  const f = fixture(t); const head = f.commit('work'); const w = world(t, f.repo, [pr(head)]);
  w.team.s.jobs.i1.model = null; w.team.recordHeadWriters(w.gh.pulls);
  assert.equal(w.team.independenceRefusal('claude', 'opus', w.gh.pulls[0]), 'writer unknown');
});

test('a merge or pull in the job worktree is not authorship: the head stays unknown (issue #704)', async t => {
  const f = fixture(t); const w0 = f.commit('work');
  git(f.repo, 'checkout', '-q', '-b', 'side', 'HEAD~1'); fs.writeFileSync(path.join(f.repo, 'g'), 'g\n'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-q', '-m', 'side');
  const win = head => ({ worktree: f.repo, head, from: NOW - 600000, to: NOW + 60000, repoPath: f.repo });
  git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const merged = git(f.repo, 'rev-parse', 'HEAD');
  assert.match(git(f.repo, 'reflog', '-1', '--format=%gs'), /^merge main: Merge made by/);
  assert.equal(findWorktreeWriter(win(merged)), null, 'git merge');
  git(f.repo, 'reset', '-q', '--hard', 'HEAD~1');
  git(f.repo, 'pull', '-q', '--no-rebase', '--no-ff', '--no-edit', '.', 'main');
  const pulled = git(f.repo, 'rev-parse', 'HEAD');
  assert.match(git(f.repo, 'reflog', '-1', '--format=%gs'), /^pull .*: Merge made by/);
  assert.equal(findWorktreeWriter(win(pulled)), null, 'git pull');
  assert.ok(w0);
  // End to end: the merged head has no writer record, so it stays 'writer unknown' for the reviewer.
  const w = world(t, f.repo, [pr(pulled)]); w.team.recordHeadWriters(w.gh.pulls);
  assert.equal(w.team.independenceRefusal('claude', 'opus', w.gh.pulls[0]), 'writer unknown');
});

test('a forged reflog line for a head committed long before the run is rejected (issue #704)', t => {
  const f = fixture(t); const old = '2020-01-01T00:00:00Z';
  fs.writeFileSync(path.join(f.repo, 'f'), 'old\n');
  execFileSync('git', ['-C', f.repo, 'commit', '-q', '-am', 'older'], { env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x.test', GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  const head = git(f.repo, 'rev-parse', 'HEAD'), prev = git(f.repo, 'rev-parse', 'HEAD~1');
  const win = { worktree: f.repo, head, from: NOW - 600000, to: NOW + 60000, repoPath: f.repo };
  assert.equal(findWorktreeWriter(win), null, 'the real entry is also outside the window');
  fs.appendFileSync(path.join(f.repo, '.git', 'logs', 'HEAD'), `${prev} ${head} a <a@x.test> ${Math.floor(NOW / 1000)} +0000\tcommit: forged\n`);
  assert.equal(findWorktreeWriter(win), null, 'forged line, but the commit itself is from 2020');
});

test('a linked worktree: its own reflog is found, the main checkout does not see it, and it survives a checkout (issue #704)', t => {
  const f = fixture(t); const linked = path.join(f.dir, 'linked');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'job', linked);
  fs.writeFileSync(path.join(linked, 'f'), 'job\n'); git(linked, 'commit', '-q', '-am', 'job work');
  const head = git(linked, 'rev-parse', 'HEAD');
  const win = worktree => ({ worktree, head, from: NOW - 600000, to: NOW + 60000, repoPath: f.repo });
  assert.equal(findWorktreeWriter(win(linked))?.head, head);
  assert.equal(findWorktreeWriter(win(f.repo)), null, 'the main checkout reflog does not hold it');
  git(linked, 'checkout', '-q', '-b', 'elsewhere', 'main');
  assert.equal(findWorktreeWriter(win(linked))?.head, head, 'still found after the worktree moves to another branch');
});

test('a per-tick cache reads each worktree once; a removed worktree is skipped without any git process (issue #704)', async t => {
  const f = fixture(t); const head = f.commit('work'); const w = world(t, f.repo, [pr(head), { ...pr(head), number: 684, headRefName: 'claude/issue-641-x' }]);
  let calls = 0; const real = w.team.worktreeWriterOf; w.team.worktreeWriterOf = o => { calls++; return real(o); };
  w.team.s.jobs.i2 = { ...w.team.s.jobs.i1, inboxId: 'b2c3d4e5' + '0'.repeat(24) };
  const cache = new Map(); w.team.inboxWritersOf(w.gh.pulls[0], 'claude', cache);
  const size = cache.size; assert.ok(size > 0); w.team.inboxWritersOf(w.gh.pulls[1], 'claude', cache);
  assert.equal(cache.size, size, 'the second PR adds no new git reads (same worktree, same head)');
  calls = 0; w.team.s.jobs.i1.worktree = path.join(f.dir, 'gone'); w.team.s.jobs.i2.worktree = path.join(f.dir, 'gone2');
  assert.deepEqual(w.team.inboxWritersOf(w.gh.pulls[0], 'claude', new Map()), []);
  assert.equal(calls, 0, 'removed worktrees never reach the git reader');
});
