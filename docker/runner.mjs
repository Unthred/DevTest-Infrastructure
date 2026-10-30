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

export function createPlan(spec, config) {
  const project = exactDirectory(spec.project, 'project');
  const allowlist = config.allowedProjects?.map(p => exactDirectory(p, 'allowlisted project')) || [];
  if (!allowlist.includes(project)) throw new RunnerError('project is not in the exact allowlist');
  if (!inside('/mnt/user/projects', project)) throw new RunnerError('project must be under /mnt/user/projects');
  const storage = exactDirectory(config.storageRoot, 'storage root');
  if (!inside('/mnt/cache', storage)) throw new RunnerError('storage root must be on /mnt/cache');
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
    '--mount', `type=bind,src=${cache},dst=/cache${phase === 'restore' ? '' : ',readonly'}`, '--workdir', '/work', image, ...spec.command];
  return { runId: spec.runId, name, image, project, storage, workspace, volume, workImage, cacheImage, phase, work, out, cache, uid: config.uid, gid: config.gid, timeoutMs: limits.timeoutMs, diskBytes: limits.diskMb * 1048576, cacheBytes: limits.cacheMb * 1048576, logDir: path.join(workspace, 'logs'), args };
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

function ensureLoopImage(image, target, bytes) {
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
  hostCommand('mount', ['-t', 'ext4', '-o', 'loop,nosuid,nodev', image, target]);
  if (!mountedSource(target)) throw new RunnerError('bounded storage mount was not established', 3);
}

// A finite ext4 loop image supplies the hard ENOSPC ceiling before a write can exceed the budget.
// Cache remains mounted for reuse; the run volume remains mounted until the caller has collected evidence.
export function ensureLoopVolumes(plan) {
  ensureLoopImage(plan.cacheImage, plan.cache, plan.cacheBytes);
  ensureLoopImage(plan.workImage, plan.volume, plan.diskBytes);
  for (const dir of [plan.work, plan.out]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chownSync(dir, plan.uid, plan.gid);
    fs.chmodSync(dir, 0o700);
  }
  fs.chownSync(plan.cache, plan.uid, plan.gid);
  fs.chmodSync(plan.cache, 0o700);
}

export function releaseRunVolume(plan) {
  const mounted = mountedSource(plan.volume);
  if (!mounted) return;
  if (mounted.type !== 'ext4' || hostCommand('losetup', ['-n', '-O', 'BACK-FILE', mounted.source]) !== plan.workImage)
    throw new RunnerError('refusing to unmount foreign run volume', 4);
  hostCommand('umount', [plan.volume]);
}

export function releaseCacheVolume(plan) {
  const mounted = mountedSource(plan.cache);
  if (!mounted) return;
  if (mounted.type !== 'ext4' || hostCommand('losetup', ['-n', '-O', 'BACK-FILE', mounted.source]) !== plan.cacheImage)
    throw new RunnerError('refusing to unmount foreign cache volume', 4);
  hostCommand('umount', [plan.cache]);
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

export async function runContainer(plan, { command = dockerCommand, spawnRun = spawn, ensureVolumes = ensureLoopVolumes } = {}) {
  if (ownedContainer(plan, command)) throw new RunnerError('run container name is already in use', 7);
  const localImage = command(['image', 'inspect', '--format', '{{.Id}}', plan.image]);
  if (localImage.status !== 0) throw new RunnerError('pinned image is not locally available; pull through a reviewed update path', 3);
  prepareDirectories(plan);
  ensureVolumes(plan);
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
