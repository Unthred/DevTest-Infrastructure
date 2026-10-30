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
  const limits = config.limits || {};
  if (!(limits.cpus > 0 && limits.cpus <= 4) || !Number.isSafeInteger(limits.memoryMb) || limits.memoryMb < 128 || limits.memoryMb > 8192 ||
      !Number.isSafeInteger(limits.pids) || limits.pids < 16 || limits.pids > 512 || !Number.isSafeInteger(limits.shmMb) || limits.shmMb < 16 || limits.shmMb > 1024 ||
      !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1000 || limits.timeoutMs > 3600000) throw new RunnerError('resource limits are missing or outside the bounded policy');
  const workspace = path.join(storage, 'runs', spec.runId);
  const work = path.join(workspace, 'work'), out = path.join(workspace, 'out');
  const cache = path.join(storage, 'cache', spec.image.startsWith('dotnet-') ? 'nuget' : 'playwright');
  const name = `devtest-${spec.runId}`;
  const args = ['run', '--rm', '--pull=never', '--name', name, '--label', `devtest.run-id=${spec.runId}`,
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--read-only', '--network=none',
    '--cpus', String(limits.cpus), '--memory', `${limits.memoryMb}m`, '--pids-limit', String(limits.pids), '--shm-size', `${limits.shmMb}m`,
    '--user', `${config.uid}:${config.gid}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--mount', `type=bind,src=${project},dst=/src,readonly`,
    '--mount', `type=bind,src=${work},dst=/work`, '--mount', `type=bind,src=${out},dst=/out`,
    '--mount', `type=bind,src=${cache},dst=/cache`, '--workdir', '/work', image, ...spec.command];
  return { runId: spec.runId, name, image, project, storage, workspace, work, out, cache, uid: config.uid, gid: config.gid, timeoutMs: limits.timeoutMs, args };
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
  for (const dir of [plan.workspace, plan.work, plan.out]) {
    fs.mkdirSync(dir, { mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new RunnerError('run directory may not be a symlink');
  }
  fs.mkdirSync(path.dirname(plan.cache), { recursive: true, mode: 0o700 });
  safeParent(path.dirname(plan.cache));
  if (!fs.existsSync(plan.cache)) fs.mkdirSync(plan.cache, { mode: 0o700 });
  if (fs.lstatSync(plan.cache).isSymbolicLink()) throw new RunnerError('cache directory may not be a symlink');
  for (const dir of [plan.work, plan.out, plan.cache]) {
    const st = fs.statSync(dir);
    if (st.uid !== plan.uid || st.gid !== plan.gid) {
      if (fs.readdirSync(dir).length) throw new RunnerError('nonempty writable directory has unexpected owner');
      fs.chownSync(dir, plan.uid, plan.gid);
    }
    fs.chmodSync(dir, 0o700);
  }
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

export async function runContainer(plan, { command = dockerCommand, spawnRun = spawn } = {}) {
  prepareDirectories(plan);
  const localImage = command(['image', 'inspect', '--format', '{{.Id}}', plan.image]);
  if (localImage.status !== 0) throw new RunnerError('pinned image is not locally available; pull through a reviewed update path', 3);
  const child = spawnRun('docker', plan.args, { stdio: ['ignore', 'ignore', 'ignore'], env: dockerEnvironment() });
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
  let clean;
  try { clean = cleanupContainer(plan, command); } catch { clean = false; }
  const exitCode = !clean ? 7 : interrupted ? 130 : timedOut ? 5 : code >= 125 ? 6 : code === 0 ? 0 : 1;
  return { runId: plan.runId, image: plan.image, exitCode, cleanup: clean ? 'complete' : 'incomplete', timedOut, interrupted };
}
