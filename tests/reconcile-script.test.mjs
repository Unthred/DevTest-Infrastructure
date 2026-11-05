import { tmpDir } from './helpers/tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const install = new URL('../tools/install-reconcile-user-script.sh', import.meta.url).pathname;
const remove = new URL('../tools/remove-reconcile-user-script.sh', import.meta.url).pathname;
// Run the installer and fail with its own stderr, so a red CI run names the cause instead of a bare "Command failed".
// Fixture executables are written to a temp name, fsynced and closed, then renamed into place, so no write descriptor is open when a spawn execs them.
// Residual window (issue #563): rename keeps the inode, so a child forked by a concurrent async spawn while the temp fd was open still holds it until that child execs (O_CLOEXEC).
// This narrows ETXTBSY but cannot remove it in principle; the retry in runInstall stays as the safety net. Tests here run in sequence with spawnSync, apart from the async flock holder that is already exec'd and so cannot hold a writeExe temp fd, so the window is effectively closed.
function writeExe(file, body) {
  const tmp = `${file}.tmp${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o755);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, file);
}
function runInstall(env) {
  // Issue #480: a freshly written fake executable can be 'Text file busy' (ETXTBSY) while a concurrent spawn still holds its write descriptor.
  // That is a load-only race in the fixture, not an installer defect, so only that exact message is retried (a few times, briefly).
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = spawnSync('bash', [install], { env, encoding: 'utf8' });
    if (r.status === 0 || !/Text file busy/.test(r.stderr || '')) break;
    spawnSync('sleep', ['0.2']);
  }
  assert.equal(r.status, 0, `installer failed (status ${r.status}, signal ${r.signal}, error ${r.error}): ${r.stderr}`);
}
test('User Scripts reconciliation install and rollback preserve all existing schedules', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-cron-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  const existing = { '/existing/script': { script: '/existing/script', frequency: 'custom', id: 'other', custom: '17 6 * * *' } };
  fs.writeFileSync(path.join(root, 'schedule.json'), JSON.stringify(existing));
  fs.writeFileSync(path.join(root, 'customSchedule.cron'), '# Generated cron schedule for user.scripts\n17 6 * * * existing\n');
  const fake = path.join(root, 'fakenode'), fakeCli = path.join(root, 'cli.mjs');
  writeExe(fake, '#!/bin/sh\necho \'{"ok":true,"actions":[]}\'\n'); fs.writeFileSync(fakeCli, '');
  const env = { ...process.env, AI_SUPERVISOR_USER_SCRIPTS_ROOT: root, AI_SUPERVISOR_RECONCILE_TEST: '1', AI_SUPERVISOR_NODE: fake, AI_SUPERVISOR_CLI: fakeCli };
  runInstall(env);
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
  assert.deepEqual(installed['/existing/script'], existing['/existing/script']);
  assert.equal(Object.keys(installed).length, 2);
  const key = path.join(root, 'scripts', 'AI Supervisor Reconcile', 'script');
  assert.equal(installed[key].custom, '*/5 * * * *');
  assert.equal(fs.readFileSync(path.join(root, 'customSchedule.cron'), 'utf8').split('\n').filter(x => x.includes(key)).length, 1);
  execFileSync('bash', [remove], { env, stdio: 'ignore' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8')), existing);
  assert.ok(!fs.existsSync(path.dirname(key)));
});
// ---- issue #35: the generated script must work under cron's empty environment and never fail silently
function cronWorld(t, { nodeBody } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-cron35-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fakebin'), plugin = path.join(root, 'plugin');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  const exe = (name, body) => writeExe(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  exe('gh', 'echo "[]"'); exe('git', 'echo git');
  exe('node', nodeBody || 'case "$2" in reconcile) gh pr list >/dev/null || exit 4; echo \'{"team":{"actions":[]}}\';; team) echo \'{"actions":[]}\';; esac');
  fs.writeFileSync(path.join(root, 'cli.mjs'), '');
  fs.writeFileSync(path.join(plugin, 'schedule.json'), '{}'); fs.writeFileSync(path.join(plugin, 'customSchedule.cron'), '# x\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_SUPERVISOR_USER_SCRIPTS_ROOT: plugin, AI_SUPERVISOR_RECONCILE_TEST: '1',
    AI_SUPERVISOR_NODE: path.join(bin, 'node'), AI_SUPERVISOR_CLI: path.join(root, 'cli.mjs'), AI_SUPERVISOR_LOG: path.join(root, 'logs', 'reconcile.log'), AI_SUPERVISOR_RUN_HOME: root };
  const script = path.join(plugin, 'scripts', 'AI Supervisor Reconcile', 'script');
  const cron = () => spawnSync('env', ['-i', '/bin/bash', script], { encoding: 'utf8' });
  return { root, bin, plugin, env, script, cron, log: env.AI_SUPERVISOR_LOG };
}

test('issue #35 the generated script runs under env -i, finds gh and node through its pinned PATH, and logs every tick', t => {
  const w = cronWorld(t);
  runInstall(w.env);
  const text = fs.readFileSync(w.script, 'utf8');
  assert.match(text, /^PATH=.*fakebin/m); assert.match(text, /^HOME=/m);
  const r = w.cron(); assert.equal(r.status, 0);
  const line = fs.readFileSync(w.log, 'utf8').trim();
  assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ rc=0 \{"team":\{"actions":\[\]\}\}/);
  // the failure that hid for 40 minutes: gh missing from the environment must leave a trace instead of /dev/null
  fs.rmSync(path.join(w.bin, 'gh'));
  w.cron();
  assert.match(fs.readFileSync(w.log, 'utf8').trim().split('\n').at(-1), /rc=[1-9]/);
});

test('issue #35 the log is trimmed only above the threshold, under the lock; an overlapping run still runs and its log write waits for the lock (issue #448)', t => {
  const w = cronWorld(t);
  runInstall(w.env);
  w.cron(); const small = fs.readFileSync(w.log, 'utf8'); w.cron();
  assert.equal(fs.readFileSync(w.log, 'utf8').split('\n').length, small.split('\n').length + 1);     // no trim below threshold
  fs.writeFileSync(w.log, 'old line\n'.repeat(140000));                                           // > 1 MiB
  w.cron();
  const trimmed = fs.readFileSync(w.log, 'utf8');
  assert.ok(trimmed.length < 400000); assert.match(trimmed.trim().split('\n').at(-1), /rc=0/);
  // hold the lock briefly: the run is NOT skipped; its log line is written once the lock is free (never lost, never racing)
  const before = fs.readFileSync(w.log, 'utf8');
  const holder = spawn('flock', [`${w.log}.lock`, 'sleep', '1']);
  t.after(() => holder.kill());
  const deadline = Date.now() + 2000; while (Date.now() < deadline) { const probe = spawnSync('flock', ['-n', `${w.log}.lock`, 'true']); if (probe.status !== 0) break; }
  assert.equal(w.cron().status, 0);
  const after = fs.readFileSync(w.log, 'utf8');
  assert.ok(after.length > before.length, 'the line of the overlapping run was written after the lock was released');
  assert.match(after.trim().split('\n').at(-1), /rc=0 \{"team"/);
});

test('issue #35 installing refuses when a required binary cannot be found for the cron PATH', t => {
  const w = cronWorld(t); fs.rmSync(path.join(w.bin, 'gh'));
  const env = { ...w.env, PATH: path.join(w.bin) + ':/nonexistent' };    // no gh anywhere
  const r = spawnSync('/bin/bash', [install], { env, encoding: 'utf8' });
  if (spawnSync('sh', ['-c', 'command -v gh'], { env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } }).status === 0) return;   // gh is in a default dir on this host
  assert.equal(r.status, 2); assert.match(r.stderr, /required binary not found/);
});

test('issue #35 reconcile exits nonzero when the team tick fails, so the generated script logs a failing rc', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-rc35-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  writeExe(path.join(bin, 'gh'), '#!/bin/sh\necho boom >&2; exit 1\n');
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true }));
  const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, 'reconcile'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_SUPERVISOR_STATE_ROOT: root } });
  assert.match(r.stdout, /"team":\{"error"/); assert.equal(r.status, 1);
});

test('issue #35 reconcile exits nonzero when the tick skips an item, so a failed dispatch is not logged as rc=0', t => {
  const src = fs.readFileSync(new URL('../supervisor/cli.mjs', import.meta.url), 'utf8');
  assert.match(src, /Array\.isArray\(result\.team\?\.skipped\) && result\.team\.skipped\.length\) process\.exitCode = 1/);
});

test('issue #35 an unreadable CLI or non-executable node leaves a failing log line instead of a silent exit', t => {
  const w = cronWorld(t);
  const inst = spawnSync('bash', [install], { env: w.env, encoding: 'utf8' });
  assert.equal(inst.status, 0, `installer failed: ${inst.stderr}`);   // show the installer's own message, not a bare "Command failed"
  const text = fs.readFileSync(w.script, 'utf8');
  const cli = text.match(/^CLI=(.*)$/m)[1].replace(/\\/g, '');
  fs.renameSync(cli, cli + '.hidden');
  w.cron();
  assert.match(fs.readFileSync(w.log, 'utf8').trim().split('\n').at(-1), /rc=127 supervisor cli unreadable/);
  fs.renameSync(cli + '.hidden', cli);
  const node = text.match(/^NODE=(.*)$/m)[1].replace(/\\/g, '');
  fs.chmodSync(node, 0o600);
  w.cron();
  assert.match(fs.readFileSync(w.log, 'utf8').trim().split('\n').at(-1), /rc=127 node not executable/);
});

// ---- issue #40: the enable gate
const verify = new URL('../tools/verify-reconcile-env.sh', import.meta.url).pathname;
const installed = w => fs.existsSync(path.dirname(w.script)) || fs.readFileSync(path.join(w.plugin, 'schedule.json'), 'utf8') !== '{}';
const PLAN = "echo '{\"actions\":[]}'";
// Fails (bad) on the first dry-run tick of a run and gives a plan (good) on later ones; the call count is kept in <log>.n.
const first = (log, bad, good) => `n=$(cat '${log}.n' 2>/dev/null || echo 0); echo $((n+1)) > '${log}.n'; if [ $n = 0 ]; then ${bad}; else ${good}; fi;;`;
// A fake node that records how it was called and fails the named subcommand.
const gateNode = (failOn, log) => [
  `[ "$1" = -e ] && exec '${process.execPath}' "$@"`,     // the gate's own plan check runs on real node
  `echo "$PWD|$HOME|$*|${'$'}{CALLER_MARK:-unset}" >> '${log}'`,
  'case "$2" in',
  'preflight) ' + (failOn === 'preflight' ? "echo '{\"ok\":false}'; exit 3;;" : "echo '{\"ok\":true}';;"),
  'team) ' + ({ tick: 'echo boom >&2; exit 1;;', planbad: "echo '{\"actions\":[]}'; exit 1;;", stray: "echo '{\"x\":1}' >&2; echo '{\"skipped\":\"x\"}'; echo '\"actions\"' >&2;;", nested: "echo '{\"plan\":{\"actions\":[]}}';;", busy: "echo '{\"skipped\":\"another tick is running\",\"actions\":[]}';;", skip: "echo '{\"skipped\":\"another tick is running\"}';;", garbage: 'echo nope;;', flaky: first(log, 'echo boom >&2; exit 1', PLAN), flakyplan: first(log, 'echo nope', PLAN) }[failOn] || "echo '{\"actions\":[]}';;"),
  'esac'].join('\n');

test('issue #40 the gate runs preflight and a dry-run tick under env -i, from a neutral directory, then installs', t => {
  const gl = path.join(tmpDir('gatelog-'), 'gate.log');
  const w = cronWorld(t, { nodeBody: gateNode('none', gl) });
  const env = { ...w.env, GATE_LOG: gl, CALLER_MARK: 'leaked' };
  const r = spawnSync('bash', [install], { env, encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(gl, 'utf8').trim().split('\n').filter(l => /cli\.mjs/.test(l));
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^\/\|.*\|.*cli\.mjs preflight\|unset$/); assert.match(calls[1], /^\/\|.*\|.*cli\.mjs team tick --dry-run\|unset$/);   // cwd /, environment not inherited
  assert.ok(installed(w));
});

for (const [failOn, why] of [['preflight', /preflight/], ['tick', /team tick --dry-run/], ['skip', /no plan returned/], ['garbage', /no plan returned/], ['planbad', /rc=1/], ['stray', /no plan returned/], ['nested', /no plan returned/], ['busy', /tick lock/]]) {
  test(`issue #40 the gate refuses to install when ${failOn} fails, and leaves no schedule behind`, t => {
    const w = cronWorld(t, { nodeBody: gateNode(failOn, os.devNull) });
    const r = spawnSync('bash', [install], { env: { ...w.env, GATE_LOG: path.join(w.root, 'gate.log'), VERIFY_RETRY_DELAY: '0' }, encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, why); assert.match(r.stderr, /no schedule was installed/);
    assert.ok(!installed(w)); assert.equal(fs.readFileSync(path.join(w.plugin, 'customSchedule.cron'), 'utf8'), '# x\n');
  });
}

