// Issue #637 (decision D-035 proposed): inbox operation actions: pause or resume new work, restart the dashboard, retry an install, one bounded
// test run, one allowance probe. Fixtures are built at run time, secret-shaped text is assembled from parts, no model is called and no real
// dashboard, git remote or test suite is touched (every effect is a fake).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as inbox from '../supervisor/inbox.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { cloneAndRunTests } from '../supervisor/inboxtests.mjs';
import { checkProposal } from '../foreman-mcp/inbox.mjs';

const tmp = (t, p = 'ops-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
const TOKEN = 'gh' + 'p_' + hex(12), PW = 'pass' + 'word';
const HEAD = 'a1'.repeat(20), REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const act = (action, target, reason = 'the homeowner needs it') => ({ kind: 'action', title: `${action} ${target}`, action, target: String(target), reason });
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });
function world(t, ops = {}, now = { v: 5000 }) {
  const dir = tmp(t, 'inbox-'); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const gh = { prs: [{ number: 9, headRefName: 'claude/issue-9-x', headRefOid: HEAD, isDraft: false, labels: [] }], listPulls: async () => gh.prs, listIssues: async () => [{ number: 5, state: 'OPEN', title: 'Issue five title', body: '', labels: [] }], listMergedPulls: async () => [], getPull: async () => null, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null };
  const team = new Team({ config: cfg, root: stateRoot(tmp(t, 'state-')), gh, jobs, git: { worktreeFor: async () => null }, register: REGISTER, clock: { now: () => now.v }, ops });
  return { dir, team, gh, now };
}
const drop = (w, item) => { const id = hex(16); fs.writeFileSync(path.join(w.dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const run = async (w, item) => { const id = drop(w, item); inbox.scan(w.dir, 1); assert.equal(inbox.decide(w.dir, id, 'approve', 2).ok, true); await w.team.processInbox(rep()); return inbox.statusOf(w.dir, id); };

test('validation: each new action takes only its own target shape; a free-form target, command or extra field is refused (proposal check agrees)', () => {
  const good = [['pause_work', 'new'], ['resume_work', 'new'], ['restart_dashboard', 'dashboard'], ['retry_install', 'install'], ['run_tests', HEAD], ['allowance_probe', 'claude']];
  for (const [a, tg] of good) { assert.equal(inbox.validateItem(act(a, tg)).ok, true, a); assert.equal(checkProposal(act(a, tg)).ok, true, a); }
  const bad = [['pause_work', 'all'], ['restart_dashboard', 'dashboard; rm -rf /'], ['retry_install', '5'], ['run_tests', HEAD.slice(0, 39)], ['run_tests', 'main'], ['run_tests', HEAD.toUpperCase()], ['allowance_probe', 'Claude'], ['allowance_probe', '../x'], ['allowance_probe', 'a'.repeat(31)]];
  for (const [a, tg] of bad) { assert.equal(inbox.validateItem(act(a, tg)).ok, false, `${a} ${tg}`); assert.equal(checkProposal(act(a, tg)).ok, false, `${a} ${tg}`); }
  assert.match(inbox.validateItem({ ...act('run_tests', HEAD), command: 'curl x' }).reason, /unknown field/);
  assert.match(inbox.validateItem({ ...act('pause_work', 'new'), reason: `because ${TOKEN}` }).reason, /secret-shaped/);
  assert.equal(inbox.validateItem(act('pause_work', 'new', '')).ok, false, 'a reason is required');
});

test('nothing runs without the approval click; a pending or rejected item changes nothing', async t => {
  const calls = []; const w = world(t, { restartDashboard: async () => { calls.push('restart'); return { ok: true, restarted: true }; } });
  const id = drop(w, act('restart_dashboard', 'dashboard')); inbox.scan(w.dir, 1);
  await w.team.processInbox(rep()); assert.equal(inbox.statusOf(w.dir, id).state, 'pending');
  const [card] = inbox.pendingCards(w.dir); assert.match(card.will, /stays up|answers/);
  inbox.decide(w.dir, id, 'reject', 3); await w.team.processInbox(rep());
  assert.deepEqual(calls, []); assert.equal(inbox.statusOf(w.dir, id).state, 'rejected');
});

test('pause_work: no implement job and no inbox prompt is planned while paused; resume restores; wrong state is refused; audit logged', async t => {
  const w = world(t);
  assert.ok((await w.team.plan()).some(a => a.type === 'implement'), 'implements before the pause');
  const done = await run(w, act('pause_work', 'new', 'Tower is being rebuilt'));
  assert.equal(done.state, 'done');
  const acts = await w.team.plan();
  assert.equal(acts.some(a => a.type === 'implement'), false);
  assert.match(w.team.pauseText(w.gh.prs), /paused by the homeowner.*Tower is being rebuilt/);
  assert.equal(w.team.inboxNext(), null);
  assert.match((await run(w, act('pause_work', 'new'))).reason, /already paused/);
  assert.ok(w.team.s.unblock.log.some(e => /paused new work/.test(e.what) && e.why.includes('Tower is being rebuilt')));
  assert.equal((await run(w, act('resume_work', 'new'))).state, 'done');
  assert.ok((await w.team.plan()).some(a => a.type === 'implement'));
  assert.match((await run(w, act('resume_work', 'new'))).reason, /not paused/);
});

test('pause_work survives a restart of the supervisor (it lives in the state file)', async t => {
  const w = world(t); await run(w, act('pause_work', 'new'));
  const again = new Team({ config: w.team.c, root: w.team.root, gh: w.gh, jobs: { listActive: async () => [], get: async () => null }, git: { worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 6000 } });
  assert.equal((await again.plan()).some(a => a.type === 'implement'), false);
});

test('restart_dashboard: success needs ok and restarted; a dashboard that does not stay up, or none running, fails the action', async t => {
  const results = [{ ok: true, restarted: true }, { ok: false, fail: 'the dashboard server on abc exited before it answered (the process exited after start)' }, { ok: false, reason: 'no dashboard server was running' }];
  const w = world(t, { restartDashboard: async () => results.shift() });
  assert.equal((await run(w, act('restart_dashboard', 'dashboard'))).state, 'done');
  const bad = await run(w, act('restart_dashboard', 'dashboard')); assert.equal(bad.state, 'failed'); assert.match(bad.reason, /did not stay up.*exited/);
  assert.match((await run(w, act('restart_dashboard', 'dashboard'))).reason, /did not stay up.*no dashboard/);
  assert.match((await run(world(t), act('restart_dashboard', 'dashboard'))).reason, /cannot do that/);
});

test('retry_install: clears the latch and asks for a retry; refused with no latch; a failing op leaves the item failed', async t => {
  const state = { latch: true, log: [] };
  const w = world(t, { retryInstall: async () => { if (!state.latch) throw new Error('no self-upgrade latch is set; nothing to retry'); state.latch = false; state.log.push('cleared'); return 'latch cleared; retry asked'; } });
  const ok = await run(w, act('retry_install', 'install')); assert.equal(ok.state, 'done'); assert.deepEqual(state.log, ['cleared']);
  const no = await run(w, act('retry_install', 'install')); assert.equal(no.state, 'failed'); assert.match(no.reason, /no self-upgrade latch/);
});

test('allowance_probe: only a configured agent, once per five minutes, never past an overage refusal; one probe per approval', async t => {
  const calls = []; let reply = { ok: true, source: 'session-log', windows: [{ type: 'weekly', utilization: 40 }] };
  const now = { v: 1_000_000 }; const w = world(t, { probe: async a => { calls.push(a); return reply; } }, now);
  assert.match((await run(w, act('allowance_probe', 'nobody'))).reason, /unknown agent/); assert.deepEqual(calls, []);
  const ok = await run(w, act('allowance_probe', 'claude')); assert.equal(ok.state, 'done'); assert.match(ok.result, /weekly 40/); assert.equal(calls.length, 1);
  assert.match((await run(w, act('allowance_probe', 'claude'))).reason, /less than five minutes/); assert.equal(calls.length, 1);
  now.v += 5 * 60 * 1000; reply = { ok: false, error: 'overage-risk' };
  const refused = await run(w, act('allowance_probe', 'claude')); assert.equal(refused.state, 'failed'); assert.match(refused.reason, /overage-risk/);
});

test('run_tests: only the head of an open Foreman pull request; the run is bounded, its result is saved and a failing suite fails the action', async t => {
  const seen = []; const out = [{ ok: true, summary: 'exit 0 in 90 s' }, { ok: false, summary: 'failed with exit code 1 after 12 s' }];
  const w = world(t, { runTests: async (sha, pr) => { seen.push([sha, pr]); return out.shift(); } });
  assert.match((await run(w, act('run_tests', 'f'.repeat(40)))).reason, /not the head of an open Foreman pull request/);
  w.gh.prs.push({ number: 10, headRefName: 'feature/other', headRefOid: 'e5'.repeat(20), isDraft: false, labels: [] });
  assert.match((await run(w, act('run_tests', 'e5'.repeat(20)))).reason, /not the head of an open Foreman/, 'a head that is not a Foreman branch is refused');
  assert.deepEqual(seen, [], 'nothing was run for a wrong target');
  const ok = await run(w, act('run_tests', HEAD)); assert.equal(ok.state, 'done'); assert.match(ok.result, /tests passed/); assert.deepEqual(seen, [[HEAD, 9]]);
  const bad = await run(w, act('run_tests', HEAD)); assert.equal(bad.state, 'failed'); assert.match(bad.reason, /tests failed/);
});

// ---- the real runner against a throwaway git repository and a fake test-slot command
function gitRepo(t) {
  const base = tmp(t, 'repo-'), origin = path.join(base, 'origin'), repo = path.join(base, 'repo'), g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.mkdirSync(origin); g(origin, 'init', '-q', '-b', 'main'); g(origin, 'config', 'user.email', 'a@b.c'); g(origin, 'config', 'user.name', 'n');
  fs.writeFileSync(path.join(origin, 'f.txt'), 'one'); g(origin, 'add', '.'); g(origin, 'commit', '-qm', 'one');
  g(base, 'clone', '-q', origin, repo); return { repo, sha: g(origin, 'rev-parse', 'HEAD'), base };
}
test('cloneAndRunTests: a fresh clone at exactly the head, the slot command with a maximum runtime, a saved redacted result, and nothing left behind', async t => {
  const { repo, sha } = gitRepo(t), root = stateRoot(tmp(t, 'state-')), tmpRoot = tmp(t, 'tmproot-'); let seen;
  const fake = async o => { seen = o; assert.equal(fs.readFileSync(path.join(o.cwd, 'f.txt'), 'utf8'), 'one'); return { code: 1, output: `FAIL x\n${PW}=${hex(8)} ${TOKEN}\n`, timedOut: false }; };
  const r = await cloneAndRunTests({ root, repoPath: repo, sha, pr: 9, cli: '/x/cli.mjs', tmpRoot, run: fake, maxMinutes: 7 });
  assert.equal(r.ok, false); assert.match(r.summary, /exit code 1/);
  assert.ok(seen.argv.includes('test-slot') && seen.argv.includes('run') && seen.argv.includes('--no-reuse') && seen.argv[seen.argv.indexOf('--max-minutes') + 1] === '7');
  assert.ok(seen.timeoutMs > 7 * 60000 && seen.timeoutMs < 20 * 60000, 'an outer bound a little above the inner one');
  const file = path.join(root, 'team', 'inbox-test-runs', `${sha}.json`), saved = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(saved).sha, sha); assert.ok(!saved.includes(TOKEN)); assert.ok(!inbox.secretShaped(saved), 'no secret-shaped output in the saved result');
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the clone is removed');
  const ok = await cloneAndRunTests({ root, repoPath: repo, sha, cli: '/x/cli.mjs', tmpRoot, run: async () => ({ code: 0, output: 'ok', timedOut: false }) }); assert.equal(ok.ok, true);
  assert.equal((await cloneAndRunTests({ root, repoPath: repo, sha, cli: '/x/cli.mjs', tmpRoot, run: async () => ({ code: null, output: '', timedOut: true }) })).ok, false, 'a timed-out run is not a pass');
  const adm = await cloneAndRunTests({ root, repoPath: repo, sha, cli: '/x/cli.mjs', tmpRoot, run: async () => ({ code: 3, output: 'waited', timedOut: false }) });
  assert.equal(adm.ok, false); assert.match(adm.summary, /no free test slot or host headroom/, 'admission refusal (exit 3) is reported, not run');
});
test('cloneAndRunTests: a head that cannot be fetched is not run; a malformed head throws', async t => {
  const { repo } = gitRepo(t), root = stateRoot(tmp(t, 'state-')), tmpRoot = tmp(t, 'tmproot-'); let ran = false;
  const r = await cloneAndRunTests({ root, repoPath: repo, sha: 'd4'.repeat(20), cli: '/x', tmpRoot, run: async () => { ran = true; return { code: 0, output: '' }; } });
  assert.equal(r.ok, false); assert.match(r.summary, /not run/); assert.equal(ran, false);
  await assert.rejects(() => cloneAndRunTests({ root, repoPath: repo, sha: 'main', cli: '/x', tmpRoot }), /40-character/);
});
test('outputs: no secret-shaped text reaches the status file when an effect fails with one in its message', async t => {
  const w = world(t, { restartDashboard: async () => { throw new Error(`boom ${TOKEN} ${PW}=${hex(8)}`); } });
  const st = await run(w, act('restart_dashboard', 'dashboard')); assert.equal(st.state, 'failed');
  const blob = fs.readFileSync(path.join(inbox.dirs(w.dir).status, `${st.id}.json`), 'utf8') + fs.readFileSync(inbox.dirs(w.dir).audit, 'utf8') + JSON.stringify(w.team.s.unblock.log);
  assert.ok(!blob.includes(TOKEN)); assert.ok(!inbox.secretShaped(blob.replace(/"hash":"[a-f0-9]+"/g, '')));
});
