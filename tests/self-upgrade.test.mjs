// Supervisor self-upgrade (issue #47): fake dependencies for every rule, plus real git, real files and the real rollback script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { MIN_INSTALL_GAP_MS, SelfUpgrade, parseTestFailure, realDeps, runningSha, installedSha, BOOTSTRAP_PATHS, envBackoffMs, ENV_RETRY_MAX_MS, holdOf, MIN_UPGRADE_INTERVAL_MS, VERIFY_MAX_WAIT_MS, ENV_RETRY_MS, PRECHECK_RETRY_MS } from '../supervisor/upgrade.mjs';
import { applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = { agents: { claude: { branch_prefix: 'claude/' }, codex: { branch_prefix: 'codex/' } } };
const FROM = H('a'), TO = H('b');

function world(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = [];
  const state = { now: 10_000_000, active: 0, files: ['supervisor/team.mjs'], target: TO, installed: FROM,
    commits: [{ sha: H('c'), pr: 7, head: H('d') }], pulls: { 7: { state: 'MERGED', headRefName: 'claude/issue-9-x', headRefOid: H('d'), statusCheckRollup: green } },
    verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'codex' } }, pre: { ok: true }, up: { ok: true }, dry: { ok: true }, rb: { ok: true }, ancestor: true, ...over };
  const deps = {
    config, independenceApproved: () => state.d024 !== false,
    installed: () => state.installed, fetchMain: () => state.target, isAncestor: () => state.ancestor, changedFiles: () => state.files,
    mainCommits: () => state.commits, mergedPull: async n => state.pulls[n] || null, verdict: (pr, head) => state.verdicts[`${pr}:${head}`] || null,
    activeJobs: async () => state.active,
    preChecks: async sha => { log.push(['pre', sha]); return state.pre; },
    upgrade: async sha => { log.push(['upgrade', sha]); return state.up; },
    dryRunTick: async () => { log.push(['dry']); return state.dry; },
    rollback: async (from, to) => { log.push(['rollback', from, to]); return state.rb; },
    alert: async text => { log.push(['alert', text]); }
  };
  const make = () => new SelfUpgrade({ root: path.join(dir, 'root'), deps, clock: { now: () => state.now }, minGapMs: state.gap ?? 0 });
  const records = () => { try { return fs.readFileSync(path.join(dir, 'root/team/upgrades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  return { dir, state, deps, log, make, up: make(), records, alerts: () => log.filter(x => x[0] === 'alert').map(x => x[1]) };
}

test('eligible range: pre-checks, upgrade, dry-run, alert and record; then the live tick verifies it', async t => {
  const w = world(t);
  assert.equal(await w.up.step(), 'upgraded');
  assert.deepEqual(w.log.map(x => x[0]), ['pre', 'upgrade', 'dry', 'alert']);
  assert.deepEqual(w.log[1], ['upgrade', TO]);
  assert.match(w.alerts()[0], new RegExp(`^Supervisor upgraded to ${TO.slice(0, 7)} \\(PR #7\\)\\.$`));
  assert.equal(w.up.s.pending.to, TO);
  assert.deepEqual(w.records().map(r => r.result), ['upgraded']);
  assert.deepEqual(w.records()[0].checks, { eligibility: 'ok', quiet: 'idle', preChecks: 'ok', dryRun: 'ok' });
  // not verified yet: another tick (old version, or a new one before the live tick) does nothing more
  assert.equal(await w.up.step(), 'awaiting-verification');
  assert.equal(await w.up.verifyPending({ running: FROM, ok: true }), 'awaiting-verification');
  assert.equal(await w.up.verifyPending({ running: TO, ok: true }), 'verified');
  assert.equal(w.up.s.pending, undefined);
  assert.deepEqual(w.records().map(r => r.result), ['upgraded', 'verified']);
  assert.equal(w.records()[1].checks.liveTick, 'ok');
  assert.equal(w.up.latch(), null);
});

test('nothing to do: same sha, not-versioned install, no supervisor/ change, installed not an ancestor', async t => {
  let w = world(t, { target: FROM }); assert.equal(await w.up.step(), 'current');
  w = world(t, { installed: null }); assert.equal(await w.up.step(), 'not-versioned');
  w = world(t, { files: ['docs/x.md', 'tests/a.test.mjs'] }); assert.equal(await w.up.step(), 'no-supervisor-change'); assert.deepEqual(w.log, []);
  w = world(t, { ancestor: false }); assert.equal(await w.up.step(), 'diverged'); assert.match(w.alerts()[0], /not an ancestor/);
  assert.equal(w.log.some(x => x[0] === 'upgrade'), false);
});

test('not reviewed: no PASS, PASS from the author, PASS at another head, unknown reviewer, failed PASS all refuse and alert once', async t => {
  const cases = {
    'no verdict': { verdicts: {} },
    'CHANGES verdict': { verdicts: { [`7:${H('d')}`]: { verdict: 'CHANGES', reviewer: 'codex' } } },
    'self review': { verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'claude' } } },
    'PASS at an older head': { verdicts: { [`7:${H('e')}`]: { verdict: 'PASS', reviewer: 'codex' } } },
    'unknown reviewer': { verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'mallory' } } },
    'same-provider PASS not recorded as independent': { verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'claude', job: 'j' } } }
  };
  for (const [name, over] of Object.entries(cases)) {
    const w = world(t, over);
    assert.equal(await w.up.step(), 'not-eligible', name);
    assert.match(w.alerts()[0], /PR #7 has no recorded PASS from an independent reviewer/, name);
    assert.equal(await w.up.step(), 'not-eligible'); assert.equal(w.alerts().length, 1, `${name}: alert repeated`);
    assert.equal(w.log.some(x => ['pre', 'upgrade'].includes(x[0])), false, name);
    assert.equal(w.records()[0].result, 'refused');
  }
  // a direct commit to main, and a PR whose merged head does not match GitHub, are refused as well
  let w = world(t, { commits: [{ sha: H('c'), pr: null, head: null }] });
  assert.equal(await w.up.step(), 'not-eligible'); assert.match(w.alerts()[0], /not a reviewed pull request merge/);
  w = world(t, { pulls: { 7: { state: 'MERGED', headRefName: 'claude/x', headRefOid: H('f'), statusCheckRollup: green } } });
  assert.equal(await w.up.step(), 'not-eligible'); assert.match(w.alerts()[0], /could not be matched/);
  w = world(t, { pulls: { 7: { state: 'MERGED', headRefName: 'feature/x', headRefOid: H('d'), statusCheckRollup: green } } });
  assert.equal(await w.up.step(), 'not-eligible');
});

