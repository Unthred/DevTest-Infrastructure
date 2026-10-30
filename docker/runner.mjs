import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export class RunnerError extends Error {
  constructor(message, exitCode = 4) { super(message); this.name = 'RunnerError'; this.exitCode = exitCode; }
}

const imageRepositories = {
  'dotnet-8': 'mcr.microsoft.com/dotnet/sdk',
  'dotnet-9': 'mcr.microsoft.com/dotnet/sdk',
  'dotnet-10': 'mcr.microsoft.com/dotnet/sdk',
  playwright: 'mcr.microsoft.com/playwright'
};
const digest = /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/;
const runId = /^[a-f0-9]{16,32}$/;
const targetName = /^[a-z][a-z0-9-]{0,31}$/;
export const targetSocketDirectory = (storage, id) => path.join(storage, 'sockets', id);
export const targetSocketPath = (storage, id, name) => path.join(targetSocketDirectory(storage, id), `${name}.sock`);
const safeArg = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);
const inside = (base, candidate) => candidate === base || candidate.startsWith(base + path.sep);

function exactDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !fs.existsSync(value) || /[,\0\r\n]/.test(value)) throw new RunnerError(`${label} must be an existing absolute directory`);
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new RunnerError(`${label} must be a directory`);
  return resolved;
}

export function validateLock(lock) {
  if (lock?.schema_version !== 1 || !lock.images || typeof lock.images !== 'object') throw new RunnerError('invalid image lock file');
  for (const [id, repository] of Object.entries(imageRepositories)) {
    const entry = lock.images[id];
    if (!entry || !safeArg(entry.tag) || !safeArg(entry.reference) || !digest.test(entry.reference) || !entry.reference.startsWith(`${repository}@sha256:`) || !entry.tag.startsWith(`${repository}:`))
      throw new RunnerError(`image ${id} is not an official digest-pinned reference`);
  }
  if (Object.keys(lock.images).some(id => !(id in imageRepositories))) throw new RunnerError('unapproved image in lock file');
  return lock;
}

// The container user must be able to read the project directory and traverse every ancestor of it. A 0700 clone (what mktemp -d
// makes) fails inside the container as a confusing exit 2 of the subject; refuse it up front with the real reason. Mode bits only:
// the runner never changes the permissions of a project.
export function containerCanRead(dir, uid, gid) {
  const allowed = (st, bit) => { const m = st.mode; return (st.uid === uid ? m >> 6 : st.gid === gid ? m >> 3 : m) & bit; };
  let p = fs.realpathSync(dir);
  if (!allowed(fs.statSync(p), 5)) return false;           // r-x on the project itself
  while (p !== path.dirname(p)) { p = path.dirname(p); if (!allowed(fs.statSync(p), 1)) return false; }   // --x on every ancestor
  return true;
}

export function createPlan(spec, config) {
  const project = exactDirectory(spec.project, 'project');
  const allowlist = config.allowedProjects?.map(p => exactDirectory(p, 'allowlisted project')) || [];
  if (!allowlist.includes(project)) throw new RunnerError('project is not in the exact allowlist');
  if (!inside('/mnt/user/projects', project)) throw new RunnerError('project must be under /mnt/user/projects');
  const storage = exactDirectory(config.storageRoot, 'storage root');
  if (!inside('/mnt/cache', storage)) throw new RunnerError('storage root must be on /mnt/cache');
  if (Number.isSafeInteger(config.uid) && Number.isSafeInteger(config.gid) && !containerCanRead(project, config.uid, config.gid))
    throw new RunnerError(`project directory is not readable by the container user (uid ${config.uid}); it needs mode 0755 (a 0700 clone fails inside the container as exit 2)`);
  return buildPlanForVerifiedPaths(spec, config, project, storage);
}

