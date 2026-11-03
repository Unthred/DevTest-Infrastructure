// Supervisor self-upgrade (issue #47): fake dependencies for every rule, plus real git, real files and the real rollback script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SelfUpgrade, parseTestFailure, realDeps, runningSha, installedSha, BOOTSTRAP_PATHS, envBackoffMs, ENV_RETRY_MAX_MS, QUIET_MAX_WAIT_MS, holdOf, MIN_UPGRADE_INTERVAL_MS, VERIFY_MAX_WAIT_MS, ENV_RETRY_MS } from '../supervisor/upgrade.mjs';
import { DRAIN_DEFAULT_MINUTES, applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';

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
  const make = () => new SelfUpgrade({ root: path.join(dir, 'root'), deps, clock: { now: () => state.now } });
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

test('busy: waits while a job runs, upgrades after 30 minutes or when idle', async t => {
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'busy');
  w.state.now += QUIET_MAX_WAIT_MS - 1;
  assert.equal(await w.up.step(), 'busy'); assert.equal(w.log.length, 0);
  w.state.now += 1;
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.records()[0].checks.quiet, 'forced-after-wait');
  const idle = world(t, { active: 1 });
  assert.equal(await idle.up.step(), 'busy'); idle.state.active = 0;
  assert.equal(await idle.up.step(), 'upgraded'); assert.equal(idle.records()[0].checks.quiet, 'idle');
});

test('pre-check failure: no upgrade, one alert, no repeat of the heavy checks for the same commit, retried for a newer main', async t => {
  const w = world(t, { pre: { ok: false, reason: 'tests: 3 failed' } });
  assert.equal(await w.up.step(), 'precheck-failed');
  assert.match(w.alerts()[0], /pre-check failed \(tests: 3 failed\)/);
  assert.equal(w.log.some(x => x[0] === 'upgrade'), false);
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 1);
  assert.equal(w.records()[0].result, 'precheck_failed');
  w.state.target = H('9'); w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'upgraded');
});

test('issue #101: a change to the bootstrap installer is refused as needs-homeowner, whatever else the range contains', async t => {
  assert.deepEqual(BOOTSTRAP_PATHS, ['tools/bootstrap-install.sh']);
  const w = world(t, { files: ['supervisor/team.mjs', 'tools/bootstrap-install.sh'] });
  assert.equal(await w.up.step(), 'upgrader-changed');
  assert.match(w.alerts()[0], /needs the homeowner: changes the bootstrap installer/);
  assert.equal(w.log.some(x => ['pre', 'upgrade', 'rollback'].includes(x[0])), false);
  assert.equal(await w.up.step(), 'upgrader-changed'); assert.equal(w.alerts().length, 1);
  assert.equal(w.records()[0].result, 'refused');
  assert.equal(w.up.s.install.result, 'needs-homeowner');
  assert.equal(w.up.latch(), null, 'a refusal is not a rollback and must not latch');
});

test('issue #265: the bootstrap refusal is recorded once per target, raises one hand-deploy item and clears when the install moves', async t => {
  const w = world(t, { files: ['supervisor/team.mjs', 'tools/bootstrap-install.sh'] });
  w.deps.remoteUrl = () => 'https://example.invalid/r.git'; w.deps.commitsBehind = () => 4;
  for (let i = 0; i < 5; i++) assert.equal(await w.up.step(), 'upgrader-changed');
  assert.equal(w.records().filter(r => r.result === 'refused').length, 1, 'one record, not one per tick');
  assert.deepEqual(w.up.s.handDeploy, { from: FROM, to: TO, files: ['tools/bootstrap-install.sh'], command: `/root/bin/ai-supervisor self-upgrade hand-install ${TO}`, at: w.up.s.handDeploy.at });
  assert.equal(w.up.s.main.sha, TO); assert.equal(w.up.s.main.behind, 4);
  // survives a restart of the process
  const again = w.make(); assert.equal(await again.step(), 'upgrader-changed'); assert.equal(w.records().length, 1);
  // a newer main is a new target: a new record and a new item
  w.state.target = H('e'); assert.equal(await again.step(), 'upgrader-changed');
  assert.equal(w.records().length, 2); assert.equal(again.s.handDeploy.to, H('e'));
  // the homeowner installs by hand: the installed commit moves and the item clears
  w.state.installed = H('e'); w.state.files = ['docs/x.md'];
  assert.equal(await again.step(), 'current');
  assert.equal(again.s.handDeploy, undefined); assert.equal(again.s.main.behind, 0);
  assert.equal(w.records().length, 2);
});

