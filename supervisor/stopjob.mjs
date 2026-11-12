// Issue #1109: a supported stop is a decision, not a fault. The stop is written on the job record BEFORE the worker is signalled,
// so a worker that ends first cannot overwrite it, and it clears the automatic restart so nothing starts the job again.
import { transition, terminal, SupervisorError } from './core.mjs';
import { redact } from './redact.mjs';

// A stop reason outside WORK_STOPS (faults.mjs) is a deliberate stop; judge each new reason against that set.
export const STOP_REASON = /^[a-z_]{1,32}$/;

// Mark the job stopped by a person or the overseer. Returns the job. `signal` runs after the record is written (kill the worker).
export function stopJob(root, job, { reason = 'manual_stop', by = 'homeowner', why = '', clock, signal = null } = {}) {
  job.autoRestart = false;
  job.autoResume = false;
  job.stop = { by: String(by).slice(0, 32), reason: STOP_REASON.test(reason) ? reason : 'manual_stop', at: (clock?.now ?? Date.now)() };
  if (why) job.stop.why = redact(String(why), 200);
  transition(root, job, 'stopped', job.stop.reason, clock, true);   // forced: a stop also ends a manually paused job
  if (typeof signal === 'function') signal();
  return job;
}

// The worker's exit save keeps the stop command's marker: without it the stopped job is later classified as an infrastructure fault.
export function adoptExternalStop(job, current) {
  job.status = current.status;
  if (current.status === 'stopped') Object.assign(job, { stop: current.stop, lastEvent: current.lastEvent, autoRestart: current.autoRestart, autoResume: current.autoResume });
}

// The signal for a job's worker: sent only while the worker process is the one that was recorded (a reused pid is left alone).
// `childSignal` goes to a worker whose provider child is alive (pause asks it to wind down), `signal` otherwise.
export function workerSignal(job, { processStart, childAlive }, childSignal, signal = 'SIGTERM') {
  return () => {
    if (!(job.workerPid && processStart(job.workerPid) === job.workerStart)) return;
    process.kill(job.workerPid, childAlive(job) ? childSignal : signal);
  };
}

// The overseer's supported stop and pause of a job (issues #629, #1115, #1164): the same steps as `ai-supervisor stop ID` and `pause ID`.
// `procs` = { processStart, childAlive } from core.mjs. A job that already ended is refused, never touched.
export function overseerStop(root, job, reason, procs, { by = 'overseer', why = '' } = {}) {
  if (terminal.has(job.status)) throw new SupervisorError('terminal job cannot be stopped');
  stopJob(root, job, { reason, by, why, signal: workerSignal(job, procs, 'SIGTERM') });
}
export function overseerPause(root, job, procs) {
  if (terminal.has(job.status)) throw new SupervisorError('terminal job cannot be paused');
  workerSignal(job, procs, 'SIGUSR1')();   // asks the worker to wind down, then the job is marked paused
  transition(root, job, 'paused_manual', 'manual_pause');
}
