// Issue #469: a worker limit per suite, a configured temp root, cleanup after failure or kill, and a safe sweep of leftovers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { withTestConcurrency, testEnv, sweepTestTemp, suiteKey, findPass, recordPass, TEST_PREFIXES, DEFAULT_TEST_CONCURRENCY } from '../supervisor/testenv.mjs';
import { validateTeamConfig, reviewPrompt, fixPrompt } from '../supervisor/team.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-469-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
const helper = new URL('./helpers/tmp.mjs', import.meta.url).pathname;
const base = () => JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
const old = (dir, hours) => { const when = new Date(Date.now() - hours * 3600000); fs.utimesSync(dir, when, when); };

test('the worker limit is added to node --test, once, and only to node --test', () => {
  assert.deepEqual(withTestConcurrency(['node', '--test', 'a'], 3), ['node', '--test', '--test-concurrency=3', 'a']);
  assert.deepEqual(withTestConcurrency(['/usr/bin/node', '--test', '--test-concurrency=7', 'a'], 3), ['/usr/bin/node', '--test', '--test-concurrency=7', 'a'], 'an explicit value wins');
  assert.deepEqual(withTestConcurrency(['git', 'status'], 3), ['git', 'status']);
  assert.deepEqual(withTestConcurrency(['node', 'script.mjs'], 3), ['node', 'script.mjs']);
  assert.deepEqual(withTestConcurrency(['node', '--test'], 0), ['node', '--test'], 'a bad value is ignored');
  assert.ok(DEFAULT_TEST_CONCURRENCY >= 1);
});

test('limits.test_concurrency (1 to 32) and test_tmp_root (absolute) are validated', () => {
  const b = base();
  for (const bad of [0, 33, 1.5, '4']) assert.throws(() => validateTeamConfig({ ...b, limits: { ...b.limits, test_concurrency: bad } }), /test_concurrency/);
  validateTeamConfig({ ...b, limits: { ...b.limits, test_concurrency: 4 } });
  for (const bad of ['relative/dir', 7]) assert.throws(() => validateTeamConfig({ ...b, test_tmp_root: bad }), /test_tmp_root/);
  assert.equal(validateTeamConfig({ ...b, test_tmp_root: '/mnt/cache/tmp' }).test_tmp_root, '/mnt/cache/tmp');
});

test('the configured temp root is used by the child (TMPDIR), created if missing; an unusable root is ignored', t => {
  const d = tmp(t), root = path.join(d, 'cache', 'tmp');
  const env = testEnv({ A: '1', TMPDIR: '/tmp' }, root);
  assert.equal(env.TMPDIR, root); assert.ok(fs.statSync(root).isDirectory()); assert.equal(env.A, '1');
  assert.equal(testEnv({ TMPDIR: '/tmp' }, undefined).TMPDIR, '/tmp');
  assert.equal(testEnv({ TMPDIR: '/tmp' }, 'relative').TMPDIR, '/tmp');
  fs.writeFileSync(path.join(d, 'file'), 'x');
  assert.equal(testEnv({ TMPDIR: '/tmp' }, path.join(d, 'file', 'sub')).TMPDIR, '/tmp', 'a path under a file cannot be made');
});

test('test-slot run applies the worker limit and the temp root end to end', t => {
  const state = tmp(t), tmpRoot = path.join(tmp(t), 'cachetmp');
  fs.writeFileSync(path.join(state, 'team.local.json'), JSON.stringify({ limits: { test_concurrency: 2 }, test_tmp_root: tmpRoot }));
  const fake = path.join(state, 'bin', 'node'); fs.mkdirSync(path.dirname(fake));   // stands in for node: prints its arguments and TMPDIR
  fs.writeFileSync(fake, '#!/bin/sh\necho "ARGS $*"\necho "TMP $TMPDIR"\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, '--', fake, '--test', 'tests/x.test.mjs'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ARGS --test --test-concurrency=2 tests\/x\.test\.mjs/);
  assert.ok(r.stdout.includes('TMP ' + tmpRoot));
  assert.ok(fs.existsSync(tmpRoot));
});

test('cleanup after failure: helper directories are removed when the process ends with a failure', t => {
  const out = tmp(t), script = path.join(out, 's.mjs');
  fs.writeFileSync(script, `import { tmpDir } from ${JSON.stringify(helper)}; import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(out, 'made'))}, tmpDir('foreman-469-leak-')); process.exit(1);`);
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, TMPDIR: out } });
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(fs.readFileSync(path.join(out, 'made'), 'utf8')), false, 'removed although the process failed');
});

