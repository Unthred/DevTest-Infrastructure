// Issue #1193: a rebase whose guarded push is refused must not be retried with the same result. Real git (bare remote, independent clone)
// and the real rebase-push command; fake GitHub and job records for the dispatcher, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team, rebasePrompt } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { prepareRebase } from '../supervisor/rebasecheck.mjs';
import { readRefusal, noHeadDetail } from '../supervisor/rebaserefusal.mjs';

const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...a) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); };
const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;

const BASE = 'function go() {\n  a();\n  run();\n}\nconst z = 1;\n';
const FEAT = 'function go() {\n  a();\n  extraStep();\n  run();\n}\nconst z = 1;\n';
const MAIN = 'function go() {\n  a();\n  lock(run);\n}\nconst z = 1;\n';
const KEEP = 'function go() {\n  a();\n  extraStep();\n  lock(run);\n}\nconst z = 1;\n';
const DROP = MAIN;   // the resolution takes main's side and silently drops the PR's extraStep() line

function world(t, resolution) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rfs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'clone', '-q', remote, seed);
  write(seed, 'f.mjs', BASE); commit(seed, 'base'); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat'); write(seed, 'f.mjs', FEAT); commit(seed, 'extra step'); git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main'); write(seed, 'f.mjs', MAIN); commit(seed, 'main locks run'); git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent');
  git(dir, 'clone', '-q', remote, agent);
  const { oldHead } = prepareRebase({ worktree: agent, branch: 'feat' });
  try { git(agent, 'rebase', 'origin/main'); } catch { /* the expected conflict */ }
  write(agent, 'f.mjs', resolution); git(agent, 'add', '-A');
  execFileSync('git', [...G, 'rebase', '--continue'], { cwd: agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  return { dir, remote, agent, oldHead };
}
function push(w) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rfsr-'));
  try {
    const out = execFileSync(process.execPath, [cli, 'rebase-push', '--worktree', w.agent, '--branch', 'feat', '--base', 'main', '--old', w.oldHead],
      { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root }, stdio: ['ignore', 'pipe', 'ignore'] });
    return { code: 0, out: JSON.parse(out) };
  } catch (e) { return { code: e.status, out: JSON.parse(e.stdout) }; } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('rebase-push leaves a note when it refuses, and none when it pushes', t => {
  const bad = world(t, DROP);
  const p = push(bad);
  assert.equal(p.code, 3);
  assert.ok(['missing', 'lost-changes'].includes(p.out.reason), p.out.reason);
  const note = readRefusal(bad.agent, bad.oldHead);
  assert.equal(note.reason, p.out.reason);
  assert.match(note.message, /Refused/);
  assert.equal(readRefusal(bad.agent, 'f'.repeat(40)), null, 'negative: a note for another head is ignored');
  const good = world(t, KEEP);
  assert.equal(push(good).out.pushed, true);
  assert.equal(readRefusal(good.agent, good.oldHead), null, 'negative: a pushed rebase leaves no note');
});

test('the post-condition names the refusal and spends the automatic retry; without a note it is unchanged', t => {
  const w = world(t, DROP);
  push(w);
  const job = { worktree: w.agent };
  assert.match(noHeadDetail(job, { baseHead: w.oldHead }), /guarded push was refused \((missing|lost-changes)\)/);
  assert.match(job.rebaseRefused, /missing|lost-changes/);
  assert.equal(job.incompleteRetries, 1);
  const plain = { worktree: w.agent };
  assert.equal(noHeadDetail(plain, { baseHead: 'a'.repeat(40) }), 'no new head was pushed: the branch is unchanged');
  assert.equal(plain.rebaseRefused, undefined);
  assert.equal(plain.incompleteRetries, undefined);
});

const H = n => String(n).repeat(40).slice(0, 40);
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
function team(t, jobRecord, calls) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rfst-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    out_of_allowance: { weekly_at: 0.95 }, limits: { roles: { implementer: 1, reviewer: 1 }, max_review_attempts: 2, max_fix_attempts: 2 },
    models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } } } },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const pull = { number: 7, title: 't', headRefName: 'claude/issue-7-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'CONFLICTING', statusCheckRollup: [] };
  const gh = { listPulls: async () => [pull], getPull: async () => pull, listIssues: async () => [], listMergedPulls: async () => [], hasComment: async () => false,
    comment: async (n, body) => { calls.comments.push({ n, body }); }, addLabel: async (n, l) => { calls.labels.push({ n, l }); }, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => jobRecord, create: async () => ({ id: 'x'.repeat(32) }) };
  const git2 = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  return new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: git2, register: REGISTER, clock: { now: () => 1_800_000_000_000 },
    providerModels: { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'high'] } }, sleep: async () => {} });
}