test('issue #101: a change to the upgrader itself self-installs like any other reviewed change', async t => {
  const w = world(t, { files: ['supervisor/upgrade.mjs', 'tools/upgrade-supervisor.sh', 'tools/rollback-supervisor.sh'] });
  assert.equal(await w.up.step(), 'upgraded');
  assert.deepEqual(w.log.map(x => x[0]), ['pre', 'upgrade', 'dry', 'alert']);
  assert.equal(await w.up.verifyPending({ running: TO, ok: true }), 'verified');
  assert.equal(w.up.s.install.result, 'verified'); assert.equal(w.up.s.install.sha, TO);
  // negative: the same range without a reviewed PASS is still refused (the review gate applies to upgrader changes too)
  const bad = world(t, { files: ['supervisor/upgrade.mjs'], verdicts: {} });
  assert.equal(await bad.up.step(), 'not-eligible'); assert.equal(bad.log.some(x => x[0] === 'upgrade'), false);
});

test('issue #101: a failed post-swap health check of an upgrader change rolls back automatically and records the result', async t => {
  const w = world(t, { files: ['supervisor/upgrade.mjs'], dry: { ok: false, reason: 'dry-run did not run a plan' } });
  assert.equal(await w.up.step(), 'rolled-back');
  assert.deepEqual(w.log.filter(x => x[0] === 'rollback'), [['rollback', FROM, TO]]);
  assert.equal(w.up.s.install.result, 'rolled_back'); assert.ok(w.up.latch());
  // and a live tick that fails after a good dry run also rolls back
  const v = world(t, { files: ['supervisor/upgrade.mjs'] });
  assert.equal(await v.up.step(), 'upgraded');
  assert.equal(await v.up.verifyPending({ running: TO, ok: false, reason: 'boom' }), 'rolled-back');
  assert.equal(v.up.s.install.result, 'rolled_back');
});

test('issue #101: GitHub unreachable is transient: backoff, no latch, one install record, recovers by itself', async t => {
  const w = world(t);
  let down = true; w.deps.fetchMain = () => { if (down) throw new Error('git fetch failed'); return w.state.target; };
  assert.equal(await w.up.step(), 'github-unreachable');
  assert.equal(w.up.s.install.result, 'transient'); assert.equal(w.up.s.install.nextAttemptAt, w.state.now + ENV_RETRY_MS);
  assert.equal(w.up.latch(), null); assert.deepEqual(w.up.s.prechecked, {});
  w.state.now += ENV_RETRY_MS - 1; assert.equal(await w.up.step(), 'github-unreachable'); assert.equal(w.up.s.fetchFailures, 1, 'no new attempt before the backoff ends');
  w.state.now += 1; assert.equal(await w.up.step(), 'github-unreachable'); assert.equal(w.up.s.fetchFailures, 2);
  assert.equal(w.up.s.install.nextAttemptAt, w.state.now + 2 * ENV_RETRY_MS, 'the backoff doubles');
  down = false; w.state.now += 2 * ENV_RETRY_MS;
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.up.s.fetchFailures, undefined);
  assert.equal(w.alerts().filter(a => /unreachable/i.test(a)).length, 0, 'a transient outage raises no alert');
  assert.equal(envBackoffMs(1), ENV_RETRY_MS); assert.equal(envBackoffMs(99), ENV_RETRY_MAX_MS);
});

test('issue #101: a clone failure at install time is retried with backoff, not rolled back and not latched', async t => {
  const w = world(t, { up: { ok: false, environmental: true, reason: 'clone failed' } });
  assert.equal(await w.up.step(), 'precheck-failed');
  assert.equal(w.log.some(x => x[0] === 'rollback'), false); assert.equal(w.up.latch(), null);
  assert.equal(w.up.s.install.result, 'transient'); assert.equal(w.up.s.install.attempts, 1);
  w.state.now += ENV_RETRY_MS; w.state.up = { ok: true };
  w.deps.upgrade = async sha => { w.log.push(['upgrade', sha]); return w.state.up; };
  assert.equal(await w.up.step(), 'upgraded');
});

test('issue #101: a failed validator or test run blocks only that commit, with one alert, until a newer main', async t => {
  const w = world(t, { pre: { ok: false, reason: 'validator: bad' } });
  assert.equal(await w.up.step(), 'precheck-failed'); w.state.now += 100 * ENV_RETRY_MAX_MS;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.alerts().length, 1);
  assert.equal(w.up.s.install.result, 'blocked');
  w.state.target = H('9'); w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'upgraded');
});
test('health check failure at the dry run rolls back, alerts, records and latches', async t => {
  const w = world(t, { dry: { ok: false, reason: 'exit 2' } });
  assert.equal(await w.up.step(), 'rolled-back');
  assert.deepEqual(w.log.map(x => x[0]), ['pre', 'upgrade', 'dry', 'rollback', 'alert']);
  assert.deepEqual(w.log[3], ['rollback', FROM, TO]);
  assert.match(w.alerts()[0], new RegExp(`^Upgrade to ${TO.slice(0, 7)} rolled back: team tick --dry-run failed: exit 2`));
  assert.equal(w.up.s.pending, undefined);
  assert.deepEqual(w.records().map(r => r.result), ['rolled_back']); assert.equal(w.records()[0].checks.dryRun, 'failed');
  assert.ok(w.up.latch());
  // latched: no further automatic upgrade, even for a newer eligible main and after the hour
  w.state.target = H('9'); w.state.now += 10 * MIN_UPGRADE_INTERVAL_MS; w.log.length = 0;
  assert.equal(await w.up.step(), 'latched'); assert.deepEqual(w.log, []);
  assert.equal(await w.make().step(), 'latched', 'the latch survives a restart');
  w.up.clearLatch(); w.state.dry = { ok: true };
  assert.equal(await w.make().step(), 'upgraded');
});

