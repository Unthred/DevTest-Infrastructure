// Issue #158: a rebase job must not drop commits. Real git (bare remote + independent clones, never a linked worktree, D-011)
// for the guarded steps; fake GitHub for the dispatcher side.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { checkRebase, prepareRebase, pushRebase } from '../supervisor/rebasecheck.mjs';

const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...a) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, msg) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };

// remote (bare) with main = a; feature = a + f1 + f2 (f2 is "the fix"); then main moves on. `agent` is the job's clone, `other` a second writer.
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbs-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed'); git(dir, 'clone', '-q', remote, seed);
  commit(seed, 'base.txt', 'base\n', 'base'); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat');
  const f1 = commit(seed, 'one.txt', 'one\n', 'feature one');
  git(seed, 'push', '-q', 'origin', 'feat');
  const agent = path.join(dir, 'agent'); git(dir, 'clone', '-q', remote, agent);   // caches feat at f1
  const f2 = commit(seed, 'two.txt', 'two\n', 'fix two'); git(seed, 'push', '-q', 'origin', 'feat');   // the newer commit, after the agent's copy
  git(seed, 'checkout', '-q', 'main'); commit(seed, 'main2.txt', 'm\n', 'main moves'); git(seed, 'push', '-q', 'origin', 'main');
  return { dir, remote, seed, agent, f1, f2 };
}

test('a stale local branch: the job rebases the fetched remote head and keeps the newer commit', t => {
  const r = repo(t);
  git(r.agent, 'checkout', '-q', 'feat');                        // stale: only f1
  assert.equal(git(r.agent, 'rev-parse', 'HEAD'), r.f1);
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  assert.equal(oldHead, r.f2); assert.equal(git(r.agent, 'rev-parse', 'HEAD'), r.f2);
  git(r.agent, 'rebase', '-q', 'origin/main');
  const res = pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
  assert.equal(res.pushed, true); assert.deepEqual(res.missing, []);
  assert.deepEqual(res.commits.map(c => c.subject), ['feature one', 'fix two']);
  const remoteHead = git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat');
  assert.equal(remoteHead, res.newHead); assert.notEqual(remoteHead, r.f2);
  assert.ok(fs.existsSync(path.join(r.agent, 'two.txt')));
});

test('a rebase that drops a commit is not pushed and names the commit', t => {
  const r = repo(t);
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  git(r.agent, 'reset', '-q', '--hard', 'origin/main'); git(r.agent, 'cherry-pick', r.f1);   // result has f1 only: f2 lost
  const res = pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
  assert.equal(res.pushed, false); assert.equal(res.reason, 'missing');
  assert.deepEqual(res.missing, [{ sha: r.f2, subject: 'fix two' }]);
  assert.equal(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat'), r.f2);   // remote untouched
});

test('a lease mismatch (branch moved during the job) pushes nothing', t => {
  const r = repo(t);
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  git(r.agent, 'rebase', '-q', 'origin/main');
  git(r.seed, 'checkout', '-q', 'feat'); const moved = commit(r.seed, 'late.txt', 'late\n', 'late push'); git(r.seed, 'push', '-q', 'origin', 'feat');
  const res = pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
  assert.equal(res.pushed, false); assert.equal(res.reason, 'lease');
  assert.equal(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat'), moved);
});

test('a commit already on main, a reworded-but-equal patch and an empty commit are not reported lost', t => {
  const r = repo(t);
  git(r.agent, 'fetch', '-q', 'origin'); git(r.agent, 'checkout', '-q', '-B', 'x', r.f2);
  git(r.agent, 'rebase', '-q', 'origin/main'); git(r.agent, 'commit', '-q', '--amend', '-m', 'reworded');   // same patch, new message
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead: r.f2, newHead: git(r.agent, 'rev-parse', 'HEAD') });
  assert.deepEqual(c.missing, []);
  assert.throws(() => checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead: 'nope', newHead: 'nope' }), /full commit ids/);
});