test('an OPEN or CLOSED PR with a matching head, PASS and green CI is refused', async t => {
  for (const state of ['OPEN', 'CLOSED', undefined]) {
    const w = world(t, { pulls: { 7: { state, headRefName: 'claude/x', headRefOid: H('d'), statusCheckRollup: green } } });
    assert.equal(await w.up.step(), 'not-eligible', String(state)); assert.match(w.alerts()[0], /could not be matched/);
    assert.equal(w.log.some(x => ['pre', 'upgrade'].includes(x[0])), false);
  }
});

test('CI red, pending or absent on the merged head refuses; one bad PR among several refuses all', async t => {
  for (const rollup of [[{ status: 'COMPLETED', conclusion: 'FAILURE' }], [{ status: 'IN_PROGRESS' }], []]) {
    const w = world(t, { pulls: { 7: { state: 'MERGED', headRefName: 'claude/x', headRefOid: H('d'), statusCheckRollup: rollup } } });
    assert.equal(await w.up.step(), 'not-eligible'); assert.match(w.alerts()[0], /CI was not green on PR #7/);
    assert.equal(w.log.some(x => x[0] === 'upgrade'), false);
  }
  const w = world(t, {
    commits: [{ sha: H('1'), pr: 7, head: H('d') }, { sha: H('2'), pr: 8, head: H('e') }],
    pulls: { 7: { state: 'MERGED', headRefName: 'claude/x', headRefOid: H('d'), statusCheckRollup: green }, 8: { state: 'MERGED', headRefName: 'codex/y', headRefOid: H('e'), statusCheckRollup: green } },
    verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'codex' } } });
  assert.equal(await w.up.step(), 'not-eligible'); assert.match(w.alerts()[0], /PR #8/);
  // both reviewed: both PRs are named in the alert
  w.state.verdicts[`8:${H('e')}`] = { verdict: 'PASS', reviewer: 'claude' }; w.up.s.alerted = {};
  assert.equal(await w.up.step(), 'upgraded'); assert.match(w.alerts().at(-1), /\(PR #7, PR #8\)/);
});

test('issue #846: running jobs never delay an install: it goes ahead at once and the record says the jobs continue on their version', async t => {
  const w = world(t, { active: 2 });
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.records()[0].checks.quiet, 'jobs-continue-on-their-version');
  assert.equal(w.up.s.holding, undefined); assert.equal(w.up.s.nextInstall, undefined);
  assert.deepEqual(w.log.map(x => x[0]), ['pre', 'upgrade', 'dry', 'alert']);
  const idle = world(t, { active: 0 });
  assert.equal(await idle.up.step(), 'upgraded'); assert.equal(idle.records()[0].checks.quiet, 'idle');
});

test('issue #846: an install never reports a hold: dispatch is never held for it, and a hold left by an older version is cleared', async t => {
  const w = world(t, { active: 1 });
  w.up.s.holding = { to: TO, since: 1, jobs: 1 }; w.up.s.nextInstall = { to: TO, at: 5, why: 'draining', state: 'draining' };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.up.s.holding, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'root/team/self-upgrade.json'), 'utf8')).holding, undefined);
  assert.deepEqual(holdOf('upgraded', w.up.s), { to: TO });   // only the tick that installs holds, because it still runs the old code
});

test('hold (issue #134): a failed pre-check, an ineligible range, an upgrader change and nothing pending never hold', async t => {
  for (const [name, over, want] of [
    ['precheck', { pre: { ok: false, reason: 'x' } }, 'precheck-failed'], ['ineligible', { verdicts: {} }, 'not-eligible'],
    ['bootstrap', { files: ['supervisor/team.mjs', 'tools/bootstrap-install.sh'] }, 'upgrader-changed'], ['current', { target: FROM }, 'current']]) {
    const w = world(t, over);
    assert.equal(await w.up.step(), want, name); assert.equal(w.up.s.holding, undefined, name);
  }
});

test('a latched failed pre-check never holds dispatch, even with active jobs, and a newer main waits afresh (#134)', async t => {
  const w = world(t, { pre: { ok: false, reason: 'tests: 3 failed' } });
  assert.equal(await w.up.step(), 'precheck-failed');
  w.state.active = 1; w.state.now += 5 * 60 * 1000;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.holding, undefined);
  w.state.now += 20 * 60 * 1000;                                 // inside PRECHECK_RETRY_MS
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.holding, undefined);
  w.state.target = H('9'); w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.records().at(-1).to, H('9'));
});

test('issue #846: a failing install with jobs running rolls back at once and reports no hold', async t => {
  for (const over of [{ up: { ok: false, reason: 'x' } }, { dry: { ok: false, reason: 'y' } }]) {
    const w = world(t, { active: 1, ...over });
    assert.equal(await w.up.step(), 'rolled-back'); assert.equal(w.up.s.holding, undefined);
  }
});

test('drain (issue #136): the drain bound is a validated, overridable team setting', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.equal(validateTeamConfig(applyLocalOverride(shipped, { self_upgrade: { drain_max_minutes: 10 } })).self_upgrade.drain_max_minutes, 10);
  for (const bad of [{ drain_max_minutes: 0 }, { drain_max_minutes: 721 }, { drain_max_minutes: 1.5 }, { drain_max_minutes: '5' }, { other: 1 }, [], null])
    assert.throws(() => validateTeamConfig(applyLocalOverride(shipped, { self_upgrade: bad })), /self_upgrade/);
});

test('issue #101: an install-time test failure blocks only that commit: no rollback, no global latch, one alert, a newer main proceeds', async t => {
  const w = world(t, { up: { ok: false, blocked: true, reason: 'tests: flaky' } });
  assert.equal(await w.up.step(), 'precheck-failed');
  assert.equal(w.log.some(x => x[0] === 'rollback'), false); assert.equal(w.up.latch(), null);
  assert.equal(w.up.s.install.result, 'blocked');
  w.state.now += 5 * 3600000;
  assert.equal(await w.up.step(), 'precheck-failed', 'the same commit stays blocked');
  assert.equal(w.alerts().filter(a => /install-time check failed/.test(a)).length, 1);
});