test('upgrade script failure rolls back too', async t => {
  const w = world(t, { up: { ok: false, reason: 'unsafe supervisor directory symlink' } });
  assert.equal(await w.up.step(), 'rolled-back'); assert.match(w.alerts()[0], /upgrade script failed: unsafe supervisor directory symlink/);
  assert.ok(w.up.latch());
});

test('the next live tick failing rolls back; a missing live tick rolls back after an hour', async t => {
  const w = world(t);
  assert.equal(await w.up.step(), 'upgraded');
  assert.equal(await w.up.verifyPending({ running: TO, ok: false, reason: 'gh pr list failed' }), 'rolled-back');
  assert.deepEqual(w.log.slice(-2).map(x => x[0]), ['rollback', 'alert']);
  assert.match(w.alerts().at(-1), /rolled back: live tick failed: gh pr list failed/);
  assert.deepEqual(w.records().map(r => r.result), ['upgraded', 'rolled_back']); assert.equal(w.records()[1].checks.liveTick, 'failed');
  assert.ok(w.up.latch());
  const slow = world(t);
  await slow.up.step();
  slow.state.now += VERIFY_MAX_WAIT_MS - 1;
  assert.equal(await slow.up.verifyPending({ running: FROM, ok: true }), 'awaiting-verification');
  slow.state.now += 1;
  assert.equal(await slow.up.verifyPending({ running: FROM, ok: true }), 'rolled-back');
  assert.match(slow.alerts().at(-1), /no live tick ran under the new version/);
});

test('a failing rollback is reported as such and still latches', async t => {
  const w = world(t, { dry: { ok: false, reason: 'x' }, rb: { ok: false, reason: 'wrapper backup missing' } });
  assert.equal(await w.up.step(), 'rollback-failed');
  assert.match(w.alerts()[0], /ROLLBACK FAILED \(wrapper backup missing\), manual repair needed/);
  assert.equal(w.records()[0].result, 'rollback_failed'); assert.ok(w.up.latch());
});

test('rate limit: a short cooldown (2 minutes) after an install, not an hour (issue #353)', async t => {
  const w = world(t);
  assert.equal(await w.up.step(), 'upgraded');
  await w.up.verifyPending({ running: TO, ok: true });
  w.state.installed = TO; w.state.target = H('9'); w.log.length = 0;
  w.state.now += MIN_UPGRADE_INTERVAL_MS - 1;
  assert.equal(await w.up.step(), 'rate-limited'); assert.deepEqual(w.log, []);
  w.state.now += 1;
  assert.equal(await w.make().step(), 'upgraded');
});

test('issue #353: a second merge installs within minutes of the first verified install, not after an hour', async t => {
  assert.ok(MIN_UPGRADE_INTERVAL_MS <= 5 * 60 * 1000);
  const w = world(t);
  assert.equal(await w.up.step(), 'upgraded');
  await w.up.verifyPending({ running: TO, ok: true });
  w.state.installed = TO; w.state.target = H('9');
  w.state.now += 5 * 60 * 1000;
  assert.equal(await w.make().step(), 'upgraded');
});

test('issue #353: the short cooldown does not bypass verification of an unverified install, or the busy wait', async t => {
  const w = world(t);
  assert.equal(await w.up.step(), 'upgraded');
  w.state.installed = TO; w.state.target = H('9'); w.state.now += 10 * 60 * 1000; w.log.length = 0;
  assert.equal(await w.make().step(), 'awaiting-verification'); assert.deepEqual(w.log, []);
});

test('an alert channel that throws never breaks the upgrade decision, and is not retried every tick', async t => {
  const w = world(t);
  w.deps.alert = async () => { throw new Error('channel down'); };
  assert.equal(await w.up.step(), 'upgraded');
  assert.ok(w.up.s.alerted[`${TO}:upgraded`]);
});

test('install helpers read the version from the current symlink and the running path', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-sym-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(installedSha(dir), null);
  fs.symlinkSync(`versions/${TO}`, path.join(dir, 'current')); assert.equal(installedSha(dir), TO);
  fs.rmSync(path.join(dir, 'current')); fs.symlinkSync('versions/../../etc', path.join(dir, 'current')); assert.equal(installedSha(dir), null);
  assert.equal(runningSha(`/mnt/cache/ai-supervisor/versions/${TO}/supervisor/cli.mjs`), TO);
  assert.equal(runningSha('/mnt/user/projects/x/supervisor/cli.mjs'), null);
});