// ---- dispatcher side
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
function world(t, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [] };
  const pulls = [{ number: 10, title: 't', headRefName: 'claude/issue-5-x', headRefOid: H(2), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green }];
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async (n, b) => calls.comments.push([n, b]), hasComment: async (n, m) => calls.comments.some(([x, b]) => x === n && b.includes(m)), addLabel: async (n, l) => calls.labels.push([n, l]) };
  const jobs = { states: {}, listActive: async () => [], get: async id => jobs.states[id] || null };
  const g = { ensureWorktree: async o => o.path, worktreeFor: async () => null, rangeEqual: async () => false, checkRebase: async a => { calls.check = a; if (check instanceof Error) throw check; return check; } };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: g, register: '', clock: { now: () => 1000 }, limitedOf: () => ({ out: false }) });
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  jobs.states.r1 = { status: 'completed' };
  return { team, calls };
}

test('the job record stores old head, new head and commits; lost commits raise one notice and a label, once', async t => {
  const lost = [{ sha: H(7), subject: 'fix two' }];
  const w = world(t, { commits: [{ sha: H(3), subject: 'feature one' }], missing: lost });
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report);
  assert.deepEqual(w.calls.check, { base: 'origin/main', oldHead: H(1), newHead: H(2) });
  assert.deepEqual(w.team.s.jobs.r1.rebase, { oldHead: H(1), newHead: H(2), commits: [{ sha: H(3), subject: 'feature one' }], lost });
  assert.equal(w.calls.comments.length, 1); assert.match(w.calls.comments[0][1], new RegExp(`${H(7).slice(0, 7)}\\\`\\]\\(https://github.com/o/r/commit/${H(7)}\\) fix two`));
  assert.deepEqual(w.calls.labels, [[10, 'needs-homeowner']]); assert.equal(report.lostCommits.length, 1);
  await w.team.ingest({ ingested: [], skipped: [] }); assert.equal(w.calls.comments.length, 1);
});

