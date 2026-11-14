// Issue #415: a conflict rebase must not silently drop a change inside a commit (PR #222: `runDueProbes` kept, its call dropped).
// Real git (bare remote + independent clones, D-011) for the comparison and the guarded push; fake GitHub for the dispatcher.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { checkRebase, prepareRebase, pushRebase, countsHold, refusal } from '../supervisor/rebasecheck.mjs';

const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...a) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };

const BASE = 'import x from "x";\nasync function teamTick(root) {\n  const lock = acquire(root);\n  await migrate(root);\n  return tick(root);\n}\n';
const FEAT = 'import x from "x";\nfunction runDueProbes(root) {\n  return probe(root);\n}\nasync function teamTick(root) {\n  const lock = acquire(root);\n  await migrate(root);\n  if (await runDueProbes(root)) reload(root);\n  return tick(root);\n}\n';
const MAIN = 'import x from "x";\nasync function teamTick(root) {\n  const lock = acquire(root);\n  await withTickLock(root, () => migrate(root));\n  return tick(root);\n}\n';

// main = BASE; feat adds runDueProbes + its call in teamTick; main then rewrites the same teamTick lines (a real conflict).
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed'); git(dir, 'clone', '-q', remote, seed);
  write(seed, 'cli.mjs', BASE); commit(seed, 'base'); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat'); write(seed, 'cli.mjs', FEAT); const f1 = commit(seed, 'probe step'); git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main'); write(seed, 'cli.mjs', MAIN); commit(seed, 'main locks migrations'); git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent'); git(dir, 'clone', '-q', remote, agent);
  return { dir, remote, seed, agent, f1 };
}
// Start the rebase, hit the conflict and write the resolution `text` (same commit, same message).
function rebaseWith(r, text) {
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* the expected conflict */ }
  write(r.agent, 'cli.mjs', text); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  return oldHead;
}
const KEEP = 'import x from "x";\nfunction runDueProbes(root) {\n  return probe(root);\n}\nasync function teamTick(root) {\n  const lock = acquire(root);\n  await withTickLock(root, () => migrate(root));\n  if (await runDueProbes(root)) reload(root);\n  return tick(root);\n}\n';
const DROP = KEEP.replace('  if (await runDueProbes(root)) reload(root);\n', '');   // the PR #222 resolution
const head = r => git(r.agent, 'rev-parse', 'HEAD');
const check = (r, oldHead) => checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });

// Issue #1422: main rewrote the same lines, so this is a hunk inside a conflict: it is listed for the review, it does not refuse the push.
test('PR #222 case: the resolution keeps runDueProbes and drops its call; the call is listed as a conflict hunk', t => {
  const r = repo(t); const oldHead = rebaseWith(r, DROP);
  const c = check(r, oldHead);
  assert.deepEqual(c.missing, []);   // the commit list looks complete
  assert.deepEqual(c.lostChanges, []);
  assert.ok(c.conflictHunks.some(x => x.file === 'cli.mjs' && x.commit === r.f1 && x.kind === 'missing' && x.text.includes('runDueProbes(root)) reload(root)')), JSON.stringify(c.conflictHunks));
});

test('a rebase that keeps every change reports nothing, including when main contains one of the PR lines', t => {
  const r = repo(t); const oldHead = rebaseWith(r, KEEP);
  assert.deepEqual(check(r, oldHead).lostChanges, []);
});

test('a PR line that main now also contains is not lost, even if the resolution took main\'s copy', t => {
  const r = repo(t);
  // main gains the PR's call line itself (after its own rewrite); the resolution is exactly main's file, minus the function the PR added
  git(r.seed, 'checkout', '-q', 'main'); write(r.seed, 'cli.mjs', MAIN.replace('  return tick(root);', '  if (await runDueProbes(root)) reload(root);\n  return tick(root);'));
  commit(r.seed, 'main has the call'); git(r.seed, 'push', '-q', 'origin', 'main'); git(r.agent, 'fetch', '-q', 'origin');
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  write(r.agent, 'cli.mjs', fs.readFileSync(path.join(r.seed, 'cli.mjs'), 'utf8').replace('import x from "x";', 'import x from "x";\nfunction runDueProbes(root) {\n  return probe(root);\n}')); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  assert.deepEqual(check(r, oldHead).lostChanges, []);
});

