import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RunnerError, assertContainerCanRead, containerCanRead, buildPlanForVerifiedPaths, cleanupContainer, releaseVolumes, sweepStaleVolumes, containerState, createPlan, dockerEnvironment, ownedContainer, prepareDirectories, runContainer, validateLock } from '../docker/runner.mjs';

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
    ensureVolumes: p => { fs.mkdirSync(p.work); fs.mkdirSync(p.out); }, releaseVolumes: () => {}, sweep: () => null, ...runOptions });
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
    ensureVolumes: () => { throw new Error('mount refused'); }, releaseVolumes: () => {}, sweep: () => null,
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

// ---- mount lifecycle (PR #19 review B1)
function lifecycle(t, options, runOptions = {}, mutatePlan = () => {}) {
  const f = fixture(t), plan = f.plan(); mutatePlan(plan);
  const events = [], h = harness(options), original = h.command;
  const command = argv => { events.push(argv[0] === 'container' ? `docker:${argv[1]}` : `docker:${argv[0]}`); const r = original(argv); if (r.stdout === 'RUN\n') r.stdout = plan.runId + '\n'; return r; };
  const release = () => events.push('release');
  return { plan, events, run: () => runContainer(plan, { command, spawnRun: () => h.spawnRun(plan), ensureVolumes: p => { events.push('acquire'); fs.mkdirSync(p.work); fs.mkdirSync(p.out); }, releaseVolumes: release, sweep: () => null, ...runOptions }) };
}

test('the volume is released after the container is gone on every outcome', async t => {
  const outcomes = [['success', { exit: 0, state: '0 false' }, 0], ['subject failure', { exit: 1, state: '1 false' }, 1], ['command not found', { exit: 127, state: '127 false' }, 1],
    ['docker failure', { exit: 125, state: null }, 6], ['timeout', { tail: true, state: '143 false' }, 5]];
  for (const [name, options, expected] of outcomes) {
    const l = lifecycle(t, options, {}, name === 'timeout' ? p => { p.timeoutMs = 10; } : () => {});
    const r = await l.run();
    assert.equal(r.exitCode, expected, name); assert.equal(r.cleanup, 'complete', name); assert.deepEqual(r.volume, { released: true, retained: false, error: null }, name);
    assert.equal(l.events.filter(e => e === 'release').length, 1, name);
    assert.ok(l.events.lastIndexOf('docker:rm') < l.events.indexOf('release'), `${name}: released only after the container was removed`);
  }
});

test('SIGINT: the runner reports 130 and still releases the volume', async t => {
  const l = lifecycle(t, { tail: true, state: '143 false', onSpawn: () => { setTimeout(() => process.emit('SIGINT'), 5); } });
  const r = await l.run();
  assert.equal(r.exitCode, 130); assert.equal(r.reason, 'interrupted'); assert.equal(r.cleanup, 'complete');
  assert.equal(l.events.filter(e => e === 'release').length, 1);
});

test('a failed start still releases whatever was acquired, and the original error is kept', async t => {
  const l = lifecycle(t, { exit: 0, state: '0 false' }, { ensureVolumes: () => { throw new RangeError('mount refused'); } });
  await assert.rejects(l.run(), /mount refused/);
  assert.equal(l.events.filter(e => e === 'release').length, 1);
  const spawnFails = lifecycle(t, { exit: 0, state: '0 false' }, { spawnRun: () => { throw new TypeError('spawn blew up'); } });
  await assert.rejects(spawnFails.run(), /spawn blew up/);
  assert.equal(spawnFails.events.filter(e => e === 'release').length, 1);
});

test('an unmount that fails is reported as incomplete cleanup (exit 7) with the error class, never as complete', async t => {
  const l = lifecycle(t, { exit: 0, state: '0 false' }, { releaseVolumes: () => { throw new RunnerError('bounded storage release incomplete (RunnerError)', 7); } });
  const r = await l.run();
  assert.equal(r.exitCode, 7); assert.equal(r.cleanup, 'incomplete'); assert.deepEqual(r.volume, { released: false, retained: false, error: 'RunnerError' });
  // a subject failure with a failed unmount is still 7: the infrastructure problem outranks the test result
  const bad = lifecycle(t, { exit: 1, state: '1 false' }, { releaseVolumes: () => { throw new Error('x'); } });
  assert.equal((await bad.run()).exitCode, 7);
});

test('keepVolume leaves release to the caller, who can then release it exactly once', async t => {
  const l = lifecycle(t, { exit: 0, state: '0 false' }, { keepVolume: true });
  const r = await l.run();
  assert.equal(r.exitCode, 0); assert.deepEqual(r.volume, { released: false, retained: true, error: null });
  assert.equal(l.events.filter(e => e === 'release').length, 0);
});