test('issue #101: realDeps maps install exit codes 11 and 12 to blocked (no rollback), 13 and others to a plain failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-map-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(`versions/${'a'.repeat(40)}`, path.join(dir, 'current'));
  const mk = status => realDeps({ root: dir, config: { repo_path: '/x', agents: {} }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {},
    run: cmd => cmd === 'git' ? { status: 0, stdout: 'x', stderr: '' } : { status, stdout: '', stderr: 'boom' } });
  for (const code of [11, 12]) { const r = await mk(code).upgrade('b'.repeat(40)); assert.equal(r.ok, false); assert.equal(r.blocked, true); assert.equal(r.environmental, undefined); }
  const swap = await mk(13).upgrade('b'.repeat(40)); assert.equal(swap.ok, false); assert.equal(swap.blocked, undefined); assert.equal(swap.environmental, undefined);
  assert.equal((await mk(10).upgrade('b'.repeat(40))).environmental, true);
});

import { liveTickOutcome } from '../supervisor/upgrade.mjs';
test('issue #302 / #846: an upgrade during a running job installs at once, and a repeated rollback is never attempted while latched', async t => {
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'upgraded'); assert.ok(w.log.some(x => x[0] === 'upgrade'), 'the install does not wait for the job');
  assert.equal(await w.up.verifyPending({ running: TO, ok: false, reason: 'boom' }), 'rolled-back');
  assert.ok(w.up.latch());
  const before = w.log.length; w.state.now += 3 * MIN_UPGRADE_INTERVAL_MS;
  assert.equal(await w.up.step(), 'latched');
  assert.equal(w.log.length, before, 'no upgrade, no second rollback and no new alert while latched');
});

test('issue #191 / #846: only an install just made holds dispatch; rolled-back and every failure hand the team step hold=null', async t => {
  const w = world(t, { active: 1 });
  for (const r of ['rolled-back', 'precheck-failed', 'not-eligible', 'current', 'awaiting-verification', 'team-loop-disabled', 'rollback-failed', undefined]) assert.equal(holdOf(r, w.up.s), null, String(r));
  assert.deepEqual(holdOf('upgraded', { pending: { to: TO } }), { to: TO });
});

// Issue #380: a job paused on a usage limit runs no process, so it does not hold an upgrade in drain; its record is untouched.
test('#380: only running or queued jobs hold an upgrade in drain, not a paused_limit job', async () => {
  const jobs = [{ id: 'a', status: 'paused_limit' }];
  const deps = realDeps({ root: '/nonexistent', config, gh: {}, listActive: async () => jobs });
  assert.equal(await deps.activeJobs(), 0);
  jobs.push({ id: 'b', status: 'running' }, { id: 'c', status: 'paused_manual' });
  assert.equal(await deps.activeJobs(), 2);
  assert.deepEqual(jobs.map(j => j.id), ['a', 'b', 'c']);   // nothing was touched
});

// ---- issue #412: failing tests are named, and a failed test run is repeated once in a fresh copy before the commit is latched
const failedTests = (over = {}) => ({ ok: false, blocked: true, kind: 'tests', tests: ['alpha works', 'beta works'], excerpt: 'not ok 2 - alpha works\n  error: boom', reason: 'tests failed: alpha works; beta works', ...over });

test('issue #412: pre-check tests fail then pass: the install goes ahead and the flaky test is recorded by name', async t => {
  const w = world(t); const runs = [failedTests(), { ok: true }];
  w.deps.preChecks = async sha => { w.log.push(['pre', sha]); return runs.shift(); };
  assert.equal(await w.up.step(), 'upgraded');
  assert.deepEqual(w.log.map(x => x[0]), ['pre', 'pre', 'alert', 'upgrade', 'dry', 'alert']);
  assert.match(w.alerts()[0], /flaky: alpha works; beta works/);
  assert.equal(w.up.s.flaky.sha, TO); assert.deepEqual(w.up.s.flaky.tests, ['alpha works', 'beta works']);
  const rec = w.records(); assert.equal(rec[0].result, 'flaky_test'); assert.deepEqual(rec[0].tests, ['alpha works', 'beta works']);
  assert.equal(w.records().find(r => r.result === 'upgraded').checks.preChecks, 'ok-after-retry');
  assert.equal(w.up.s.prechecked[TO], undefined);
});

test('issue #412: pre-check tests fail twice: latched as before, names and excerpt in the record, alert and install state', async t => {
  const w = world(t); let runs = 0;
  w.deps.preChecks = async () => { runs++; return failedTests(); };
  assert.equal(await w.up.step(), 'precheck-failed');
  assert.equal(runs, 2);
  assert.equal(w.up.s.install.result, 'blocked'); assert.equal(w.up.s.install.retried, true);
  assert.deepEqual(w.up.s.install.tests, ['alpha works', 'beta works']); assert.match(w.up.s.install.excerpt, /error: boom/);
  assert.match(w.alerts()[0], /tests failed: alpha works; beta works/);
  assert.equal(w.records()[0].reason, 'tests failed: alpha works; beta works');
  assert.deepEqual(w.records()[0].tests, ['alpha works', 'beta works']); assert.match(w.records()[0].excerpt, /error: boom/); assert.equal(w.records()[0].retried, true);
  assert.match(w.alerts()[0], /error: boom/);
  w.state.now += PRECHECK_RETRY_MS - 1;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(runs, 2); assert.equal(w.alerts().length, 1);   // latched inside the delay: no third run
});

test('issue #412: tests pass the first time: one run only, nothing recorded as flaky', async t => {
  const w = world(t); let runs = 0; w.deps.preChecks = async () => { runs++; return { ok: true }; };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(runs, 1);
  assert.equal(w.up.s.flaky, undefined); assert.equal(w.records().some(r => r.result === 'flaky_test'), false);
});

test('issue #412: a validator failure, a payload refusal and an environmental failure are not repeated', async t => {
  for (const pre of [{ ok: false, blocked: true, reason: 'validator: bad' }, { ok: false, blocked: true, reason: 'refused: payload differs' }, { ok: false, environmental: true, kind: 'tests', reason: 'clone failed' }]) {
    const w = world(t); let runs = 0; w.deps.preChecks = async () => { runs++; return pre; };
    assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(runs, 1);
  }
});

