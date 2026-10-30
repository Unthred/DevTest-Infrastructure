import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { buildPlanForVerifiedPaths, cleanupContainer, createPlan, ownedContainer, prepareDirectories, runContainer, validateLock } from '../docker/runner.mjs';

const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-docker-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), storage = path.join(root, 'storage');
  fs.mkdirSync(project); fs.mkdirSync(storage, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  const spec = { project, runId: 'abcdef0123456789', image: 'dotnet-8', command: ['dotnet', '--version'] };
  const config = { allowedProjects: [project], storageRoot: storage, lock, uid: process.getuid() || 1000, gid: process.getgid() || 1000,
    limits: { cpus: 1, memoryMb: 512, pids: 64, shmMb: 64, timeoutMs: 30000 } };
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
  for (const expected of ['--rm', '--pull=never', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--read-only', '--network=none',
    '--cpus 1', '--memory 512m', '--pids-limit 64', '--shm-size 64m', '--user', 'dst=/src,readonly', 'dst=/work', 'dst=/out', 'dst=/cache']) assert.ok(args.includes(expected), expected);
  assert.ok(!args.includes(['--', 'privileged'].join('')));
  assert.ok(!args.includes(['docker', '.sock'].join('')));
  assert.equal(plan.name, 'devtest-abcdef0123456789');
  assert.equal(plan.image, lock.images['dotnet-8'].reference);
});

test('planner refuses unsafe paths, IDs, limits, images, network and command shape', t => {
  const f = fixture(t);
  assert.throws(() => createPlan(f.spec, f.config), /under \/mnt\/user\/projects/);
  for (const mutation of [
    s => { s.runId = '../bad'; }, s => { s.image = 'unknown'; }, s => { s.network = 'host'; },
    s => { s.command = ['sh', 'bad\narg']; }
  ]) { const s = structuredClone(f.spec); mutation(s); assert.throws(() => buildPlanForVerifiedPaths(s, f.config, f.project, f.storage)); }
  for (const mutation of [
    c => { c.uid = 0; }, c => { c.gid = 0; }, c => { c.limits.memoryMb = 0; }, c => { c.limits.pids = 10000; }, c => { c.limits.timeoutMs = 0; }
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

test('run maps success, subject failure, timeout and cleanup failure', async t => {
  for (const scenario of ['success', 'subject', 'timeout', 'cleanup']) {
    const f = fixture(t), plan = f.plan();
    if (scenario === 'timeout') plan.timeoutMs = 10;
    let present = scenario === 'cleanup';
    const command = argv => {
      if (argv[0] === 'image') return { status: 0, stdout: 'sha256:local\n', stderr: '' };
      if (argv[1] === 'inspect') return present ? { status: 0, stdout: `${plan.runId}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'No such container' };
      if (argv[1] === 'rm') return { status: scenario === 'cleanup' ? 1 : 0, stdout: '', stderr: '' };
      throw new Error('unexpected command');
    };
    const spawnRun = () => {
      const child = new EventEmitter();
      child.kill = () => { queueMicrotask(() => child.emit('close', 143)); return true; };
      if (scenario !== 'timeout') queueMicrotask(() => child.emit('close', scenario === 'subject' ? 1 : 0));
      return child;
    };
    const result = await runContainer(plan, { command, spawnRun });
    assert.equal(result.exitCode, { success: 0, subject: 1, timeout: 5, cleanup: 7 }[scenario]);
    assert.equal(result.cleanup, scenario === 'cleanup' ? 'incomplete' : 'complete');
  }
});
