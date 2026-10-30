import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const install = new URL('../tools/install-reconcile-user-script.sh', import.meta.url).pathname;
const remove = new URL('../tools/remove-reconcile-user-script.sh', import.meta.url).pathname;
test('User Scripts reconciliation install and rollback preserve all existing schedules', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-cron-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  const existing = { '/existing/script': { script: '/existing/script', frequency: 'custom', id: 'other', custom: '17 6 * * *' } };
  fs.writeFileSync(path.join(root, 'schedule.json'), JSON.stringify(existing));
  fs.writeFileSync(path.join(root, 'customSchedule.cron'), '# Generated cron schedule for user.scripts\n17 6 * * * existing\n');
  const env = { ...process.env, AI_SUPERVISOR_USER_SCRIPTS_ROOT: root, AI_SUPERVISOR_RECONCILE_TEST: '1' };
  execFileSync('bash', [install], { env, stdio: 'ignore' });
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
const verify = new URL('../tools/verify-reconcile-env.sh', import.meta.url).pathname;
function cronWorld(t, { nodeBody } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-cron35-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fakebin'), plugin = path.join(root, 'plugin');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  exe('gh', 'echo "[]"'); exe('git', 'echo git');
  exe('node', nodeBody || 'case "$2" in preflight) command -v gh >/dev/null || exit 3; echo \'{"preflight":{"gh":"ok"}}\';; team) gh pr list >/dev/null || exit 5;; reconcile) gh pr list >/dev/null || exit 4; echo \'{"team":{"actions":[]}}\';; esac');
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
  execFileSync('bash', [install], { env: w.env, stdio: 'ignore' });
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

test('issue #35 the log is trimmed only above the threshold, under the lock; an overlapping run skips instead of racing', t => {
  const w = cronWorld(t);
  execFileSync('bash', [install], { env: w.env, stdio: 'ignore' });
  w.cron(); const small = fs.readFileSync(w.log, 'utf8'); w.cron();
  assert.equal(fs.readFileSync(w.log, 'utf8').split('\n').length, small.split('\n').length + 1);     // no trim below threshold
  fs.writeFileSync(w.log, 'old line\n'.repeat(140000));                                           // > 1 MiB
  w.cron();
  const trimmed = fs.readFileSync(w.log, 'utf8');
  assert.ok(trimmed.length < 400000); assert.match(trimmed.trim().split('\n').at(-1), /rc=0/);
  // hold the lock: the script must not touch the log
  const before = fs.readFileSync(w.log, 'utf8');
  const holder = spawn('flock', [`${w.log}.lock`, 'sleep', '3']);
  t.after(() => holder.kill());
  const deadline = Date.now() + 2000; while (Date.now() < deadline) { const probe = spawnSync('flock', ['-n', `${w.log}.lock`, 'true']); if (probe.status !== 0) break; }
  assert.equal(w.cron().status, 0); assert.equal(fs.readFileSync(w.log, 'utf8'), before);
});

test('issue #35 enable gate: the preflight runs under env -i with the pinned PATH, and a failure schedules nothing', t => {
  const w = cronWorld(t);
  execFileSync('bash', [install], { env: { ...w.env, AI_SUPERVISOR_VERIFY: '1' }, stdio: 'ignore' });
  assert.equal(spawnSync('bash', [verify, w.script], { encoding: 'utf8' }).status, 0);
  // negative: preflight fails in the cron environment (here, gh not visible there) -> installer refuses, no schedule written
  const bad = cronWorld(t, { nodeBody: 'case "$2" in preflight) echo \'{"preflight":{"codex":"not_found"}}\'; exit 3;; esac' });
  const r = spawnSync('bash', [install], { env: { ...bad.env, AI_SUPERVISOR_VERIFY: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 3); assert.match(r.stderr, /nothing was scheduled/);
  assert.equal(fs.readFileSync(path.join(bad.plugin, 'schedule.json'), 'utf8'), '{}');
  assert.ok(!fs.existsSync(path.dirname(bad.script)));
});

test('issue #35 installing refuses when a required binary cannot be found for the cron PATH', t => {
  const w = cronWorld(t); fs.rmSync(path.join(w.bin, 'gh'));
  const env = { ...w.env, PATH: path.join(w.bin) + ':/nonexistent' };    // no gh anywhere
  const r = spawnSync('/bin/bash', [install], { env, encoding: 'utf8' });
  if (spawnSync('sh', ['-c', 'command -v gh'], { env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } }).status === 0) return;   // gh is in a default dir on this host
  assert.equal(r.status, 2); assert.match(r.stderr, /required binary not found/);
});

test('issue #35 enable gate also runs a dispatcher tick: preflight passing but the tick failing schedules nothing', t => {
  const bad = cronWorld(t, { nodeBody: 'case "$2" in preflight) echo ok;; team) echo tick failed >&2; exit 5;; esac' });
  const r = spawnSync('bash', [install], { env: { ...bad.env, AI_SUPERVISOR_VERIFY: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 3); assert.match(r.stderr, /nothing was scheduled/);
  assert.equal(fs.readFileSync(path.join(bad.plugin, 'schedule.json'), 'utf8'), '{}');
});

test('issue #35 reconcile exits nonzero when the team tick fails, so the generated script logs a failing rc', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-rc35-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho boom >&2; exit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true }));
  const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, 'reconcile'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_SUPERVISOR_STATE_ROOT: root } });
  assert.match(r.stdout, /"team":\{"error"/); assert.equal(r.status, 1);
});

test('issue #35 preflight passes the configured product repository, not the caller cwd, to the provider preflight', t => {
  const src = fs.readFileSync(new URL('../supervisor/cli.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("command === 'preflight'"), src.indexOf("command === 'reconcile'"));
  assert.doesNotMatch(block, /process\.cwd\(\)/); assert.match(block, /loadTeamConfig\(teamConfigFile, root\)\.repo_path/);
  // behavioural: run from a non-repository directory with a fake governed codex that demands the configured repo path
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-pf35-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'elsewhere'); fs.mkdirSync(cwd);
  const r = spawnSync(process.execPath, [new URL('../supervisor/cli.mjs', import.meta.url).pathname, 'preflight'], { cwd, encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root } });
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(cwd));
});

test('issue #35 an unreadable CLI or non-executable node leaves a failing log line instead of a silent exit', t => {
  const w = cronWorld(t);
  execFileSync('bash', [install], { env: w.env, stdio: 'ignore' });
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