test('issue #412: install-time tests fail then pass: installs; fail then fail: latched with names; no swap in between', async t => {
  let w = world(t); let runs = [failedTests(), { ok: true }];
  w.deps.upgrade = async sha => { w.log.push(['upgrade', sha]); return runs.shift(); };
  assert.equal(await w.up.step(), 'upgraded');
  assert.equal(w.log.filter(x => x[0] === 'upgrade').length, 2); assert.equal(w.up.s.flaky.stage, 'install');
  assert.equal(w.records().find(r => r.result === 'upgraded').checks.installChecks, 'ok-after-retry');
  w = world(t); w.deps.upgrade = async sha => { w.log.push(['upgrade', sha]); return failedTests(); };
  assert.equal(await w.up.step(), 'precheck-failed');
  assert.equal(w.log.filter(x => x[0] === 'upgrade').length, 2); assert.equal(w.log.some(x => x[0] === 'rollback' || x[0] === 'dry'), false);
  assert.equal(w.up.s.install.result, 'blocked'); assert.deepEqual(w.up.s.install.tests, ['alpha works', 'beta works']); assert.equal(w.up.s.lastUpgradeAt, undefined);
  const rec = w.records().find(r => r.result === 'precheck_failed'); assert.deepEqual(rec.tests, ['alpha works', 'beta works']); assert.match(rec.excerpt, /error: boom/); assert.match(w.alerts()[0], /error: boom/);
});

test('issue #412: a latched blocked commit is shown as blocked and holds nothing, even with jobs running', async t => {
  const w = world(t, { pre: failedTests() });
  assert.equal(await w.up.step(), 'precheck-failed');
  w.state.active = 3; w.state.now += 60_000;
  const r = await w.up.step();
  assert.equal(r, 'precheck-failed'); assert.equal(holdOf(r, w.up.s), null);
  assert.equal(w.up.s.holding, undefined); assert.equal(w.up.s.install.result, 'blocked'); assert.match(w.up.s.install.reason, /alpha works/);
  assert.equal(w.up.s.pending, undefined);
});

test('issue #412: the failing-test report is parsed, bounded and redacted; an old installer summary still counts as a test failure', () => {
  const secret = ['gh', 'p_'].join('') + 'a'.repeat(30);
  const out = `tests failed: one; two\n--- excerpt ---\nnot ok 1 - one\n  error: 'token=${secret}'\n` + 'x'.repeat(5000);
  const f = parseTestFailure(out);
  assert.deepEqual(f.tests, ['one', 'two']); assert.ok(!f.excerpt.includes(secret)); assert.ok(f.excerpt.length <= 1600); assert.equal(f.kind, 'tests');
  assert.deepEqual(parseTestFailure('tests: # skipped 0 # todo 0'), { kind: 'tests', tests: [], excerpt: '' });
  assert.equal(parseTestFailure('validator: bad'), null);
});

test('issue #412: realDeps maps the installer report (exit 11) to a named, blocked, test-kind result', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-rd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'versions', FROM), { recursive: true }); fs.symlinkSync(`versions/${FROM}`, path.join(dir, 'current'));
  const run = (cmd, args) => {
    if (cmd === 'git' && args.includes('show')) return { status: 0, stdout: '#!/bin/bash\n', stderr: '' };
    if (cmd === 'git') return { status: 0, stdout: 'https://example.invalid/r.git\n', stderr: '' };
    return { status: 11, stdout: '', stderr: 'tests failed: alpha works; beta works\n--- excerpt ---\nnot ok 2 - alpha works\n' };
  };
  const d = realDeps({ root: dir, config: { repo_path: dir }, gh: {}, listActive: async () => [], verdictFor: () => null, run });
  const r = await d.preChecks(TO);
  assert.equal(r.ok, false); assert.equal(r.blocked, true); assert.equal(r.kind, 'tests');
  assert.deepEqual(r.tests, ['alpha works', 'beta works']); assert.equal(r.reason, 'tests failed: alpha works; beta works'); assert.match(r.excerpt, /not ok 2/);
});

test('issue #448: an unwritable state root makes the install check an environmental failure, not a thrown error', async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slot-blocked-')), 'file'); fs.writeFileSync(blocker, ''); // a root under a plain file cannot hold a slot directory, as any user
  const none = realDeps({ root: blocker, config: { repo_path: '/x', agents: {} }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {} });
  const res = await none.preChecks('a'.repeat(40));
  assert.equal(res.ok, false); assert.equal(res.environmental, true); assert.match(res.reason, /test slot unavailable/);
});

test('issue #488: each refusal kind raises one refusal item, clears when main or the install moves, and environmental failures raise none', async t => {
  const leak = '/mnt/cache/private/dir token=abc123 at 10.1.2.3:8080';
  // not eligible
  let w = world(t, { verdicts: {} });
  assert.equal(await w.up.step(), 'not-eligible');
  assert.equal(w.up.s.refusal.kind, 'not-eligible'); assert.equal(w.up.s.refusal.to, TO);
  const first = w.up.s.refusal.at; w.state.now += 1000; assert.equal(await w.up.step(), 'not-eligible'); assert.equal(w.up.s.refusal.at, first, 'one item per target');
  assert.equal(w.records().at(-1).kind, 'not-eligible');
  // main moves: cleared
  w.state.target = H('e'); w.state.verdicts[`7:${H('d')}`] = { verdict: 'PASS', reviewer: 'codex' };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.up.s.refusal, undefined);
  // diverged
  w = world(t, { ancestor: false });
  assert.equal(await w.up.step(), 'diverged'); assert.equal(w.up.s.refusal.kind, 'diverged');
  await w.up.step(); assert.equal(w.records().filter(r => r.kind === 'diverged').length, 1);
  w.state.installed = H('f'); w.state.ancestor = true; w.state.files = ['docs/x.md'];
  assert.equal(await w.up.step(), 'no-supervisor-change'); assert.equal(w.up.s.refusal, undefined, 'installed commit moved');
  // non-environmental pre-check failure, reason sanitised in state and history
  w = world(t, { pre: { ok: false, reason: `validator failed in ${leak}` } });
  assert.equal(await w.up.step(), 'precheck-failed');
  assert.equal(w.up.s.refusal.kind, 'precheck');
  for (const text of [w.up.s.refusal.reason, w.records().at(-1).reason]) { assert.doesNotMatch(text, /abc123|10\.1\.2\.3|\/mnt\/cache/); assert.match(text, /validator failed/); }
  w.state.target = H('e'); w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.up.s.refusal, undefined);
  // install-time check failure
  w = world(t, { up: { ok: false, blocked: true, reason: `payload check failed ${leak}` } });
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.refusal.kind, 'install-check');
  assert.doesNotMatch(JSON.stringify(w.up.s.refusal) + JSON.stringify(w.records()), /abc123|10\.1\.2\.3|\/mnt\/cache/);
  // environmental failures raise nothing
  w = world(t, { pre: { ok: false, environmental: true, reason: 'GitHub unreachable' } });
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.refusal, undefined);
  w = world(t, { up: { ok: false, environmental: true, reason: 'clean copy failed' } });
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.refusal, undefined);
});

