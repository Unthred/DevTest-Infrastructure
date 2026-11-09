// Issue #1109: a supported stop is a decision, not a fault. The stop is written on the job record BEFORE the worker is signalled,
// so a worker that ends first cannot overwrite it, and it clears the automatic restart so nothing starts the job again.
import { transition } from './core.mjs';

export const STOP_REASON = /^[a-z_]{1,32}$/;

// Mark the job stopped by a person or the overseer. Returns the job. `signal` runs after the record is written (kill the worker).
export function stopJob(root, job, { reason = 'manual_stop', by = 'homeowner', clock, signal = null } = {}) {
  job.autoRestart = false;
  job.autoResume = false;
  job.stop = { by: String(by).slice(0, 32), reason: STOP_REASON.test(reason) ? reason : 'manual_stop', at: (clock?.now ?? Date.now)() };
  transition(root, job, 'stopped', job.stop.reason, clock);
  if (typeof signal === 'function') signal();
  return job;
}

// The signal for a job's worker: sent only while the worker process is the one that was recorded (a reused pid is left alone).
// `childSignal` goes to a worker whose provider child is alive (pause asks it to wind down), `signal` otherwise.
export function workerSignal(job, { processStart, childAlive }, childSignal, signal = 'SIGTERM') {
  return () => {
    if (!(job.workerPid && processStart(job.workerPid) === job.workerStart)) return;
    process.kill(job.workerPid, childAlive(job) ? childSignal : signal);
  };
}