// Internal planner seam for tests. The host CLI must call createPlan, which enforces the real path boundaries.
export function buildPlanForVerifiedPaths(spec, config, project, storage) {
  if (!runId.test(spec.runId || '')) throw new RunnerError('invalid run id');
  const image = validateLock(config.lock).images[spec.image]?.reference;
  if (!image) throw new RunnerError('image is not in the lock file');
  if (!Number.isSafeInteger(config.uid) || config.uid < 1 || !Number.isSafeInteger(config.gid) || config.gid < 1) throw new RunnerError('container UID and GID must be non-root');
  if (!Array.isArray(spec.command) || !spec.command.length || !spec.command.every(safeArg)) throw new RunnerError('command must be a bounded argv array');
  const network = spec.network || 'none';
  if (network !== 'none') throw new RunnerError('network access requires a later approved phase policy');
  // Declared targets are the ONLY way out of a network-none container: each is a host-side Unix socket mounted at
  // /targets/<name>.sock. The container gets no network interface and no route, so nothing else is reachable.
  const names = spec.targets ?? [];
  if (!Array.isArray(names) || names.length > 4 || !names.every(n => targetName.test(n)) || new Set(names).size !== names.length) throw new RunnerError('targets must be up to four unique simple names');
  const targets = names.map(name => ({ name, host: targetSocketPath(storage, spec.runId, name), container: `/targets/${name}.sock` }));
  // sun_path holds 107 bytes; longer paths are silently truncated by listen(), so refuse them before anything starts.
  if (targets.some(t => Buffer.byteLength(t.host) > 107)) throw new RunnerError('target socket path is too long; use a shorter storage root');
  const phase = spec.phase || 'build';
  if (!['restore', 'build', 'test'].includes(phase)) throw new RunnerError('invalid run phase');
  const limits = config.limits || {};
  if (!(limits.cpus > 0 && limits.cpus <= 4) || !Number.isSafeInteger(limits.memoryMb) || limits.memoryMb < 128 || limits.memoryMb > 8192 ||
      !Number.isSafeInteger(limits.pids) || limits.pids < 16 || limits.pids > 512 || !Number.isSafeInteger(limits.shmMb) || limits.shmMb < 16 || limits.shmMb > 1024 ||
      !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1000 || limits.timeoutMs > 3600000 ||
      !Number.isSafeInteger(limits.diskMb) || limits.diskMb < 16 || limits.diskMb > 20480 || !Number.isSafeInteger(limits.cacheMb) || limits.cacheMb < 16 || limits.cacheMb > 20480) throw new RunnerError('resource limits are missing or outside the bounded policy');
  const workspace = path.join(storage, 'runs', spec.runId);
  const volume = path.join(workspace, 'volume');
  const work = path.join(volume, 'work'), out = path.join(volume, 'out');
  const cache = path.join(storage, 'cache', spec.image.startsWith('dotnet-') ? 'nuget' : 'playwright');
  const workImage = path.join(workspace, 'volume.img');
  const cacheImage = `${cache}.img`;
  const name = `devtest-${spec.runId}`;
  const args = ['run', '--init', '--pull=never', '--log-driver=none', '--name', name, '--label', `devtest.run-id=${spec.runId}`,
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--read-only', '--network=none',
    '--cpus', String(limits.cpus), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, '--ulimit', `fsize=${limits.diskMb * 1048576}:${limits.diskMb * 1048576}`, '--pids-limit', String(limits.pids), '--shm-size', `${limits.shmMb}m`,
    '--user', `${config.uid}:${config.gid}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--mount', `type=bind,src=${project},dst=/src,readonly`,
    '--mount', `type=bind,src=${work},dst=/work`, '--mount', `type=bind,src=${out},dst=/out`,
    '--mount', `type=bind,src=${cache},dst=/cache${phase === 'restore' ? '' : ',readonly'}`,
    ...targets.flatMap(t => ['--mount', `type=bind,src=${t.host},dst=${t.container},readonly`]), '--workdir', '/work', image, ...spec.command];
  return { runId: spec.runId, name, image, targets, project, storage, workspace, volume, workImage, cacheImage, phase, work, out, cache, uid: config.uid, gid: config.gid, timeoutMs: limits.timeoutMs, diskBytes: limits.diskMb * 1048576, cacheBytes: limits.cacheMb * 1048576, logDir: path.join(workspace, 'logs'), args };
}

// The caller (host side) starts each target server before the run. Refuse anything that is not a real socket in a private,
// run-specific directory, so a swapped file or a symlink can never be mounted into the container.
export function verifyTargets(plan) {
  for (const t of plan.targets) {
    const dir = fs.lstatSync(path.dirname(t.host), { throwIfNoEntry: false });
    if (!dir || !dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0) throw new RunnerError(`target ${t.name}: socket directory is missing or unsafe`);
    const st = fs.lstatSync(t.host, { throwIfNoEntry: false });
    if (!st || !st.isSocket()) throw new RunnerError(`target ${t.name}: no host-side socket is listening`);
    if (st.uid !== plan.uid && st.uid !== process.getuid()) throw new RunnerError(`target ${t.name}: socket owner is unexpected`);
  }
}

export function prepareDirectories(plan) {
  const runs = path.join(plan.storage, 'runs');
  const safeParent = dir => {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0)
      throw new RunnerError('run or cache parent is unsafe');
  };
  safeParent(plan.storage);
  fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
  safeParent(runs);
  if (fs.existsSync(plan.workspace)) throw new RunnerError('run id already has a workspace');
  for (const dir of [plan.workspace, plan.volume, plan.logDir]) {
    fs.mkdirSync(dir, { mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new RunnerError('run directory may not be a symlink');
  }
  fs.mkdirSync(path.dirname(plan.cache), { recursive: true, mode: 0o700 });
  safeParent(path.dirname(plan.cache));
  if (!fs.existsSync(plan.cache)) fs.mkdirSync(plan.cache, { mode: 0o700 });
  if (fs.lstatSync(plan.cache).isSymbolicLink()) throw new RunnerError('cache directory may not be a symlink');
  for (const dir of [plan.cache]) {
    const st = fs.statSync(dir);
    if (st.uid !== plan.uid || st.gid !== plan.gid) {
      if (fs.readdirSync(dir).length) throw new RunnerError('nonempty writable directory has unexpected owner');
      fs.chownSync(dir, plan.uid, plan.gid);
    }
    fs.chmodSync(dir, 0o700);
  }
}

function hostCommand(program, argv) {
  const result = spawnSync(program, argv, { encoding: 'utf8', timeout: 30000, maxBuffer: 4096,
    env: { PATH: '/usr/sbin:/sbin:/usr/bin:/bin' } });
  if (result.error || result.status !== 0) throw new RunnerError(`${path.basename(program)} failed while preparing bounded storage`, 3);
  return result.stdout.trim();
}

function mountedSource(target) {
  const result = spawnSync('findmnt', ['-n', '-o', 'SOURCE,FSTYPE', '--mountpoint', target],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } });
  if (result.status === 1) return null;
  if (result.error || result.status !== 0) throw new RunnerError('cannot verify bounded storage mount', 3);
  const [source, type] = result.stdout.trim().split(/\s+/);
  return { source, type };
}

function ensureLoopImage(image, target, bytes, readOnly = false) {
  const existing = mountedSource(target);
  if (existing) {
    const st = fs.lstatSync(image);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size !== bytes)
      throw new RunnerError('bounded storage image size or owner mismatch', 4);
    if (existing.type !== 'ext4' || !existing.source.startsWith('/dev/loop')) throw new RunnerError('foreign storage mount refused', 4);
    const backing = hostCommand('losetup', ['-n', '-O', 'BACK-FILE', existing.source]);
    if (backing !== image) throw new RunnerError('storage mount backing image mismatch', 4);
    return;
  }
  if (fs.readdirSync(target).length) throw new RunnerError('unmounted storage directory is not empty', 4);
  if (!fs.existsSync(image)) {
    const fd = fs.openSync(image, 'wx', 0o600);
    try { hostCommand('chattr', ['+C', image]); fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
    hostCommand('mkfs.ext4', ['-q', '-F', image]);
  } else {
    const st = fs.lstatSync(image);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size !== bytes)
      throw new RunnerError('bounded storage image size or owner mismatch', 4);
  }
  hostCommand('mount', ['-t', 'ext4', '-o', readOnly ? 'loop,ro,nosuid,nodev,noexec' : 'loop,nosuid,nodev', image, target]);
  if (!mountedSource(target)) throw new RunnerError('bounded storage mount was not established', 3);
}

// ---- bounded-storage lifecycle -------------------------------------------------------------------------------------
// A finite ext4 loop image supplies the hard ENOSPC ceiling. Every run owns a lease (its PID and start time) so a sweep can
// tell a live run from a dead one, and a mount is released in a finally on every outcome. The shared cache image is mounted
// while at least one live run uses it and unmounted by the last one to finish.
function processStart(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21]; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
const alive = owner => !!owner && processStart(owner.pid) === owner.start;
function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
const ownerNow = () => ({ pid: process.pid, start: processStart(process.pid) });
const leaseFile = plan => path.join(plan.workspace, 'lease.json');
const cacheUsers = cache => `${cache}.users`;

function withCacheLock(cache, fn) {
  const lock = `${cache}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 200 && !held; attempt++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); held = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!alive(readOwner(path.join(lock, 'owner.json')))) { fs.rmSync(lock, { recursive: true, force: true }); continue; }   // dead holder
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (!held) throw new RunnerError('cache lock is busy', 3);
  try { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(ownerNow()), { mode: 0o600 }); return fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function mountedAs(target, image) {
  const mounted = mountedSource(target);
  if (!mounted) return null;
  if (mounted.type !== 'ext4' || !mounted.source.startsWith('/dev/loop') || hostCommand('losetup', ['-n', '-O', 'BACK-FILE', mounted.source]) !== image)
    throw new RunnerError('refusing to touch a foreign mount', 4);
  return mounted;
}
export function releaseRunVolume(plan) {
  if (mountedAs(plan.volume, plan.workImage)) hostCommand('umount', [plan.volume]);
}
export function releaseCacheVolume(plan) {
  if (mountedAs(plan.cache, plan.cacheImage)) hostCommand('umount', [plan.cache]);
}