test('issue #40 the gate script alone: exit 1 on a failing step, 2 on bad arguments or a missing cli, 0 on a real plan', t => {
  const w = cronWorld(t, { nodeBody: gateNode('none', os.devNull) });
  const node = path.join(w.bin, 'node'), cli = path.join(w.root, 'cli.mjs'), env = { ...process.env, GATE_LOG: path.join(w.root, 'g.log') };
  assert.equal(spawnSync('bash', [verify, '/usr/bin:/bin', w.root, node, cli], { env }).status, 0);
  assert.equal(spawnSync('bash', [verify], { env }).status, 2);
  assert.equal(spawnSync('bash', [verify, '/usr/bin:/bin', w.root, node, path.join(w.root, 'missing.mjs')], { env }).status, 2);
  fs.writeFileSync(node, '#!/bin/sh\nexit 1\n');
  assert.equal(spawnSync('bash', [verify, '/usr/bin:/bin', w.root, node, cli], { env }).status, 1);
});

test('issue #40 real cli: preflight names a failing gh, an unreadable register and a missing provider, from any cwd, and exits 3', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-pf40-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  writeExe(path.join(bin, 'gh'), '#!/bin/sh\necho boom >&2; exit 1\n');
  // git: --version style calls succeed, but reading the register from origin/main fails (the false pass at 97f0227)
  writeExe(path.join(bin, 'git'), '#!/bin/sh\ncase "$*" in *show*) exit 42;; *) echo /nonexistent;; esac\n');
  const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, 'preflight'], { cwd: '/', encoding: 'utf8', env: { PATH: bin, HOME: root, AI_SUPERVISOR_STATE_ROOT: root } });
  assert.equal(r.status, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.checks.github, /^failed: gh pr list failed/); assert.match(out.checks.register, /^failed: cannot read docs\/DECISIONS\.md/);
  assert.match(out.checks.git, /^failed/);
  assert.match(out.checks['provider:claude'], /^failed/); assert.match(out.checks['provider:codex'], /^failed/);
});

