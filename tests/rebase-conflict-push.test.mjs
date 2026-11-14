// Issue #1422: a rebase that resolved a real conflict is pushed and handed to the reviewer; a loss outside a conflict is still refused.
// Real git (bare remote + independent clones, D-011) through the real rebase-push entry point, as tests/rebase-lost-changes.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { prepareRebase, pushRebase, refusal } from '../supervisor/rebasecheck.mjs';

const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...a) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
const put = (cwd, files) => { for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, f), text); };
const commit = (cwd, msg, files) => { put(cwd, files); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
const remoteHead = r => git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat');

// The meta command list of PR #1294 (commit 8d9b9060): main and the PR both edit the one line that lists the commands.
const LIST = cmds => `assert.deepEqual(meta, [${cmds.map(c => `'${c}'`).join(', ')}]);\n`;
const FILES = ['tests/api-contract.test.mjs', 'tests/api-router-ext.test.mjs'];
const both = text => Object.fromEntries(FILES.map(f => [f, text]));

// A bare remote, a seed clone that builds main and feat, and the agent clone the rebase runs in.
function scratch(t, { base, mainEdit, featCommits }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'clone', '-q', remote, seed);
  fs.mkdirSync(path.join(seed, 'tests'));
  commit(seed, 'base', base);
  git(seed, 'branch', '-M', 'main');
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat');
  for (const c of featCommits) c.merge ? c.merge(seed) : commit(seed, c.msg, c.files);
  git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main');
  commit(seed, 'main edits', mainEdit);
  git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent');
  git(dir, 'clone', '-q', remote, agent);
  return { dir, remote, seed, agent };
}
// Rebase onto origin/main, writing `resolution` at each conflict stop, then `after` (an edit of the finished result, amended in).
function rebase(r, resolution, after = null) {
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* a conflict stop: resolved below */ }
  while (fs.existsSync(path.join(r.agent, '.git', 'rebase-merge'))) {
    put(r.agent, resolution);
    git(r.agent, 'add', '-A');
    try { git(r.agent, 'rebase', '--continue'); } catch { /* the next stop */ }
  }
  if (after) { put(r.agent, after); git(r.agent, 'add', '-A'); git(r.agent, 'commit', '-q', '--amend', '--no-edit'); }
  return oldHead;
}
const push = (r, oldHead) => pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });

const BASE = both(LIST(['meta.a', 'meta.b']));
const metaCase = t => scratch(t, {
  base: BASE,
  mainEdit: both(LIST(['meta.a', 'meta.b', 'upgrade.clear_latch', 'work_item.clear_retry_cap'])),
  featCommits: [{ msg: 'add job commands', files: both(LIST(['meta.a', 'meta.b', 'job.resume', 'job.close'])) }],
});
// The resolution keeps all four commands. The list is now long, so it is wrapped one command per line: the lines differ from the PR's
// old line, and no accepted pattern (folded, merged) covers a list split over lines, which is what the guard refused as lost-changes.
const WRAPPED = ['meta.a', 'meta.b', 'upgrade.clear_latch', 'work_item.clear_retry_cap', 'job.resume', 'job.close'].map(c => `  '${c}',\n`).join('');
const ALL_FOUR = both(`assert.deepEqual(meta, [\n${WRAPPED}]);\n`);

test('PR #1294 shape: both sides edited the one line, the resolution keeps all four and is pushed with one conflict hunk per file', t => {
  const r = metaCase(t);
  const oldHead = rebase(r, ALL_FOUR);
  const res = push(r, oldHead);
  assert.equal(res.pushed, true, JSON.stringify(res));
  assert.deepEqual(res.lostChanges, []);
  assert.deepEqual(res.conflictHunks.map(h => h.file).sort(), [...FILES].sort());
  assert.ok(res.conflictHunks.every(h => h.commit && h.hunk && h.text), JSON.stringify(res.conflictHunks));
  assert.equal(remoteHead(r), git(r.agent, 'rev-parse', 'HEAD'));
});

