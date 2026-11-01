// Supervisor self-upgrade (issue #47): fake dependencies for every rule, plus real git, real files and the real rollback script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SelfUpgrade, realDeps, runningSha, installedSha, UPGRADER_PATHS, QUIET_MAX_WAIT_MS, MIN_UPGRADE_INTERVAL_MS, VERIFY_MAX_WAIT_MS, ENV_RETRY_MS } from '../supervisor/upgrade.mjs';
import { applyLocalOverride } from '../supervisor/team.mjs';

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
    config,
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
  assert.match(w.alerts()[0], new RegExp(`^Supervisor upgraded to ${TO.slice(0, 7)} \\(PRs #7\\)\\.$`));
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
    'interim PASS while interim review is not enabled': { verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'claude', interim: true } } }
  };
  for (const [name, over] of Object.entries(cases)) {
    const w = world(t, over);
    assert.equal(await w.up.step(), 'not-eligible', name);
    assert.match(w.alerts()[0], /PR #7 has no recorded PASS from the opposite agent/, name);
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
  assert.equal(await w.up.step(), 'upgraded'); assert.match(w.alerts().at(-1), /\(PRs #7, #8\)/);
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

test('upgrader-touching change is refused with the deploy-needed alert, whatever else it contains', async t => {
  for (const file of UPGRADER_PATHS) {
    const w = world(t, { files: ['supervisor/team.mjs', file] });
    assert.equal(await w.up.step(), 'upgrader-changed');
    assert.match(w.alerts()[0], /deploy needed: changes the upgrader/);
    assert.equal(w.log.some(x => ['pre', 'upgrade', 'rollback'].includes(x[0])), false);
    assert.equal(await w.up.step(), 'upgrader-changed'); assert.equal(w.alerts().length, 1);
    assert.equal(w.records()[0].result, 'refused');
    assert.equal(w.up.latch(), null, 'a refusal is not a rollback and must not latch');
  }
  // the self-upgrade code is on the list, and so is the module this test imports
  assert.ok(UPGRADER_PATHS.includes('supervisor/upgrade.mjs'));
  assert.ok(fs.existsSync(new URL('../supervisor/upgrade.mjs', import.meta.url)));
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

test('rate limit: at most one automatic upgrade per hour', async t => {
  const w = world(t);
  assert.equal(await w.up.step(), 'upgraded');
  await w.up.verifyPending({ running: TO, ok: true });
  w.state.installed = TO; w.state.target = H('9'); w.log.length = 0;
  w.state.now += MIN_UPGRADE_INTERVAL_MS - 1;
  assert.equal(await w.up.step(), 'rate-limited'); assert.deepEqual(w.log, []);
  w.state.now += 1;
  assert.equal(await w.make().step(), 'upgraded');
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

test('real checkout: pre-checks run in a detached clean checkout of the target and fail on a failing validator or test', async t => {
  for (const [validator, test_, ok] of [['process.exit(0)', 'import t from "node:test"; t("a",()=>{});', true], ['process.exit(3)', 'import t from "node:test"; t("a",()=>{});', false], ['process.exit(0)', 'import t from "node:test"; import a from "node:assert"; t("a",()=>a.fail("boom"));', false]]) {
    const r = repo(t);
    r.write('tools/validate-project.mjs', validator); r.write('tests/x.test.mjs', test_); r.git('add', '-A'); r.git('commit', '-qm', 'c');
    const sha = r.git('rev-parse', 'HEAD');
    r.write('tests/untracked-local-change.txt', 'dirty'); // the working copy is dirty; the pre-check must not see it
    const deps = realDeps({ root: '/nonexistent', config: { repo_path: r.dir }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {} });
    const res = await deps.preChecks(sha);
    assert.equal(res.ok, ok, JSON.stringify(res));
    if (!ok) assert.match(res.reason, /^(validator|tests):/);
  }
  const r = repo(t); r.write('f', '1'); r.git('add', '-A'); r.git('commit', '-qm', 'c');
  const deps = realDeps({ root: '/nonexistent', config: { repo_path: r.dir }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {} });
  assert.match((await deps.preChecks(H('7'))).reason, /checkout failed/);
});

test('dry-run health check: only a real plan counts, not a lock skip, bad JSON or a non-zero exit', async t => {
  const mk = out => realDeps({ root: '/x', config: { repo_path: '/x' }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {}, wrapper: '/w', run: () => out });
  assert.equal((await mk({ status: 0, stdout: JSON.stringify({ actions: [], skipped: [] }), stderr: '' }).dryRunTick()).ok, true);
  assert.equal((await mk({ status: 0, stdout: JSON.stringify({ skipped: 'another tick is running' }), stderr: '' }).dryRunTick()).ok, false);
  assert.equal((await mk({ status: 0, stdout: 'not json', stderr: '' }).dryRunTick()).ok, false);
  assert.equal((await mk({ status: 2, stdout: '', stderr: 'boom' }).dryRunTick()).ok, false);
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

test('an interim (D-021) PASS from the author counts while interim review is enabled', async t => {
  const w = world(t, { verdicts: { [`7:${H('d')}`]: { verdict: 'PASS', reviewer: 'claude', interim: true } } });
  w.up.d.config = { ...config, interim_review: { enabled: true, decision: 'D-021' } };
  assert.notEqual(await w.up.step(), 'not-eligible');
  assert.ok(w.log.some(x => x[0] === 'pre'));
});

test('issue #69: an environmental pre-check failure is retried after an hour with one alert; a failed check stays latched', async t => {
  const w = world(t, { pre: { ok: false, environmental: true, reason: 'checkout failed: unable to read tree' } });
  assert.equal(await w.up.step(), 'precheck-failed');
  w.state.now += ENV_RETRY_MS - 1; assert.equal(await w.up.step(), 'precheck-failed'); assert.equal(w.log.filter(x => x[0] === 'pre').length, 1);
  w.state.now += 1; w.state.pre = { ok: true };
  assert.equal(await w.up.step(), 'upgraded'); assert.equal(w.alerts().filter(a => /pre-check failed/.test(a)).length, 1);
  const g = world(t, { pre: { ok: false, reason: 'tests: 1 failed' } });
  assert.equal(await g.up.step(), 'precheck-failed'); g.state.now += 10 * ENV_RETRY_MS; g.state.pre = { ok: true };
  assert.equal(await g.up.step(), 'precheck-failed'); assert.equal(g.log.filter(x => x[0] === 'pre').length, 1);
});

test('issue #69: the real pre-check checks out an origin/main commit that the local main is behind', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-git-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), other = path.join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, other]); g(other, 'commit', '-q', '--allow-empty', '-m', 'one'); g(other, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '-q', origin, repo]);
  g(other, 'commit', '-q', '--allow-empty', '-m', 'two'); g(other, 'push', '-q', 'origin', 'HEAD:main');
  // the self-upgrade fetch: origin/main moves, local main stays behind
  g(repo, 'fetch', '-q', 'origin', 'main'); const target = g(repo, 'rev-parse', 'origin/main');
  assert.notEqual(g(repo, 'rev-parse', 'main'), target);
  const run = (cmd, args, opts = {}) => {
    if (cmd === 'node') return { status: 0, stdout: '', stderr: '' };   // validator and tests are not part of this fixture
    const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const deps = realDeps({ root: dir, config: { repo_path: repo, agents: {} }, gh: {}, listActive: async () => [], verdictFor: () => null, run, sendAlert: async () => {} });
  assert.deepEqual(await deps.preChecks(target), { ok: true });
  const missing = await deps.preChecks('f'.repeat(40));
  assert.equal(missing.ok, false); assert.equal(missing.environmental, true); assert.match(missing.reason, /^checkout failed/);
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
    ['upgrader', { files: ['supervisor/upgrade.mjs'] }, 'upgrader-changed'], ['current', { target: FROM }, 'current']]) {
    const w = world(t, over);
    assert.equal(await w.up.step(), want, name); assert.equal(w.up.s.holding, undefined, name);
  }
  const w = world(t, { active: 1 });
  assert.equal(await w.up.step(), 'busy'); w.state.target = FROM;     // main moved back / upgraded by hand: the hold ends
  assert.equal(await w.up.step(), 'current'); assert.equal(w.up.s.holding, undefined);
});