test('alerts.command is a validated, local-only override', () => {
  const shipped = { enabled: false, limits: {}, agents: {}, depends_on_overrides: {} };
  assert.deepEqual(applyLocalOverride(shipped, { alerts: { command: ['/root/bin/notify', '--channel', 'ai'] } }).alerts, { command: ['/root/bin/notify', '--channel', 'ai'] });
  for (const bad of [{ command: 'notify' }, { command: [] }, { command: ['notify'] }, { command: ['/x', 1] }, { command: ['/x'], webhook: 'u' }, null])
    assert.throws(() => applyLocalOverride(shipped, { alerts: bad }), /alerts\.command/);
});

// ---- real git: range detection, merge/PR parsing, ancestry, clean-checkout pre-checks
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-git-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
  return { dir, git, write };
}
test('real git: PR merges, direct commits, changed files and ancestry are read correctly', t => {
  const r = repo(t);
  r.write('supervisor/a.mjs', '1'); r.write('tools/validate-project.mjs', 'process.exit(0)'); r.git('add', '-A'); r.git('commit', '-qm', 'base');
  const base = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-qb', 'claude/issue-1-x'); r.write('supervisor/a.mjs', '2'); r.git('commit', '-qam', 'work');
  const head = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', 'main'); r.git('merge', '--no-ff', '-qm', 'Merge pull request #12 from o/claude/issue-1-x', 'claude/issue-1-x');
  r.write('docs/direct.md', 'x'); r.git('add', '-A'); r.git('commit', '-qm', 'direct push');
  const tip = r.git('rev-parse', 'HEAD');
  const deps = realDeps({ root: '/nonexistent', config: { repo_path: r.dir }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {} });
  const commits = deps.mainCommits(base, tip);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].pr, 12); assert.equal(commits[0].head, head);
  assert.equal(commits[1].pr, null); assert.equal(commits[1].head, null);
  assert.deepEqual(deps.changedFiles(base, tip).sort(), ['docs/direct.md', 'supervisor/a.mjs']);
  assert.equal(deps.isAncestor(base, tip), true); assert.equal(deps.isAncestor(tip, base), false);
  // the injected-text subject cannot fake a PR number on a non-merge commit
  r.write('docs/e.md', 'x'); r.git('add', '-A'); r.git('commit', '-qm', 'Merge pull request #99 from o/x'); const fake = r.git('rev-parse', 'HEAD');
  assert.equal(deps.mainCommits(tip, fake)[0].pr, null);
});

// A real bootstrap installer run against a bare "GitHub" repository (a file URL), with fixture validator, tests and swap script.
const BOOT = new URL('../tools/bootstrap-install.sh', import.meta.url).pathname;
function remote(t, { validator = 'process.exit(0)', test_ = 'import t from "node:test"; t("a",()=>{});', swap = 'echo swapped > "$SWAP_MARK"' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env }).trim();
  const origin = path.join(dir, 'origin.git'), work = path.join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]); execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), c); };
  write('tools/validate-project.mjs', validator); write('tests/x.test.mjs', test_); write('tools/upgrade-supervisor.sh', swap + '\n'); write('tools/bootstrap-install.sh', fs.readFileSync(BOOT));
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'c'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  return { dir, origin, work, g, write, sha: g(work, 'rev-parse', 'HEAD'), mark: path.join(dir, 'swap.mark') };
}
const boot = (r, mode, url, sha) => spawnSync('bash', [BOOT, mode, url, sha], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, SWAP_MARK: r.mark } });

test('issue #101: bootstrap check/install from a clean remote copy: passes, swaps only on install, ignores local edits', t => {
  const r = remote(t);
  r.write('tests/untracked-local-change.txt', 'dirty'); fs.writeFileSync(path.join(r.work, 'tools/validate-project.mjs'), 'process.exit(9)');   // a dirty local checkout must not matter
  const c = boot(r, 'check', r.origin, r.sha); assert.equal(c.status, 0, c.stderr);
  assert.equal(fs.existsSync(r.mark), false, 'check never swaps');
  const i = boot(r, 'install', r.origin, r.sha); assert.equal(i.status, 0, i.stderr);
  assert.equal(fs.readFileSync(r.mark, 'utf8').trim(), 'swapped');
});

test('issue #101: bootstrap exit codes: failing validator or test = 11, bad usage = 2, swap failure = 13, no swap on failure', t => {
  for (const over of [{ validator: 'process.exit(3)' }, { test_: 'import t from "node:test"; import a from "node:assert"; t("a",()=>a.fail("boom"));' }]) {
    const r = remote(t, over);
    for (const mode of ['check', 'install']) { const x = boot(r, mode, r.origin, r.sha); assert.equal(x.status, 11, x.stderr); }
    assert.equal(fs.existsSync(r.mark), false);
  }
  const r = remote(t);
  assert.equal(boot(r, 'check', r.origin, 'abc').status, 2); assert.equal(boot(r, 'bogus', r.origin, r.sha).status, 2); assert.equal(boot(r, 'check', '', r.sha).status, 2);
  const f = remote(t, { swap: 'exit 5' }); assert.equal(boot(f, 'install', f.origin, f.sha).status, 13);
});

