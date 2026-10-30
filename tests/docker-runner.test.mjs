import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { buildPlanForVerifiedPaths, cleanupContainer, containerState, createPlan, dockerEnvironment, ownedContainer, prepareDirectories, runContainer, validateLock } from '../docker/runner.mjs';

const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-docker-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), storage = path.join(root, 'storage');
  fs.mkdirSync(project); fs.mkdirSync(storage, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  const spec = { project, runId: 'abcdef0123456789', image: 'dotnet-8', command: ['dotnet', '--version'] };
  const config = { allowedProjects: [project], storageRoot: storage, lock, uid: process.getuid() || 1000, gid: process.getgid() || 1000,
    limits: { cpus: 1, memoryMb: 512, pids: 64, shmMb: 64, timeoutMs: 30000, diskMb: 16, cacheMb: 16 } };
  return { root, project, storage, spec, config, plan: () => buildPlanForVerifiedPaths(spec, config, project, storage) };
}

test('locked official images have exact digests and unknown or malformed entries fail', () => {
  assert.equal(Object.keys(validateLock(lock).images).length, 4);
  for (const value of ['sha256:abc', `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`]) {
    const bad = structuredClone(lock); bad.images['dotnet-8'].reference = `mcr.microsoft.com/dotnet/sdk@${value}`;
    assert.throws(() => validateLock(bad), /digest-pinned/);
  }
  const foreign = structuredClone(lock); foreign.images['dotnet-8'].reference = foreign.images['dotnet-8'].reference.replace('mcr.microsoft.com', 'example.invalid');
  assert.throws(() => validateLock(foreign), /official/);
  const extra = structuredClone(lock); extra.images.extra = extra.images['dotnet-8'];
  assert.throws(() => validateLock(extra), /unapproved/);
});

test('planner applies every hardening boundary and keeps source read-only', t => {
  const f = fixture(t), plan = f.plan(), args = plan.args.join(' ');
  for (const expected of ['--pull=never', '--log-driver=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--read-only', '--network=none',
    '--cpus 1', '--memory 512m', '--pids-limit 64', '--shm-size 64m', '--user', 'dst=/src,readonly', 'dst=/work', 'dst=/out', 'dst=/cache', '--init', '--memory-swap 512m', 'fsize=16777216:16777216']) assert.ok(args.includes(expected), expected);
  assert.ok(!args.includes('--rm'), 'exit state is read before removal');
  assert.ok(!args.includes(['--', 'privileged'].join('')));
  assert.ok(!args.includes(['docker', '.sock'].join('')));
  assert.equal(plan.name, 'devtest-abcdef0123456789');
  assert.equal(plan.image, lock.images['dotnet-8'].reference);
  assert.ok(args.includes('dst=/cache,readonly'), 'build cache must be read-only');
  assert.equal(plan.workImage, path.join(plan.workspace, 'volume.img'));
  const restore = buildPlanForVerifiedPaths({ ...f.spec, phase: 'restore' }, f.config, f.project, f.storage);
  assert.ok(restore.args.join(' ').includes('dst=/cache --workdir'), 'only restore may write cache');
});

test('planner refuses unsafe paths, IDs, limits, images, network and command shape', t => {
  const f = fixture(t);
  assert.throws(() => createPlan(f.spec, f.config), /under \/mnt\/user\/projects/);
  for (const mutation of [
    s => { s.runId = '../bad'; }, s => { s.image = 'unknown'; }, s => { s.network = 'host'; },
    s => { s.command = ['sh', 'bad\narg']; }, s => { s.phase = 'unknown'; }
  ]) { const s = structuredClone(f.spec); mutation(s); assert.throws(() => buildPlanForVerifiedPaths(s, f.config, f.project, f.storage)); }
  for (const mutation of [
    c => { c.uid = 0; }, c => { c.gid = 0; }, c => { c.limits.memoryMb = 0; }, c => { c.limits.pids = 10000; }, c => { c.limits.timeoutMs = 0; }, c => { delete c.limits.diskMb; }, c => { c.limits.diskMb = 99999; }, c => { c.limits.cacheMb = 1; }
  ]) { const c = structuredClone(f.config); mutation(c); assert.throws(() => buildPlanForVerifiedPaths(f.spec, c, f.project, f.storage)); }
});

