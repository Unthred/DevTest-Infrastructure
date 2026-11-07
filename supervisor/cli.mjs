#!/usr/bin/env node
import fs from 'node:fs';
import { requestBreakerResume } from './breakerresume.mjs';
import { queueHomeownerRequest } from './homeownerqueue.mjs';
import { resumeAllowed } from './breaker.mjs';
import { rangeEqual } from './rangediff.mjs';
import { checkRebase, prepareRebase, pushRebase } from './rebasecheck.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminal, leaseKeys, jobProcessesAlive, childAlive, SupervisorError, WorktreeUnusable, gitCommonDir, claimWorker, createJob, defaultRegistry, drive, jobFile, processStart, provider, readJob, resolveJobId, recover, releaseLeases, saveJob, stateRoot, transition, realClock } from './core.mjs';
import { runProcess } from './process.mjs';
import { runMigrations } from './migrations.mjs';
import { recordSkip } from './skips.mjs';
import { withTestConcurrency, testEnv, sweepTestTemp, suiteKey, findPass, recordPass, DEFAULT_REUSE_HOURS, DEFAULT_TEST_CONCURRENCY, DEFAULT_SWEEP_AGE_HOURS } from './testenv.mjs';
import { admit, checkClass, runLimited, cgroupWrapper } from './resources.mjs';
import { acquireTestSlot, recordTestEvent, testSlotStatus, testSlotLine, DEFAULT_TEST_SLOTS, DEFAULT_MAX_RUNTIME_MS, runInGroup, formatRuntime } from './testslots.mjs';
import { upgradeLock } from './team.mjs';
import { Team, checksState, retriedIn, loadTeamConfig, validateTeamConfig, applyLocalOverride, tickLock, tickLockWait, decisionApproved, INDEPENDENCE_DECISION } from './team.mjs';
import { githubClient } from './github.mjs';
import { changeCheckOf, checkForChanges, ghProbeRunner, loadCache, saveCache, buildCache, cachedGithub } from './ghchange.mjs';
import { publishStatusIssue } from './statusissue.mjs';
import { currentStatus } from './teamstatus.mjs';
import { alertSender } from './alert.mjs';
import { advanceWatchlist, factsFromCache } from './watchlist.mjs';
import { readCache, readJobs, readEvents, readSnapshots, readLastSnapshot, readTeamState, recordTick, readVersion, tickOutcome, storeProbes, mergeProbes } from './dashdata.mjs';
import { idleReport, renderIdleReport, passStats, renderPassStats } from './idlecause.mjs';
import { readTimeline, recordTimeline, githubBackfill, storageReport, computeGaps, allSnapshots } from './history.mjs';
import { readIncidents } from './migrations.mjs';
import { ghRunner } from './github.mjs';
import { redact } from './redact.mjs';
import { saveWork } from './savework.mjs';
import { hasProbe, refreshProvider } from './probe.mjs';
import { probeNow } from './probenow.mjs';
import { planningInputs, readRegister } from './planning.mjs';
import { codexAllowanceProbe } from './allowance.mjs';
import { spawnSync } from 'node:child_process';
import { handInstall, handInstallHold } from './handinstall.mjs';
import { SelfUpgrade, QUIET_MAX_WAIT_MS, MIN_INSTALL_GAP_MS, holdOf, realDeps, runningSha, liveTickOutcome } from './upgrade.mjs';
import { requestWake, spawnDetachedPass, recordWakePass, TRIGGERS, workerArgs, wakeStatus, WAKE_MAX_PER_HOUR } from './wake.mjs';
import { drivePass } from './wakepass.mjs';