export function releaseVolumes(plan, ops = { releaseRun: releaseRunVolume, releaseCache: releaseCacheVolume }) {
  const failed = [];
  try { ops.releaseRun(plan); fs.rmSync(leaseFile(plan), { force: true }); } catch (error) { failed.push(errorClass(error)); }
  try {
    withCacheLock(plan.cache, () => {
      const users = cacheUsers(plan.cache);
      fs.rmSync(path.join(users, plan.runId), { force: true });
      const live = fs.existsSync(users) ? fs.readdirSync(users).filter(n => alive(readOwner(path.join(users, n)))) : [];
      if (!live.length) ops.releaseCache(plan);
    });
  } catch (error) { failed.push(errorClass(error)); }
  if (failed.length) throw new RunnerError(`bounded storage release incomplete (${failed.join(', ')})`, 7);
}

export function ensureLoopVolumes(plan) {
  fs.writeFileSync(leaseFile(plan), JSON.stringify(ownerNow()), { mode: 0o600 });
  try {
    withCacheLock(plan.cache, () => {
      fs.mkdirSync(cacheUsers(plan.cache), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(cacheUsers(plan.cache), plan.runId), JSON.stringify(ownerNow()), { mode: 0o600 });
      ensureLoopImage(plan.cacheImage, plan.cache, plan.cacheBytes);
    });
    ensureLoopImage(plan.workImage, plan.volume, plan.diskBytes);
    for (const dir of [plan.work, plan.out]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chownSync(dir, plan.uid, plan.gid);
      fs.chmodSync(dir, 0o700);
    }
    fs.chownSync(plan.cache, plan.uid, plan.gid);
    fs.chmodSync(plan.cache, 0o700);
  } catch (error) {
    try { releaseVolumes(plan); } catch (releaseError) { error.releaseFailed = true; }    // never leave a half-acquired mount behind
    throw error;
  }
}