test('issue #488: refusal text hides private hostnames, URLs and their paths', async () => {
  const { refusalText } = await import('../supervisor/upgrade.mjs');
  for (const t of ['validator could not contact tower.lan at http://tower.lan/private/status', 'host nas.home.arpa:8080/x failed', 'see https://example.com/a/b']) {
    const out = refusalText(t);
    assert.doesNotMatch(out, /tower|\.lan|home\.arpa|private\/status|example\.com|\/a\/b/);
  }
  assert.match(refusalText('validator could not contact tower.lan'), /validator could not contact/);
});

test('issue #501: refusal text hides bare host:port tokens and configured local domains, keeps file:line', async () => {
  const { refusalText } = await import('../supervisor/upgrade.mjs');
  for (const t of ['could not reach tower:8123', 'nas.example.com:8080 refused', 'ha.mylab.net failed']) {
    const out = refusalText(t, ['mylab.net', 'nas.example.com']);
    assert.doesNotMatch(out, /tower|nas\.example|mylab/, t);
    assert.match(out, /\[host\]/);
  }
  assert.match(refusalText('see build.mjs:42 error', []), /build\.mjs:42/);
  assert.match(refusalText('open nas.example.com ok', []), /nas\.example\.com/, 'no configured domain: ordinary public name stays');
});

test('issue #489: the no-install path list decides per range; every other path needs an install', async t => {
  const { needsNoInstall, rangeNeedsInstall } = await import('../supervisor/upgrade.mjs');
  assert.equal(rangeNeedsInstall(['tests/a.test.mjs', 'docs/x.md', '.github/workflows/ci.yml', 'tools/ci/v.mjs', 'README.md']), false, 'a test/docs-only range needs none');
  for (const f of ['bin/ai-supervisor', 'supervisor/team.mjs', 'tools/upgrade-supervisor.sh', 'contracts/cli.v1.json', 'package.json', 'src/new.mjs', 'docs/../bin/x', 'sub/README.md']) {
    assert.equal(needsNoInstall(f), false, f);
    assert.equal(rangeNeedsInstall(['tests/a.test.mjs', f]), true, `mixed range with ${f}`);
  }
  assert.equal(rangeNeedsInstall([]), false);
  const w = world(t, { files: ['tests/a.test.mjs', 'bin/ai-supervisor'] });
  assert.notEqual(await w.up.step(), 'no-supervisor-change', 'a range touching bin/ is not skipped');
});

test('issue #581: a commit refused by a failed pre-check is tried once more after PRECHECK_RETRY_MS without main moving, then stays latched', async t => {
  const w = world(t, { pre: { ok: false, reason: 'tests: 2 failed' } });
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 1);
  w.state.now += PRECHECK_RETRY_MS - 1; assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 1, 'inside the delay: no attempt');
  w.state.now += 1; assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 2, 'after the delay: one more attempt');
  w.state.now += 10 * ENV_RETRY_MAX_MS; w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 2, 'the second failure latches until a newer main');
  // positive: the delayed attempt that passes installs
  const g = world(t, { pre: { ok: false, reason: 'tests: 2 failed' } });
  assert.equal(await g.up.step(), 'precheck-failed'); g.state.now += PRECHECK_RETRY_MS; g.state.pre = { ok: true };
  assert.equal(await g.up.step(), 'upgraded');
});

test('issue #606: an environmental outcome does not hand a commit a second delayed retry', async t => {
  const w = world(t, { pre: { ok: false, reason: 'tests: 2 failed' } });
  const pres = () => w.log.filter(x => x[0] === 'pre').length;
  assert.equal(await w.up.step(), 'precheck-failed');
  w.state.now += PRECHECK_RETRY_MS; w.state.pre = { ok: false, environmental: true, reason: 'clone failed' };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(pres(), 2, 'the delayed retry ran and hit an environmental failure');
  w.state.now += 10 * ENV_RETRY_MAX_MS; w.state.pre = { ok: false, reason: 'tests: 2 failed' };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(pres(), 3, 'the environmental retry runs');
  w.state.now += PRECHECK_RETRY_MS * 4; w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(pres(), 3, 'no further delayed retry for the same commit');
});

test('issue #606: the install-time check failure gets one delayed retry, then stays latched', async t => {
  const w = world(t, { up: { ok: false, blocked: true, reason: 'tests: flaky-not' } });
  const n = k => w.log.filter(x => x[0] === k).length;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('upgrade'), 1);
  w.state.now += PRECHECK_RETRY_MS - 1; assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('upgrade'), 1, 'inside the delay: no attempt');
  w.state.now += 1; assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('upgrade'), 2, 'after the delay: one more attempt');
  w.state.now += 10 * ENV_RETRY_MAX_MS; w.state.up = { ok: true };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('upgrade'), 2, 'latched until a newer main');
  const g = world(t, { up: { ok: false, blocked: true, reason: 'x' } });
  assert.equal(await g.up.step(), 'precheck-failed'); g.state.now += PRECHECK_RETRY_MS; g.state.up = { ok: true };
  assert.equal(await g.up.step(), 'upgraded');
});

test('issue #668: an install-time environmental failure on the delayed retry does not hand a commit a second delayed retry', async t => {
  const w = world(t, { pre: { ok: false, reason: 'tests: 2 failed' } });
  const n = k => w.log.filter(x => x[0] === k).length;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('pre'), 1);
  w.state.now += PRECHECK_RETRY_MS; w.state.pre = { ok: true }; w.state.up = { ok: false, environmental: true, reason: 'clean copy failed' };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('upgrade'), 1, 'the delayed retry passed the check and hit an install-time environmental failure');
  w.state.now += 10 * ENV_RETRY_MAX_MS; w.state.up = { ok: false, blocked: true, reason: 'tests: 2 failed' };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('upgrade'), 2, 'the environmental retry runs and is blocked');
  w.state.now += PRECHECK_RETRY_MS * 4; w.state.up = { ok: true };
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(n('upgrade'), 2, 'no further delayed retry for the same commit');
  assert.equal(n('pre'), 3, 'pre-check ran once per attempt, never a further delayed one');
  // positive: a commit that never used its delayed retry still gets it after an install-time environmental failure then a block
  const g = world(t, { up: { ok: false, environmental: true, reason: 'clean copy failed' } });
  assert.equal(await g.up.step(), 'precheck-failed');
  g.state.now += 10 * ENV_RETRY_MAX_MS; g.state.up = { ok: false, blocked: true, reason: 'x' };
  assert.equal(await g.up.step(), 'precheck-failed');
  g.state.now += PRECHECK_RETRY_MS; g.state.up = { ok: true };
  assert.equal(await g.up.step(), 'upgraded');
});