const self = fileURLToPath(import.meta.url);
function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (['auto-resume', 'foreground', 'force', 'dry-run', 'json', 'no-github', 'no-reuse'].includes(key)) out[key] = true;
    else if (key === 'no-auto-resume') out[key] = false;
    else out[key] = list[++i];
  }
  return out;
}
function print(job) {
  const { id, provider, issue, repository, worktree, branch, status, autoResume, attempts, resetAt, nextAttemptAt, workerPid, childPid, lastEvent, checkpoint, capabilities, allowance, kind, access, autoRestart, incompleteRetries, postcondition, model, effort, modelSource, modelReason, modelWarning, sessions } = job;
  console.log(JSON.stringify({ id, provider, issue, repository, worktree, branch, status, autoResume, attempts, resetAt, nextAttemptAt, workerPid, childPid, lastEvent, checkpoint, capabilities, allowance, kind, access, autoRestart, incompleteRetries, postcondition, model, effort, modelSource, modelReason, modelWarning, sessions }, null, 2));
}
function startWorker(root, id, registry) {
  // The default registry is not passed on: it would be this version's path, and a wake handed to a newer install would load the old manifests.
  const child = spawn(process.execPath, workerArgs({ self, id, root, registry, defaultRegistry }),
    { detached: true, stdio: 'ignore', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root } });
  child.unref();
  return child.pid;
}
function installRunning(root) {
  // Issue #448: true while another process holds upgrade.lock (its pre-check, install and retry). Probing takes and releases the lock.
  const unlock = upgradeLock(root);
  if (!unlock) return true;
  unlock(); return false;
}
// Issue #406: ask for one extra pass now (job-end, install). Best effort and model-free: any failure only loses the speed-up, the scheduled
// pass is the fallback. The pass runs the installed code, never the code of this process.
let registryOption = null;
const wakeCap = () => { const v = process.env.AI_SUPERVISOR_WAKE_MAX_PER_HOUR; return v !== undefined && v !== '' && Number(v) >= 0 ? Number(v) : WAKE_MAX_PER_HOUR; };
const spawnPass = (root, reason) => spawnDetachedPass({ root, reason, self, registry: registryOption });
function wakeNextJob(root, reason) {
  try {
    if (!loadTeamConfig(teamConfigFile, root).enabled) return;
    requestWake({ root, reason, cap: wakeCap(), spawnPass: why => spawnPass(root, why) });
  } catch (error) { console.error(`ai-supervisor: wake not requested: ${error?.name || 'Error'}`); }
}
function reconcileOnce(root, registry, installing = false) {
  const dir = path.join(root, 'jobs');
  let resumed = 0, blocked = 0, released = 0, held = 0;
  const handHold = installing || handInstallHold(root) !== null;   // issue #446: a hand-install holds due restarts too (they stay recorded and restart after it)
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    const current = readJob(root, name.slice(0, -5));
    if (current.workerPid && processStart(current.workerPid) === current.workerStart) continue;
    // Issue #132 backstop: a terminal job whose leases were kept because a process was alive (manual stop, orphaned child)
    // never reaches transition() again. Once nothing of it runs, release them here.
    if (terminal.has(current.status)) {
      if (!jobProcessesAlive(current)) released += releaseLeases(root, current) ? 1 : 0;   // issue #195: count only leases this job owned
      continue;
    }
    const eligible = ['resume', 'usage_limit_detection', 'reset_time_parsing', 'non_interactive'].every(key => current.capabilities?.[key] === 'supported');
    const due = current.nextAttemptAt != null && current.nextAttemptAt <= Date.now();
    if (['paused_limit', 'queued'].includes(current.status) && ((current.autoResume && eligible) || current.autoRestart) && due) {
      if (handHold) { held++; continue; }
      recover(root, current.id, false); startWorker(root, current.id, registry); resumed++;
    } else if (current.status === 'running') { transition(root, current, 'blocked', 'orphaned_worker'); blocked++; }
  }
  return { resumed, blocked, released, ...(held ? { held } : {}) };
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
    alive: async job => jobProcessesAlive(job),
    // Issue #163: one automatic resume of a job that stopped on a transient cause. Same recovery as `resume`, with the attempt
    // counters reset so the worker gets one more bounded round instead of stopping at once on retry_exhausted.
    resume: async id => {
      const job = recover(root, id, false);
      job.attempts = 0; job.incompleteRetries = 0; job.nextAttemptAt = Date.now(); saveJob(root, job, realClock, true);
      startWorker(root, id, registry);
    },
    // Issue #629: the homeowner's approved stop, the same steps as `ai-supervisor stop ID`
    stop: async id => {
      const job = readJob(root, id);
      if (terminal.has(job.status)) throw new SupervisorError('terminal job cannot be stopped');
      if (job.workerPid && processStart(job.workerPid) === job.workerStart) process.kill(job.workerPid, 'SIGTERM');
      transition(root, job, 'stopped', 'manual_stop');
    },
    create: async spec => { const job = await createJob(root, spec, registry); startWorker(root, job.id, registry); return job; }
  };
}
function realGit(repoPath) {
  const git = (...args) => { const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new SupervisorError(`git ${args[0]} failed`); return r.stdout.trim(); };
  return {
    // range-diff equality (issue #79); refs are fetched first so both heads and the base are present
    rangeEqual: async ({ base, oldHead, newHead }) => { git('fetch', '--quiet', 'origin'); return rangeEqual({ repoPath, base, oldHead, newHead }); },
    // issue #158: the commits a rebase carried and the ones it dropped (by patch-id), checked again by the dispatcher after the job
    checkRebase: async ({ base, oldHead, newHead }) => { git('fetch', '--quiet', 'origin'); return checkRebase({ repoPath, base, oldHead, newHead }); },
    // issue #302: true only when git can prove the worktree has no uncommitted work (tracked or untracked); anything else is false/null
    isClean: async wt => { if (!fs.existsSync(wt)) return null; const r = spawnSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 60000 }); return r.status === 0 ? r.stdout.trim() === '' : null; },
    // issue #610: the branch the worktree has checked out (null when detached or unknown)
    currentBranch: async wt => { if (!fs.existsSync(wt)) return null; const r = spawnSync('git', ['-C', wt, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', timeout: 60000 }); return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null; },
    // issue #629: save a job's worktree before it is closed: commit uncommitted work (ignored files stay out) and push HEAD to a new branch under saved/,
    // which never matches an agent branch prefix. Returns { ref } when something was pushed, { missing: true } when there is no worktree.
    saveWork,
    // issue #583: commits in the worktree's HEAD that no remote branch has; null when it cannot be told (callers then keep the hold)
    unpushedCommits: async wt => { if (!fs.existsSync(wt)) return null; spawnSync('git', ['-C', wt, 'fetch', '--quiet', 'origin'], { encoding: 'utf8', timeout: 60000 }); /* issue #610: best effort; a failed fetch leaves stale refs, which only keeps the hold */ const r = spawnSync('git', ['-C', wt, 'rev-list', '--count', 'HEAD', '--not', '--remotes'], { encoding: 'utf8', timeout: 60000 }); const n = Number(r.stdout.trim()); return r.status === 0 && Number.isSafeInteger(n) ? n : null; },
    // issue #495: existing worktree directories and local branches a new implement job would reuse unreset
    leftoversFor: async ({ worktrees, branchPrefixes }) => {
      const out = worktrees.filter(w => fs.existsSync(w)).map(w => `a worktree at ${w}`);
      for (const pre of branchPrefixes) { const r = spawnSync('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${pre}*`], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new SupervisorError('git for-each-ref failed'); out.push(...r.stdout.split('\n').filter(Boolean).map(b => `the local branch ${b}`)); }
      return out;
    },
    worktreeFor: async branch => { const out = git('worktree', 'list', '--porcelain').split('\n\n'); const hit = out.find(b => b.includes(`branch refs/heads/${branch}`)); return hit ? hit.split('\n')[0].replace('worktree ', '') : null; },
    ensureWorktree: async ({ path: wt, branch, base }) => {
      if (fs.existsSync(wt)) {
        // An existing directory is reused only if it is a linked worktree of THIS repository (resolved from its own absolute path).
        let common = null;
        try { common = gitCommonDir(wt); } catch { /* not a git checkout at all */ }
        if (common !== fs.realpathSync(path.join(repoPath, '.git'))) throw new WorktreeUnusable(`${wt} is not a linked worktree of ${repoPath}`, wt);
        return wt;
      }
      git('fetch', '--quiet', 'origin');
      const exists = spawnSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
      if (exists) git('worktree', 'add', wt, branch); else git('worktree', 'add', '-b', branch, wt, base);
      return wt;
    }
  };
}
async function teamFor(root, registry, config = loadTeamConfig(teamConfigFile, root), needRegister = true, { wrapGh = g => g, ghStats = null } = {}) {
  // The decision register that counts is the one merged into main, not a working copy.
  // A dry run needs it too: the enable gate (issue #40) must fail exactly where a live tick would.
  const register = readRegister(config);
  if (!register && needRegister) throw new SupervisorError('cannot read docs/DECISIONS.md from origin/main');
  // Model routing (issue #64): what each CLI accepts comes from its manifest; the weekly allowance is the freshest the provider reported.
  const providerModels = {};
  for (const a of Object.values(config.agents)) providerModels[a.provider] = (await provider(registry, a.provider)).config.manifest.models ?? null;
  // The allowance inputs are shared with `team status` and the dashboard (issue #121), so all of them plan alike.
  const jobsNow = readJobs(root);
  const { allowanceOf, limitedOf, usage } = planningInputs({ config, jobs: jobsNow, probes: readCache(root)?.probes, snapshots: readSnapshots(root), hadLimit: id => readEvents(root, [id]).some(e => e.kind === 'usage_limit') });
  return new Team({ config, root, gh: wrapGh(githubClient(config, countingGh(ghStats))), jobs: realJobs(root, registry), git: realGit(config.repo_path), register, alert: alertSender(root, config), providerModels, allowanceOf, limitedOf, usage });
}
// Issue #755: counts the gh processes a pass starts (for the pass record), without changing what any call does.
function countingGh(stats) {
  const base = ghRunner();
  return stats ? (args, input, opts) => { const t = Date.now(); stats.calls++; try { return base(args, input, opts); } finally { stats.ms += Date.now() - t; } } : base;
}
// Model-free allowance probes, one per provider that has one (issue #75), so a paused agent's reading still refreshes.
// Only a local file read: never a model call. A probe failure only loses this tick's refresh.
function probeAllowances(config) {
  const out = {};
  if (Object.values(config.agents || {}).some(a => a.provider === 'codex')) {
    try { const a = codexAllowanceProbe(); if (a) out.codex = a; } catch (error) { console.error(`ai-supervisor: codex allowance probe failed: ${error?.code || error?.name || 'Error'}`); }
  }
  return out;
}
async function runDueProbes(root, registry, team, found) {
  const due = team.probesDue(id => hasProbe(registry, id));
  for (const d of due) {
    team.noteProbe(d.agent, d);
    const r = await refreshProvider(registry, d.provider);
    if (r.record) { found[d.provider] = r.record; storeProbes(root, { [d.provider]: r.record }); }
    else console.error(`ai-supervisor: allowance probe for ${d.agent} (${d.reason}) produced no reading: ${r.error}`);
  }
  return Object.keys(found).length > 0;
}
// Enable gate (issue #40): everything a live tick needs that a dry-run plan alone would not prove. Read-only, no model call.
// Provider preflights run against the configured product repository, never the caller's working directory.
async function gatePreflight(registry, config) {
  const checks = {};
  const run = async (name, fn) => { try { const r = await fn(); checks[name] = r === true ? 'ok' : r; } catch (error) { checks[name] = `failed: ${String(error?.message || error).slice(0, 160)}`; } };
  await run('git', () => { const r = spawnSync('git', ['-C', config.repo_path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 15000 }); if (r.error?.code === 'ENOENT') throw new SupervisorError('required binary not found: git'); if (r.status !== 0 || fs.realpathSync(r.stdout.trim()) !== fs.realpathSync(config.repo_path)) throw new SupervisorError(`repo_path is not a Git repository root: ${config.repo_path}`); return true; });
  await run('github', async () => { await githubClient(config).listPulls(); return true; });
  await run('register', () => { const text = readRegister(config); if (!text) throw new SupervisorError('cannot read docs/DECISIONS.md from origin/main'); if (config.access?.mode === 'full' && !decisionApproved(text, config.access.decision)) throw new SupervisorError(`${config.access.decision} is not homeowner-approved`); return true; });
  const here = process.cwd();
  try {
    if (checks.git === 'ok') process.chdir(config.repo_path);
    for (const id of [...new Set(Object.values(config.agents || {}).map(a => a.provider))]) {
      await run(`provider:${id}`, async () => {
        const ok = (await provider(registry, id)).adapter.preflight?.({ role: 'implementer', worktree: config.repo_path });
        return ok === 'not_found' ? 'failed: provider binary not found on PATH' : ok === false ? 'failed: not logged in or launcher refused the product root' : true;
      });
    }
  } finally { process.chdir(here); }
  return { ok: Object.values(checks).every(v => v === 'ok'), checks };
}
// Issue #867: homeowner commands wait for the tick lock (default 5 minutes, AI_SUPERVISOR_LOCK_WAIT_MS overrides) and say so. On timeout the command
// leaves its request for the next tick and fails with a clear message, so the request is not lost.
async function homeownerLock(root, what, queue = null) {
  const ms = Number(process.env.AI_SUPERVISOR_LOCK_WAIT_MS);
  const release = await tickLockWait(root, { timeoutMs: Number.isFinite(ms) && ms >= 0 ? ms : 300000, say: line => console.error(`ai-supervisor: ${line}`) });
  if (release) return release;
  const queued = queue ? queue() : null;
  throw new SupervisorError(`a team tick kept running past the wait, so team ${what} was not applied now${queued ? `; ${queued}` : ''}`);
}
const queueOf = (root, command, args) => () => { queueHomeownerRequest(root, command, args, Date.now()); return 'the request is queued; the next tick applies it'; };
const currentStatusFor = (root, config) => currentStatus({ root, config, register: readRegister(config) });
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
async function teamTick(root, registry, dryRun, hold = null, pass = null) {
  // One tick lock covers the whole tick, migrations included, so two concurrent ticks can neither run the same migration nor interleave.
  if (!dryRun && handInstallHold(root)) return { skipped: [{ what: 'team tick', reason: 'held for a hand-install', expected: true }] };
  // A dry run plans only and writes nothing, so it does not take the tick lock: the install's dry-run health check must run while a
  // concurrent live tick holds it, or the install would be rolled back for no real reason (issue #448).
  const unlock = dryRun ? (() => {}) : tickLock(root);
  if (!unlock) {
    // Issue #448: a tick that does not run says why, in the dashboard record. It was silent.
    const reason = 'another tick is running and holds the tick lock';
    try { recordSkip(root, reason); } catch { /* best effort */ }
    return { skipped: 'another tick is running' };
  }
  try {
    // Issue #153: pending config migrations run once, before the first tick of a new version; a failing one skips this tick (it is retried on the next).
    if (!dryRun) {
      const migrated = await runMigrations({ root, dir: migrationsDir, validate: next => validateTeamConfig(applyLocalOverride(JSON.parse(fs.readFileSync(teamConfigFile, 'utf8')), next)) });
      if (migrated.failed) {
        const error = redact(`config migration ${String(migrated.failed.number).padStart(3, '0')}-${migrated.failed.name} failed: ${migrated.failed.error}`, 300);
        try { recordTick(root, { now: Date.now(), status: 'error', error, jobs: readJobs(root) }); } catch { /* the dashboard record is best effort */ }
        return { skipped: [{ what: 'config migration', reason: error }] };
      }
    }
    const config = loadTeamConfig(teamConfigFile, root);
    const tickStartedAt = Date.now();   // issue #487: tick run time before a job starts is measured from here
    // The dashboard cache and history (#32) are written here, at the end of a real tick, and nowhere else.
    const found = {};
    const record = args => { try { recordTick(root, { now: Date.now(), jobs: readJobs(root), probes: mergeProbes(probeAllowances(config), found), ...args }); } catch (error) { console.error(`ai-supervisor: dashboard record failed: ${error?.name || 'Error'}`); } };
    if (!config.enabled && !dryRun) { record({ status: 'disabled' }); return { skipped: 'team loop is not enabled (set "enabled": true in <state root>/team.local.json)' }; }
    // Issue #755: a scheduled pass first asks GitHub, with conditional requests, whether anything the planner reads has changed. A wake (job end,
    // install, inbox, approve) is never checked: it always runs the full pass. Dry runs touch nothing here.
    const ghStats = { calls: 0, ms: 0 };
    let check = null, wrapper = null, mode = 'plain', prevCache = null, checkedAt = Date.now();
    if (!dryRun) {
      const cc = changeCheckOf(config), scheduledOnly = !pass || (pass.trigger === 'schedule' && (pass.merged || []).every(r => r === 'schedule'));
      prevCache = loadCache(root, config.repository); checkedAt = Date.now();
      if (cc.enabled && pass && scheduledOnly) {
        try { check = await checkForChanges({ repository: config.repository, prev: prevCache, config: cc, run: ghProbeRunner({ timeoutMs: cc.timeout_seconds * 1000 }) }); }
        catch (error) { check = { replay: false, baseline: null, probes: 0, reason: `the change check failed (${String(error?.message || error).slice(0, 80)}): full pass` }; }   // never a tick failure
        mode = check.replay ? 'replay' : check.baseline ? 'record' : 'memo';
      } else mode = 'memo';
    }
    const wrapGh = raw => (mode === 'plain' ? raw : (wrapper ||= cachedGithub(raw, { mode, cache: prevCache })).gh);
    try {
      let team = await teamFor(root, registry, config, true, { wrapGh, ghStats });
      // Issue #110: refresh the allowance of a held agent whose reading is stale (or whose reset time has just passed) before
      // planning, so a fresh reading can release the reviews-only latch in this very tick. A dry run or a hold never spends a run.
      if (!dryRun && !hold && await runDueProbes(root, registry, team, found)) team = await teamFor(root, registry, config, true, { wrapGh, ghStats });
      const report = await team.tick({ dryRun, hold, replay: mode === 'replay', beforeChain: () => wrapper?.endReplay() });
      if (!dryRun) {
        record({ ...tickOutcome(report), team, actions: report.actions, ingested: (report.ingested || []).length, startedAt: tickStartedAt, heldAgents: report.held ? (report.held.agents || []) : null, holds: report.holds, ...(pass ? { trigger: pass.trigger, merged: pass.merged } : {}), noop: report.noop === true, ghCalls: ghStats.calls, ghMs: ghStats.ms, ...(check ? { check: { result: check.replay ? 'unchanged' : 'full', reason: check.reason, probes: check.probes, served: wrapper?.stats.served ?? 0 } } : {}) });
        // The baseline is stored only after a full pass that read everything without error, and never after a replay (so the forced-full clock keeps running).
        if (mode === 'record' && tickOutcome(report).status === 'ok') { try { const next = buildCache({ repository: config.repository, baseline: check.baseline, wrapper, now: checkedAt }); if (next) saveCache(root, next); } catch { /* the next pass is a full one */ } }
        // Issue #358: publish live state to the pinned status issue; never throws, never fails the tick.
        // Issue #430: advance the watched changes (merge commit, install, alerts, clearing). Never throws, never fails the tick.
        try {
          const cache = readCache(root) || {}, state = readTeamState(root), ver = readVersion(root), now = Date.now();
          await advanceWatchlist({ root, cache, state, now, installed: ver?.installed || null, running: runningSha(self), tickOk: tickOutcome(report).status === 'ok',
            isAncestor: (a, b) => spawnSync('git', ['-C', config.repo_path, 'merge-base', '--is-ancestor', a, b], { encoding: 'utf8' }).status === 0, alert: alertSender(root, config),
            factsFor: factsFromCache({ cache, state, now, checksOf: (pull, at) => checksState(pull.statusCheckRollup, retriedIn(state.cancelWatch, pull, at)) }), title: n => `#${n}` });
        } catch (error) { console.error(`ai-supervisor: watchlist step failed: ${error?.name || 'Error'}`); }
        await publishStatusIssue({ root, gh: team.gh, status: () => currentStatusFor(root, config) });
      }
      return report;
    } catch (error) {
      if (!dryRun) record({ status: 'error', error: error?.message });
      throw error;
    }
  } finally { unlock(); }
}
// Issue #695: work the previous tick planned (not merges), read from its snapshot; local only, no GitHub. A stale plan can only delay an install to the end of the batching window.
function plannedWorkOf(root) {
  const last = readLastSnapshot(root);
  return Array.isArray(last?.plan) ? last.plan.filter(a => a && a.type !== 'merge').length : 0;
}
function selfUpgradeFor(root, registry) {
  const config = loadTeamConfig(teamConfigFile, root);
  const verdictFor = (pr, head) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8')).verdicts?.[`${pr}:${head}`] || null; } catch { return null; } };
  const jobs = realJobs(root, registry);
  return { config, upgrade: new SelfUpgrade({ root, minGapMs: config.self_upgrade?.min_install_gap_minutes != null ? config.self_upgrade.min_install_gap_minutes * 60000 : MIN_INSTALL_GAP_MS, drainMaxMs: config.self_upgrade?.drain_max_minutes != null ? config.self_upgrade.drain_max_minutes * 60000 : QUIET_MAX_WAIT_MS, deps: { ...realDeps({ root, config, gh: githubClient(config), listActive: jobs.listActive, verdictFor, independenceApproved: () => decisionApproved(readRegister(config) || '', INDEPENDENCE_DECISION), sendAlert: alertSender(root, config) }), plannedWork: () => plannedWorkOf(root) } }) };
}
// Runs BEFORE the team step (issue #134): while an upgrade is pending and eligible, the tick starts no new job, so running jobs
// can drain and the upgrade finds a quiet period. `hold` names the pending target; it is null when nothing is waiting.
async function selfUpgradeBefore(root, registry) {
  // Issue #448: the install step (with its test run) has its own lock, so it never holds the tick lock or stops another tick. While
  // another process installs, this tick starts no new job (the same hold as a pending upgrade), and the reason is shown.
  const unlockUpgrade = upgradeLock(root);
  if (!unlockUpgrade) return { result: 'install-running', hold: { to: null, installRunning: true } };
  try { return await selfUpgradeLocked(root, registry); } finally { unlockUpgrade(); }
}
async function selfUpgradeLocked(root, registry) {
  const { config, upgrade } = selfUpgradeFor(root, registry);
  // Issue #209: the dashboard check runs on every tick, even with the team loop off, and never fails the tick.
  try { await upgrade.watchdog(); } catch { /* the next tick checks again */ }
  if (!config.enabled) return { result: 'team-loop-disabled', hold: null };
  if (handInstallHold(root)) return { result: 'hand-install-hold', hold: null };
  const result = await upgrade.step();
  // 'upgraded': this process still runs the old code, so it must not dispatch either; the next tick runs the new version.
  return { result, hold: holdOf(result, upgrade.s) };
}
// After the team step: an upgrade installed by an earlier tick is verified by this live tick.
async function selfUpgradeAfter(root, registry, before, tick) {
  if (before.result !== 'awaiting-verification') return before.result;
  // Verification, rollback and the dashboard restart are serialised with the install step by the same lock (issue #448): two overlapping
  // reconcile runs must not both verify, roll back or save the upgrade state. The run that cannot take it leaves it to the holder.
  const unlockUpgrade = upgradeLock(root);
  if (!unlockUpgrade) return before.result;
  try { return await selfUpgradeVerify(root, registry, before, tick); } finally { unlockUpgrade(); }
}
async function selfUpgradeVerify(root, registry, before, tick) {
  const { upgrade } = selfUpgradeFor(root, registry);
  // A tick skipped because another one holds the lock is not a live tick and verifies nothing.
  const live = !tick?.skipped || Array.isArray(tick.skipped);
  const outcome = liveTickOutcome(tick);
  if (live) {
    const verdict = await upgrade.verifyPending({ running: runningSha(self), ok: outcome.ok, reason: outcome.reason });
    if (verdict === 'rolled-back' || verdict === 'rollback-failed' || verdict === 'verified') return verdict;
  }
  return before.result;
}
async function main() {
  const command = process.argv[2] || 'help';
  const rest = process.argv.slice(3), cut = rest.indexOf('--');
  const a = args(command === 'test-slot' && cut >= 0 ? rest.slice(0, cut) : rest);   // the command after `--` is not ours to parse
  const root = stateRoot(a['state-root']);
  const registry = path.resolve(a.registry || defaultRegistry);
  registryOption = a.registry ? registry : null;   // only an operator-given registry is passed on (issue #406)
  if (command === 'help') {
    console.log('ai-supervisor dry-run|start --spec FILE [--foreground] [--registry FILE]\n  status [ID] | logs ID | pause ID | stop ID | resume ID [--force] | auto-resume ID --no-auto-resume | self-upgrade status|install-now|clear-latch|hand-install SHA | reconcile | preflight | daemon | release ID\n  rebase-prepare --worktree DIR --branch B | rebase-push --worktree DIR --branch B --base BASE --old SHA\n  probe AGENT | team reopen ISSUE | team breaker status|resume SCOPE | team tick [--dry-run] | team status [--json] | dashboard serve --host LAN_IPV4 [--port N]');
    return;
  }
  // issue #158: the guarded steps of a rebase job (the prompt tells the agent to use exactly these)
  if (command === 'rebase-prepare') {
    if (!a.worktree || !a.branch) throw new SupervisorError('usage: rebase-prepare --worktree DIR --branch BRANCH');
    console.log(JSON.stringify(prepareRebase({ worktree: a.worktree, branch: a.branch }), null, 2)); return;
  }
  if (command === 'rebase-push') {
    if (!a.worktree || !a.branch || !a.base || !a.old) throw new SupervisorError('usage: rebase-push --worktree DIR --branch BRANCH --base BASE --old OLD_HEAD');
    const result = pushRebase({ worktree: a.worktree, branch: a.branch, base: a.base, oldHead: a.old });
    console.log(JSON.stringify(result, null, 2)); if (!result.pushed) process.exitCode = 3; return;
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
      const result = await drive(root, job, registry, realClock, (c, ad, j, cl) => runProcess(root, j, c, ad, cl), 4, job.postcondition ? (await teamFor(root, registry)).postconditions() : null, async j => (await teamFor(root, registry, undefined, false)).resumeGate()(j));
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
    const result = await drive(root, job, registry, realClock, (c, ad, j, cl) => runProcess(root, j, c, ad, cl), 4, job.postcondition ? (await teamFor(root, registry)).postconditions() : null, async j => (await teamFor(root, registry, undefined, false)).resumeGate()(j));
    result.workerPid = null; result.workerStart = null; saveJob(root, result);
    } finally { release(); }
    wakeNextJob(root, 'job-end');   // issue #406
    return;
  }
  if (command === 'status') {
    if (a._[0]) print(readJob(root, resolveJobId(root, a._[0])));
    else {
      const dir = path.join(root, 'jobs');
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (name.endsWith('.json')) {
        const job = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        console.log(`${job.id} ${job.provider} #${job.issue} ${job.status} attempts=${job.attempts}`);
      }
    }
    return;
  }
  // Issue #448: the cron script calls this when it cannot start a run, so a skipped tick always leaves a record with its reason.
  if (command === 'record-skip') {
    if (!a.reason) throw new SupervisorError('usage: record-skip --reason TEXT');
    recordSkip(root, a.reason); console.log(JSON.stringify({ recorded: true })); return;
  }
  // Issue #448: `test-slot status` shows what runs and waits; `test-slot run [--label L] -- CMD ARGS` runs a full test suite once a
  // slot is free (reviews and jobs use it for their suite), so suites queue behind limits.test_slots instead of piling on.
  if (command === 'test-slot') {
    const cfg = (() => { try { return loadTeamConfig(teamConfigFile, root); } catch { return {}; } })();
    const limit = cfg.limits?.test_slots ?? DEFAULT_TEST_SLOTS;
    if (a._[0] === 'sweep') {   // Issue #469: remove old test leftovers (test prefixes only, older than --age-hours, not open, not a cwd)
      if (!cfg.test_tmp_root && !a.dir) throw new SupervisorError('usage: test-slot sweep [--dir ABSOLUTE_DIR] [--age-hours N] [--dry-run] (or set test_tmp_root in the team config)');
      const res = sweepTestTemp({ tmpRoot: a.dir || cfg.test_tmp_root, ageHours: Number(a['age-hours'] ?? DEFAULT_SWEEP_AGE_HOURS), dryRun: Boolean(a['dry-run']), logFile: path.join(root, 'team', 'test-sweeps.jsonl') });
      console.log(JSON.stringify({ removed: res.removed.length, kept: res.kept.length, skipped: res.skipped, names: res.removed.slice(0, 50) }, null, 2)); return;
    }
    if (a._[0] === 'status') { const st = testSlotStatus(root, limit); console.log(JSON.stringify(st, null, 2)); console.error(testSlotLine(st)); return; }
    const dash = process.argv.indexOf('--');
    if (a._[0] !== 'run' || dash < 0 || dash === process.argv.length - 1) throw new SupervisorError('usage: test-slot status | test-slot sweep | test-slot run [--label TEXT] [--max-minutes N] -- COMMAND [ARGS]');
    const rawCmd = process.argv.slice(dash + 1);
    const passFile = path.join(root, 'team', 'test-passes.jsonl');
    const configuredReuseHours = cfg.limits?.test_reuse_hours ?? DEFAULT_REUSE_HOURS;
    const reuseHours = a['no-reuse'] ? 0 : configuredReuseHours;
    // Issue #469: computed before the run, so the recorded pass names the tree that was tested (also with --no-reuse, whose real pass a later job may reuse).
    // Issue #480: when reuse is switched off in the configuration nothing would ever read a pass, so the git calls and the record are skipped.
    const key = configuredReuseHours > 0 ? suiteKey(process.cwd(), rawCmd) : null;
    const prior = reuseHours > 0 ? findPass(passFile, key, { maxAgeHours: reuseHours }) : null;   // the same clean tree that already passed is not run again
    if (prior) { console.error(`test-slot: tree ${prior.tree} already passed this suite at ${prior.at}; not run again (use --no-reuse to force)`); process.exitCode = 0; return; }
    const keyBefore = key;   // the tree that is tested, computed before the run
    const cmd = withTestConcurrency(rawCmd, cfg.limits?.test_concurrency ?? DEFAULT_TEST_CONCURRENCY);
    // Issue #574: size class, admission against the host budget (when one exists) and a limited launch. Without a budget file
    // none of this changes anything: the job is granted at once and runs as before.
    const res = cfg.test_resources || {}, klass = a.class || 'suite';
    const allowed = checkClass(klass, res);
    if (!allowed.ok) { console.error(`test-slot: ${allowed.reason}`); recordTestEvent(root, { kind: 'refused', label: a.label || cmd.join(' '), reason: allowed.reason }); process.exitCode = 3; return; }
    const num = v => (v === undefined ? undefined : Number(v));
    const grant = await admit({ klass, request: { memory_mb: num(a['memory-mb']), cpus: num(a.cpus) }, cfg: res, onQueue: why => console.error(`test-slot: queued: ${why}`) });
    if (grant.action !== 'grant') { console.error(`test-slot: waited too long for host headroom (${grant.reason})`); recordTestEvent(root, { kind: 'refused', label: a.label || cmd.join(' '), reason: `waited too long for host headroom: ${grant.reason}` }); process.exitCode = 3; return; }
    const release = await acquireTestSlot(root, { limit, label: a.label || cmd.join(' ') });
    if (!release) { console.error('waited too long for a free test slot'); recordTestEvent(root, { kind: 'refused', label: a.label || cmd.join(' '), reason: 'waited too long for a free test slot' }); process.exitCode = 3; return; }
    const id = `${Date.now()}-${process.pid}`;
    if (grant.limits) {
      // A memory-limited job runs through the resource runner (own group, cgroup wrapper, memory watchdog).
      const { code, kill } = await runLimited(cmd, { env: testEnv(process.env, cfg.test_tmp_root), limits: grant.limits, klass, id, wrapper: cgroupWrapper(grant, id, { available: fs.existsSync('/run/systemd/system') }) });
      if (kill) {
        console.error(`test-slot: ${kill.note}`); recordTestEvent(root, { kind: 'killed', label: a.label || cmd.join(' '), reason: kill.note });
        try { fs.mkdirSync(path.join(root, 'team'), { recursive: true }); fs.appendFileSync(path.join(root, 'team', 'test-job-results.jsonl'), JSON.stringify({ at: new Date().toISOString(), label: a.label || null, ...kill }) + '\n'); } catch { /* the stderr line above is the record */ }
      }
      release(); if (code === 0 && keyBefore) recordPass(passFile, keyBefore, { label: a.label }); process.exitCode = code; return;
    }
    // Own process group, a maximum runtime, and the whole group is stopped (TERM, then KILL) on timeout, signal or exit.
    const maxMinutes = Number(a['max-minutes']);
    const maxRuntimeMs = Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes * 60000 : DEFAULT_MAX_RUNTIME_MS;
    const run = await runInGroup(cmd, { env: testEnv(process.env, cfg.test_tmp_root), maxRuntimeMs, graceMs: Number(process.env.AI_SUPERVISOR_TEST_GRACE_MS) || 5000 });
    if (run.timedOut) console.error(`test-slot: stopped after the maximum runtime of ${formatRuntime(maxRuntimeMs)} (process group terminated)`);
    if (run.timedOut) recordTestEvent(root, { kind: 'timeout', label: a.label || cmd.join(' '), reason: `stopped after the maximum runtime of ${formatRuntime(maxRuntimeMs)}` });
    if (run.leftover) { console.error('test-slot: WARNING processes of the test run survived SIGKILL'); recordTestEvent(root, { kind: 'orphaned', label: a.label || cmd.join(' '), reason: 'processes of the test run survived SIGKILL' }); }
    const code = run.code;
    release(); if (code === 0 && keyBefore) recordPass(passFile, keyBefore, { label: a.label }); process.exitCode = code; return;
  }
  if (command === 'dashboard') {
    if (a._[0] !== 'serve') throw new SupervisorError('usage: dashboard serve --host LAN_IPV4 [--port N]');
    const { serve, DEFAULT_PORT } = await import('./dashserver.mjs');
    const server = await serve({ root, config: () => loadTeamConfig(teamConfigFile, root), host: a.host || process.env.DASHBOARD_HOST, port: Number(a.port || process.env.DASHBOARD_PORT || DEFAULT_PORT), evidenceRoot: process.env.DASHBOARD_EVIDENCE_ROOT || undefined });
    console.log(`dashboard listening on http://${server.address().address}:${server.address().port}/ (read-only)`);
    return;   // the server keeps the process alive
  }
  if (command === 'probe') {
    if (!a._[0]) throw new SupervisorError('usage: probe <agent>');
    const out = await probeNow({ root, registry, config: loadTeamConfig(teamConfigFile, root), agent: a._[0] });
    console.log(JSON.stringify(out, null, 2));
    if (!out.ok) process.exitCode = 3;
    return;
  }
  if (command === 'preflight') {
    const result = await gatePreflight(registry, loadTeamConfig(teamConfigFile, root));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 3;
    return;
  }
  if (command === 'history') {   // issue #362: backfill the retained timeline; only 'backfill --github' calls GitHub, and no model is ever called
    const config = loadTeamConfig(teamConfigFile, root);
    if (a._[0] === 'backfill') {
      const jobs = readJobs(root);
      const local = recordTimeline(root, { config, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), incidents: readIncidents(root) });
      const github = a.github === true ? githubBackfill(root, ghRunner(), config.repository) : null;
      console.log(JSON.stringify({ added: local, github }, null, 2)); return;
    }
    if (a._[0] === 'status') {
      const timeline = readTimeline(root), now = Date.now();
      console.log(JSON.stringify({ entries: timeline.length, first: timeline[0]?.at ?? null, storage: storageReport(root, { now, timeline }), gaps: computeGaps(timeline, allSnapshots(root, readSnapshots(root)), now).length }, null, 2)); return;
    }
    throw new SupervisorError('usage: history backfill [--github] | history status');
  }
  if (command === 'team') {
    if (a._[0] === 'status') {
      const { currentStatus, renderStatus } = await import('./teamstatus.mjs');
      const config = loadTeamConfig(teamConfigFile, root);
      const status = await currentStatus({ root, config, register: readRegister(config), gh: a['no-github'] ? null : githubClient(config) });
      console.log(a.json === true ? JSON.stringify(status, null, 2) : renderStatus(status).trimEnd()); return;
    }
    if (a._[0] === 'accept-split') {   // issue #244: the "Accept split" path of the Needs you item
      const n = Number(a._[1]);
      if (!Number.isSafeInteger(n) || n <= 0) throw new SupervisorError('usage: team accept-split ISSUE');
      const release = await homeownerLock(root, 'accept-split', queueOf(root, 'accept-split', [n]));
      try { console.log(JSON.stringify({ issue: n, filed: await (await teamFor(root, registry)).acceptSplit(n) })); } finally { release(); }
      return;
    }
    if (a._[0] === 'breaker') {   // issue #549: the circuit breaker's status, and the homeowner's resume
      const sub = a._[1];
      if (sub === 'status') { console.log(JSON.stringify(await (await teamFor(root, registry)).breakerStatus(), null, 2)); return; }
      if (sub !== 'resume' || !a._[2]) throw new SupervisorError('usage: team breaker status | team breaker resume CAUSE|global|all');
      if (!resumeAllowed()) throw new SupervisorError('team breaker resume needs a person at a terminal, outside any supervised job; there is no supported route for a supervised job to clear it');
      const release = await homeownerLock(root, 'breaker resume', () => { requestBreakerResume(root, String(a._[2]), Date.now()); return 'the resume is queued; the next tick applies it'; });
      try { console.log(JSON.stringify((await teamFor(root, registry)).breakerResume(String(a._[2])))); } finally { release(); }
      return;
    }
    if (a._[0] === 'reopen') {   // issue #490: let an issue be implemented again after its pull request was closed unmerged
      const n = Number(a._[1]);
      if (!Number.isSafeInteger(n) || n <= 0) throw new SupervisorError('usage: team reopen ISSUE');
      const release = await homeownerLock(root, 'reopen', queueOf(root, 'reopen', [n]));
      try { console.log(JSON.stringify({ issue: n, reopened: await (await teamFor(root, registry)).reopen(n) })); } finally { release(); }
      return;
    }
    if (a._[0] === 'request-review') {   // issue #366: the homeowner asks for one new review of the same head, citing the decision
      if (!/^\d+$/.test(String(a._[1] ?? '')) || typeof a._[2] !== 'string' || !a._[2]) throw new SupervisorError('usage: team request-review PR DECISION_LINK');
      const release = await homeownerLock(root, 'request-review', queueOf(root, 'request-review', [a._[1], a._[2]]));
      try { console.log(JSON.stringify(await (await teamFor(root, registry)).requestReReview(a._[1], a._[2]))); } finally { release(); }
      return;
    }
    if (a._[0] === 'idle-report') {   // issue #487: idle time by cause for a time range; reads local records only (no GitHub, no model)
      const config = loadTeamConfig(teamConfigFile, root), to = a.to ? Date.parse(a.to) : Date.now();
      const from = a.from ? Date.parse(a.from) : to - Number(a.hours ?? 24) * 3600000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new SupervisorError('usage: team idle-report [--hours N | --from ISO_TIME [--to ISO_TIME]] [--json]');
      const snapshots = allSnapshots(root, readSnapshots(root));
      const rep = idleReport({ jobs: readJobs(root), snapshots, agents: Object.fromEntries(Object.entries(config.agents).map(([n, x]) => [n, x.provider])), from, to });
      // Issue #406: passes by trigger, and the wake cap state, from local records only.
      rep.passes = passStats(snapshots, from, to); rep.wake = wakeStatus(root, Date.now(), wakeCap());
      const wk = rep.wake, wakeLine = `Wakes: ${wk.acceptedLastHour} of ${wk.cap} used in the last hour${wk.capHit ? `; CAP REACHED: ${wk.droppedLastHour} request(s) dropped, the five-minute schedule is the fallback` : ''}`;
      console.log(a.json === true ? JSON.stringify(rep, null, 2) : `${renderIdleReport(rep)}\n${renderPassStats(rep.passes)}\n${wakeLine}`); return;
    }
    if (a._[0] !== 'tick') throw new SupervisorError('usage: team tick [--dry-run] | team idle-report [--hours N | --from T --to T] [--json] | team status [--json] | team accept-split ISSUE | team request-review PR DECISION_LINK');
    console.log(JSON.stringify(await teamTick(root, registry, a['dry-run'] === true), null, 2)); return;
  }
  if (command === 'self-upgrade') {
    const { config, upgrade } = selfUpgradeFor(root, registry);
    upgrade.lock = () => upgradeLock(root);   // issue #798: state updates from this command run under upgrade.lock
    if (a._[0] === 'hand-install') {
      // Issue #446: the one supported route for an update the automatic upgrader refuses.
      const d = upgrade.d;
      const publicUrl = config.self_upgrade?.public_dashboard_url || null;
      const deps = {
        installed: d.installed, now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)),
        activeJobs: d.runningJobs, dueHeld: d.dueHeld, install: d.handInstall, dryRunTick: d.dryRunTick, rollback: d.rollback,
        restartDashboard: sha => d.restartDashboard(sha),
        dashboardAnswers: async () => {
          const st = await d.dashboardStatus();
          const local = Boolean(st.running && st.healthy);
          let pub = null;
          if (publicUrl) { try { const r = await fetch(new URL('/api/view.json', publicUrl), { signal: AbortSignal.timeout(8000) }); pub = r.status === 200; } catch { pub = false; } }
          return { local, public: pub };
        },
        liveTick: d.liveTick,
        record: e => upgrade.record(e),
        noteInstalled: () => upgrade.noteHandInstalled()   // issue #708: the batching window runs from this install; a pending install-now is spent
      };
      const drain = config.self_upgrade?.drain_max_minutes != null ? config.self_upgrade.drain_max_minutes * 60000 : undefined;
      const out = await handInstall({ root, sha: a._[1], deps, say: line => console.log(line), ...(drain ? { drainMaxMs: drain } : {}) });
      process.exitCode = out.ok ? 0 : 1; return;
    }
    if (a._[0] === 'install-now') { const r = upgrade.requestInstallNow(); if (!r.ok) { console.log(`not requested: ${r.reason}`); process.exitCode = 1; return; } console.log('the next install skips the batching wait'); return; }   // issue #695
    if (a._[0] === 'clear-latch') { upgrade.clearLatch(); console.log('latch cleared'); return; }
    if (a._[0] !== 'status') throw new SupervisorError('usage: self-upgrade status|install-now|clear-latch|hand-install SHA');
    console.log(JSON.stringify({ latch: upgrade.latch(), pending: upgrade.s.pending || null, lastUpgradeAt: upgrade.s.lastUpgradeAt || null, lastFinishedAt: upgrade.s.lastFinishedAt || null, urgent: upgrade.urgentView(), nextInstall: upgrade.s.nextInstall || null, batchDueAt: upgrade.batchDueAt(), install: upgrade.s.install || null, installed: upgrade.d.installed() }, null, 2)); return;
  }
  if (command === 'reconcile' || command === 'daemon') {
    if (command === 'reconcile') {
      // Issue #406: one pass at a time, scheduled or woken (supervisor/wakepass.mjs). A scheduled fire that finds a pass running queues one more.
      if (a.wake !== undefined && !(typeof a.wake === 'string' && TRIGGERS.includes(a.wake))) throw new SupervisorError(`unknown --wake value; use one of: ${TRIGGERS.join(', ')}`);
      let out;
      try { out = await drivePass({ root, wake: a.wake || null, spawnFollowUp: why => spawnPass(root, why), runPass: async pass => {
        // Issue #448: the script no longer serialises whole runs, so recovery takes its own lock; a run that finds it held skips recovery.
        const unlockRecover = tickLock(root, 'reconcile.lock');
        let result;
        if (!unlockRecover) { result = { skippedRecovery: 'another reconcile run is recovering jobs' }; try { recordSkip(root, 'job recovery skipped: another reconcile run holds reconcile.lock'); } catch { /* best effort */ } }
        else { try { result = reconcileOnce(root, registry, installRunning(root)); } finally { unlockRecover(); } }
        // The upgrade check comes first (issue #134). A failure here never fails the tick.
        let before;
        try { before = await selfUpgradeBefore(root, registry); } catch (error) { before = { error: String(error.message).slice(0, 200), hold: null }; }
        // The five-minute reconcile cron also runs the token-free team tick, when the team loop is enabled.
        try {
          result.team = await teamTick(root, registry, false, before.hold, pass);
          // A skipped item (lease conflict, gh error) keeps the other items running but still makes the scheduled run fail visibly.
          if (Array.isArray(result.team?.skipped) && result.team.skipped.length) process.exitCode = 1;
        } catch (error) { result.team = { error: String(error.message).slice(0, 200) }; process.exitCode = 1; }
        // After the tick lock is released, so the new version's dry-run health check can take it (the pass lock is not taken by that check). A failure here never fails the tick.
        try { result.selfUpgrade = before.error ? { error: before.error } : await selfUpgradeAfter(root, registry, before, result.team); } catch (error) { result.selfUpgrade = { error: String(error.message).slice(0, 200) }; }
        // Issue #406: this process ran the old code and dispatched nothing after an install; ask for a pass on the new code now. The request is
        // seen when this pass releases the pass lock, so the follow-up runs the installed code and verifies the install.
        if (before.result === 'upgraded') wakeNextJob(root, 'install');
        return result;
      } }); } catch (error) {
        // A pass that throws is the case the record matters most for (review of PR #797): log it, then fail as before.
        if (a.wake) recordWakePass(root, { at: Date.now(), wake: a.wake, path: process.env.PATH || null, ran: true, error: String(error?.message || error).slice(0, 200), exit: process.exitCode || 1 });
        throw error;
      }
      if (a.wake) recordWakePass(root, { at: Date.now(), wake: a.wake, path: process.env.PATH || null, ran: out.ran, trigger: out.trigger || null, followUp: out.followUp || null, skipped: out.skipped || null, exit: process.exitCode || 0 });
      console.log(JSON.stringify(out.ran ? out.result : { skipped: out.skipped })); return;
    }
    // Run under a host service or tmux supervisor pane; this loop never invokes a model itself.
    while (true) {
      const result = reconcileOnce(root, registry);
      if (result.resumed || result.blocked || result.released) console.log(JSON.stringify({ at: Date.now(), ...result }));
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
      if (childAlive(job)) process.kill(job.workerPid, command === 'pause' ? 'SIGUSR1' : 'SIGTERM');
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
