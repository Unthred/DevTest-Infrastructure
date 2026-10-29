#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SupervisorError, claimWorker, createJob, defaultRegistry, drive, jobFile, processStart, provider, readJob, recover, releaseLeases, saveJob, stateRoot, transition, realClock } from './core.mjs';
import { runProcess } from './process.mjs';

const self = fileURLToPath(import.meta.url);
function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (['auto-resume', 'foreground', 'force'].includes(key)) out[key] = true;
    else if (key === 'no-auto-resume') out[key] = false;
    else out[key] = list[++i];
  }
  return out;
}
function print(job) {
  const { id, provider, issue, repository, worktree, branch, status, autoResume, attempts, resetAt, nextAttemptAt, workerPid, childPid, lastEvent, checkpoint, capabilities } = job;
  console.log(JSON.stringify({ id, provider, issue, repository, worktree, branch, status, autoResume, attempts, resetAt, nextAttemptAt, workerPid, childPid, lastEvent, checkpoint, capabilities }, null, 2));
}
function startWorker(root, id, registry) {
  const child = spawn(process.execPath, [self, 'worker', id, '--state-root', root, '--registry', registry],
    { detached: true, stdio: 'ignore', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root } });
  child.unref();
  return child.pid;
}
function reconcileOnce(root, registry) {
  const dir = path.join(root, 'jobs');
  let resumed = 0, blocked = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    const current = readJob(root, name.slice(0, -5));
    if (current.workerPid && processStart(current.workerPid) === current.workerStart) continue;
    if (current.status === 'paused_limit' && current.autoResume && (current.nextAttemptAt || 0) <= Date.now()) {
      recover(root, current.id, false); startWorker(root, current.id, registry); resumed++;
    } else if (current.status === 'running') { transition(root, current, 'blocked', 'orphaned_worker'); blocked++; }
  }
  return { resumed, blocked };
}
async function main() {
  const command = process.argv[2] || 'help';
  const a = args(process.argv.slice(3));
  const root = stateRoot(a['state-root']);
  const registry = path.resolve(a.registry || defaultRegistry);
  if (command === 'help') {
    console.log('ai-supervisor dry-run|start --spec FILE [--foreground] [--registry FILE]\n  status [ID] | logs ID | pause ID | stop ID | resume ID [--force] | auto-resume ID --no-auto-resume | reconcile | daemon | release ID');
    return;
  }
  if (command === 'dry-run' || command === 'start') {
    if (!a.spec) throw new SupervisorError('--spec FILE is required');
    const spec = JSON.parse(fs.readFileSync(a.spec, 'utf8'));
    if (a['auto-resume'] !== undefined) spec.autoResume = a['auto-resume'];
    if (command === 'dry-run') {
      const { validateSpec } = await import('./core.mjs');
      const checked = validateSpec(spec), { config, adapter } = await provider(registry, checked.provider);
      console.log(JSON.stringify({ provider: checked.provider, issue: checked.issue, worktree: checked.worktree, branch: checked.branch, command: adapter.command(config, checked, false), capabilities: adapter.capabilities, autoResume: spec.autoResume === true }, null, 2));
      return;
    }
    const job = await createJob(root, spec, registry);
    if (a.foreground) { job.workerPid = process.pid; job.workerStart = processStart(process.pid); saveJob(root, job); print(await drive(root, job, registry, realClock, (c, ad, j, cl) => runProcess(root, j, c, ad, cl))); }
    else { startWorker(root, job.id, registry); print(readJob(root, job.id)); }
    return;
  }
  if (command === 'worker') {
    const release = claimWorker(root, a._[0]);
    try {
    const job = readJob(root, a._[0]);
    if (job.status !== 'queued' && job.status !== 'paused_limit') throw new SupervisorError('job is not runnable');
    if (job.workerPid && processStart(job.workerPid) === job.workerStart) throw new SupervisorError('another worker owns job');
    job.workerPid = process.pid; job.workerStart = processStart(process.pid); saveJob(root, job);
    const result = await drive(root, job, registry, realClock, (c, ad, j, cl) => runProcess(root, j, c, ad, cl));
    result.workerPid = null; result.workerStart = null; saveJob(root, result);
    } finally { release(); }
    return;
  }
  if (command === 'status') {
    if (a._[0]) print(readJob(root, a._[0]));
    else {
      const dir = path.join(root, 'jobs');
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (name.endsWith('.json')) {
        const job = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        console.log(`${job.id} ${job.provider} #${job.issue} ${job.status} attempts=${job.attempts}`);
      }
    }
    return;
  }
  if (command === 'reconcile' || command === 'daemon') {
    if (command === 'reconcile') { console.log(JSON.stringify(reconcileOnce(root, registry))); return; }
    // Run under a host service or tmux supervisor pane; this loop never invokes a model itself.
    while (true) {
      const result = reconcileOnce(root, registry);
      if (result.resumed || result.blocked) console.log(JSON.stringify({ at: Date.now(), ...result }));
      await realClock.sleep(60000);
    }
  }
  if (command === 'logs') {
    const id = a._[0]; readJob(root, id);
    const file = path.join(root, 'events', `${id}.jsonl`);
    if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8').split('\n').slice(-51).join('\n'));
    return;
  }
  const id = a._[0]; if (!id) throw new SupervisorError('job ID is required');
  const job = readJob(root, id);
  if (command === 'pause' || command === 'stop') {
    if (job.workerPid && processStart(job.workerPid) === job.workerStart) {
      if (job.childPid && processStart(job.childPid)) process.kill(job.workerPid, command === 'pause' ? 'SIGUSR1' : 'SIGTERM');
      else process.kill(job.workerPid, 'SIGTERM');
    }
    transition(root, job, command === 'pause' ? 'paused_manual' : 'stopped', command === 'pause' ? 'manual_pause' : 'manual_stop');
    print(job); return;
  }
  if (command === 'auto-resume') { job.autoResume = a['auto-resume'] !== false; saveJob(root, job); print(job); return; }
  if (command === 'resume') {
    if (!['paused_manual', 'paused_limit', 'blocked', 'failed'].includes(job.status)) throw new SupervisorError('job is not resumable');
    recover(root, id, a.force === true);
    startWorker(root, id, registry); print(readJob(root, id)); return;
  }
  if (command === 'release') { releaseLeases(root, job); print(job); return; }
  throw new SupervisorError('unknown command');
}
main().catch(error => { console.error(`ai-supervisor: ${error instanceof SupervisorError ? error.message : error.message}`); process.exitCode = 2; });
