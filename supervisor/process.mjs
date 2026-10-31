import { spawn } from 'node:child_process';
import { billingRisk, limitFromAllowance } from './allowance.mjs';
import { addUsage, usageFromLine } from './usage.mjs';
import { checkpoint, event, prompt, readJob, safeEnvironment, saveJob } from './core.mjs';

export async function runProcess(root, job, config, adapter, clock, options = {}) {
  if (typeof adapter.preflight === 'function') {
    const ok = adapter.preflight(job);
    // A missing provider binary is a PATH/install fault, not a login problem: never tell the homeowner to log in again.
    if (ok === 'not_found') return { code: 1, event: 'preflight_failed' };
    if (!ok) return { code: 1, event: 'auth_error' };
  }
  const argv = adapter.command(config, job, job.attempts > 1);
  const child = spawn(argv[0], argv.slice(1), { cwd: job.worktree, env: safeEnvironment(process.env, config.manifest.launch.env_allowlist || []), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let observed = null, resetAt = null, resetSource = 'none', verified = false;
  const buffers = { stdout: '', stderr: '' };
  const nonFatal = new Set(['transient_rate_limit', 'network_error']);
  let allowance = null, usage = null;
  // Redacted diagnostics for issue #68: which stream and line class produced a classified event. Never the text itself.
  const lineClass = line => {
    if (!/^\s*[{\[]/.test(line)) return 'non-json';
    try { const t = JSON.parse(line)?.type; return /^[A-Za-z0-9_.-]{1,40}$/.test(String(t)) ? `json:${t}` : 'json'; } catch { return 'json-truncated'; }
  };
  let cause = null;
  const observeEvent = (result, stream = 'stdout', line = '') => {
    if (result.event) event(root, job, `classified:${result.event}:${stream}:${lineClass(line)}`, clock);
    if (result.allowance) allowance = result.allowance;
    if (!result.event || (observed && !nonFatal.has(observed) && nonFatal.has(result.event))) return;
    // Several exhausted windows: wait for the later reset, never the earlier one.
    if (observed === 'usage_limit' && result.event === 'usage_limit' && resetAt && (!result.resetAt || result.resetAt < resetAt)) return;
    observed = result.event; resetAt = result.resetAt || null; cause = `${stream}:${lineClass(line)}`;
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
  // A child that exits before reading its prompt closes the pipe; that is an exit status, not a supervisor crash.
  child.stdin.on('error', () => {});
  child.stdin.end(prompt(job, job.attempts > 1));
  const onData = stream => chunk => {
    buffers[stream] = (buffers[stream] + chunk.toString('utf8')).slice(-65536);
    let index;
    while ((index = buffers[stream].indexOf('\n')) !== -1) {
      const line = buffers[stream].slice(0, index).slice(0, 16384); buffers[stream] = buffers[stream].slice(index + 1);
      usage = addUsage(usage, usageFromLine(line));
      const result = adapter.observe(line, clock.now());
      if (result.sessionId && result.sessionId !== job.sessionId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(result.sessionId)) { job.sessionId = result.sessionId; saveJob(root, job, clock); }
      observeEvent(result, stream, line);
    }
  };
  child.stdout.on('data', onData('stdout')); child.stderr.on('data', onData('stderr'));
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
    for (const stream of ['stdout', 'stderr']) if (buffers[stream]) { const rest = buffers[stream].slice(0, 16384); observeEvent(adapter.observe(rest, clock.now()), stream, rest); }
    if (typeof adapter.postRun === 'function') { const late = adapter.postRun(job); if (late) allowance = late; }
    if (usage) job.usage = addUsage(job.usage, usage);
    if (allowance) job.allowance = { ...allowance, observedAt: clock.now() };
    // Billing guard: spending beyond the subscription blocks for a human on ANY exit, and outranks every other event
    // (including a clean exit), so a run that used paid overage is never recorded as plainly completed or retried.
    if (billingRisk(allowance)) { observed = 'approval_required'; resetAt = null; resetSource = 'none'; verified = false; }
    // A clean exit whose only approval evidence is a text match, with the provider reporting an allowed allowance and no
    // overage, is a false positive (issue #68): the post-condition, not a log line, decides completion.
    else if (result.code === 0 && observed === 'approval_required' && allowance?.status === 'allowed' && allowance.billing?.usingOverage === false) {
      event(root, job, `approval_ignored:clean_exit_allowance_allowed:${cause}`, clock);
      observed = null; resetAt = null; resetSource = 'none'; verified = false;
    }
    // Limit evidence only refines a failed run; it never turns a success into a limit.
    else if (result.code !== 0 && (!observed || nonFatal.has(observed))) {
      const derived = limitFromAllowance(allowance, clock.now());
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