// Read the evidence of a finished run: mount its image read-only (no exec), call fn, always unmount.
export function withRunVolume(plan, fn) {
  ensureLoopImage(plan.workImage, plan.volume, plan.diskBytes, true);
  try { return fn(plan); } finally { releaseRunVolume(plan); }
}

// Start-up sweep. It touches ONLY loop devices whose backing file is a DevTest image under this storage root
// (runs/<id>/volume.img or cache/<name>.img). Docker's, libvirt's and the boot loop devices are never considered.
const defaultHost = {
  listLoops: () => hostCommand('losetup', ['-n', '-O', 'NAME,BACK-FILE']).split('\n').filter(Boolean).map(l => { const i = l.indexOf(' '); return { name: l.slice(0, i), file: l.slice(i).trim() }; }),
  mountedSource,
  umount: target => hostCommand('umount', [target]),
  detach: device => hostCommand('losetup', ['-d', device]),
  containerExists: (name, command) => { const r = command(['container', 'inspect', '--format', '{{.Id}}', name]); return r.status === 0; }
};
export function sweepStaleVolumes(storageRoot, command = dockerCommand, host = defaultHost) {
  const root = fs.realpathSync(storageRoot);
  const result = { released: [], skipped: [], errors: [] };
  const runImage = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/runs/([a-f0-9]{16,32})/volume\\.img$`);
  const cacheImage = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cache/([a-z0-9-]{1,32})\\.img$`);
  for (const loop of host.listLoops()) {
    try {
      let m;
      if ((m = runImage.exec(loop.file))) {
        const id = m[1], workspace = path.join(root, 'runs', id), target = path.join(workspace, 'volume');
        if (alive(readOwner(path.join(workspace, 'lease.json'))) || host.containerExists(`devtest-${id}`, command)) { result.skipped.push(loop.name); continue; }
        const mounted = host.mountedSource(target);
        if (mounted && mounted.source === loop.name) host.umount(target);
        if (host.listLoops().some(l => l.name === loop.name && l.file === loop.file)) host.detach(loop.name);
        result.released.push(loop.name);
      } else if ((m = cacheImage.exec(loop.file))) {
        const target = path.join(root, 'cache', m[1]), users = cacheUsers(target);
        if (fs.existsSync(users)) for (const n of fs.readdirSync(users)) {
          if (!alive(readOwner(path.join(users, n))) && !host.containerExists(`devtest-${n}`, command)) fs.rmSync(path.join(users, n), { force: true });
        }
        if (fs.existsSync(users) && fs.readdirSync(users).length) { result.skipped.push(loop.name); continue; }
        const mounted = host.mountedSource(target);
        if (mounted && mounted.source === loop.name) host.umount(target);
        if (host.listLoops().some(l => l.name === loop.name && l.file === loop.file)) host.detach(loop.name);
        result.released.push(loop.name);
      }
    } catch (error) { result.errors.push(`${loop.name}:${errorClass(error)}`); }
  }
  return result;
}