test('issue #565 the gate accepts a plan when the checker exits without reading stdin (no SIGPIPE under pipefail)', t => {
  const w = cronWorld(t, { nodeBody: ['[ "$1" = -e ] && exit 0', 'case "$2" in preflight) echo \'{"ok":true}\';; team) head -c 300000 /dev/zero | tr \'\\0\' x | sed \'s/^/{"actions":[],"pad":"/;s/$/"}/\';; esac'].join('\n') });
  const node = path.join(w.bin, 'node'), cli = path.join(w.root, 'cli.mjs');
  for (let i = 0; i < 5; i++) assert.equal(spawnSync('bash', [verify, '/usr/bin:/bin', w.root, node, cli], { env: process.env }).status, 0);
});

// ---- issue #581: the plan check keeps its stderr in the failure text and is retried once
test('issue #581 a refused plan names the reason from the plan check, not just "no plan returned"', t => {
  for (const [failOn, reason] of [['skip', /plan check: skipped: another tick is running/], ['nested', /plan check: no actions array/], ['garbage', /plan check: not JSON/]]) {
    const w = cronWorld(t, { nodeBody: gateNode(failOn, os.devNull) });
    const r = spawnSync('bash', [install], { env: { ...w.env, GATE_LOG: path.join(w.root, 'gate.log'), VERIFY_RETRY_DELAY: '0' }, encoding: 'utf8' });
    assert.equal(r.status, 2, failOn); assert.match(r.stderr, reason, failOn);
  }
});
for (const failOn of ['flaky', 'flakyplan']) {
  test(`issue #581 the gate retries the dry-run tick once: a first ${failOn} failure passes, a persistent one still fails`, t => {
    const gl = path.join(tmpDir('gatelog-'), 'gate.log');
    const w = cronWorld(t, { nodeBody: gateNode(failOn, gl) });
    const r = spawnSync('bash', [install], { env: { ...w.env, GATE_LOG: gl, VERIFY_RETRY_DELAY: '0' }, encoding: 'utf8', cwd: os.tmpdir() });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(gl + '.n', 'utf8').trim(), '2', 'exactly one retry');
    assert.ok(installed(w));
  });
}
test('issue #581 a tick that always fails is attempted exactly twice', t => {
  const gl = path.join(tmpDir('gatelog-'), 'gate.log');
  const body = gateNode('tick', gl).replace('echo boom >&2; exit 1;;', `echo x >> '${gl}.c'; echo boom >&2; exit 1;;`);
  const w = cronWorld(t, { nodeBody: body });
  const r = spawnSync('bash', [install], { env: { ...w.env, GATE_LOG: gl, VERIFY_RETRY_DELAY: '0' }, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /boom/);
  assert.equal(fs.readFileSync(gl + '.c', 'utf8').trim().split('\n').length, 2);
});
