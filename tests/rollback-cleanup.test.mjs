// Issue #1120: a rolled back install leaves the host as it was, so the same commit can be retried without hand clean-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cleanupFrom, withCleanup } from '../supervisor/rollbackcleanup.mjs';

const H = c => c.repeat(40);
const FROM = H('1'), TO = H('2');
const tools = name => new URL(`../tools/${name}`, import.meta.url).pathname;

function world(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rbclean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), state = path.join(dir, 'state');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(state, 'versions', FROM), { recursive: true });
  fs.symlinkSync(`versions/${FROM}`, path.join(state, 'current'));
  fs.writeFileSync(path.join(bin, `ai-supervisor.before-${TO}`), '#!/usr/bin/env bash\necho old\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ai-supervisor'), '#!/usr/bin/env bash\necho new\n', { mode: 0o755 });
  const env = { ...process.env, AI_SUPERVISOR_BIN_DIR: bin, AI_SUPERVISOR_STATE_DIR: state };
  const versionDir = commit => path.join(state, 'versions', commit);
  const marker = commit => path.join(state, `.created-${commit}`);
  // The swap's directory step, run from the real script the upgrade sources.
  const prepare = commit => spawnSync('bash', ['-c', 'source "$1"; prepare_version_dir "$2" "$3"', 'x', tools('version-dir.sh'), state, commit], { encoding: 'utf8' });
  const rollback = (from, to) => spawnSync('bash', [tools('rollback-supervisor.sh'), '--supervisor', to, from], { encoding: 'utf8', env });
  // The installer made the new version current before the live tick failed.
  const installNew = () => { fs.rmSync(path.join(state, 'current')); fs.symlinkSync(`versions/${TO}`, path.join(state, 'current')); };
  return { state, env, versionDir, marker, prepare, rollback, installNew };
}

test('valid: a rollback removes the version directory its own attempt created', t => {
  const w = world(t);
  assert.equal(w.prepare(TO).status, 0);
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  w.installNew();
  const r = w.rollback(FROM, TO);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cleanup: removed version directory /);
  assert.equal(fs.existsSync(w.versionDir(TO)), false);
  assert.equal(fs.existsSync(w.marker(TO)), false);
  assert.ok(fs.existsSync(w.versionDir(FROM)), 'the restored version is untouched');
});

test('boundary: a directory that existed before the attempt (no marker) is left alone', t => {
  const w = world(t);
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  w.installNew();
  const r = w.rollback(FROM, TO);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cleanup: version directory kept \(it existed before the attempt\)/);
  assert.ok(fs.existsSync(w.versionDir(TO)));
});

test('invalid: the installed version is never removed, even when marked', t => {
  const w = world(t);
  fs.writeFileSync(w.marker(FROM), '');
  fs.copyFileSync(path.join(w.state, '..', 'bin', `ai-supervisor.before-${TO}`), path.join(w.state, '..', 'bin', `ai-supervisor.before-${FROM}`));
  const r = w.rollback(FROM, FROM);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept \(it is the installed version\)/);
  assert.ok(fs.existsSync(w.versionDir(FROM)));
});

test('invalid: a directory a running process uses is kept and the outcome says so', async t => {
  const w = world(t);
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  fs.writeFileSync(w.marker(TO), '');
  w.installNew();
  const holder = spawn('sleep', ['30'], { cwd: w.versionDir(TO), stdio: 'ignore' });
  t.after(() => holder.kill());
  await new Promise(r => setTimeout(r, 100));
  const r = w.rollback(FROM, TO);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept \(in use by a running process\)/);
  assert.ok(fs.existsSync(w.versionDir(TO)));
});

test('regression (20:50 refusal): after a rollback the same commit installs again with no hand clean-up', t => {
  const w = world(t);
  assert.equal(w.prepare(TO).status, 0);
  fs.mkdirSync(path.join(w.versionDir(TO), 'supervisor'), { recursive: true });
  w.installNew();
  assert.equal(w.rollback(FROM, TO).status, 0);
  const again = w.prepare(TO);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(fs.existsSync(w.marker(TO)));
});

test('regression: a leftover that is neither installed nor in use is rebuilt, not refused', t => {
  const w = world(t);
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  fs.writeFileSync(path.join(w.versionDir(TO), 'stale'), 'x');
  const r = w.prepare(TO);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /leftover version directory .* removed; rebuilding/);
  assert.equal(fs.existsSync(w.versionDir(TO)), false, 'the swap then creates it fresh');
});

test('the swap still refuses the installed version, and says a leftover in use is a leftover', async t => {
  const w = world(t);
  const installed = w.prepare(FROM);
  assert.equal(installed.status, 1);
  assert.match(installed.stderr, /already installed \(it is the installed version\)/);
  assert.ok(fs.existsSync(w.versionDir(FROM)));
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  const holder = spawn('sleep', ['30'], { cwd: w.versionDir(TO), stdio: 'ignore' });
  t.after(() => holder.kill());
  await new Promise(r => setTimeout(r, 100));
  const busy = w.prepare(TO);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /left by an earlier attempt is in use by a running process/);
  assert.ok(fs.existsSync(w.versionDir(TO)));
});