// PR #1324 shape: main moved the inline reply object into a helper; the PR had edited that object; the resolution edits the helper.
const INLINE = (extra = '') => `function submit(x) {\n  const reply = { id: x.id, text: x.text${extra} };\n  return send(reply);\n}\n`;
const HELPER = body => `function submittedReply(x) {\n${body}}\nfunction submit(x) {\n  const reply = submittedReply(x);\n  return send(reply);\n}\n`;
test('PR #1324 shape: main moved the edited lines into a helper and the resolution edits the helper: pushed with the conflict hunk', t => {
  const r = scratch(t, {
    base: { 'inbox.mjs': INLINE() },
    mainEdit: { 'inbox.mjs': HELPER('  return { id: x.id, text: x.text, at: now() };\n') },
    featCommits: [{ msg: 'replace the reply', files: { 'inbox.mjs': INLINE(", ...x.replaceReply, kind: 'submitted'") } }],
  });
  const oldHead = rebase(r, { 'inbox.mjs': HELPER("  return {\n    id: x.id,\n    text: x.text,\n    at: now(),\n    ...x.replaceReply,\n    kind: 'submitted',\n  };\n") });
  const res = push(r, oldHead);
  assert.equal(res.pushed, true, JSON.stringify(res));
  assert.deepEqual(res.conflictHunks.map(h => h.file), ['inbox.mjs']);
  assert.deepEqual(res.lostChanges, []);
});

// Two files in one PR commit: a.txt conflicts with main, b.txt does not.
const twoFiles = t => scratch(t, {
  base: { 'a.txt': 'one\n', 'b.txt': 'x\ny\n' },
  mainEdit: { 'a.txt': 'one main\n' },
  featCommits: [{ msg: 'edit both', files: { 'a.txt': 'one pr extra\n', 'b.txt': 'x\ny\nthree\nfour\n' } }],
});
const RESOLVED_A = { 'a.txt': 'one\nmain\npr\nextra\n' };

test('a finding inside a conflict and one outside: refused, and only the outside one is named as the reason', t => {
  const r = twoFiles(t);
  const before = remoteHead(r);
  const oldHead = rebase(r, RESOLVED_A, { 'b.txt': 'x\ny\nthree\n' });
  const res = push(r, oldHead);
  assert.equal(res.pushed, false);
  assert.equal(res.reason, 'lost-changes');
  assert.deepEqual(res.lostChanges.map(h => h.file), ['b.txt']);
  assert.deepEqual(res.conflictHunks.map(h => h.file), ['a.txt']);
  assert.match(res.message, /b\.txt/);
  assert.doesNotMatch(res.message, /a\.txt/);
  assert.equal(res.message, refusal(res, 'feat', oldHead, 1), 'the refusal text is the same as before');
  assert.equal(remoteHead(r), before);
});

test('a hunk dropped from a file with no conflict is refused', t => {
  const r = scratch(t, {
    base: { 'a.txt': 'one\n', 'b.txt': 'x\ny\n' },
    mainEdit: { 'a.txt': 'one main\n' },
    featCommits: [{ msg: 'edit b', files: { 'b.txt': 'x\ny\nthree\nfour\n' } }],
  });
  const oldHead = rebase(r, {}, { 'b.txt': 'x\ny\nthree\n' });
  const res = push(r, oldHead);
  assert.equal(res.pushed, false);
  assert.equal(res.reason, 'lost-changes');
  assert.deepEqual(res.conflictHunks, []);
});

test('a whole commit dropped is refused as missing', t => {
  const r = scratch(t, {
    base: { 'a.txt': 'one\n' },
    mainEdit: { 'a.txt': 'one main\n' },
    featCommits: [{ msg: 'first', files: { 'f1.txt': 'f1\n' } }, { msg: 'second', files: { 'f2.txt': 'f2\n' } }],
  });
  const oldHead = rebase(r, {});
  git(r.agent, 'reset', '-q', '--hard', 'HEAD~1');
  const res = push(r, oldHead);
  assert.equal(res.pushed, false);
  assert.equal(res.reason, 'missing');
  assert.deepEqual(res.missing.map(m => m.subject), ['second']);
});

// A branch holding a merge commit of its base. `own` is a change made in the merge commit itself.
function mergedBranch(t, own) {
  const merge = seed => {
    git(seed, 'checkout', '-q', 'main');
    commit(seed, 'main before the merge', { 'm.txt': 'm1\n' });
    git(seed, 'checkout', '-q', 'feat');
    git(seed, 'merge', '-q', '--no-ff', '--no-commit', 'main');
    put(seed, own ? { 'z.txt': 'z\nown\n' } : {});
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'merge main into the branch');
  };
  return scratch(t, {
    base: { 'a.txt': 'one\n', 'm.txt': 'm0\n', 'z.txt': 'z\n' },
    mainEdit: { 'a.txt': 'one main\n' },
    featCommits: [{ msg: 'first', files: { 'f1.txt': 'f1\n' } }, { merge }, { msg: 'last', files: { 'f2.txt': 'f2\n' } }],
  });
}