test('cleanup after a kill: SIGTERM removes helper directories', async t => {
  const out = tmp(t), script = path.join(out, 's.mjs');
  fs.writeFileSync(script, `import { tmpDir } from ${JSON.stringify(helper)}; import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(out, 'made'))}, tmpDir('foreman-469-kill-')); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, TMPDIR: out }, stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', r));
  for (let i = 0; i < 100 && !fs.existsSync(path.join(out, 'made')); i++) await new Promise(r => setTimeout(r, 50));
  const made = fs.readFileSync(path.join(out, 'made'), 'utf8'); assert.ok(fs.existsSync(made));
  child.kill('SIGTERM'); await exited;
  assert.equal(fs.existsSync(made), false);
});

test('no test makes a bare temp directory in the files that used to leak (they use the tracked helper)', () => {
  for (const f of ['broker', 'naming', 'decision-governance', 'reconcile-script']) {
    const src = fs.readFileSync(new URL(`./${f}.test.mjs`, import.meta.url), 'utf8');
    assert.match(src, /helpers\/tmp\.mjs/, f);
    for (const line of src.split('\n').filter(l => /mkdtempSync/.test(l))) assert.match(line + (src.split('\n')[src.split('\n').indexOf(line) + 1] || ''), /t\.after|rmSync/, `${f}: ${line.trim().slice(0, 80)}`);
  }
});

test('the sweep removes only old directories with the tests\' prefixes and records them', t => {
  const root = tmp(t), state = tmp(t), log = path.join(state, 'sweeps.jsonl');
  const mk = (name, hours) => { const d = path.join(root, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), 'x'); old(d, hours); return d; };
  const oldTest = mk('supervisor-regress-aaa', 30), newTest = mk('supervisor-regress-bbb', 1), other = mk('someone-elses-dir', 30), brk = mk('devtest-broker-zzz', 48);
  const file = path.join(root, 'nm-file'); fs.writeFileSync(file, 'x'); old(file, 48);
  const res = sweepTestTemp({ tmpRoot: root, ageHours: 24, logFile: log });
  assert.deepEqual(res.removed.sort(), ['devtest-broker-zzz', 'supervisor-regress-aaa']);
  assert.equal(fs.existsSync(oldTest), false); assert.equal(fs.existsSync(brk), false);
  assert.ok(fs.existsSync(newTest), 'too new'); assert.ok(fs.existsSync(other), 'not a test prefix'); assert.ok(fs.existsSync(file), 'not a directory');
  const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim()); assert.deepEqual(rec.removed.sort(), res.removed.sort());
  assert.ok(TEST_PREFIXES.includes('gatelog-'));
});

test('the sweep dry run removes nothing, and a directory a process uses as its cwd is kept', async t => {
  const root = tmp(t), d = path.join(root, 'hr-clone-busy'), e = path.join(root, 'hr-clone-idle');
  fs.mkdirSync(d); fs.mkdirSync(e); old(d, 72); old(e, 72);
  const dry = sweepTestTemp({ tmpRoot: root, dryRun: true });
  assert.deepEqual(dry.removed.sort(), ['hr-clone-busy', 'hr-clone-idle']); assert.ok(fs.existsSync(d) && fs.existsSync(e));
  const child = spawn('sleep', ['30'], { cwd: d, stdio: 'ignore' });
  t.after(() => child.kill());
  await new Promise(r => setTimeout(r, 100));
  const res = sweepTestTemp({ tmpRoot: root });
  assert.deepEqual(res.removed, ['hr-clone-idle']); assert.ok(fs.existsSync(d), 'in use as a cwd');
  assert.equal(res.kept.find(k => k.name === 'hr-clone-busy').why, 'in use');
});

test('the sweep keeps a directory with an open file and removes nothing when /proc cannot be read', async t => {
  const root = tmp(t), d = path.join(root, 'gatelog-open');
  fs.mkdirSync(d); const f = path.join(d, 'log'); fs.writeFileSync(f, ''); old(d, 72);
  const child = spawn('sh', ['-c', `exec 3<${JSON.stringify(f)}; exec sleep 30`], { cwd: os.tmpdir(), stdio: 'ignore' });
  t.after(() => child.kill());
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(sweepTestTemp({ tmpRoot: root, dryRun: true }).removed, [], 'open file keeps it');
  child.kill(); await new Promise(r => child.on('exit', r));
  const res = sweepTestTemp({ tmpRoot: root, procDir: path.join(root, 'no-proc') });
  assert.deepEqual(res.removed, []); assert.ok(fs.existsSync(d)); assert.equal(res.skipped.length, 1);
});

test('test-slot sweep needs a root and works from the CLI', t => {
  const state = tmp(t), root = tmp(t);
  const d = path.join(root, 'supervisor-test-x'); fs.mkdirSync(d); old(d, 100);
  assert.notEqual(spawnSync(process.execPath, [cli, 'test-slot', 'sweep', '--state-root', state], { encoding: 'utf8' }).status, 0);
  const r = spawnSync(process.execPath, [cli, 'test-slot', 'sweep', '--dir', root, '--state-root', state], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).removed, 1); assert.equal(fs.existsSync(d), false);
});

// Issue #469: a repeat full suite is skipped only for the exact same clean tree that already passed it.
test('repeat suite: the same clean tree is not run again, a changed tree is, a failed run is never recorded', t => {
  const state = tmp(t), repo = tmp(t), marker = path.join(state, 'runs');
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'f.txt'), '1'); git('add', '.'); git('commit', '-qm', 'one');
  const fake = path.join(state, 'bin', 'node'); fs.mkdirSync(path.dirname(fake));   // stands in for node: counts runs, fails when FAIL is set
  fs.writeFileSync(fake, `#!/bin/sh\necho x >> ${marker}\n[ -n "$FAIL" ] && exit 1\nexit 0\n`, { mode: 0o755 });
  const run = (extra = [], env = {}) => spawnSync(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, ...extra, '--', fake, '--test', 'x'], { cwd: repo, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  const runs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0);
  assert.equal(run([], { FAIL: '1' }).status, 1); assert.equal(runs(), 1);
  assert.equal(run().status, 0); assert.equal(runs(), 2, 'a failed run was not recorded, so this one runs');
  const again = run(); assert.equal(again.status, 0); assert.equal(runs(), 2, 'same tree: not run again'); assert.match(again.stderr, /already passed/);
  assert.equal(run(['--no-reuse']).status, 0); assert.equal(runs(), 3, '--no-reuse forces a run');
  fs.writeFileSync(path.join(repo, 'f.txt'), '2');
  assert.equal(run().status, 0); assert.equal(runs(), 4, 'a dirty tree always runs');
  git('commit', '-qam', 'two'); assert.equal(run().status, 0); assert.equal(runs(), 5, 'a changed tree runs');
  assert.equal(run().status, 0); assert.equal(runs(), 5, 'and is then recorded');
});

test('repeat suite: findPass honours the age limit and a zero setting; test_reuse_hours is validated', t => {
  const file = path.join(tmp(t), 'p.jsonl'), key = { key: 'k', tree: 'a'.repeat(40) }, now = Date.now();
  recordPass(file, key, { now: now - 3 * 3600000 });
  assert.ok(findPass(file, key, { now, maxAgeHours: 4 }));
  assert.equal(findPass(file, key, { now, maxAgeHours: 2 }), null);
  assert.equal(findPass(file, key, { now, maxAgeHours: 0 }), null);
  assert.equal(findPass(file, { key: 'other' }, { now, maxAgeHours: 4 }), null);
  assert.equal(suiteKey(tmp(t), ['node', '--test']), null, 'no git: never reused');
  assert.equal(suiteKey(process.cwd(), ['git', 'status']), null, 'not a node --test suite: never reused');
  const b = base();
  for (const bad of [-1, 721, 1.5]) assert.throws(() => validateTeamConfig({ ...b, limits: { ...b.limits, test_reuse_hours: bad } }), /test_reuse_hours/);
  validateTeamConfig({ ...b, limits: { ...b.limits, test_reuse_hours: 0 } });
});

test('a review prompt never reuses an earlier pass (D-024); fix prompts may', () => {
  const j = { pr: 7, head: 'a'.repeat(40), branch: 'b', repository: 'o/r', inbox: '/x' };
  assert.match(reviewPrompt(j), /test-slot run --no-reuse --/);
  assert.doesNotMatch(fixPrompt(j), /--no-reuse/);
});

// Issue #480: with test_reuse_hours 0 in the configuration nothing could read a pass, so none is computed or recorded; the default still records.
test('repeat suite: test_reuse_hours 0 records no pass and always runs; the default records one', t => {
  const mk = limits => {
    const state = tmp(t), repo = tmp(t), marker = path.join(state, 'runs');
    const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    git('init', '-q'); fs.writeFileSync(path.join(repo, 'f.txt'), '1'); git('add', '.'); git('commit', '-qm', 'one');
    if (limits) fs.writeFileSync(path.join(state, 'team.local.json'), JSON.stringify({ limits }));
    const fake = path.join(state, 'bin', 'node'); fs.mkdirSync(path.dirname(fake));
    fs.writeFileSync(fake, `#!/bin/sh\necho x >> ${marker}\nexit 0\n`, { mode: 0o755 });
    const run = () => spawnSync(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, '--', fake, '--test', 'x'], { cwd: repo, encoding: 'utf8', timeout: 60000 });
    return { state, run, runs: () => fs.readFileSync(marker, 'utf8').trim().split('\n').length, passes: () => fs.existsSync(path.join(state, 'team', 'test-passes.jsonl')) };
  };
  const off = mk({ test_reuse_hours: 0 });
  assert.equal(off.run().status, 0); assert.equal(off.run().status, 0);
  assert.equal(off.runs(), 2, 'reuse off: runs every time'); assert.equal(off.passes(), false, 'reuse off: no pass recorded');
  const on = mk(null);
  assert.equal(on.run().status, 0); assert.equal(on.passes(), true, 'default: pass recorded');
  assert.equal(on.run().status, 0); assert.equal(on.runs(), 1);
});