test('the real job path: a change lost inside a conflict is pushed and listed as a conflict hunk', t => {
  const r = repo(t); const oldHead = rebaseWith(r, DROP);
  const res = pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
  assert.equal(res.pushed, true); assert.deepEqual(res.lostChanges, []); assert.ok(res.conflictHunks.length >= 1);
  assert.equal(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat'), git(r.agent, 'rev-parse', 'HEAD'));
});

// ---- dispatcher side: the pushed head is not accepted as a clean rebase
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
function world(t, checkResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlcd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [] };
  const pulls = [{ number: 10, title: 't', headRefName: 'claude/issue-5-x', headRefOid: H(2), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green }];
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async (n, b) => calls.comments.push([n, b]), hasComment: async (n, m) => calls.comments.some(([x, b]) => x === n && b.includes(m)), addLabel: async (n, l) => calls.labels.push([n, l]) };
  const jobs = { states: { r1: { status: 'completed' } }, listActive: async () => [], get: async id => jobs.states[id] || null };
  const g = { ensureWorktree: async o => o.path, worktreeFor: async () => null, rangeEqual: async () => true, checkRebase: async () => checkResult };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const team = new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: g, register: '', clock: { now: () => 1000 }, limitedOf: () => ({ out: false }) });
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  team.s.verdicts[`10:${H(1)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'j', findings: [], commandsRun: ['x'], at: 1 };
  return { team, calls };
}

test('the dispatcher records lost changes, posts what disappeared once, labels the PR and carries no PASS', async t => {
  const lostChanges = [{ file: 'supervisor/cli.mjs', kind: 'altered', commit: H(3), hunk: '@@ -4,0 +5 @@', text: '+ if (await runDueProbes(root)) reload(root);' }];
  const w = world(t, { commits: [{ sha: H(3), subject: 'probe step' }], missing: [], lostChanges, resolvedConflicts: false });
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report);
  assert.deepEqual(w.team.s.jobs.r1.rebase.lostChanges, lostChanges.map(c => ({ ...c, commit: c.commit.slice(0, 12) })));
  assert.equal(w.calls.comments.length, 1);
  assert.match(w.calls.comments[0][1], /runDueProbes\(root\)\) reload\(root\);/); assert.match(w.calls.comments[0][1], /not a conflict-only rebase/);
  assert.deepEqual(w.calls.labels, [[10, 'needs-homeowner']]); assert.equal(report.lostChanges.length, 1);
  assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined); assert.equal(w.team.s.jobs.r1.carry, undefined);
  await w.team.ingest({ ingested: [], skipped: [] }); assert.equal(w.calls.comments.length, 1);
});

test('with no lost change the same record carries nothing extra and raises nothing', async t => {
  const w = world(t, { commits: [{ sha: H(3), subject: 'probe step' }], missing: [], lostChanges: [], resolvedConflicts: false });
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.equal(w.calls.comments.filter(c => /Needs the homeowner/.test(c[1])).length, 0); assert.deepEqual(w.calls.labels, []);
  assert.equal(w.team.s.jobs.r1.rebase.lostChanges, undefined);
});

// ---- issue #580: a list merged from both sides is not lost; rebase-push prints the guard's reason
const LBASE = 'export const KEYS = [\n  "a",\n];\nconst z = 1;\n';
const LFEAT = 'export const KEYS = [\n  "a", "reviewRefusals",\n];\nconst z = 1;\n';
const LMAIN = 'export const KEYS = [\n  "a", "refusedReviews",\n];\nconst z = 1;\n';
function listRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlu-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed'); git(dir, 'clone', '-q', remote, seed);
  write(seed, 'l.mjs', LBASE); commit(seed, 'base'); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat'); write(seed, 'l.mjs', LFEAT); commit(seed, 'add key'); git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main'); write(seed, 'l.mjs', LMAIN); commit(seed, 'main key'); git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent'); git(dir, 'clone', '-q', remote, agent);
  return { dir, remote, agent };
}
function resolveList(r, text) {
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  write(r.agent, 'l.mjs', text); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  return oldHead;
}
const cliPath = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
const rlsrRoots = [];   // issue #1007: removed after the run
after(() => { for (const d of rlsrRoots) fs.rmSync(d, { recursive: true, force: true }); });
const rlsrRoot = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rlsr-')); rlsrRoots.push(d); return d; };
const runPush = (r, oldHead) => { try { return { code: 0, out: execFileSync(process.execPath, [cliPath, 'rebase-push', '--worktree', r.agent, '--branch', 'feat', '--base', 'main', '--old', oldHead], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: rlsrRoot() }, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };

function sameLineRepo(t, feat, main) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed'); git(dir, 'clone', '-q', remote, seed);
  const f = x => `function go() {\n${x}\n}\nconst z = 1;\n`;
  write(seed, 'l.mjs', f('  if (a) run(x);')); commit(seed, 'base'); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat'); write(seed, 'l.mjs', f(feat).replace('const z = 1;', 'const z = 3;')); commit(seed, 'fix'); git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main'); write(seed, 'l.mjs', f(main)); commit(seed, 'main'); git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent'); git(dir, 'clone', '-q', remote, agent);
  return { dir, remote, agent, f };
}
test('keeping both main\'s line and the PR\'s line is not reported as lost', t => {
  const feat = '  sub(x, ready);', main = '  sub(x, y, ready);';
  const r = sameLineRepo(t, feat, main);
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  write(r.agent, 'l.mjs', r.f(main + '\n' + feat).replace('const z = 1;', 'const z = 3;')); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  assert.deepEqual(checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) }).lostChanges, []);
});

// Positive control for unionSurvives (issue #762); the main-line exclusion is guarded by the line-of-main refusal test.
// The resolution is a merged line that is neither verbatim nor a substring of anything, so only the ordered-token union check can keep it.
test('rebase-prepare prints oldHead so the agent can pass it to rebase-push', t => {
  const r = listRepo(t);
  const out = execFileSync(process.execPath, [cliPath, 'rebase-prepare', '--worktree', r.agent, '--branch', 'feat'], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: rlsrRoot() }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(JSON.parse(out).oldHead, /^[0-9a-f]{40}$/);
});

// ---- issue #640: both sides edited one line; a commit main already covers; a real loss is still refused
function lineRepo(t, { base, feat, main, extra = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl640-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed'); git(dir, 'clone', '-q', remote, seed);
  const f = x => `function go() {\n${x}\n}\n`;
  write(seed, 'l.mjs', f(base)); commit(seed, 'base'); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat'); write(seed, 'l.mjs', f(feat)); commit(seed, 'pr change'); git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main'); write(seed, 'l.mjs', f(main)); commit(seed, 'main change'); git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent'); git(dir, 'clone', '-q', remote, agent);
  return { dir, remote, agent, f };
}
function resolveLine(r, text) {
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  write(r.agent, 'l.mjs', r.f(text)); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  return oldHead;
}
const T640 = { base: '  title("names six read-only tools");', feat: '  title("names six read-only tools (no inbox configured)");', main: '  title("names seven read-only tools");' };

function coveredRepo(t, mainText) {
  const r = lineRepo(t, { base: '  const z = 1;', feat: '  const z = 3;', main: mainText });
  return r;
}
test('#640: a PR commit whose change main already contains is not missing', t => {
  const r = coveredRepo(t, '  const z = 3;');
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* may skip the commit as already applied */ }
  try { execFileSync('git', [...G, 'rebase', '--skip'], { cwd: r.agent, stdio: 'ignore' }); } catch { /* no rebase in progress */ }
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.deepEqual(c.missing, []); assert.deepEqual(c.lostChanges, []);
});

test('#640: a commit emptied by keeping a main fix that differs from the PR\'s is still missing, and refused', t => {
  const r = coveredRepo(t, '  const z = 2;');
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  try { execFileSync('git', [...G, 'rebase', '--skip'], { cwd: r.agent, stdio: 'ignore' }); } catch { /* none */ }
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.equal(c.missing.length, 1);
  const p = runPush(r, oldHead); assert.equal(p.code, 3); const out = JSON.parse(p.out);
  assert.equal(out.reason, 'missing'); assert.match(out.message, /pr change/);
});

test('#640: main made the same change next to another edit, the rebase conflicts and keeps main\'s side: the emptied commit is not missing', t => {
  const r = lineRepo(t, { base: '  const z = 1;\n  const w = 1;', feat: '  const z = 3;\n  const w = 1;', main: '  const z = 3;\n  const w = 2;' });
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  let conflicted = false;
  try { git(r.agent, 'rebase', 'origin/main'); } catch { conflicted = true; }
  assert.ok(conflicted, 'the fixture must conflict');
  write(r.agent, 'l.mjs', r.f('  const z = 3;\n  const w = 2;')); git(r.agent, 'add', '-A');
  try { execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' }); } catch { /* emptied */ }
  try { execFileSync('git', [...G, 'rebase', '--skip'], { cwd: r.agent, stdio: 'ignore' }); } catch { /* none in progress */ }
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.deepEqual(c.missing, []); assert.deepEqual(c.lostChanges, []);
});

test('#640: the same adjacent-edit conflict where main\'s value differs from the PR\'s stays missing', t => {
  const r = lineRepo(t, { base: '  const z = 1;\n  const w = 1;', feat: '  const z = 3;\n  const w = 1;', main: '  const z = 2;\n  const w = 2;' });
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  write(r.agent, 'l.mjs', r.f('  const z = 2;\n  const w = 2;')); git(r.agent, 'add', '-A');
  try { execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' }); } catch { /* emptied */ }
  try { execFileSync('git', [...G, 'rebase', '--skip'], { cwd: r.agent, stdio: 'ignore' }); } catch { /* none */ }
  assert.equal(checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) }).missing.length, 1);
});

// ---- review of PR #683: count rule. A commit that adds a copy of a line the file already holds must not be dropped unnoticed.
const DUP = '  assert.ok(x);';
function dupConflictRebase(r, resolved) {
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  let conflicted = false;
  try { git(r.agent, 'rebase', 'origin/main'); } catch { conflicted = true; }
  assert.ok(conflicted, 'the fixture must conflict');
  write(r.agent, 'l.mjs', r.f(resolved)); git(r.agent, 'add', '-A');
  try { execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' }); } catch { /* emptied */ }
  try { execFileSync('git', [...G, 'rebase', '--skip'], { cwd: r.agent, stdio: 'ignore' }); } catch { /* none in progress */ }
  return oldHead;
}

test('count rule: a dropped commit that added a duplicate of an existing line is missing, and rebase-push refuses it', t => {
  const r = lineRepo(t, { base: `${DUP}\n  const w = 1;`, feat: `${DUP}\n${DUP}\n  const w = 1;`, main: `${DUP}\n  const w = 2;` });
  const oldHead = dupConflictRebase(r, `${DUP}\n  const w = 2;`);   // the duplicate is lost
  assert.equal(checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) }).missing.length, 1);
  const p = runPush(r, oldHead); assert.equal(p.code, 3); assert.equal(JSON.parse(p.out).reason, 'missing');
});

test('count rule: a duplicate line that main itself gained makes the dropped commit not missing', t => {
  const r = lineRepo(t, { base: `${DUP}\n  const w = 1;`, feat: `${DUP}\n${DUP}\n  const w = 1;`, main: `${DUP}\n${DUP}\n  const w = 2;` });
  const oldHead = dupConflictRebase(r, `${DUP}\n${DUP}\n  const w = 2;`);
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.deepEqual(c.missing, []); assert.deepEqual(c.lostChanges, []);
});

test('count rule: counts that cannot be read mean not applied', () => {
  const hunks = [{ file: 'l.mjs', removed: [], added: ['assert.ok(x);'] }];
  const files = { 'p:l.mjs': 'assert.ok(x);\n', 'b:l.mjs': 'assert.ok(x);\nassert.ok(x);\n' };
  const reader = unreadable => args => { const k = args[1]; if (k === unreadable || !(k in files)) throw new Error('unreadable'); return files[k]; };
  assert.equal(countsHold(reader(null), 'p', 'b', hunks), false);      // `p^` is not a key: the parent cannot be read
  const run = args => { if (args[1] === 'p^:l.mjs') return files['p:l.mjs']; if (args[1] === 'b:l.mjs') return files['b:l.mjs']; throw new Error('unreadable'); };
  assert.equal(countsHold(run, 'p', 'b', hunks), true);                // readable, base holds 2 >= 1 + 1
  assert.equal(countsHold((a) => { if (a[1] === 'b:l.mjs') throw new Error('unreadable'); return run(a); }, 'p', 'b', hunks), false);
  assert.equal(countsHold(run, 'p', 'b', [{ file: null, removed: [], added: ['assert.ok(x);'] }]), false);
});

// ---- issue #875: anchor the added lines to the position their hunk maps to. The same line added elsewhere on main must not hide a lost change.
const A875 = (a, extraA, extraB) => `function A() {\n  let a = ${a};\n${extraA}  b();\n}\nfunction B() {\n${extraB}  y();\n}\n`;
function anchorRepo(t, { feat, main, base: base875 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl875-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '-q', '-b', 'main', '--bare', remote);
  const seed = path.join(dir, 'seed'); git(dir, 'clone', '-q', remote, seed);
  write(seed, "a.mjs", base875 || A875(1, "", "")); commit(seed, "base"); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat'); write(seed, 'a.mjs', feat); commit(seed, 'pr change'); git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main'); write(seed, 'a.mjs', main); commit(seed, 'main change'); git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent'); git(dir, 'clone', '-q', remote, agent);
  return { dir, remote, agent };
}
function anchorRebase(r, resolved) {
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  let conflicted = false;
  try { git(r.agent, 'rebase', 'origin/main'); } catch { conflicted = true; }
  assert.ok(conflicted, 'the fixture must conflict');
  write(r.agent, 'a.mjs', resolved); git(r.agent, 'add', '-A');
  try { execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' }); } catch { /* emptied */ }
  try { execFileSync('git', [...G, 'rebase', '--skip'], { cwd: r.agent, stdio: 'ignore' }); } catch { /* none in progress */ }
  return oldHead;
}
const AUDIT = '  audit();\n';

test('#875: main adds the same line in another function next to a conflicting edit: the dropped commit is missing, and rebase-push refuses it', t => {
  const r = anchorRepo(t, { feat: A875(1, AUDIT, ''), main: A875(2, '', AUDIT) });
  const oldHead = anchorRebase(r, A875(2, '', AUDIT));   // keeps main's side: the PR's audit() in A is lost
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.equal(c.missing.length, 1); assert.equal(c.missing[0].subject, 'pr change');
  const p = runPush(r, oldHead); assert.equal(p.code, 3); assert.equal(JSON.parse(p.out).reason, 'missing');
});

test('#875: main adds the same line at the same place in the same function: the emptied commit is not missing', t => {
  const r = anchorRepo(t, { feat: A875(1, AUDIT, ''), main: A875(2, AUDIT, '') });
  const oldHead = anchorRebase(r, A875(2, AUDIT, ''));
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.deepEqual(c.missing, []); assert.deepEqual(c.lostChanges, []);
});

// Review of PR #1071: main's copy elsewhere shares a neighbour line's text (here `b();` below it), so text equality alone must not anchor the block.
test('#875: main adds the same line elsewhere and that spot shares a neighbour line: the dropped commit is still missing', t => {
  const SH = (a, extraA, extraB) => `function A() {\n  let a = ${a};\n${extraA}  b();\n}\nfunction B() {\n${extraB}  b();\n}\n`;
  const r = anchorRepo(t, { feat: SH(1, AUDIT, ''), main: SH(2, '', AUDIT), base: SH(1, '', '') });
  const oldHead = anchorRebase(r, SH(2, '', AUDIT));
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.equal(c.missing.length, 1);
  const p = runPush(r, oldHead); assert.equal(p.code, 3); assert.equal(JSON.parse(p.out).reason, 'missing');
});