// ---- issue #695: batch installs
const MIN = 60000, GAP = 45 * MIN;
const finished = async (w, steps = 1) => { for (let i = 0; i < steps; i++) { assert.equal(await w.up.step(), 'upgraded'); assert.equal(await w.up.verifyPending({ running: w.state.target, ok: true }), 'verified'); w.state.installed = w.state.target; w.state.target = H((5 + i).toString(16)); w.state.now += 3 * MIN; } };

test('issue #695: within the window with jobs running, jobs start (no hold) and merged work waits; the window passing installs', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  w.state.active = 1;
  assert.equal(await w.up.step(), 'batched'); assert.equal(holdOf('batched', w.up.s), null); assert.equal(w.up.s.holding, undefined);
  assert.equal(w.up.s.nextInstall.state, 'batched'); assert.equal(w.up.s.nextInstall.at, w.up.s.lastFinishedAt + GAP);
  w.state.now += 20 * MIN; assert.equal(await w.up.step(), 'batched'); assert.equal(w.log.filter(x => x[0] === 'upgrade').length, 1);
  w.state.now = w.up.s.lastFinishedAt + GAP;                      // window over, jobs still running: it installs, nothing drains
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.up.s.nextInstall, undefined);
});

test('issue #695: nothing running or planned installs straight away inside the window; planned work or a running job waits', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  assert.equal(await w.up.step(), 'upgraded');                    // idle, nothing planned: no wait
  const p = world(t, { gap: GAP }); await finished(p); p.deps.plannedWork = async () => 2;
  assert.equal(await p.up.step(), 'batched');                     // idle but work is planned: it starts, the install waits
  p.deps.plannedWork = async () => { throw new Error('unreadable'); };
  assert.equal(await p.up.step(), 'upgraded');                    // an unreadable plan counts as none (the old behaviour)
});

test('issue #695: urgent installs skip the wait: a rollback, or the homeowner asking; the urgency is spent by the install', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  w.state.active = 1; assert.equal(await w.up.step(), 'batched');
  w.up.requestInstallNow();
  assert.equal(await w.up.step(), 'upgraded');                    // skips the window, with the job still running
  assert.equal(w.up.s.urgent, undefined);
  // rolled back: after the latch is cleared the next install is not batched
  const b = world(t, { gap: GAP }); await finished(b);
  b.state.dry = { ok: true }; assert.equal(await b.up.step(), 'upgraded');
  assert.equal(await b.up.verifyPending({ running: b.state.target, ok: false, reason: 'boom' }), 'rolled-back');
  assert.equal(b.up.s.urgent.reason, 'the previous install rolled back');
  b.up.clearLatch(); b.state.active = 1; b.state.now += 4 * MIN; b.state.target = H('7');
  assert.equal(await b.up.step(), 'upgraded');                    // inside the window, yet not batched
});

test('issue #695: the window survives a restart, and a gap of 0 disables batching', async t => {
  const w = world(t, { gap: GAP }); await finished(w); w.state.active = 1;
  const again = w.make();                                         // a restarted process reads the same state file
  assert.equal(await again.step(), 'batched'); assert.equal(again.s.lastFinishedAt, w.up.s.lastFinishedAt);
  const legacy = w.make(); delete legacy.s.lastFinishedAt;        // state from before this field: the install start stands in
  assert.equal(await legacy.step(), 'batched');
  const off = w.make(); off.minGapMs = 0; assert.equal(await off.step(), 'upgraded');
});

test('issue #695: self_upgrade.min_install_gap_minutes is validated (0-1440 integers) and defaults to 0 (off)', async t => {
  assert.equal(MIN_INSTALL_GAP_MS, 0); assert.equal(world(t).up.minGapMs, 0);
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.equal(validateTeamConfig(applyLocalOverride(shipped, { self_upgrade: { min_install_gap_minutes: 90 } })).self_upgrade.min_install_gap_minutes, 90);
  assert.equal(validateTeamConfig(applyLocalOverride(shipped, { self_upgrade: { min_install_gap_minutes: 0 } })).self_upgrade.min_install_gap_minutes, 0);
  for (const bad of [-1, 1441, 1.5, '45', null]) assert.throws(() => validateTeamConfig(applyLocalOverride(shipped, { self_upgrade: { min_install_gap_minutes: bad } })), /min_install_gap_minutes/, String(bad));
});

test('issue #708: install-now is refused when current, lapses unspent, and is dropped when main is current', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  // the installed version is main: refused, nothing stored
  w.state.target = w.state.installed; assert.equal(await w.up.step(), 'current');
  const r = w.up.requestInstallNow(); assert.equal(r.ok, false); assert.equal(w.up.s.urgent, undefined);
  // a request while main is ahead is stored with its target and applies
  w.up.noteMain(w.state.installed, H('7')); w.state.target = H('7');
  assert.equal(w.up.requestInstallNow().ok, true); assert.equal(w.up.s.urgent.to, H('7'));
  // it lapses after a day without an install
  w.up.s.urgent.at = w.state.now - 25 * 3600 * 1000;
  assert.equal(w.up.urgentNow(w.state.now), null); assert.equal(w.up.s.urgent, undefined);
  // a rollback's urgency does not lapse
  w.up.s.urgent = { reason: 'the previous install rolled back', at: w.state.now - 48 * 3600 * 1000 };
  assert.ok(w.up.urgentNow(w.state.now));
  // a request left over when main becomes current is dropped by the 'current' step
  const c = world(t, { gap: GAP }); await finished(c); c.up.s.urgent = { reason: 'homeowner request', at: c.state.now }; c.state.target = c.state.installed;
  assert.equal(await c.up.step(), 'current'); assert.equal(c.up.s.urgent, undefined);
});

