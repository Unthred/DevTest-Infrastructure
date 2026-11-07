// Issue #415: a conflict rebase must not silently drop a change inside a commit (PR #222: `runDueProbes` kept, its call dropped).
// Real git (bare remote + independent clones, D-011) for the comparison and the guarded push; fake GitHub for the dispatcher.
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

test('PR #222 case: the resolution keeps runDueProbes and drops its call; the call is reported lost', t => {
  const r = repo(t); const oldHead = rebaseWith(r, DROP);
  const c = check(r, oldHead);
  assert.deepEqual(c.missing, []);   // the commit list looks complete
  assert.ok(c.lostChanges.some(x => x.kind === 'line' && x.file === 'cli.mjs' && x.text.includes('runDueProbes(root)) reload(root)')), JSON.stringify(c.lostChanges));
  assert.ok(c.lostChanges.some(x => x.kind === 'unreferenced' && x.text === 'runDueProbes'), JSON.stringify(c.lostChanges));
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

test('an added function that nothing references is flagged even though its lines still exist', t => {
  const r = repo(t); const oldHead = rebaseWith(r, DROP);
  const c = check(r, oldHead);
  assert.deepEqual(c.lostChanges.filter(x => x.kind === 'unreferenced').map(x => x.text), ['runDueProbes']);
  // an exported helper nobody called before either is not flagged
  const q = repo(t);
  const { oldHead: o2 } = prepareRebase({ worktree: q.agent, branch: 'feat' });
  try { git(q.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  write(q.agent, 'cli.mjs', DROP.replace('function runDueProbes', 'export function runDueProbes')); git(q.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: q.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  // the old head DID call it, so the vanished call site is still flagged
  assert.ok(check(q, o2).lostChanges.some(x => x.kind === 'unreferenced'));
});

test('the real job path: pushRebase refuses a lost change and leaves the remote head alone; a faithful rebase is pushed', t => {
  const r = repo(t); const oldHead = rebaseWith(r, DROP);
  const res = pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
  assert.equal(res.pushed, false); assert.equal(res.reason, 'lost-changes'); assert.ok(res.lostChanges.length >= 1);
  assert.equal(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat'), oldHead);
  // fix the resolution, amend, push
  write(r.agent, 'cli.mjs', KEEP); git(r.agent, 'add', '-A'); git(r.agent, 'commit', '-q', '--amend', '--no-edit');
  const ok = pushRebase({ worktree: r.agent, branch: 'feat', base: 'main', oldHead });
  assert.equal(ok.pushed, true); assert.deepEqual(ok.lostChanges, []);
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
  const lostChanges = [{ file: 'supervisor/cli.mjs', kind: 'line', text: 'if (await runDueProbes(root)) reload(root);' }, { file: 'supervisor/cli.mjs', kind: 'unreferenced', text: 'runDueProbes' }];
  const w = world(t, { commits: [{ sha: H(3), subject: 'probe step' }], missing: [], lostChanges, resolvedConflicts: false });
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report);
  assert.deepEqual(w.team.s.jobs.r1.rebase.lostChanges, lostChanges);
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
const runPush = (r, oldHead) => { try { return { code: 0, out: execFileSync(process.execPath, [cliPath, 'rebase-push', '--worktree', r.agent, '--branch', 'feat', '--base', 'main', '--old', oldHead], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'rlsr-')) }, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };

test('a union of both sides\' list items is not lost, and rebase-push pushes it', t => {
  const r = listRepo(t); const oldHead = resolveList(r, 'export const KEYS = [\n  "a", "refusedReviews", "reviewRefusals",\n];\nconst z = 1;\n');
  assert.deepEqual(checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) }).lostChanges, []);
  const p = runPush(r, oldHead); assert.equal(p.code, 0); assert.equal(JSON.parse(p.out).pushed, true);
});

test('a resolution that really drops the PR\'s item is still refused, and rebase-push prints the reason and the lost line', t => {
  const r = listRepo(t); const oldHead = resolveList(r, LMAIN.replace('const z = 1;', 'const z = 2;'));
  const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
  assert.ok(c.lostChanges.some(x => x.text.includes('reviewRefusals')), JSON.stringify(c.lostChanges));
  const p = runPush(r, oldHead); assert.equal(p.code, 3);
  const out = JSON.parse(p.out); assert.equal(out.pushed, false); assert.equal(out.reason, 'lost-changes'); assert.ok(out.lostChanges[0].text.includes('reviewRefusals'));
  assert.equal(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat'), oldHead);
});

// Review fix: taking main's line of a same-line conflict, negating a guard, or reordering arguments is not a union
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
for (const [name, feat, main] of [
  ['a negated guard', '  if (!a) run(x);', '  if (a) run(x, y);'],
  ['reordered arguments', '  sub(x, ready);', '  sub(ready, x);'],
  ['a dropped early return', '  if (!ready) return x;', '  if (ready) return x;'],
  ['a line of main that holds the PR tokens in order', '  sub(x, ready);', '  sub(x, y, ready);'],
]) {
  test(`taking main's line drops the PR's change and is refused: ${name}`, t => {
    const r = sameLineRepo(t, feat, main);
    const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
    try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
    write(r.agent, 'l.mjs', r.f(main).replace('const z = 1;', 'const z = 3;')); git(r.agent, 'add', '-A');
    execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
    const c = checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) });
    assert.ok(c.lostChanges.some(x => x.text === feat.trim()), JSON.stringify(c.lostChanges));
  });
}

// End-to-end guard (issue #677): keeping the PR's own line verbatim next to main's line is not a loss. It short-circuits at the exact-count
// check, so it does not exercise unionSurvives; the next test is the control for that.
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
test('a merged line that is new in the resolution and holds the PR\'s tokens in order is not reported as lost', t => {
  const feat = '  sub(x, ready);', main = '  sub(x, y, ready);', merged = '  sub(x, y, z, ready);';
  const r = sameLineRepo(t, feat, main);
  const { oldHead } = prepareRebase({ worktree: r.agent, branch: 'feat' });
  try { git(r.agent, 'rebase', 'origin/main'); } catch { /* conflict */ }
  write(r.agent, 'l.mjs', r.f(merged).replace('const z = 1;', 'const z = 3;')); git(r.agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: r.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  assert.deepEqual(checkRebase({ repoPath: r.agent, base: 'origin/main', oldHead, newHead: head(r) }).lostChanges, []);
});

test('rebase-prepare prints oldHead so the agent can pass it to rebase-push', t => {
  const r = listRepo(t);
  const out = execFileSync(process.execPath, [cliPath, 'rebase-prepare', '--worktree', r.agent, '--branch', 'feat'], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'rlsr-')) }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(JSON.parse(out).oldHead, /^[0-9a-f]{40}$/);
});
