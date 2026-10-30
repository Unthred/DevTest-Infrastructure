import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const defaultRegistry = new URL('./providers.json', import.meta.url).pathname;
export const terminal = new Set(['completed', 'failed', 'blocked', 'stopped']);
export const allowedActions = new Set(['read', 'edit', 'test', 'push_feature_branch', 'create_pr', 'update_issue', 'update_handover']);
export class SupervisorError extends Error {}
export const realClock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export async function sleepUntil(clock, target) {
  while (clock.now() < target) await clock.sleep(Math.min(86400000, target - clock.now()));
}

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
export function saveJob(root, job, clock = realClock, force = false) {
  const lockDir = path.join(root, 'job-locks', job.id);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  let locked = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { fs.mkdirSync(lockDir, { mode: 0o700 }); locked = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (!locked) throw new SupervisorError('job state lock is held; inspect owner before recovery');
  try {
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }), { mode: 0o600 });
    const file = jobFile(root, job.id);
    if (!force && fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((current.status === 'paused_manual' || terminal.has(current.status)) && current.status !== job.status) {
        Object.assign(job, current);
        return;
      }
    }
    job.updatedAt = clock.now(); atomicJson(file, job);
  } finally { fs.unlinkSync(path.join(lockDir, 'owner.json')); fs.rmdirSync(lockDir); }
}
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
  for (const key of ['role', 'provider', 'repository', 'worktree', 'issue', 'scope', 'allowed_actions', 'prompt'])
    if (!(key in spec)) throw new SupervisorError(`missing job field: ${key}`);
  if (!/^[a-z][a-z-]{1,31}$/.test(spec.role) || !Number.isSafeInteger(spec.issue) || spec.issue < 1 || !String(spec.scope).trim() || !String(spec.prompt).trim()) throw new SupervisorError('invalid role, issue, scope or prompt');
  if (!Array.isArray(spec.allowed_actions) || !spec.allowed_actions.length || !spec.allowed_actions.every(x => allowedActions.has(x)) || new Set(spec.allowed_actions).size !== spec.allowed_actions.length)
    throw new SupervisorError('allowed_actions must be a unique closed-list selection');
  const repository = fs.realpathSync(spec.repository), worktree = fs.realpathSync(spec.worktree);
  if (repository === worktree || git(repository, 'rev-parse', '--show-toplevel') !== repository || git(worktree, 'rev-parse', '--show-toplevel') !== worktree)
    throw new SupervisorError('repository and dedicated worktree must be distinct Git roots');
  const common = fs.realpathSync(git(worktree, 'rev-parse', '--git-common-dir'));
  if (common !== fs.realpathSync(path.join(repository, '.git'))) throw new SupervisorError('worktree does not belong to repository');
  const branch = git(worktree, 'symbolic-ref', '--short', 'HEAD');
  if (['main', 'master'].includes(branch)) throw new SupervisorError('job must use a feature branch');
  const handover = spec.handover ? path.resolve(worktree, spec.handover) : null;
  if (handover && !handover.startsWith(worktree + path.sep)) throw new SupervisorError('handover must be in worktree');
  const { allowed_actions, ...rest } = spec;
  return { ...rest, allowedActions: allowed_actions, repository, worktree, branch, handover };
}
export async function provider(registry, id) {
  const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
  if (data.schemaVersion !== 1) throw new SupervisorError('unsupported registry version');
  const entry = data.providers?.[id];
  if (!entry || !/^[a-z][a-z0-9_]*$/.test(entry.adapter) || typeof entry.manifest !== 'string' || !/^[a-z0-9/_-]+\.json$/.test(entry.manifest) || entry.manifest.includes('..'))
    throw new SupervisorError('provider is not registered or has invalid configuration');
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(registry), entry.manifest), 'utf8'));
  validateManifest(manifest, id);
  const config = { command: [manifest.launch.command, ...manifest.launch.args], manifest };
  const adapter = await import(`./adapters/${entry.adapter}.mjs`);
  return { config, adapter };
}
export function validateManifest(m, id) {
  const exact = (object, allowed, required, label) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !allowed.includes(key)) || required.some(key => !(key in object)))
      throw new SupervisorError(`invalid ${label}: unknown or missing field`);
  };
  exact(m, ['schema_version', 'id', 'display_name', 'adapter_version', 'launch', 'resume', 'capabilities', 'billing', 'events'],
    ['schema_version', 'id', 'display_name', 'adapter_version', 'launch', 'capabilities', 'billing'], 'provider manifest');
  if (m.schema_version !== 1 || m.id !== id || !/^[a-z][a-z0-9-]{1,31}$/.test(m.id) || !m.display_name || !/^\d+\.\d+\.\d+$/.test(m.adapter_version))
    throw new SupervisorError('invalid provider manifest identity/version');
  exact(m.launch, ['command', 'args', 'env_allowlist'], ['command', 'args'], 'launch');
  if (typeof m.launch.command !== 'string' || !m.launch.command || !Array.isArray(m.launch.args) || !m.launch.args.every(x => typeof x === 'string')) throw new SupervisorError('invalid launch command');
  if (m.launch.env_allowlist && (!Array.isArray(m.launch.env_allowlist) || !m.launch.env_allowlist.every(x => /^[A-Z_][A-Z0-9_]*$/.test(x)))) throw new SupervisorError('invalid env allowlist');
  if (m.resume) { exact(m.resume, ['args'], ['args'], 'resume'); if (!Array.isArray(m.resume.args) || !m.resume.args.every(x => typeof x === 'string')) throw new SupervisorError('invalid resume args'); }
  const caps = ['launch', 'resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing', 'checkpoint', 'non_interactive', 'structured_output'];
  exact(m.capabilities, caps, caps.slice(0, 7), 'capabilities');
  if (Object.values(m.capabilities).some(x => !['supported', 'unsupported', 'unverified'].includes(x)) || m.capabilities.launch !== 'supported' || m.capabilities.checkpoint !== 'supported')
    throw new SupervisorError('invalid provider capabilities');
  exact(m.billing, ['model', 'fallback_to_other_billing'], ['model', 'fallback_to_other_billing'], 'billing');
  if (!['subscription', 'api', 'unknown'].includes(m.billing.model) || m.billing.fallback_to_other_billing !== false) throw new SupervisorError('billing fallback must be false');
  if (m.events && (!Array.isArray(m.events) || !m.events.every(x => ['usage_limit', 'transient_rate_limit', 'context_limit', 'auth_error', 'approval_required', 'network_error', 'crash'].includes(x)))) throw new SupervisorError('invalid events');
}
export function leaseKeys(job) {
  // A shared repository may host parallel jobs; the issue and worktree are exclusive.
  return [`issue:${job.repository}#${job.issue}`, `worktree:${job.worktree}`].map(v => crypto.createHash('sha256').update(v).digest('hex'));
}
export async function createJob(root, spec, registry = defaultRegistry, clock = realClock) {
  const checked = validateSpec(spec);
  const { config } = await provider(registry, checked.provider);
  const capabilities = config.manifest.capabilities;
  if (spec.autoResume === true && ['resume', 'usage_limit_detection', 'reset_time_parsing', 'non_interactive'].some(key => capabilities[key] !== 'supported'))
    throw new SupervisorError('auto-resume requires verified supported provider capabilities');
  const job = { ...checked, id: crypto.randomBytes(16).toString('hex'), schemaVersion: 1, status: 'queued', autoResume: spec.autoResume === true,
    createdAt: clock.now(), updatedAt: clock.now(), attempts: 0, resetAt: null, nextAttemptAt: null, sessionId: null,
    workerPid: null, workerStart: null, childPid: null, lastEvent: null, lastProgress: null, checkpoint: null, capabilities,
    currentAttemptId: null };
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
  let handoverExcerpt = null;
  if (job.handover && fs.existsSync(job.handover) && fs.statSync(job.handover).isFile()) {
    const fd = fs.openSync(job.handover, 'r');
    try {
      const buffer = Buffer.alloc(65536); const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      handoverSha256 = crypto.createHash('sha256').update(buffer.subarray(0, size)).digest('hex');
      // Only heading labels are retained; body text and command output are never copied.
      handoverExcerpt = buffer.subarray(0, Math.min(size, 4096)).toString('utf8').split('\n')
        .filter(line => /^#{1,4} /.test(line)).slice(0, 4)
        .map(line => /^(#{1,4}) (current handover|status|completed|next|blockers|evidence)\s*$/i.test(line) ? line.slice(0, 40) : '[heading redacted]');
    }
    finally { fs.closeSync(fd); }
  }
  const previous = job.checkpoint;
  const handoverStale = !!(job.handover && previous && previous.handoverSha256 === handoverSha256 &&
    (previous.handoverStale || previous.head !== head || JSON.stringify(previous.status) !== JSON.stringify(status)));
  job.checkpoint = { at: clock.now(), head, status, issueState, issueCheckedAt, handoverSha256, handoverExcerpt, handoverStale };
  job.lastProgress = clock.now(); saveJob(root, job, clock); event(root, job, 'checkpoint', clock);
}
export function prompt(job, resume = false) {
  let head = `Selected launcher role: ${job.role}. Supervised issue #${job.issue} in ${job.worktree}. Approved scope: ${job.scope}. Allowed actions: ${job.allowedActions.join(', ')}. Preserve project and role governance. Do not purchase credits, switch to paid API billing, deploy, merge, reboot or change credentials without separate authorization.`;
  if (job.handover) head += ` Read the handover at ${job.handover} and update it only when the approved actions permit edits.`;
  if (resume) head += ` Resume the SAME issue and worktree. Read issue, Git state and handover before changing anything. Last checkpoint HEAD: ${job.checkpoint?.head || 'unknown'}. Avoid duplicate actions.`;
  return head + '\n\n' + job.prompt;
}
export function safeEnvironment(source = process.env, allowlist = null) {
  const env = allowlist ? Object.fromEntries(allowlist.filter(key => key in source).map(key => [key, source[key]])) : { ...source };
  for (const key of Object.keys(env)) if (/_API_KEY$|_ACCESS_TOKEN$/.test(key) || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].includes(key)) delete env[key];
  return env;
}
export function transition(root, job, status, kind, clock = realClock) {
  job.status = status; job.lastEvent = kind; saveJob(root, job, clock);
  event(root, job, job.status === status ? kind : 'transition_ignored', clock);
}
export async function drive(root, job, registry = defaultRegistry, clock = realClock, runOnce, maxAttempts = 4) {
  const { config, adapter } = await provider(registry, job.provider);
  while (true) {
    checkpoint(root, job, clock);
    if (job.checkpoint.issueState === 'CLOSED') { transition(root, job, 'blocked', 'issue_closed', clock); return job; }
    if (job.attempts > 0 && job.checkpoint.handoverStale) { transition(root, job, 'blocked', 'stale_handover', clock); return job; }
    transition(root, job, 'running', 'started', clock);
    job.attempts++; job.currentAttemptId = crypto.randomUUID(); saveJob(root, job, clock);
    let result;
    try { result = await runOnce(config, adapter, job, clock); }
    catch (error) {
      const errorClass = String(error?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 48);
      event(root, job, `run_exception:${errorClass}:message_redacted`, clock);
      result = { code: 1, event: 'crash' };
    }
    const external = readJob(root, job.id);
    if (external.status === 'paused_manual' || external.status === 'stopped') Object.assign(job, external);
    checkpoint(root, job, clock);
    if (job.status === 'paused_manual' || job.status === 'stopped') return job;
    if (result.code === 0 && (!result.event || ['transient_rate_limit', 'network_error'].includes(result.event))) {
      transition(root, job, 'completed', 'completed', clock); return job;
    }
    if (result.event === 'usage_limit' && config.manifest.capabilities.usage_limit_detection === 'supported' && job.autoResume) {
      if (job.attempts >= maxAttempts) { transition(root, job, 'blocked', 'retry_exhausted', clock); return job; }
      const now = clock.now();
      const verifiedReset = result.verified === true && result.resetSource === 'provider_reported' && result.resetAt > now;
      const delay = verifiedReset ? Math.max(300000, result.resetAt + 120000 - now) : Math.min(86400000, 3600000 * 2 ** (job.attempts - 1));
      job.resetAt = verifiedReset ? result.resetAt : null; job.nextAttemptAt = now + delay;
      transition(root, job, 'paused_limit', 'usage_limit', clock);
      await sleepUntil(clock, now + delay); // no CLI process or model invocation in the wait
      continue;
    }
    if (result.event === 'transient_rate_limit' && job.autoResume && job.attempts < maxAttempts) {
      const delay = Math.min(1800000, 60000 * 2 ** (job.attempts - 1));
      job.nextAttemptAt = clock.now() + delay;
      transition(root, job, 'paused_limit', 'transient_rate_limit', clock);
      await clock.sleep(delay); continue;
    }
    if (result.event === 'context_limit' && job.autoResume && job.attempts < maxAttempts) {
      // Due immediately: if this worker dies before relaunching, reconcile can still revive the job.
      job.sessionId = null; job.nextAttemptAt = clock.now(); saveJob(root, job, clock);
      transition(root, job, 'queued', 'context_fresh_session', clock); continue;
    }
    if (['network_error', 'crash'].includes(result.event) && job.autoResume && job.attempts < maxAttempts) {
      const delay = result.event === 'network_error' ? Math.min(300000, 30000 * 2 ** (job.attempts - 1)) : Math.min(120000, 10000 * 2 ** (job.attempts - 1));
      job.nextAttemptAt = clock.now() + delay;
      transition(root, job, 'queued', result.event, clock);
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
  const stateLock = path.join(root, 'job-locks', id);
  if (fs.existsSync(stateLock)) {
    const ownerFile = path.join(stateLock, 'owner.json');
    if (!fs.existsSync(ownerFile)) throw new SupervisorError('state lock owner is unknown; inspect before recovery');
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (processStart(owner.pid) === owner.start) throw new SupervisorError('state lock owner still active');
    fs.unlinkSync(ownerFile); fs.rmdirSync(stateLock); event(root, job, 'stale_state_lock_recovered');
  }
  const claim = path.join(root, 'workers', `${id}.json`);
  if (fs.existsSync(claim)) {
    const owner = JSON.parse(fs.readFileSync(claim, 'utf8'));
    if (processStart(owner.pid) === owner.start) throw new SupervisorError('worker claim still active');
    fs.unlinkSync(claim);
  }
  if (job.status === 'running' && !force) { transition(root, job, 'blocked', 'orphaned_worker'); throw new SupervisorError('orphaned worker requires explicit recovery'); }
  job.workerPid = null; job.workerStart = null; job.childPid = null; job.status = 'queued'; saveJob(root, job, realClock, true);
  event(root, job, 'recovered'); return job;
}