test('issue #708: a hand-install restarts the batching window and spends a pending install-now', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  w.up.noteMain(w.state.installed, H('7')); w.up.requestInstallNow(); assert.ok(w.up.s.urgent);
  w.state.now += 10 * MIN; const before = w.up.s.lastFinishedAt;
  w.up.noteHandInstalled();
  assert.equal(w.up.s.urgent, undefined); assert.equal(w.up.s.lastFinishedAt, w.state.now); assert.ok(w.up.s.lastFinishedAt > before);
  assert.equal(w.up.batchDueAt(), w.state.now + w.up.minGapMs);
  assert.equal(JSON.parse(fs.readFileSync(w.up.stateFile, 'utf8')).urgent, undefined, 'persisted');
});

test('issue #798: install-now judges against live main, not the last tick; unknown main is refused', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  // the recorded main is the installed one (one tick old), but main has moved: accepted, target is the live main
  w.up.noteMain(w.state.installed, w.state.installed); w.state.target = H('8');
  assert.equal(w.up.requestInstallNow().ok, true); assert.equal(w.up.s.urgent.to, H('8'));
  // live main equals the install although the recorded one is older: refused
  const c = world(t, { gap: GAP }); await finished(c); c.up.noteMain(c.state.installed, H('7')); c.state.target = c.state.installed;
  assert.equal(c.up.requestInstallNow().ok, false); assert.equal(c.up.s.urgent, undefined);
  // fetch fails and nothing recorded: refused rather than stored and dropped later
  const d = world(t, { gap: GAP }); await finished(d); delete d.up.s.main; d.up.save(); d.up.d.fetchMain = () => { throw new Error('offline'); };
  const r = d.up.requestInstallNow(); assert.equal(r.ok, false); assert.match(r.reason, /not known/);
});

test('issue #798: state updates reread under upgrade.lock, keep a tick\'s newer fields, and refuse install-now while the lock is busy', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  let held = false, takes = 0;
  w.up.lock = () => { takes++; if (held) return null; held = true; return () => { held = false; }; };
  w.up.lockSleep = () => {}; w.up.lockWaitMs = 0;
  // a stale in-memory copy must not overwrite what another process saved
  const other = JSON.parse(fs.readFileSync(w.up.stateFile, 'utf8')); other.marker = 'newer'; fs.writeFileSync(w.up.stateFile, JSON.stringify(other));
  w.state.now += MIN; w.up.noteHandInstalled();
  assert.equal(held, false, 'lock released'); assert.ok(takes >= 1);
  const saved = JSON.parse(fs.readFileSync(w.up.stateFile, 'utf8')); assert.equal(saved.marker, 'newer'); assert.equal(saved.lastFinishedAt, w.state.now);
  // busy lock: install-now is refused and changes nothing
  held = true; const r = w.up.requestInstallNow(); assert.equal(r.ok, false); assert.match(r.reason, /upgrade\.lock/); assert.equal(w.up.s.urgent, undefined);
  // busy lock: the hand-install note still lands
  w.state.now += MIN; w.up.noteHandInstalled(); assert.equal(JSON.parse(fs.readFileSync(w.up.stateFile, 'utf8')).lastFinishedAt, w.state.now);
});

test('issue #798: a stale copy does not restore keys another process deleted when the hand-install note lands', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  w.up.s.pending = { sha: H('9') }; w.up.s.refusal = { from: 'x' }; w.up.s.waitingFor = 'y'; w.up.save();
  const other = JSON.parse(fs.readFileSync(w.up.stateFile, 'utf8')); delete other.pending; delete other.refusal; delete other.waitingFor; fs.writeFileSync(w.up.stateFile, JSON.stringify(other));
  w.state.now += MIN; w.up.noteHandInstalled();
  const saved = JSON.parse(fs.readFileSync(w.up.stateFile, 'utf8'));
  for (const k of ['pending', 'refusal', 'waitingFor']) assert.equal(saved[k], undefined, k);
  assert.equal(saved.lastFinishedAt, w.state.now);
});

test('issue #798: status hides a lapsed homeowner request without changing the state, and shows a rollback urgency', async t => {
  const w = world(t, { gap: GAP }); await finished(w);
  w.up.s.urgent = { reason: 'homeowner request', at: w.state.now - 25 * 3600 * 1000 };
  assert.equal(w.up.urgentView(w.state.now), null); assert.ok(w.up.s.urgent, 'state untouched');
  w.up.s.urgent = { reason: 'the previous install rolled back', at: w.state.now - 48 * 3600 * 1000 };
  assert.ok(w.up.urgentView(w.state.now));
});

// ---- issue #846: side-by-side installs, no drain, cleanup of versions nothing names
import { pruneVersions, jobVersions } from '../supervisor/versions.mjs';
const V = c => c.repeat(40);
const OLD = Date.now() - 3600000 * 24;
function versionRoot(t, shas, jobs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ver-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const sha of shas) { const d = path.join(root, 'versions', sha); fs.mkdirSync(path.join(d, 'supervisor'), { recursive: true }); fs.writeFileSync(path.join(d, 'supervisor/cli.mjs'), '//'); fs.utimesSync(d, OLD / 1000, OLD / 1000); }
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
  jobs.forEach((j, i) => fs.writeFileSync(path.join(root, 'jobs', `${i}.json`), JSON.stringify(j)));
  return root;
}
const present = root => fs.readdirSync(path.join(root, 'versions')).sort();