test('a refused rebase spends the head\'s rebase attempts and asks the homeowner once; any other incomplete rebase does not', async t => {
  const w = world(t, DROP);
  push(w);
  const key = `7:${H(1)}`, id = 'j'.repeat(32);
  const record = extra => ({ id, status: 'blocked', lastEvent: 'incomplete', attempts: 1, worktree: w.agent, postcondition: { kind: 'rebased', pr: 7, baseHead: w.oldHead },
    incompleteReason: { cause: 'postcondition_not_met', detail: 'x', attempt: 1 }, ...extra });
  const run = async (rec, head) => {
    const calls = { comments: [], labels: [] }, tm = team(t, rec, calls);
    const j = tm.s.jobs[id] = { kind: 'rebase', agent: 'claude', pr: 7, head, key, ingested: false, at: 1 };
    await tm.ingestOne(id, j, { ingested: [] });
    return { tm, calls };
  };
  const hit = await run(record({ rebaseRefused: 'missing' }), w.oldHead);
  assert.equal(hit.tm.s.rebaseAttempts[key], 2, 'the head is out of rebase attempts, so the planner skips it');
  assert.equal(hit.calls.comments.length, 1);
  assert.match(hit.calls.comments[0].body, /Needs the homeowner[\s\S]*Refused/);
  assert.deepEqual(hit.calls.labels, [{ n: 7, l: 'needs-homeowner' }]);
  const miss = await run(record({}), w.oldHead);
  assert.equal(miss.tm.s.rebaseAttempts[key] || 0, 0, 'negative: a rebase that stopped for another reason keeps its attempts');
  assert.equal(miss.calls.comments.length, 0);
  assert.equal(miss.calls.labels.length, 0);
});

// Issue #1207: an agent that cannot finish records why with the real rebase-stop command; the same hold follows, with its own wording.
test('rebase-stop records the agent\'s stop, the post-condition reads it, and the homeowner is asked once', async t => {
  const w = world(t, KEEP);   // nothing was pushed; the agent decides it cannot go on
  const stop = args => execFileSync(process.execPath, [cli, 'rebase-stop', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => stop(['--worktree', w.agent, '--old', w.oldHead]), 'negative: a stop without a reason is refused');
  assert.equal(readRefusal(w.agent, w.oldHead), null);
  assert.deepEqual(JSON.parse(stop(['--worktree', w.agent, '--old', w.oldHead, '--reason', 'seven files conflict and the two sides are different designs'])), { stopped: true });
  const note = readRefusal(w.agent, w.oldHead);
  assert.equal(note.reason, 'agent-stop');
  assert.equal(readRefusal(w.agent, 'f'.repeat(40)), null, 'negative: a note for another head is ignored');
  const job = { worktree: w.agent };
  assert.match(noHeadDetail(job, { baseHead: w.oldHead }), /agent reported that it cannot finish/);
  assert.equal(job.incompleteRetries, 1);
  const key = `7:${H(1)}`, id = 'j'.repeat(32), calls = { comments: [], labels: [] }, tm = team(t, { id, status: 'blocked', lastEvent: 'incomplete', attempts: 1, worktree: w.agent,
    postcondition: { kind: 'rebased', pr: 7, baseHead: w.oldHead }, incompleteReason: { cause: 'postcondition_not_met', detail: 'x', attempt: 1 }, rebaseRefused: 'agent-stop' }, calls);
  const j = tm.s.jobs[id] = { kind: 'rebase', agent: 'claude', pr: 7, head: w.oldHead, key, ingested: false, at: 1 };
  await tm.ingestOne(id, j, { ingested: [] });
  assert.equal(tm.s.rebaseAttempts[key], 2);
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0].body, /could not be finished by the agent[\s\S]*seven files conflict/);
  assert.doesNotMatch(calls.comments[0].body, /guarded push refused/);
});

test('the rebase prompt tells the agent to run rebase-stop when it cannot finish', () => {
  
  assert.match(rebasePrompt({ pr: 7, head: 'a'.repeat(40), base: 'main', branch: 'b' }), /ai-supervisor rebase-stop --worktree <this worktree> --old <oldHead from step 1> --reason/);
});