test('cache volume is unmounted only by the last live user; dead users are pruned; a failed unmount is reported', t => {
  const f = fixture(t), a = f.plan(), b = buildPlanForVerifiedPaths({ ...f.spec, runId: 'bbbbbbbbbbbbbbbb' }, f.config, f.project, f.storage);
  fs.mkdirSync(path.dirname(a.cache), { recursive: true });
  const users = a.cache + '.users'; fs.mkdirSync(users, { recursive: true });
  const me = { pid: process.pid, start: fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[21] };
  fs.writeFileSync(path.join(users, a.runId), JSON.stringify(me)); fs.writeFileSync(path.join(users, b.runId), JSON.stringify(me));
  fs.writeFileSync(path.join(users, 'cccccccccccccccc'), JSON.stringify({ pid: 999999, start: '1' }));            // dead user
  fs.mkdirSync(a.workspace, { recursive: true }); fs.writeFileSync(path.join(a.workspace, 'lease.json'), '{}');
  const calls = [], ops = { releaseRun: () => calls.push('run'), releaseCache: () => calls.push('cache') };
  releaseVolumes(a, ops);
  assert.deepEqual(calls, ['run']);                                  // b is still alive: cache stays mounted
  assert.equal(fs.existsSync(path.join(users, a.runId)), false); assert.equal(fs.existsSync(path.join(a.workspace, 'lease.json')), false);
  releaseVolumes(b, ops);
  assert.deepEqual(calls, ['run', 'run', 'cache']);                  // last user out unmounts it
  assert.throws(() => releaseVolumes(b, { releaseRun: () => {}, releaseCache: () => { throw new RunnerError('x'); } }), /release incomplete \(RunnerError\)/);
  assert.throws(() => releaseVolumes(b, { releaseRun: () => { throw new RunnerError('x'); }, releaseCache: () => {} }), error => error.exitCode === 7);
  assert.equal(fs.existsSync(a.cache + '.lock'), false, 'the cache lock is always released');
});