test('issue #846: cleanup removes versions nothing names, and keeps current, last good, and the version a live job names', async t => {
  const root = versionRoot(t, [V('1'), V('2'), V('3'), V('4'), V('5')], [
    { status: 'running', supervisorVersion: V('2') }, { status: 'completed', supervisorVersion: V('3') }, { status: 'paused_limit', supervisorVersion: V('4') }]);
  const w = world(t, {}); w.deps.installed = () => V('1'); w.deps.referencedVersions = () => jobVersions(root);
  const up = new SelfUpgrade({ root, deps: w.deps, clock: { now: () => Date.now() } });
  up.s.lastGood = V('5');
  const out = up.prune();
  assert.deepEqual(out.removed, [V('3')]);                          // only the completed job's version is unreferenced
  assert.deepEqual(present(root), [V('1'), V('2'), V('4'), V('5')]);
  const log = fs.readFileSync(path.join(root, 'team/upgrades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(log.at(-1).result, 'versions_removed'); assert.deepEqual(log.at(-1).removed, [V('3')]);
  // the job ends: its version goes on the next tick; current and the rollback target stay whatever else happens
  fs.writeFileSync(path.join(root, 'jobs/0.json'), JSON.stringify({ status: 'completed', supervisorVersion: V('2') }));
  fs.writeFileSync(path.join(root, 'jobs/2.json'), JSON.stringify({ status: 'stopped', supervisorVersion: V('4') }));
  assert.deepEqual(up.prune().removed.sort(), [V('2'), V('4')]);
  assert.deepEqual(present(root), [V('1'), V('5')]);
  assert.deepEqual(up.prune().removed, []);
});

test('issue #846: a paused or blocked job keeps its version; a pending install keeps both of its versions', async t => {
  const root = versionRoot(t, [V('1'), V('2'), V('3'), V('4'), V('5'), V('6')], [{ status: 'paused_manual', supervisorVersion: V('2') }, { status: 'blocked', supervisorVersion: V('3') }]);
  const w = world(t, {}); w.deps.installed = () => V('1'); w.deps.referencedVersions = () => jobVersions(root);
  const up = new SelfUpgrade({ root, deps: w.deps, clock: { now: () => Date.now() } });
  up.s.lastGood = V('1'); up.s.pending = { from: V('4'), to: V('5') };
  assert.deepEqual(up.prune().removed, [V('6')]);
  assert.deepEqual(present(root), [V('1'), V('2'), V('3'), V('4'), V('5')]);
});

test('issue #846: nothing is removed while the rollback target is unknown or a live job has no recorded version', async t => {
  const root = versionRoot(t, [V('1'), V('2')], []);
  const w = world(t, {}); w.deps.installed = () => V('1'); w.deps.referencedVersions = () => jobVersions(root);
  const up = new SelfUpgrade({ root, deps: w.deps, clock: { now: () => Date.now() } });
  assert.match(up.prune().skipped, /rollback target/); assert.deepEqual(present(root), [V('1'), V('2')]);
  up.s.lastGood = V('1'); fs.writeFileSync(path.join(root, 'jobs/x.json'), JSON.stringify({ status: 'running' }));
  assert.match(up.prune().skipped, /no recorded version/); assert.deepEqual(present(root), [V('1'), V('2')]);
  fs.writeFileSync(path.join(root, 'jobs/x.json'), '{not json');   // an unreadable record counts as a reference
  assert.match(up.prune().skipped, /no recorded version/);
  fs.rmSync(path.join(root, 'jobs/x.json'));
  assert.deepEqual(up.prune().removed, [V('2')]);
});

test('issue #846: pruneVersions never touches a symlink, a fresh directory or a name that is not a full sha', async t => {
  const root = versionRoot(t, [V('1'), V('2')]);
  fs.symlinkSync(path.join(root, 'versions', V('1')), path.join(root, 'versions', V('a')));
  fs.mkdirSync(path.join(root, 'versions', 'notasha')); fs.mkdirSync(path.join(root, 'versions', V('b')));   // fresh: mtime is now
  fs.symlinkSync('versions/' + V('1'), path.join(root, 'current'));
  const out = pruneVersions({ root, keep: new Set([V('1')]) });
  assert.deepEqual(out.removed, [V('2')]);
  assert.deepEqual(present(root), ['notasha', V('1'), V('a'), V('b')].sort());
  assert.equal(fs.readlinkSync(path.join(root, 'current')), 'versions/' + V('1'));
});

test('issue #846: a verified install records the previous version as the rollback target; a rollback does not move it', async t => {
  const w = world(t, {}); await w.up.step();
  assert.equal(await w.up.verifyPending({ running: TO, ok: true }), 'verified'); assert.equal(w.up.s.lastGood, FROM);
});

test('issue #846: a job started before an install finishes from its own version and its record is read by the new one', async t => {
  // The worker records the directory it runs from; the new version keeps it, reads the same record, and the old worker keeps running there.
  const root = versionRoot(t, [V('1'), V('2')], [{ status: 'running', supervisorVersion: V('1'), id: 'a' }]);
  const w = world(t, { active: 1 }); w.deps.installed = () => V('2'); w.deps.referencedVersions = () => jobVersions(root);
  const up = new SelfUpgrade({ root, deps: w.deps, clock: { now: () => Date.now() } }); up.s.lastGood = V('2');
  assert.deepEqual(up.prune().removed, []);                          // V1 is not current and not the rollback target, but a running job is on it
  assert.ok(fs.existsSync(path.join(root, 'versions', V('1'), 'supervisor/cli.mjs')));
  const job = JSON.parse(fs.readFileSync(path.join(root, 'jobs/0.json'), 'utf8')); assert.equal(job.supervisorVersion, V('1'));   // the new version reads the record as is
  fs.writeFileSync(path.join(root, 'jobs/0.json'), JSON.stringify({ ...job, status: 'completed' }));   // the old worker finished and saved its verdict
  assert.deepEqual(up.prune().removed, [V('1')]);
});

test('issue #846: the wait shown on the dashboard is a rule, never a clock time, and none is shown when nothing waits', async t => {
  const w = world(t, { verdicts: {} });                              // not reviewed
  assert.equal(await w.up.step(), 'not-eligible');
  assert.equal(w.up.s.nextInstall.at, null); assert.match(w.up.s.nextInstall.why, /independent PASS review with green CI/);
  w.state.verdicts[`7:${H('d')}`] = { verdict: 'PASS', reviewer: 'codex' }; w.up.s.alerted = {};
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.up.s.nextInstall, undefined);
  assert.equal(await w.up.step(), 'awaiting-verification'); assert.match(w.up.s.nextInstall.why, /verified/);
  assert.equal(await w.up.verifyPending({ running: TO, ok: true }), 'verified');
  w.state.installed = TO; w.state.now += 3 * MIN_UPGRADE_INTERVAL_MS; assert.equal(await w.up.step(), 'current'); assert.equal(w.up.s.nextInstall, undefined);
});

test('issue #846: the worker stamps the install directory it runs from on its job record', () => {
  const src = fs.readFileSync(new URL('../supervisor/cli.mjs', import.meta.url), 'utf8');
  assert.match(src, /job\.supervisorVersion = runningSha\(self\) \|\| 'source'/);
  assert.equal(runningSha(`/x/versions/${V('a')}/supervisor/cli.mjs`), V('a')); assert.equal(runningSha('/repo/supervisor/cli.mjs'), null);
});