test('issue #101: bootstrap treats an unreachable remote or a missing commit as transient (10)', t => {
  const r = remote(t);
  assert.equal(boot(r, 'check', path.join(r.dir, 'nonexistent.git'), r.sha).status, 10);
  assert.equal(boot(r, 'install', r.origin, 'f'.repeat(40)).status, 10);
  assert.equal(fs.existsSync(r.mark), false);
});

test('issue #101: bootstrap refuses a payload that differs from the reviewed commit (a check that alters the copy)', t => {
  const r = remote(t, { validator: 'import fs from "node:fs"; fs.appendFileSync("tools/upgrade-supervisor.sh", ' + JSON.stringify('echo evil > "$SWAP_MARK"\n') + ');' });
  const x = boot(r, 'install', r.origin, r.sha);
  assert.equal(x.status, 12, x.stderr); assert.match(x.stderr, /differs from the reviewed commit/);
  assert.equal(fs.existsSync(r.mark), false, 'nothing is swapped');
  // positive control for the same shape of repo: an untouched copy installs
  const ok = remote(t); assert.equal(boot(ok, 'install', ok.origin, ok.sha).status, 0);
});

test('issue #101: realDeps runs the bootstrap installer taken from the installed commit against the origin URL and maps its exit codes', async t => {
  const r = remote(t);
  const clone = path.join(r.dir, 'repo'); execFileSync('git', ['clone', '-q', r.origin, clone], { stdio: 'ignore' });
  const root = path.join(r.dir, 'state'); fs.mkdirSync(path.join(root, 'versions'), { recursive: true }); fs.symlinkSync(`versions/${r.sha}`, path.join(root, 'current'));
  const deps = realDeps({ root, config: { repo_path: clone, agents: {} }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {}, run: (cmd, args, o = {}) => {
    const x = spawnSync(cmd, args, { cwd: o.cwd, encoding: 'utf8', env: { ...process.env, SWAP_MARK: r.mark } }); return { status: x.status ?? 1, stdout: x.stdout || '', stderr: x.stderr || '' }; } });
  assert.deepEqual(await deps.preChecks(r.sha), { ok: true });
  const missing = await deps.preChecks('f'.repeat(40)); assert.equal(missing.ok, false); assert.equal(missing.environmental, true);
  assert.deepEqual(await deps.upgrade(r.sha), { ok: true }); assert.equal(fs.existsSync(r.mark), true);
  const bad = remote(t, { validator: 'process.exit(3)' }); const badClone = path.join(bad.dir, 'repo'); execFileSync('git', ['clone', '-q', bad.origin, badClone], { stdio: 'ignore' });
  fs.mkdirSync(path.join(bad.dir, 'state/versions'), { recursive: true }); fs.symlinkSync(`versions/${bad.sha}`, path.join(bad.dir, 'state/current'));
  const d2 = realDeps({ root: path.join(bad.dir, 'state'), config: { repo_path: badClone, agents: {} }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {} });
  const res = await d2.preChecks(bad.sha); assert.equal(res.ok, false); assert.equal(res.environmental, undefined); assert.match(res.reason, /^validator:/);
  // no installed version: nothing to take the bootstrap from, so it refuses rather than guess
  const none = realDeps({ root: path.join(r.dir, 'no-state'), config: { repo_path: clone, agents: {} }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {} });
  assert.equal((await none.preChecks(r.sha)).ok, false);
});
test('dry-run health check: only a real plan counts, not a lock skip, bad JSON or a non-zero exit', async t => {
  const mk = out => realDeps({ root: '/x', config: { repo_path: '/x' }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {}, wrapper: '/w', run: () => out });
  assert.equal((await mk({ status: 0, stdout: JSON.stringify({ actions: [], skipped: [] }), stderr: '' }).dryRunTick()).ok, true);
  assert.equal((await mk({ status: 0, stdout: JSON.stringify({ skipped: 'another tick is running' }), stderr: '' }).dryRunTick()).ok, false);
  assert.equal((await mk({ status: 0, stdout: 'not json', stderr: '' }).dryRunTick()).ok, false);
  assert.equal((await mk({ status: 2, stdout: '', stderr: 'boom' }).dryRunTick()).ok, false);
});