test('sweep touches only stale DevTest volumes under the storage root, never Docker, libvirt or boot loop devices', t => {
  const f = fixture(t), root = fs.realpathSync(f.storage);
  const ids = { stale: '1111111111111111', liveLease: '2222222222222222', liveContainer: '3333333333333333', staleCacheUser: 'dddddddddddddddd', other: '4444444444444444' };
  const me = { pid: process.pid, start: fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[21] };
  for (const id of [ids.stale, ids.liveLease, ids.liveContainer]) fs.mkdirSync(path.join(root, 'runs', id, 'volume'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runs', ids.liveLease, 'lease.json'), JSON.stringify(me));
  fs.writeFileSync(path.join(root, 'runs', ids.stale, 'lease.json'), JSON.stringify({ pid: 999999, start: '1' }));
  fs.mkdirSync(path.join(root, 'cache', 'nuget'), { recursive: true }); fs.mkdirSync(path.join(root, 'cache', 'nuget.users'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', 'nuget.users', ids.staleCacheUser), JSON.stringify({ pid: 999999, start: '1' }));
  fs.mkdirSync(path.join(root, 'cache', 'playwright'), { recursive: true }); fs.mkdirSync(path.join(root, 'cache', 'playwright.users'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', 'playwright.users', ids.liveLease), JSON.stringify(me));
  let loops = [
    { name: '/dev/loop0', file: '/boot/bzfirmware' }, { name: '/dev/loop2', file: '/mnt/cache/system/docker/docker.img' }, { name: '/dev/loop3', file: '/mnt/cache/system/libvirt/libvirt.img' },
    { name: '/dev/loop4', file: `${root}/runs/${ids.stale}/volume.img` }, { name: '/dev/loop5', file: `${root}/runs/${ids.liveLease}/volume.img` }, { name: '/dev/loop6', file: `${root}/runs/${ids.liveContainer}/volume.img` },
    { name: '/dev/loop7', file: `${root}/cache/nuget.img` }, { name: '/dev/loop8', file: `${root}/cache/playwright.img` },
    { name: '/dev/loop9', file: `${root}/runs/${ids.other}/other.img` },                     // under the root but not a DevTest volume image
    { name: '/dev/loop10', file: `/elsewhere${root}/runs/${ids.stale}/volume.img` }          // same tail, different root
  ];
  const touched = [];
  const host = {
    listLoops: () => loops,
    mountedSource: target => { const l = loops.find(x => target.endsWith('/volume') ? x.file.endsWith(`/${path.basename(path.dirname(target))}/volume.img`) && x.file.startsWith(root) : x.file === `${target}.img`); return l ? { source: l.name, type: 'ext4' } : null; },
    umount: target => touched.push(['umount', target]), detach: device => { touched.push(['detach', device]); loops = loops.filter(l => l.name !== device); },
    containerExists: name => name === `devtest-${ids.liveContainer}`
  };
  const result = sweepStaleVolumes(root, () => ({ status: 1 }), host);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.released.sort(), ['/dev/loop4', '/dev/loop7']);                       // stale run volume + cache whose only user was dead
  assert.deepEqual(result.skipped.sort(), ['/dev/loop5', '/dev/loop6', '/dev/loop8']);          // live lease, live container, cache with a live user
  const devices = touched.map(x => x[1]).join(' ');
  for (const never of ['/dev/loop0', '/dev/loop2', '/dev/loop3', '/dev/loop9', '/dev/loop10', 'docker.img', 'libvirt', 'bzfirmware']) assert.ok(!devices.includes(never), never);
  assert.ok(touched.some(x => x[0] === 'umount' && x[1] === `${root}/runs/${ids.stale}/volume`)); assert.ok(touched.some(x => x[0] === 'umount' && x[1] === `${root}/cache/nuget`));
  assert.equal(fs.existsSync(path.join(root, 'cache', 'nuget.users', ids.staleCacheUser)), false);
});

test('sweep reports a per-device failure without touching anything else, and a sweep failure does not block the run', async t => {
  const f = fixture(t), root = fs.realpathSync(f.storage);
  fs.mkdirSync(path.join(root, 'runs', 'aaaaaaaaaaaaaaaa', 'volume'), { recursive: true });
  const host = { listLoops: () => [{ name: '/dev/loop4', file: `${root}/runs/aaaaaaaaaaaaaaaa/volume.img` }, { name: '/dev/loop2', file: '/mnt/cache/system/docker/docker.img' }],
    mountedSource: () => ({ source: '/dev/loop4', type: 'ext4' }), umount: () => { throw new RunnerError('busy'); }, detach: () => { throw new Error('no'); }, containerExists: () => false };
  const result = sweepStaleVolumes(root, () => ({ status: 1 }), host);
  assert.deepEqual(result.errors, ['/dev/loop4:RunnerError']); assert.deepEqual(result.released, []);
  const l = lifecycle(t, { exit: 0, state: '0 false' }, { sweep: () => { throw new SyntaxError('sweep bug'); } });
  const r = await l.run();
  assert.equal(r.exitCode, 0); assert.deepEqual(r.sweep, { error: 'SyntaxError' });
});

// PR #29 review: a 0700 project directory (a mktemp -d clone) made every browser run fail inside the container as exit 2.
test('containerCanRead: the container user needs r-x on the project and --x on its ancestors; mode bits only', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-perm-'));
  t.after(() => { fs.chmodSync(root, 0o755); fs.rmSync(root, { recursive: true, force: true }); });
  const project = path.join(root, 'p'); fs.mkdirSync(project);
  const other = { uid: 99, gid: 100 };
  fs.chmodSync(root, 0o755); fs.chmodSync(project, 0o755);
  assert.equal(containerCanRead(project, other.uid, other.gid), true, '0755 is readable by a different user');
  fs.chmodSync(project, 0o700);
  assert.equal(containerCanRead(project, other.uid, other.gid), false, 'a 0700 project is not readable by a different user');
  assert.equal(containerCanRead(project, process.getuid(), process.getgid()), true, 'the owner can read it');
  fs.chmodSync(project, 0o755); fs.chmodSync(root, 0o700);
  assert.equal(containerCanRead(project, other.uid, other.gid), false, 'an untraversable ancestor refuses');
  fs.chmodSync(root, 0o755); fs.chmodSync(project, 0o750);
  assert.equal(containerCanRead(project, other.uid, other.gid), false, 'group-only mode refuses a user outside the group');
});

test('the runner refuses a project the container user cannot read, with the real reason', t => {
  const f = fixture(t);
  const config = { ...f.config, uid: 99, gid: 100 };
  fs.chmodSync(f.root, 0o755);   // mkdtemp makes the fixture root 0700, which would hide the project permission under test
  fs.chmodSync(f.project, 0o700);
  assert.throws(() => assertContainerCanRead(f.project, config), /not readable by the container user \(uid 99\).*0755/);
  fs.chmodSync(f.project, 0o755);
  assert.doesNotThrow(() => assertContainerCanRead(f.project, config));
});

// createPlan itself enforces /mnt/user/projects and /mnt/cache, which exist on Tower only.
test('createPlan applies the readability check (Tower only)', { skip: !fs.existsSync('/mnt/user/projects') || !fs.existsSync('/mnt/cache') }, t => {
  const f = fixture(t);
  const proj = fs.mkdtempSync('/mnt/user/projects/.devtest-perm-'), storage = fs.mkdtempSync('/mnt/cache/.devtest-perm-st-');
  t.after(() => { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(storage, { recursive: true, force: true }); });
  fs.chmodSync(storage, 0o700);
  const config = { ...f.config, uid: 99, gid: 100, allowedProjects: [proj], storageRoot: storage };
  fs.chmodSync(proj, 0o700);
  assert.throws(() => createPlan({ ...f.spec, project: proj }, config), /not readable by the container user/);
  fs.chmodSync(proj, 0o755);
  assert.doesNotThrow(() => createPlan({ ...f.spec, project: proj }, config));
});