test('cleanup removes only a container bearing this run label', t => {
  const plan = fixture(t).plan(), calls = [];
  const absent = argv => { calls.push(argv); return { status: 1, stdout: '', stderr: 'No such object' }; };
  assert.equal(cleanupContainer(plan, absent), true);
  assert.equal(calls.length, 1);
  assert.throws(() => cleanupContainer(plan, () => ({ status: 0, stdout: 'someone-else\n', stderr: '' })), /different owner/);
  let present = true;
  const owned = argv => {
    calls.push(argv);
    if (argv[1] === 'inspect') return present ? { status: 0, stdout: `${plan.runId}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'No such container' };
    if (argv[1] === 'rm') { present = false; return { status: 0, stdout: '', stderr: '' }; }
    throw new Error('unexpected command');
  };
  assert.equal(ownedContainer(plan, owned), true);
  assert.equal(cleanupContainer(plan, owned), true);
  assert.ok(calls.some(argv => argv[1] === 'rm' && argv.at(-1) === plan.name));
  assert.throws(() => cleanupContainer(plan, () => ({ status: 1, stdout: '', stderr: 'daemon unavailable' })), /cannot verify/);
});

test('run preparation refuses symlinked parents and reused workspaces', t => {
  const f = fixture(t), plan = f.plan();
  const elsewhere = path.join(f.root, 'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(f.storage, 'runs'));
  assert.throws(() => prepareDirectories(plan), /parent is unsafe/);
  fs.unlinkSync(path.join(f.storage, 'runs'));
  prepareDirectories(plan);
  assert.throws(() => prepareDirectories(plan), /already has a workspace/);
});

test('Docker environment supports a scoped rootless socket without forwarding secrets', t => {
  const f = fixture(t), runtime = path.join(f.root, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const source = { PATH: '/usr/bin', HOME: f.root, XDG_RUNTIME_DIR: runtime, DOCKER_HOST: `unix://${runtime}/${'docker' + '.sock'}`, TEST_API_KEY: 'hidden' };
  assert.deepEqual(dockerEnvironment(source), { PATH: '/usr/bin', HOME: f.root, XDG_RUNTIME_DIR: runtime, DOCKER_HOST: source.DOCKER_HOST });
  assert.throws(() => dockerEnvironment({ ...source, DOCKER_HOST: 'tcp://example.invalid:2375' }), /rootless Docker socket/);
  fs.chmodSync(runtime, 0o777);
  assert.throws(() => dockerEnvironment(source), /owner-only/);
});

const stateFormat = '{{.State.ExitCode}} {{.State.OOMKilled}}';
function harness({ exit = 0, state = '0 false', tail = false, rmStatus = 0, onSpawn = () => {}, stdoutText = '', stderrText = '' }) {
  let present = false;
  const calls = [];
  const command = argv => {
    calls.push(argv);
    if (argv[0] === 'image') return { status: 0, stdout: 'sha256:local\n', stderr: '' };
    if (argv[1] === 'kill') { return { status: 0, stdout: '', stderr: '' }; }
    if (argv[1] === 'inspect' && argv.includes(stateFormat)) return present && state !== null ? { status: 0, stdout: state + '\n', stderr: '' } : { status: 1, stdout: '', stderr: 'No such container' };
    if (argv[1] === 'inspect') return present ? { status: 0, stdout: 'RUN\n', stderr: '' } : { status: 1, stdout: '', stderr: 'No such container' };
    if (argv[1] === 'rm') { if (rmStatus === 0) present = false; return { status: rmStatus, stdout: '', stderr: '' }; }
    throw new Error('unexpected command ' + argv.join(' '));
  };
  const spawnRun = plan => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    present = state !== null || tail;
    child.kill = () => { queueMicrotask(() => child.emit('close', 143)); return true; };
    onSpawn(child, plan);
    if (!tail) queueMicrotask(() => { if (stdoutText) child.stdout.emit('data', Buffer.from(stdoutText)); if (stderrText) child.stderr.emit('data', Buffer.from(stderrText)); child.emit('close', exit); });
    return child;
  };
  return { command, spawnRun, calls };
}
async function runWith(t, options, mutatePlan = () => {}, runOptions = {}) {
  const f = fixture(t), plan = f.plan(); mutatePlan(plan);
  const h = harness(options);
  const originalCommand = h.command;
  const command = argv => { const r = originalCommand(argv.map(x => x === plan.name ? plan.name : x)); if (r.stdout === 'RUN\n') r.stdout = plan.runId + '\n'; return r; };
  const result = await runContainer(plan, { command, spawnRun: () => h.spawnRun(plan),
    ensureVolumes: p => { fs.mkdirSync(p.work); fs.mkdirSync(p.out); }, ...runOptions });
  return { result, plan, h };
}

test('exit mapping uses the container state: subject failures are 1, only Docker failures are 6', async t => {
  const cases = [
    ['success', { exit: 0, state: '0 false' }, 0, null],
    ['subject exit 1', { exit: 1, state: '1 false' }, 1, null],
    ['command not found 127', { exit: 127, state: '127 false' }, 1, null],
    ['cannot execute 126', { exit: 126, state: '126 false' }, 1, null],
    ['memory kill 137', { exit: 137, state: '137 true' }, 1, 'memory_limit'],
    ['docker failed before a container existed', { exit: 125, state: null }, 6, null]
  ];
  for (const [name, options, expected, reason] of cases) {
    const { result } = await runWith(t, options);
    assert.equal(result.exitCode, expected, name); assert.equal(result.reason, reason, name); assert.equal(result.cleanup, 'complete', name);
  }
});

test('timeout is 5 and an unremovable container is 7 with the error class recorded', async t => {
  const timeout = await runWith(t, { tail: true, state: '143 false' }, plan => { plan.timeoutMs = 10; });
  assert.equal(timeout.result.exitCode, 5); assert.equal(timeout.result.reason, 'timeout');
  const cleanup = await runWith(t, { exit: 0, state: '0 false', rmStatus: 1 });
  assert.equal(cleanup.result.exitCode, 7); assert.equal(cleanup.result.cleanup, 'incomplete');
});

test('subject output is consumed without persisting possible secrets', async t => {
  const { result, plan } = await runWith(t, { exit: 3, state: '3 false', stdoutText: 'VISIBLE_STDOUT\n', stderrText: 'x'.repeat(2 * 1048576) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.logs.stdout.bytes, 15);
  assert.equal(result.logs.stderr.bytes, 1048576); assert.equal(result.logs.stderr.truncated, true);
  assert.equal(result.logs.stdout.persisted, false); assert.equal(result.logs.stderr.persisted, false);
  assert.equal(fs.readdirSync(plan.logDir).length, 0);
});

test('a bounded-storage failure refuses the run before Docker starts', async t => {
  const f = fixture(t), plan = f.plan();
  let spawned = false;
  const command = argv => argv[0] === 'image'
    ? { status: 0, stdout: 'sha256:local\n', stderr: '' }
    : { status: 1, stdout: '', stderr: 'No such container' };
  await assert.rejects(runContainer(plan, { command,
    ensureVolumes: () => { throw new Error('mount refused'); },
    spawnRun: () => { spawned = true; throw new Error('unexpected spawn'); } }), /mount refused/);
  assert.equal(spawned, false);
});

test('containerState parses exit code and OOM flag and returns null when no container exists', () => {
  const plan = { name: 'n' };
  assert.deepEqual(containerState(plan, () => ({ status: 0, stdout: '137 true\n' })), { exitCode: 137, oomKilled: true });
  assert.equal(containerState(plan, () => ({ status: 1, stdout: '' })), null);
  assert.equal(containerState(plan, () => ({ status: 0, stdout: 'garbage' })), null);
});

test('a pre-existing run container is never started over or removed', async t => {
  const f = fixture(t), plan = f.plan();
  let spawned = false, removed = false;
  const command = argv => {
    if (argv[1] === 'inspect') return { status: 0, stdout: `${plan.runId}\n`, stderr: '' };
    if (argv[1] === 'rm') removed = true;
    throw new Error('unexpected command');
  };
  await assert.rejects(runContainer(plan, { command, spawnRun: () => { spawned = true; throw new Error('unexpected spawn'); } }), /already in use/);
  assert.equal(spawned, false); assert.equal(removed, false);
  assert.equal(fs.existsSync(plan.workspace), false);
});