export function dockerCommand(argv, timeout = 10000) {
  return spawnSync('docker', argv, { encoding: 'utf8', timeout, maxBuffer: 16384, env: dockerEnvironment() });
}

export function dockerEnvironment(source = process.env, uid = process.getuid()) {
  const env = { PATH: source.PATH || '/usr/bin:/bin', HOME: source.HOME || '/' };
  if (source.XDG_RUNTIME_DIR) {
    const runtime = exactDirectory(source.XDG_RUNTIME_DIR, 'XDG runtime directory');
    const st = fs.statSync(runtime);
    if (st.uid !== uid || (st.mode & 0o077) !== 0) throw new RunnerError('XDG runtime directory is not owner-only');
    env.XDG_RUNTIME_DIR = runtime;
  }
  if (source.DOCKER_HOST) {
    if (!env.XDG_RUNTIME_DIR || source.DOCKER_HOST !== `unix://${env.XDG_RUNTIME_DIR}/${'docker' + '.sock'}`)
      throw new RunnerError('only the current user rootless Docker socket is allowed');
    env.DOCKER_HOST = source.DOCKER_HOST;
  }
  return env;
}

export function ownedContainer(plan, command = dockerCommand) {
  const inspect = command(['container', 'inspect', '--format', '{{index .Config.Labels "devtest.run-id"}}', plan.name]);
  if (inspect.status !== 0) {
    if (/No such (object|container)/i.test(inspect.stderr || '')) return false;
    throw new RunnerError('cannot verify container ownership', 7);
  }
  if (inspect.stdout.trim() !== plan.runId) throw new RunnerError('container name belongs to a different owner', 7);
  return true;
}

export function cleanupContainer(plan, command = dockerCommand) {
  if (!ownedContainer(plan, command)) return true;
  command(['container', 'rm', '--force', plan.name]);
  return !ownedContainer(plan, command);
}

const LOG_CAP = 1048576;
const errorClass = error => String(error?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 48);