test('lost commits stop a verdict carrying; a clean rebase and an unreadable comparison raise nothing', async t => {
  const w = world(t, { commits: [{ sha: H(3), subject: 'a' }], missing: [{ sha: H(7), subject: 'x' }] });
  w.team.s.verdicts[`10:${H(1)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'j', findings: [], commandsRun: ['x'], at: 1 };
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined);
  const clean = world(t, { commits: [{ sha: H(3), subject: 'a' }], missing: [] });
  await clean.team.ingest({ ingested: [], skipped: [] });
  assert.equal(clean.calls.comments.length, 0); assert.deepEqual(clean.calls.labels, []); assert.equal(clean.team.s.jobs.r1.rebase.lost, undefined);
  const broken = world(t, new Error('x'));
  await broken.team.ingest({ ingested: [], skipped: [] });
  assert.equal(broken.calls.comments.length, 0); assert.equal(broken.team.s.jobs.r1.rebase.unchecked, true);
});

test('a finding fixed on an earlier head that reappears after a rebase is flagged as possibly lost', t => {
  const w = world(t, { commits: [], missing: [] });
  const text = 'transcript.mjs mishandles an empty line';
  w.team.s.verdicts[`10:${H(1)}`] = { verdict: 'CHANGES', findings: [{ kind: 'blocking', text }], at: 10 };
  w.team.s.jobs.f1 = { kind: 'fix', pr: 10, head: H(1), at: 20 };
  const j = { pr: 10, head: H(3) };
  // no rebase yet: nothing flagged
  assert.equal(w.team.flagLostInRebase(j, [{ kind: 'blocking', text }])[0].possiblyLostInRebase, undefined);
  w.team.s.jobs.r2 = { kind: 'rebase', pr: 10, head: H(2), at: 30 };
  const out = w.team.flagLostInRebase(j, [{ kind: 'blocking', text: text.toUpperCase() }, { kind: 'blocking', text: 'something new' }]);
  assert.equal(out[0].possiblyLostInRebase, true); assert.match(out[0].text, /possibly lost in rebase/);
  assert.equal(out[1].possiblyLostInRebase, undefined); assert.equal(out[1].text, 'something new');
});

test('a rebase that resolves a conflict is not reported lost and is pushed', t => {
  const r = repo(t);
  git(r.seed, 'checkout', '-q', 'feat'); commit(r.seed, 'base.txt', 'FEAT\n', 'feat edits base'); git(r.seed, 'push', '-q', 'origin', 'feat');
  git(r.seed, 'checkout', '-q', 'main'); commit(r.seed, 'base.txt', 'MAIN\n', 'main edits base'); git(r.seed, 'push', '-q', 'origin', 'main');
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  assert.throws(() => git(r.agent, 'rebase', 'origin/main'));                  // conflicts on base.txt
  fs.writeFileSync(path.join(r.agent, 'base.txt'), 'MAIN+FEAT\n'); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  const res = pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
  assert.equal(res.pushed, true); assert.deepEqual(res.missing, []);
  assert.equal(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat'), res.newHead);
});

// Pinned limits of the identity fallback (issue #164). All fail safe: a commit that cannot be proven present is reported missing.
function conflictRebase(r, resolved, extra = []) {
  // a fixed past author date, so a reset to "now" always differs from it
  git(r.seed, 'checkout', '-q', 'feat'); fs.writeFileSync(path.join(r.seed, 'base.txt'), 'FEAT\n'); git(r.seed, 'add', '-A');
  execFileSync('git', [...G, 'commit', '-q', '-m', 'feat edits base'], { cwd: r.seed, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' } }); git(r.seed, 'push', '-q', 'origin', 'feat');
  git(r.seed, 'checkout', '-q', 'main'); commit(r.seed, 'base.txt', 'MAIN\n', 'main edits base'); git(r.seed, 'push', '-q', 'origin', 'main');
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  assert.throws(() => git(r.agent, 'rebase', ...extra, 'origin/main'));
  fs.writeFileSync(path.join(r.agent, 'base.txt'), resolved); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  return pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
}

test('a commit that conflict resolution made empty is dropped by git and reported missing, not pushed', t => {
  const r = repo(t);
  const res = conflictRebase(r, 'MAIN\n');             // resolved to exactly main's content: nothing left to commit
  assert.equal(res.pushed, false); assert.equal(res.reason, 'missing');
  assert.deepEqual(res.missing.map(m => m.subject), ['feat edits base']);
});

test('a rebase that resets author dates cannot be paired after a conflict and is reported missing (fails safe)', t => {
  const r = repo(t);
  const res = conflictRebase(r, 'MAIN+FEAT\n', ['--reset-author-date']);
  assert.equal(res.pushed, false); assert.equal(res.reason, 'missing');
  assert.deepEqual(res.missing.map(m => m.subject), ['feat edits base']);
});

test('squashing commits during a rebase is reported missing (fails safe)', t => {
  const r = repo(t);
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  git(r.agent, 'reset', '-q', '--soft', 'origin/main'); git(r.agent, 'commit', '-q', '-m', 'squashed');
  const res = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: git(r.agent, 'rev-parse', 'HEAD') });
  assert.equal(res.missing.length, 2);
});

test('two old commits with the same author, second and subject need two distinct new commits', t => {
  const r = repo(t);
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  git(r.seed, 'checkout', '-q', 'feat');
  for (const [f, c] of [['x.txt', 'x1\n'], ['y.txt', 'y1\n']]) {
    fs.writeFileSync(path.join(r.seed, f), c); git(r.seed, 'add', '-A');
    execFileSync('git', [...G, 'commit', '-q', '-m', 'same subject'], { cwd: r.seed, env });
  }
  git(r.seed, 'push', '-q', 'origin', 'feat');
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  // drop the second of the twins: only one commit with that identity remains, so exactly one is reported missing
  git(r.agent, 'reset', '-q', '--hard', 'HEAD~1');
  const res = checkRebase({ repoPath: r.agent, base: 'origin/feat~3', oldHead, newHead: git(r.agent, 'rev-parse', 'HEAD') });
  assert.equal(res.missing.length, 1); assert.equal(res.missing[0].subject, 'same subject');
});