test('dry-run health check retries a failed register read, but not other failures', async () => {
  const seq = outs => { const calls = []; const sleeps = []; const deps = realDeps({ root: '/x', config: { repo_path: '/x' }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {}, wrapper: '/w', sleep: async ms => sleeps.push(ms), run: () => { calls.push(1); return outs[Math.min(calls.length - 1, outs.length - 1)]; } }); return { deps, calls, sleeps }; };
  const regFail = { status: 1, stdout: '', stderr: 'cannot read docs/DECISIONS.md from origin/main' };
  const plan = { status: 0, stdout: JSON.stringify({ actions: [] }), stderr: '' };
  let w = seq([regFail, plan]); assert.equal((await w.deps.dryRunTick()).ok, true); assert.equal(w.calls.length, 2); assert.equal(w.sleeps.length, 1);
  w = seq([regFail]); const bad = await w.deps.dryRunTick(); assert.equal(bad.ok, false); assert.equal(w.calls.length, 3); assert.match(bad.reason, /cannot read docs/);
  w = seq([{ status: 1, stdout: '', stderr: 'boom' }, plan]); assert.equal((await w.deps.dryRunTick()).ok, false); assert.equal(w.calls.length, 1);
});

// ---- the real rollback script against temporary directories
function install(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-rb-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), state = path.join(dir, 'state');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(state, 'versions', FROM), { recursive: true }); fs.mkdirSync(path.join(state, 'versions', TO), { recursive: true });
  fs.symlinkSync(`versions/${TO}`, path.join(state, 'current'));
  fs.writeFileSync(path.join(bin, 'ai-supervisor'), '#!/usr/bin/env bash\necho new\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, `ai-supervisor.before-${TO}`), '#!/usr/bin/env bash\necho old\n', { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'team.local.json'), '{"enabled":true}');
  const run = (...args) => spawnSync('bash', [new URL('../tools/rollback-supervisor.sh', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_BIN_DIR: bin, AI_SUPERVISOR_STATE_DIR: state } });
  return { bin, state, run };
}
test('rollback script --supervisor restores the previous wrapper and version and keeps local configuration', t => {
  const i = install(t);
  const r = i.run('--supervisor', TO, FROM);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readlinkSync(path.join(i.state, 'current')), `versions/${FROM}`);
  assert.match(fs.readFileSync(path.join(i.bin, 'ai-supervisor'), 'utf8'), /echo old/);
  assert.equal(fs.readFileSync(path.join(i.state, 'team.local.json'), 'utf8'), '{"enabled":true}');
  assert.ok(fs.existsSync(path.join(i.state, 'versions', TO)), 'the new version stays for inspection');
});
test('rollback script --supervisor refuses bad input without changing anything', t => {
  const i = install(t);
  for (const args of [['--supervisor'], ['--supervisor', TO], ['--supervisor', 'zz', FROM], ['--supervisor', TO, '../etc'], ['--supervisor', H('3'), FROM], ['--supervisor', TO, H('4')]]) {
    const r = i.run(...args); assert.notEqual(r.status, 0, args.join(' '));
  }
  assert.equal(fs.readlinkSync(path.join(i.state, 'current')), `versions/${TO}`);
  assert.match(fs.readFileSync(path.join(i.bin, 'ai-supervisor'), 'utf8'), /echo new/);
  fs.writeFileSync(path.join(i.bin, `ai-supervisor.before-${TO}`), 'if then\n');   // a corrupt backup must not be installed
  assert.notEqual(i.run('--supervisor', TO, FROM).status, 0);
  assert.match(fs.readFileSync(path.join(i.bin, 'ai-supervisor'), 'utf8'), /echo new/);
  assert.equal(fs.readlinkSync(path.join(i.state, 'current')), `versions/${TO}`);
});
test('rollback script keeps the original single-argument launcher behaviour', t => {
  assert.notEqual(spawnSync('bash', [new URL('../tools/rollback-supervisor.sh', import.meta.url).pathname], { encoding: 'utf8' }).status, 0);
  assert.notEqual(spawnSync('bash', [new URL('../tools/rollback-supervisor.sh', import.meta.url).pathname, 'nothex'], { encoding: 'utf8' }).status, 0);
});

test('a PASS from the author\'s provider counts when it was recorded as independent (a different model, issue #152), and so does an earlier interim PASS', async t => {
  for (const flag of [{ independent: true }, { interim: true }]) {
    const w = world(t, { verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'claude', ...flag } } });
    assert.notEqual(await w.up.step(), 'not-eligible', JSON.stringify(flag));
    assert.ok(w.log.some(x => x[0] === 'pre'));
  }
});

test('review fix (PR #168): an independent same-provider PASS counts only once D-024 is approved; an earlier interim PASS always counts', async t => {
  const v = { verdict: 'PASS', reviewer: 'claude' };
  assert.equal(await world(t, { d024: false, verdicts: { [`7:${H('d')}`]: { ...v, independent: true } } }).up.step(), 'not-eligible');
  assert.notEqual(await world(t, { d024: false, verdicts: { [`7:${H('d')}`]: { ...v, interim: true } } }).up.step(), 'not-eligible');
});