function logSink() {
  let bytes = 0, truncated = false;
  return {
    write(chunk) {
      if (bytes >= LOG_CAP) { truncated = true; return; }
      const piece = chunk.subarray(0, LOG_CAP - bytes);
      // Subject output can contain credentials. Never persist it, even before a scan.
      bytes += piece.length;
      if (piece.length < chunk.length) truncated = true;
    },
    close() { return { bytes, truncated, persisted: false }; }
  };
}

// Exit state is read before removal (the container is not started with --rm) so a missing binary, a kill and a
// memory-limit kill are subject outcomes, and only a Docker-level failure is an internal error.
export function containerState(plan, command = dockerCommand) {
  const r = command(['container', 'inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}}', plan.name]);
  if (r.status !== 0) return null;
  const [code, oom] = r.stdout.trim().split(' ');
  return Number.isInteger(Number(code)) ? { exitCode: Number(code), oomKilled: oom === 'true' } : null;
}

export async function runContainer(plan, { command = dockerCommand, spawnRun = spawn, ensureVolumes = ensureLoopVolumes, releaseVolumes: release = releaseVolumes, sweep = sweepStaleVolumes, keepVolume = false } = {}) {
  if (ownedContainer(plan, command)) throw new RunnerError('run container name is already in use', 7);
  const localImage = command(['image', 'inspect', '--format', '{{.Id}}', plan.image]);
  if (localImage.status !== 0) throw new RunnerError('pinned image is not locally available; pull through a reviewed update path', 3);
  verifyTargets(plan);
  prepareDirectories(plan);
  let swept;
  try { swept = sweep(plan.storage, command); } catch (error) { swept = { error: errorClass(error) }; }   // a failed sweep never blocks a run
  let outcome, thrown = null;
  try {
    ensureVolumes(plan);
    outcome = await executeRun(plan, command, spawnRun);
  } catch (error) { thrown = error; }
  // Released on every outcome, including a failed start. keepVolume lets the caller read evidence first and then call
  // releaseVolumes(plan) itself; the default never leaves a mount or loop device behind.
  let volume = { released: !keepVolume || !!thrown, retained: keepVolume && !thrown, error: null };
  if (!keepVolume || thrown) {
    try { release(plan); volume = { released: true, retained: false, error: null }; }
    catch (error) { volume = { released: false, retained: false, error: errorClass(error) }; }
  }
  if (thrown) throw thrown;
  const incomplete = !volume.released && !volume.retained;
  return { ...outcome, exitCode: incomplete ? 7 : outcome.exitCode, cleanup: incomplete || outcome.cleanup !== 'complete' ? 'incomplete' : 'complete', volume, sweep: swept };
}

async function executeRun(plan, command, spawnRun) {
  const stdout = logSink(), stderr = logSink();
  const child = spawnRun('docker', plan.args, { stdio: ['ignore', 'pipe', 'pipe'], env: dockerEnvironment() });
  child.stdout?.on('data', chunk => stdout.write(chunk)); child.stderr?.on('data', chunk => stderr.write(chunk));
  let timedOut = false, interrupted = false;
  const stop = () => { interrupted = true; child.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, plan.timeoutMs);
  let code;
  try {
    code = await new Promise(resolve => { child.once('error', () => resolve(125)); child.once('close', value => resolve(value ?? 125)); });
  } finally {
    clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
  const logs = { stdout: stdout.close(), stderr: stderr.close() };
  let state = null, cleanupError = null;
  try { state = containerState(plan, command); } catch (error) { cleanupError = errorClass(error); }
  let clean;
  try { clean = cleanupContainer(plan, command); } catch (error) { clean = false; cleanupError = errorClass(error); }
  // 125 is Docker's own failure; with no container state it is internal. Any other code is the subject's.
  const internal = state === null && code >= 125;
  const reason = state?.oomKilled ? 'memory_limit' : timedOut ? 'timeout' : interrupted ? 'interrupted' : null;
  const exitCode = !clean ? 7 : interrupted ? 130 : timedOut ? 5 : internal ? 6 : (state ? state.exitCode : code) === 0 && !state?.oomKilled ? 0 : 1;
  return { runId: plan.runId, image: plan.image, exitCode, reason, subjectExit: state?.exitCode ?? null, cleanup: clean ? 'complete' : 'incomplete', cleanupError, timedOut, interrupted, logs };
}