test('a branch with a merge commit of its base and no other difference is pushed', t => {
  const r = mergedBranch(t, false);
  const oldHead = rebase(r, {});
  const res = push(r, oldHead);
  assert.equal(res.pushed, true, JSON.stringify(res));
  assert.deepEqual([res.lostChanges, res.conflictHunks], [[], []]);
});

test('a merge commit that carried a change of its own: dropped from a file with no conflict is refused, restored is pushed', t => {
  const dropped = mergedBranch(t, true);
  const res = push(dropped, rebase(dropped, {}));
  assert.equal(res.pushed, false);
  assert.equal(res.reason, 'lost-changes');
  assert.deepEqual(res.lostChanges.map(h => h.file), ['z.txt']);

  const kept = mergedBranch(t, true);
  const ok = push(kept, rebase(kept, {}, { 'z.txt': 'z\nown\n' }));
  assert.equal(ok.pushed, true, JSON.stringify(ok));
});

// ---- the dispatcher records the hunks, names them on the PR and hands them to the reviewer
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z' }];
const HUNK = { commit: H(3), subject: 'add job commands', file: 'tests/api-contract.test.mjs', hunk: '@@ -1 +1 @@', kind: 'missing', text: "+ assert.deepEqual(meta, ['job.resume'])" };
function world(t, { check = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [], created: [] };
  const gh = {
    pulls: [{ number: 10, title: 't', headRefName: 'claude/issue-5-x', headRefOid: H(2), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green }],
    listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async (n, b) => calls.comments.push([n, b]), hasComment: async (n, m) => calls.comments.some(([x, b]) => x === n && b.includes(m)),
    addLabel: async (n, l) => calls.labels.push([n, l]), findIssueByMarker: async () => null, createIssue: async () => 1, board: async () => {},
  };
  const jobs = { states: { r1: { status: 'completed' } }, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = String(++jobs.seq).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git2 = { ensureWorktree: async o => o.path, worktreeFor: async () => null, rangeEqual: async () => true, checkRebase: async () => check };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const team = new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: git2, register: '## D-020 — x\n- Status: homeowner-approved\n', clock: { now: () => 1000 }, limitedOf: () => ({ out: false }) });
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  return { team, calls };
}

test('the dispatcher stores the conflict hunks on the rebase job and names them once on the pull request, with no homeowner label', async t => {
  const w = world(t, { check: { commits: [{ sha: H(3), subject: 'add job commands' }], missing: [], lostChanges: [], conflictHunks: [HUNK], resolvedConflicts: true } });
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.deepEqual(w.team.s.jobs.r1.rebase.conflictHunks, [{ file: HUNK.file, hunk: HUNK.hunk, kind: HUNK.kind, text: HUNK.text, commit: H(3).slice(0, 12) }]);
  const named = w.calls.comments.filter(([, b]) => b.includes('tests/api-contract.test.mjs'));
  assert.equal(named.length, 1);
  assert.match(named[0][1], /resolved a conflict/);
  assert.deepEqual(w.calls.labels, []);
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.equal(w.calls.comments.filter(([, b]) => b.includes('tests/api-contract.test.mjs')).length, 1);
});

test('the real review launch gives the reviewer the conflict hunks as a task data file and asks for a statement on each', async t => {
  const w = world(t);
  w.team.s.jobs.r1.ingested = true;   // already recorded, as it is when the review is planned
  w.team.s.jobs.r1.rebase = { oldHead: H(1), newHead: H(2), commits: [], resolvedConflicts: true, conflictHunks: [{ ...HUNK, commit: H(3).slice(0, 12) }] };
  w.team.save();
  await w.team.tick();
  const spec = w.calls.created.find(s => s.kind === 'review');
  assert.ok(spec, 'a review job starts');
  const rec = Object.values(w.team.s.jobs).find(j => j.kind === 'review');
  const file = path.join(w.team.dir, 'inbox', rec.ticket, 'conflict-hunks.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).conflictHunks.map(h => h.file), ['tests/api-contract.test.mjs']);
  assert.ok(spec.prompt.includes(file), 'the prompt names the file');
  assert.match(spec.prompt, /intent of the PR's change survives/);
  assert.match(spec.prompt, /lost is a blocking finding/);
});

test('a review of a head with no conflict hunks gets no such file and no such request', async t => {
  const w = world(t);
  await w.team.tick();
  const spec = w.calls.created.find(s => s.kind === 'review');
  assert.ok(spec);
  assert.doesNotMatch(spec.prompt, /conflict-hunks/);
});