test('issue #69/#101: an environmental pre-check failure is retried with backoff and one alert; a failed check stays latched', async t => {
  const w = world(t, { pre: { ok: false, environmental: true, reason: 'checkout failed: unable to read tree' } });
  assert.equal(await w.up.step(), 'precheck-failed');
  w.state.now += ENV_RETRY_MS - 1; assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 1);
  w.state.now += 1;   // second failure doubles the wait
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 2);
  w.state.now += 2 * ENV_RETRY_MS - 1; assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 2);
  w.state.now += 1; w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.alerts().filter(a => /pre-check failed/.test(a)).length, 1);
  const g = world(t, { pre: { ok: false, reason: 'tests: 1 failed' } });
  assert.equal(await g.up.step(), 'precheck-failed'); g.state.now += 10 * ENV_RETRY_MAX_MS; g.state.pre = { ok: true };
  assert.equal(await g.up.step(), 'precheck-failed'); assert.equal(g.log.filter(x => x[0] === 'pre').length, 1);
});
test('hold (issue #134): busy marks the hold, idle installs with quiet idle and clears it, a forced install records forced-after-wait', async t => {
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'busy'); assert.equal(w.up.s.holding.to, TO); const since = w.up.s.holding.since;
  w.state.now += 1000; assert.equal(await w.up.step(), 'busy'); assert.equal(w.up.s.holding.since, since);
  w.state.active = 0;
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.up.s.holding, undefined);
  assert.equal(w.records()[0].checks.quiet, 'idle');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'root/team/self-upgrade.json'), 'utf8')).holding, undefined);
  const forced = world(t, { active: 1 });
  assert.equal(await forced.up.step(), 'busy'); forced.state.now += QUIET_MAX_WAIT_MS;
  assert.equal(await forced.up.step(), 'upgraded'); assert.equal(forced.records()[0].checks.quiet, 'forced-after-wait'); assert.equal(forced.up.s.holding, undefined);
});

test('hold (issue #134): a failed pre-check, an ineligible range, an upgrader change and nothing pending never hold', async t => {
  for (const [name, over, want] of [
    ['precheck', { pre: { ok: false, reason: 'x' } }, 'precheck-failed'], ['ineligible', { verdicts: {} }, 'not-eligible'],
    ['bootstrap', { files: ['supervisor/team.mjs', 'tools/bootstrap-install.sh'] }, 'upgrader-changed'], ['current', { target: FROM }, 'current']]) {
    const w = world(t, over);
    assert.equal(await w.up.step(), want, name); assert.equal(w.up.s.holding, undefined, name);
  }
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'busy'); w.state.target = FROM;     // main moved back / upgraded by hand: the hold ends
  assert.equal(await w.up.step(), 'current'); assert.equal(w.up.s.holding, undefined);
});

test('a latched failed pre-check never holds dispatch, even with active jobs, and a newer main waits afresh (#134)', async t => {
  const w = world(t, { pre: { ok: false, reason: 'tests: 3 failed' } });
  assert.equal(await w.up.step(), 'precheck-failed');
  w.state.active = 1; w.state.now += 5 * 60 * 1000;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.holding, undefined);
  w.state.now += 31 * 60 * 1000;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.holding, undefined);
  w.state.target = H('9'); w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'busy'); assert.equal(w.up.s.holding.to, H('9'));
});

test('review of PR #162: a newer main during a wait starts a fresh wait instead of inheriting the old start', async t => {
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'busy');
  w.state.now += 29 * 60 * 1000; w.state.target = H('9');
  assert.equal(await w.up.step(), 'busy'); assert.equal(w.up.s.holding.to, H('9'));
  w.state.now += 2 * 60 * 1000;                                  // 31 min after the first target, 2 after the newer one
  assert.equal(await w.up.step(), 'busy');
  w.state.now += 28 * 60 * 1000;                                 // 30 min after the newer target
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.records()[0].checks.quiet, 'forced-after-wait');
  // the same target keeps its original start
  const s = world(t, { active: 1 });
  assert.equal(await s.up.step(), 'busy'); s.state.now += QUIET_MAX_WAIT_MS - 1;
  assert.equal(await s.up.step(), 'busy'); s.state.now += 1;
  assert.equal(await s.up.step(), 'upgraded');
});

test('review of PR #162: an environmental pre-check retry with active jobs holds dispatch again for the drain bound, then retries the check', async t => {
  const w = world(t, { active: 1, pre: { ok: false, environmental: true, reason: 'checkout failed' } });
  assert.equal(await w.up.step(), 'busy');
  w.state.now += QUIET_MAX_WAIT_MS;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.holding, undefined);
  w.state.now += ENV_RETRY_MS - 1;                               // latched inside the retry window: no hold
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.up.s.holding, undefined);
  w.state.now += 1;                                              // window over: held again for the full bound
  assert.equal(await w.up.step(), 'busy'); assert.ok(w.up.s.holding);
  w.state.now += QUIET_MAX_WAIT_MS - 1;
  assert.equal(await w.up.step(), 'busy'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 1);
  w.state.now += 1; w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 2);
});

