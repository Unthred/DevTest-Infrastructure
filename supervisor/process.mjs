import { spawn } from 'node:child_process';
import { billingRisk, limitFromAllowance } from './allowance.mjs';
import { checkpoint, event, prompt, readJob, safeEnvironment, saveJob } from './core.mjs';

export async function runProcess(root, job, config, adapter, clock, options = {}) {
  if (typeof adapter.preflight === 'function' && !adapter.preflight(job)) return { code: 1, event: 'auth_error' };
  const argv = adapter.command(config, job, job.attempts > 1);
  const child = spawn(argv[0], argv.slice(1), { cwd: job.worktree, env: safeEnvironment(process.env, config.manifest.launch.env_allowlist || []), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let observed = null, resetAt = null, resetSource = 'none', verified = false, buffer = '';
  const nonFatal = new Set(['transient_rate_limit', 'network_error']);
  let allowance = null;
  const observeEvent = result => {
    if (result.allowance) allowance = result.allowance;
    if (!result.event || (observed && !nonFatal.has(observed) && nonFatal.has(result.event))) return;
    observed = result.event; resetAt = result.resetAt || null;
    resetSource = result.resetSource || 'none'; verified = result.verified === true;
  };
  let stopping = false;
  const signalChild = signal => {
    if (!child.pid || stopping) return;
    stopping = true;
    try { process.kill(-child.pid, signal); } catch { /* already exited */ }
  };
  const onInt = () => signalChild('SIGINT');
  const onTerm = () => signalChild('SIGTERM');
  process.on('SIGUSR1', onInt); process.on('SIGTERM', onTerm);
  // Publish the child only after the worker can accept a stop/pause signal.
  job.childPid = child.pid; saveJob(root, job, clock);
  child.stdin.end(prompt(job, job.attempts > 1));
  const onData = chunk => {
    buffer = (buffer + chunk.toString('utf8')).slice(-65536);
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).slice(0, 16384); buffer = buffer.slice(index + 1);
      const result = adapter.observe(line);
      if (result.sessionId && result.sessionId !== job.sessionId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(result.sessionId)) { job.sessionId = result.sessionId; saveJob(root, job, clock); }
      observeEvent(result);
    }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const interval = setInterval(() => { try { checkpoint(root, job, clock); } catch (error) {
    const errorClass = String(error?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 48);
    event(root, job, `checkpoint_exception:${errorClass}:message_redacted`, clock);
    signalChild('SIGINT');
  } }, options.checkpointMs || 60000);
  try {
    const result = await new Promise(resolve => {
      child.on('error', () => resolve({ code: 1, event: 'crash' }));
      child.on('close', code => resolve({ code: code ?? 1 }));
    });
    if (buffer) observeEvent(adapter.observe(buffer.slice(0, 16384)));
    if (typeof adapter.postRun === 'function') { const late = adapter.postRun(job); if (late) allowance = late; }
    if (allowance) job.allowance = { ...allowance, observedAt: clock.now() };
    // Structured allowance evidence only refines a failed run; it never turns a success into a limit.
    if (result.code !== 0 && (!observed || nonFatal.has(observed))) {
      const derived = billingRisk(allowance) ? { event: 'approval_required' } : limitFromAllowance(allowance, clock.now());
      if (derived) { observed = null; observeEvent(derived); }
    }
    const current = readJob(root, job.id);
    if (current.status === 'paused_manual' || current.status === 'stopped') job.status = current.status;
    job.childPid = null; saveJob(root, job, clock);
    if (stopping) return { code: 1, event: 'manual_stop' };
    return { code: result.code, event: observed || result.event, resetAt, resetSource, verified };
  } finally {
    clearInterval(interval);
    process.off('SIGUSR1', onInt); process.off('SIGTERM', onTerm);
  }
}
