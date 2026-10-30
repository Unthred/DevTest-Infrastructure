#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SupervisorError, claimWorker, createJob, defaultRegistry, drive, jobFile, processStart, provider, readJob, recover, releaseLeases, saveJob, stateRoot, transition, realClock } from './core.mjs';
import { runProcess } from './process.mjs';
import { Team, loadTeamConfig, tickLock } from './team.mjs';
import { githubClient } from './github.mjs';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (['auto-resume', 'foreground', 'force', 'dry-run'].includes(key)) out[key] = true;
    else if (key === 'no-auto-resume') out[key] = false;
    else out[key] = list[++i];
  }
  return out;
}
function print(job) {
  const { id, provider, issue, repository, worktree, branch, status, autoResume, attempts, resetAt, nextAttemptAt, workerPid, childPid, lastEvent, checkpoint, capabilities, allowance, kind, access, autoRestart, incompleteRetries, postcondition } = job;
  console.log(JSON.stringify({ id, provider, issue, repository, worktree, branch, status, autoResume, attempts, resetAt, nextAttemptAt, workerPid, childPid, lastEvent, checkpoint, capabilities, allowance, kind, access, autoRestart, incompleteRetries, postcondition }, null, 2));
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
    const eligible = ['resume', 'usage_limit_detection', 'reset_time_parsing', 'non_interactive'].every(key => current.capabilities?.[key] === 'supported');
    const due = current.nextAttemptAt != null && current.nextAttemptAt <= Date.now();
    if (['paused_limit', 'queued'].includes(current.status) && ((current.autoResume && eligible) || current.autoRestart) && due) {
      recover(root, current.id, false); startWorker(root, current.id, registry); resumed++;
    } else if (current.status === 'running') { transition(root, current, 'blocked', 'orphaned_worker'); blocked++; }
  }
  return { resumed, blocked };
}
const teamConfigFile = new URL('./team.json', import.meta.url).pathname;
function realJobs(root, registry) {
  return {
    listActive: async () => {
      const dir = path.join(root, 'jobs'); const out = [];
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (name.endsWith('.json')) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (['queued', 'running', 'paused_limit', 'paused_manual'].includes(j.status)) out.push({ id: j.id, provider: j.provider, status: j.status });
      }
      return out;
    },
    get: async id => { try { return readJob(root, id); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    release: async id => releaseLeases(root, readJob(root, id)),
    create: async spec => { const job = await createJob(root, spec, registry); startWorker(root, job.id, registry); return job; }
  };
}
function realGit(repoPath) {
  const git = (...args) => { const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new SupervisorError(`git ${args[0]} failed`); return r.stdout.trim(); };
  return {
    worktreeFor: async branch => { const out = git('worktree', 'list', '--porcelain').split('\n\n'); const hit = out.find(b => b.includes(`branch refs/heads/${branch}`)); return hit ? hit.split('\n')[0].replace('worktree ', '') : null; },
    ensureWorktree: async ({ path: wt, branch, base }) => {
      if (fs.existsSync(wt)) return wt;
      git('fetch', '--quiet', 'origin');
      const exists = spawnSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
      if (exists) git('worktree', 'add', wt, branch); else git('worktree', 'add', '-b', branch, wt, base);
      return wt;
    }
  };
}
async function teamFor(root, registry, config = loadTeamConfig(teamConfigFile, root), needRegister = true) {
  // The decision register that counts is the one merged into main, not a working copy.
  let register = '';
  if (needRegister) {
    const shown = spawnSync('git', ['-C', config.repo_path, 'show', 'origin/main:docs/DECISIONS.md'], { encoding: 'utf8', timeout: 30000 });
    if (shown.status !== 0) throw new SupervisorError('cannot read docs/DECISIONS.md from origin/main');
    register = shown.stdout;
  }
  return new Team({ config, root, gh: githubClient(config), jobs: realJobs(root, registry), git: realGit(config.repo_path), register });
}
async function teamTick(root, registry, dryRun) {
  const config = loadTeamConfig(teamConfigFile, root);
  if (!config.enabled && !dryRun) return { skipped: 'team loop is not enabled (set "enabled": true in <state root>/team.local.json)' };
  const unlock = tickLock(root);
  if (!unlock) return { skipped: 'another tick is running' };
  try { return await (await teamFor(root, registry, config, !dryRun)).tick({ dryRun }); } finally { unlock(); }
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
      const capabilities = config.manifest.capabilities;
      const autoResumeEligible = ['resume', 'usage_limit_detection', 'reset_time_parsing', 'non_interactive'].every(key => capabilities[key] === 'supported');
      console.log(JSON.stringify({ provider: checked.provider, issue: checked.issue, worktree: checked.worktree, branch: checked.branch, command: adapter.command(config, checked, false), capabilities, autoResume: spec.autoResume === true, autoResumeEligible }, null, 2));
      return;
    }
    const job = await createJob(root, spec, registry);
    if (a.foreground) {
      job.workerPid = process.pid; job.workerStart = processStart(process.pid); saveJob(root, job);
      const result = await drive(root, job, registry, realClock, (c, ad, j, cl) => runProcess(root, j, c, ad, cl), 4, job.postcondition ? (await teamFor(root, registry)).postconditions() : null);
      result.workerPid = null; result.workerStart = null; saveJob(root, result); print(result);
    }
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
    const result = await drive(root, job, registry, realClock, (c, ad, j, cl) => runProcess(root, j, c, ad, cl), 4, job.postcondition ? (await teamFor(root, registry)).postconditions() : null);
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
  if (command === 'team') {
    if (a._[0] !== 'tick') throw new SupervisorError('usage: team tick [--dry-run]');
    console.log(JSON.stringify(await teamTick(root, registry, a['dry-run'] === true), null, 2)); return;
  }
  if (command === 'preflight') {
    // Run by the enable/upgrade procedure under the cron environment (env -i + the script's PATH): every binary the tick and
    // the supervised jobs need must resolve there, or enabling is refused. Exit 3 on any failure.
    const out = { gh: spawnSync('gh', ['--version'], { encoding: 'utf8' }).error ? 'not_found' : 'ok', git: spawnSync('git', ['--version'], { encoding: 'utf8' }).error ? 'not_found' : 'ok' };
    for (const id of ['claude', 'codex']) { const { adapter } = await provider(registry, id); const r = adapter.preflight ? adapter.preflight({ role: 'devtest', worktree: process.cwd() }) : true; out[id] = r === 'not_found' ? 'not_found' : r ? 'ok' : 'auth_or_governance_failed'; }
    console.log(JSON.stringify({ preflight: out }));
    if (Object.values(out).some(v => v !== 'ok')) process.exitCode = 3;
    return;
  }
  if (command === 'reconcile' || command === 'daemon') {
    if (command === 'reconcile') {
      const result = reconcileOnce(root, registry);
      // The five-minute reconcile cron also runs the token-free team tick, when the team loop is enabled.
      try { result.team = await teamTick(root, registry, false); } catch (error) { result.team = { error: String(error.message).slice(0, 200) }; }
      console.log(JSON.stringify(result)); return;
    }
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
    if (['completed', 'failed', 'blocked', 'stopped'].includes(job.status)) throw new SupervisorError('terminal job cannot be paused or stopped');
    if (job.workerPid && processStart(job.workerPid) === job.workerStart) {
      if (job.childPid && processStart(job.childPid)) process.kill(job.workerPid, command === 'pause' ? 'SIGUSR1' : 'SIGTERM');
      else process.kill(job.workerPid, 'SIGTERM');
    }
    transition(root, job, command === 'pause' ? 'paused_manual' : 'stopped', command === 'pause' ? 'manual_pause' : 'manual_stop');
    print(job); return;
  }
  if (command === 'auto-resume') {
    const enabled = a['auto-resume'] !== false;
    if (enabled && !['resume', 'usage_limit_detection', 'reset_time_parsing', 'non_interactive'].every(key => job.capabilities?.[key] === 'supported'))
      throw new SupervisorError('auto-resume requires verified supported provider capabilities');
    job.autoResume = enabled; saveJob(root, job); print(job); return;
  }
  if (command === 'resume') {
    if (!['paused_manual', 'paused_limit', 'blocked', 'failed'].includes(job.status)) throw new SupervisorError('job is not resumable');
    recover(root, id, a.force === true);
    startWorker(root, id, registry); print(readJob(root, id)); return;
  }
  if (command === 'release') { releaseLeases(root, job); print(job); return; }
  throw new SupervisorError('unknown command');
}
main().catch(error => { console.error(`ai-supervisor: ${error instanceof SupervisorError ? error.message : error.message}`); process.exitCode = 2; });