test('the install record text carries what the rollback cleaned up', () => {
  assert.equal(cleanupFrom('supervisor restored\ncleanup: removed version directory abc\n'), 'removed version directory abc');
  assert.equal(cleanupFrom('supervisor restored\n'), null);
  assert.equal(cleanupFrom(undefined), null);
  assert.equal(withCleanup('live tick failed', { cleanup: 'removed version directory abc' }), 'live tick failed; removed version directory abc');
  assert.equal(withCleanup("live tick failed", { ok: true }), 'live tick failed');
});

test('rollback note and install record say what was cleaned up, and a failed rollback still says so', async () => {
  const { rollbackNote, rollbackInstall } = await import('../supervisor/rollbackcleanup.mjs');
  const ok = { ok: true, cleanup: 'removed version directory abc' };
  assert.equal(rollbackNote('live tick failed', ok), 'live tick failed; removed version directory abc');
  assert.deepEqual(rollbackInstall(TO, 'n', ok), { result: 'rolled_back', sha: TO, reason: 'n', cleanup: 'removed version directory abc' });
  const bad = { ok: false, reason: 'wrapper backup missing' };
  assert.match(rollbackNote('x', bad), /ROLLBACK FAILED \(wrapper backup missing\)/);
  assert.equal(rollbackInstall(TO, 'n', bad).result, 'rollback_failed');
  assert.equal('cleanup' in rollbackInstall(TO, 'n', bad), false);
});

test('a leftover the swap rebuilt is this attempt\'s own directory: its rollback removes it and the retry installs', t => {
  const w = world(t);
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  fs.writeFileSync(path.join(w.versionDir(TO), 'stale'), 'old');
  const p = w.prepare(TO);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /leftover .* removed; rebuilding/);
  assert.ok(fs.existsSync(w.marker(TO)), 'the rebuilt directory is marked as created by this attempt');
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  w.installNew();
  const r = w.rollback(FROM, TO);
  assert.match(r.stdout, /cleanup: removed version directory /);
  assert.equal(fs.existsSync(w.versionDir(TO)), false);
  assert.equal(fs.existsSync(w.marker(TO)), false);
  assert.equal(w.prepare(TO).status, 0, 'the same commit can be retried');
});

test('invalid: a process started through the current symlink keeps the directory it was running from', async t => {
  const w = world(t);
  assert.equal(w.prepare(TO).status, 0);
  fs.mkdirSync(w.versionDir(TO), { recursive: true });
  w.installNew();
  const holder = spawn('bash', ['-c', 'sleep 30; : "$0"', path.join(w.state, 'current', 'supervisor', 'cli.mjs')], { cwd: os.tmpdir(), stdio: 'ignore' });
  t.after(() => holder.kill());
  await new Promise(r => setTimeout(r, 150));
  const r = w.rollback(FROM, TO);
  assert.match(r.stdout, /kept \(in use by a running process\)/);
  assert.ok(fs.existsSync(w.versionDir(TO)));
  assert.equal(r.stderr, '', 'scanning /proc prints no errors for processes that exit');
});

test('lastInstall shows what the rollback cleaned up', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rbinst-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  const { rollbackInstall } = await import('../supervisor/rollbackcleanup.mjs');
  fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify({ install: { ...rollbackInstall(TO, 'live tick failed', { ok: true, cleanup: 'removed version directory abc' }), at: Date.now() } }));
  const { installs } = await import('../supervisor/installs.mjs');
  assert.equal(installs(root, { running: null }).lastInstall.cleanup, 'removed version directory abc');
});

test('valid: the calling process, running from the directory or the current symlink, does not count as a user of it', t => {
  const w = world(t);
  for (const via of [path.join(w.versionDir(TO), 'supervisor', 'cli.mjs'), path.join(w.state, 'current', 'supervisor', 'cli.mjs')]) {
    assert.equal(w.prepare(TO).status, 0);
    fs.mkdirSync(w.versionDir(TO), { recursive: true });
    w.installNew();
    // The parent shell stands in for the reconcile run: its command line names a file inside the directory.
    const r = spawnSync('bash', ['-c', 'bash "$1" --supervisor "$2" "$3"; : "$0"', via, tools('rollback-supervisor.sh'), TO, FROM], { encoding: 'utf8', env: w.env });
    assert.match(r.stdout, /cleanup: removed version directory/, r.stdout + r.stderr);
    assert.equal(fs.existsSync(w.versionDir(TO)), false);
  }
});

test('the two copies of the in-use scan (swap and rollback) are identical', () => {
  const fn = (file, name) => {
    const text = fs.readFileSync(tools(file), 'utf8');
    const start = text.indexOf(`${name}() {`);
    const indent = text.slice(text.lastIndexOf('\n', start) + 1, start);
    const end = start + text.slice(start).search(/\n *\}\n/) + 1;
    return text.slice(start, end).split('\n').map(l => l.startsWith(indent) ? l.slice(indent.length) : l).join('\n');
  };
  for (const name of ['self_and_ancestors', 'dir_in_use']) {
    assert.ok(fn('version-dir.sh', name).length > 20, name);
    assert.equal(fn('rollback-supervisor.sh', name), fn('version-dir.sh', name), name);
  }
});
