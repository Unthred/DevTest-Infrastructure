import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const defaultRegistry = new URL('./providers.json', import.meta.url).pathname;
export const terminal = new Set(['completed', 'failed', 'blocked', 'stopped']);
export class SupervisorError extends Error {}
export const realClock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

export function stateRoot(value = process.env.AI_SUPERVISOR_STATE_ROOT || '/mnt/cache/ai-supervisor') {
  const root = path.resolve(value);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new SupervisorError('state root may not be a symlink');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(root);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new SupervisorError('state root must be owned by this user and mode 0700');
  return root;
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dir); fs.closeSync(dir);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function jobFile(root, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new SupervisorError('invalid job ID');
  return path.join(root, 'jobs', `${id}.json`);
}
export function readJob(root, id) { return JSON.parse(fs.readFileSync(jobFile(root, id), 'utf8')); }
export function saveJob(root, job, clock = realClock) { job.updatedAt = clock.now(); atomicJson(jobFile(root, job.id), job); }
export function event(root, job, kind, clock = realClock) {
  const file = path.join(root, 'events', `${job.id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ at: clock.now(), job: job.id, kind }) + '\n', { mode: 0o600 });
}
export function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (r.status !== 0) throw new SupervisorError(`Git check failed: ${args[0]}`);
  return r.stdout.trim();
}
export function validateSpec(spec) {
  for (const key of ['role', 'provider', 'repository', 'worktree', 'issue', 'scope', 'allowedActions', 'prompt'])
    if (!(key in spec)) throw new SupervisorError(`missing job field: ${key}`);
  if (!/^[a-z][a-z-]{1,31}$/.test(spec.role) || !Number.isSafeInteger(spec.issue) || spec.issue < 1 || !String(spec.scope).trim() || !String(spec.prompt).trim()) throw new SupervisorError('invalid role, issue, scope or prompt');
  if (!Array.isArray(spec.allowedActions) || !spec.allowedActions.every(x => typeof x === 'string')) throw new SupervisorError('invalid allowedActions');
  const repository = fs.realpathSync(spec.repository), worktree = fs.realpathSync(spec.worktree);
  if (repository === worktree || git(repository, 'rev-parse', '--show-toplevel') !== repository || git(worktree, 'rev-parse', '--show-toplevel') !== worktree)
    throw new SupervisorError('repository and dedicated worktree must be distinct Git roots');
  const common = fs.realpathSync(git(worktree, 'rev-parse', '--git-common-dir'));
  if (common !== fs.realpathSync(path.join(repository, '.git'))) throw new SupervisorError('worktree does not belong to repository');
  const branch = git(worktree, 'symbolic-ref', '--short', 'HEAD');
  if (['main', 'master'].includes(branch)) throw new SupervisorError('job must use a feature branch');
  const handover = spec.handover ? path.resolve(worktree, spec.handover) : null;
  if (handover && !handover.startsWith(worktree + path.sep)) throw new SupervisorError('handover must be in worktree');
  return { ...spec, repository, worktree, branch, handover };
}
export async function provider(registry, id) {
  const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
  if (data.schemaVersion !== 1) throw new SupervisorError('unsupported registry version');
  const config = data.providers?.[id];
  if (!config || !/^[a-z][a-z0-9_]*$/.test(config.adapter) || !Array.isArray(config.command) || !config.command.every(x => typeof x === 'string') || !config.command.length)
    throw new SupervisorError('provider is not registered or has invalid configuration');
  const adapter = await import(`./adapters/${config.adapter}.mjs`);
  return { config, adapter };
}
export function leaseKeys(job) {
  // A shared repository may host parallel jobs; the issue and worktree are exclusive.
  return [`issue:${job.repository}#${job.issue}`, `worktree:${job.worktree}`].map(v => crypto.createHash('sha256').update(v).digest('hex'));
}
export async function createJob(root, spec, registry = defaultRegistry, clock = realClock) {
  const checked = validateSpec(spec);
  const { adapter } = await provider(registry, checked.provider);
  const job = { ...checked, id: crypto.randomBytes(16).toString('hex'), schemaVersion: 1, status: 'queued', autoResume: spec.autoResume === true,
    createdAt: clock.now(), updatedAt: clock.now(), attempts: 0, resetAt: null, nextAttemptAt: null, sessionId: null,
    workerPid: null, workerStart: null, childPid: null, lastEvent: null, lastProgress: null, checkpoint: null, capabilities: adapter.capabilities };
  fs.mkdirSync(path.join(root, 'leases'), { recursive: true, mode: 0o700 });
  const acquired = [];
  try {
    for (const key of leaseKeys(job)) {
      const file = path.join(root, 'leases', key);
      fs.writeFileSync(file, JSON.stringify({ job: job.id, at: clock.now() }), { flag: 'wx', mode: 0o600 });
      acquired.push(file);
    }
    saveJob(root, job, clock); event(root, job, 'created', clock);
    return job;
  } catch (error) {
    for (const file of acquired) fs.unlinkSync(file);
    if (error.code === 'EEXIST') throw new SupervisorError('issue or worktree already leased; stale lease requires explicit recovery');
    throw error;
  }
}
export function releaseLeases(root, job) {
  if (!terminal.has(job.status)) throw new SupervisorError('cannot release active lease');
  for (const key of leaseKeys(job)) {
    const file = path.join(root, 'leases', key);
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).job === job.id) fs.unlinkSync(file);
  }
  event(root, job, 'leases_released');
}
export function checkpoint(root, job, clock = realClock) {
  const head = git(job.worktree, 'rev-parse', 'HEAD');
  const status = git(job.worktree, 'status', '--short', '--untracked-files=no').split('\n').filter(Boolean).slice(0, 80);
  let issueState = job.checkpoint?.issueState || 'unknown';
  let issueCheckedAt = job.checkpoint?.issueCheckedAt || 0;
  if (clock.now() - issueCheckedAt >= 300000 && git(job.worktree, 'remote').split('\n').includes('origin')) {
    const result = spawnSync('gh', ['issue', 'view', String(job.issue), '--json', 'state'], { cwd: job.worktree, encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
    if (result.status === 0) {
      try { issueState = JSON.parse(result.stdout).state || 'unknown'; issueCheckedAt = clock.now(); } catch { /* retain prior state */ }
    }
  }
  let handoverSha256 = null;
  if (job.handover && fs.existsSync(job.handover) && fs.statSync(job.handover).isFile()) {
    const fd = fs.openSync(job.handover, 'r');
    try { const buffer = Buffer.alloc(65536); const size = fs.readSync(fd, buffer, 0, buffer.length, 0); handoverSha256 = crypto.createHash('sha256').update(buffer.subarray(0, size)).digest('hex'); }
    finally { fs.closeSync(fd); }
  }
  job.checkpoint = { at: clock.now(), head, status, issueState, issueCheckedAt, handoverSha256 };
  job.lastProgress = clock.now(); saveJob(root, job, clock); event(root, job, 'checkpoint', clock);
}
export function prompt(job, resume = false) {
  let head = `Selected launcher role: ${job.role}. Supervised issue #${job.issue} in ${job.worktree}. Approved scope: ${job.scope}. Allowed actions: ${job.allowedActions.join(', ')}. Preserve project and role governance. Do not purchase credits, switch to paid API billing, deploy, merge, reboot or change credentials without separate authorization. Update handover at ${job.handover || '(none specified)'} during normal work.`;
  if (resume) head += ` Resume the SAME issue and worktree. Read issue, Git state and handover before changing anything. Last checkpoint HEAD: ${job.checkpoint?.head || 'unknown'}. Avoid duplicate actions.`;
  return head + '\n\n' + job.prompt;
}
export function safeEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/_API_KEY$|_ACCESS_TOKEN$/.test(key) || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].includes(key)) delete env[key];
  return env;
}
export function transition(root, job, status, kind, clock = realClock) {
  job.status = status; job.lastEvent = kind; saveJob(root, job, clock); event(root, job, kind, clock);
}
export async function drive(root, job, registry = defaultRegistry, clock = realClock, runOnce, maxAttempts = 4) {
  const { config, adapter } = await provider(registry, job.provider);
  while (true) {
    checkpoint(root, job, clock);
    if (job.checkpoint.issueState === 'CLOSED') { transition(root, job, 'blocked', 'issue_closed', clock); return job; }
    transition(root, job, 'running', 'started', clock);
    job.attempts++; saveJob(root, job, clock);
    let result;
    try { result = await runOnce(config, adapter, job, clock); }
    catch { result = { code: 1, event: 'crash' }; }
    const external = readJob(root, job.id);
    if (external.status === 'paused_manual' || external.status === 'stopped') Object.assign(job, external);
    checkpoint(root, job, clock);
    if (job.status === 'paused_manual' || job.status === 'stopped') return job;
    if (result.code === 0 && !result.event) { transition(root, job, 'completed', 'completed', clock); return job; }
    if (result.event === 'usage_limit' && adapter.capabilities.usageReset && job.autoResume) {
      if (job.attempts >= maxAttempts) { transition(root, job, 'blocked', 'retry_exhausted', clock); return job; }
      const now = clock.now();
      const delay = result.resetAt && result.resetAt > now ? Math.max(300000, Math.min(604800000, result.resetAt + 120000 - now)) : Math.min(86400000, 3600000 * 2 ** (job.attempts - 1));
      job.resetAt = result.resetAt || null; job.nextAttemptAt = now + delay;
      transition(root, job, 'paused_limit', 'usage_limit', clock);
      await clock.sleep(delay); // no CLI process or model invocation in the wait
      continue;
    }
    if (result.event === 'transient_rate_limit' && job.autoResume && job.attempts < maxAttempts) {
      const delay = Math.min(1800000, 60000 * 2 ** (job.attempts - 1));
      job.nextAttemptAt = clock.now() + delay;
      transition(root, job, 'paused_limit', 'transient_rate_limit', clock);
      await clock.sleep(delay); continue;
    }
    const blocked = ['auth_error', 'approval_required', 'context_limit', 'usage_limit'].includes(result.event);
    transition(root, job, blocked ? 'blocked' : 'failed', result.event || 'crash', clock);
    return job;
  }
}
export function processStart(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21]; } catch { return null; }
}
export function claimWorker(root, id) {
  const dir = path.join(root, 'workers'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, start: processStart(process.pid) }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new SupervisorError('worker claim exists; recover after checking process ownership'); throw error; }
  return () => { if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); };
}
export function recover(root, id, force = false) {
  const job = readJob(root, id);
  if (job.workerPid && processStart(job.workerPid) === job.workerStart) throw new SupervisorError('worker is still running; refusing takeover');
  if (job.childPid && processStart(job.childPid)) throw new SupervisorError('child PID still exists; refusing takeover');
  const claim = path.join(root, 'workers', `${id}.json`);
  if (fs.existsSync(claim)) {
    const owner = JSON.parse(fs.readFileSync(claim, 'utf8'));
    if (processStart(owner.pid) === owner.start) throw new SupervisorError('worker claim still active');
    fs.unlinkSync(claim);
  }
  if (job.status === 'running' && !force) { transition(root, job, 'blocked', 'orphaned_worker'); throw new SupervisorError('orphaned worker requires explicit recovery'); }
  job.workerPid = null; job.workerStart = null; job.childPid = null; job.status = 'queued'; saveJob(root, job);
  event(root, job, 'recovered'); return job;
}