test('drain (issue #136): the bound is configurable and honoured, the hold records the running count, an install never touches running jobs', async t => {
  const w = world(t, { active: 3 });
  w.up.drainMaxMs = 5 * 60000;
  assert.equal(await w.up.step(), 'busy'); assert.equal(w.up.s.holding.jobs, 3);
  w.state.active = 2; w.state.now += 5 * 60000 - 1;
  assert.equal(await w.up.step(), 'busy'); assert.equal(w.up.s.holding.jobs, 2); assert.equal(w.log.length, 0);
  w.state.now += 1;
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.records()[0].checks.quiet, 'forced-after-wait');
  assert.equal(w.up.s.holding, undefined); assert.equal(w.log.filter(x => x[0] === 'upgrade').length, 1);
  assert.equal(w.log.some(x => x[0] === 'kill' || x[0] === 'stop'), false);   // the dependency set offers no way to stop a job
  // the default bound is the shipped 30 minutes
  assert.equal(world(t).up.drainMaxMs, QUIET_MAX_WAIT_MS);
});

test('drain (issue #136): dispatch resumes after an install failure or rollback (no hold is reported)', async t => {
  for (const over of [{ up: { ok: false, reason: 'x' } }, { dry: { ok: false, reason: 'y' } }]) {
    const w = world(t, { active: 1, ...over });
    assert.equal(await w.up.step(), 'busy'); w.state.active = 0;
    const r = await w.up.step(); assert.equal(r, 'rolled-back'); assert.equal(w.up.s.holding, undefined);
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
test('issue #302: a verifying tick with only a live job\'s lease wait verifies; real faults still fail it', async t => {
  assert.deepEqual(liveTickOutcome({ actions: [], skipped: [], waiting: [{ what: 'review 5 (claude)', reason: 'waiting for job abababab (running)' }] }), { ok: true, reason: null });
  assert.equal(liveTickOutcome({ skipped: [{ what: 'x', reason: 'r', expected: true }] }).ok, true);
  assert.deepEqual(liveTickOutcome({ skipped: [{ what: 'x', reason: 'gh failed' }] }), { ok: false, reason: 'gh failed' });
  assert.deepEqual(liveTickOutcome({ error: 'boom' }), { ok: false, reason: 'boom' });
  const w = world(t);
  await w.up.step();
  assert.equal(await w.up.verifyPending({ running: TO, ...liveTickOutcome({ skipped: [], waiting: [{ what: 'review', reason: 'waiting' }] }) }), 'verified');
  assert.equal(w.up.latch(), null);
});

test('issue #302: an upgrade during a running job holds, installs once the job ends, and a repeated rollback is never attempted while latched', async t => {
  const w = world(t, { active: 1 });
  assert.notEqual(await w.up.step(), 'upgraded'); assert.ok(!w.log.some(x => x[0] === 'upgrade'), 'nothing installs while a job runs');
  w.state.active = 0;
  assert.equal(await w.up.step(), 'upgraded');
  assert.equal(await w.up.verifyPending({ running: TO, ok: false, reason: 'boom' }), 'rolled-back');
  assert.ok(w.up.latch());
  const before = w.log.length; w.state.now += 3 * MIN_UPGRADE_INTERVAL_MS;
  assert.equal(await w.up.step(), 'latched');
  assert.equal(w.log.length, before, 'no upgrade, no second rollback and no new alert while latched');
});

test('issue #191: the default drain bound has one source (the team default) and the CLI derives from it', () => {
  assert.equal(QUIET_MAX_WAIT_MS, DRAIN_DEFAULT_MINUTES * 60000);
  assert.match(fs.readFileSync(new URL('../supervisor/cli.mjs', import.meta.url), 'utf8'), /: QUIET_MAX_WAIT_MS/);
  assert.doesNotMatch(fs.readFileSync(new URL('../supervisor/cli.mjs', import.meta.url), 'utf8'), /DRAIN_DEFAULT_MINUTES/);
});

test('issue #191: holding.since is the drain start the bound is measured from, and survives a newer target only as a new drain', async t => {
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'busy'); const start = w.up.s.waitingSince;
  assert.equal(w.up.s.holding.since, start);
  w.state.now += 60000; assert.equal(await w.up.step(), 'busy'); assert.equal(w.up.s.holding.since, start);
  w.state.target = H('e'); w.state.now += 60000; assert.equal(await w.up.step(), 'busy');
  assert.equal(w.up.s.holding.since, w.up.s.waitingSince); assert.equal(w.up.s.holding.since, w.state.now);
});

test('issue #191: only busy and upgraded hold dispatch; rolled-back and every failure hand the team step hold=null', async t => {
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'busy'); assert.deepEqual(holdOf('busy', w.up.s), { to: TO });
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
  w.state.now += 100 * ENV_RETRY_MAX_MS;
  assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(runs, 2); assert.equal(w.alerts().length, 1);   // latched: no third run
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
