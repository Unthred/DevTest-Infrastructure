// Issue #1164: the direct controls that act on one job (start, pause, stop) and on the parked label (park, unpark). Each returns
// { outcome: 'done' | 'refused', changed, text, before, after, undo } and never throws for a normal refusal; `undo` is the step that reverses it.
// A start goes through the same checks as the homeowner's approved resume (jobresume.mjs), so it cannot take a slot, allowance or breaker it would not
// be given.
import { SupervisorError } from './core.mjs';
import { TERMINAL, findItem, park, stopJob } from './controlactions.mjs';
import { checkResumable } from './jobresume.mjs';

const done = (changed, text, extra = {}) => ({ outcome: 'done', changed, text, ...extra });
const refused = text => ({ outcome: 'refused', changed: false, text });
const PARKED = 'parked';
// Narrower than the homeowner's resume (jobresume RESUMABLE): a blocked or failed job, such as one out of retries, is not the overseer's to restart.
const STARTABLE = ['paused_manual', 'paused_limit'];

// The one job an id names (8 characters or the full id), or a refusal; a prefix that fits several jobs is ambiguous, never guessed.
export async function resolveJob(target, deps) {
  const hits = Object.keys(deps.records).filter(id => id.startsWith(target));
  if (hits.length !== 1) return { refusal: refused(hits.length ? `job id ${target} is ambiguous; use the full id` : `no job ${target}`) };
  const job = await deps.jobs.get(hits[0]);
  return job ? { id: hits[0], job, rec: deps.records[hits[0]] } : { refusal: refused(`job ${target} is unknown to the supervisor`) };
}

export async function directPark(n, deps) {
  const r = await park(n, deps);
  if (r.outcome === 'refused') return r;
  return { ...r, before: { parked: !r.changed }, after: { parked: true }, undo: r.changed ? { op: 'unpark', n } : null };
}

export async function directUnpark(n, deps) {
  const found = await findItem(deps.gh, n);
  if (!found) return refused(`no open issue or pull request #${n}`);
  if (!found.labels.includes(PARKED)) return done(false, `${found.kind} #${n} is not parked; nothing changed`, { before: { parked: false },
    after: { parked: false } });
  await deps.gh.removeLabel(n, PARKED);
  return done(true, `${found.kind} #${n} is no longer parked`, { before: { parked: true }, after: { parked: false }, undo: { op: 'park', n } });
}

export async function directStop(target, deps) {
  const found = await resolveJob(target, deps);
  if (found.refusal) return found.refusal;
  const r = await stopJob(target, deps);
  if (r.outcome === 'refused') return r;
  return { ...r, before: { status: found.job.status }, after: { status: r.changed ? 'stopped' : found.job.status }, undo: r.changed ? { op: 'restart',
    id: found.id } : null };
}

export async function directPause(target, deps) {
  const found = await resolveJob(target, deps);
  if (found.refusal) return found.refusal;
  const { id, job } = found, state = { status: job.status };
  if (TERMINAL.has(job.status)) return refused(`job ${target} already ended (${job.status}); it cannot be paused`);
  if (job.status === 'paused_manual') return done(false, `job ${target} is already paused`, { before: state, after: state });
  if (job.status === 'paused_limit') return done(false, `job ${target} is already paused on a usage limit; it resumes after the reset`,
    { before: state, after: state });
  if (typeof deps.jobs.pause !== 'function') return refused('this supervisor cannot pause a job');
  await deps.jobs.pause(id);
  return done(true, `job ${target} paused`, { before: state, after: { status: 'paused_manual' }, undo: { op: 'start_job', id } });
}

async function startWaiting(id, job, target, deps) {
  const waiting = Number.isFinite(job.nextAttemptAt) && job.nextAttemptAt > deps.now();
  if (!waiting || typeof deps.jobs.rearm !== 'function') return done(false, `job ${target} is already queued to start`,
    { before: { status: 'queued' }, after: { status: 'queued' } });
  const moved = await deps.jobs.rearm(id);
  const text = moved ? `job ${target} no longer waits out its backoff and starts now` : `job ${target} is already queued to start`;
  return done(moved, text, { before: { status: 'queued', waiting: true }, after: { status: 'queued', waiting: false }, undo: { op: 'pause_job', id } });
}

export async function directStart(target, deps) {
  const found = await resolveJob(target, deps);
  if (found.refusal) return found.refusal;
  const { id, job, rec } = found, state = { status: job.status };
  if (job.status === 'running') return done(false, `job ${target} is already running`, { before: state, after: state });
  if (job.status === 'queued') return startWaiting(id, job, target, deps);
  if (!STARTABLE.includes(job.status)) return refused(`job ${target} is ${job.status}; only a paused or waiting job can be started directly. A blocked or failed job, or one that used its retries, needs the homeowner's resume`);
  try { await checkResumable(deps.team, { target, rec, job }, deps.roleOf); } catch (error) {
    if (error instanceof SupervisorError) return refused(error.message);
    throw error;
  }
  rec.ingested = false;
  deps.save();
  await deps.jobs.resume(id);
  return done(true, `job ${target} resumed once with a fresh bounded round`, { before: state, after: { status: 'queued' }, undo: { op: 'pause_job', id } });
}

// The reverse of a stop: the job comes back through the same checks as the homeowner's resume (free slot, allowance, breaker, PR still open at the same head).
export async function restartStopped(id, deps) {
  const job = await deps.jobs.get(id), rec = deps.records[id];
  if (!job || !rec) return refused('the job is no longer known to the supervisor');
  if (job.status !== 'stopped') return refused(`job ${id.slice(0, 8)} is ${job.status}, not stopped, so there is nothing to restart`);
  try { await checkResumable(deps.team, { target: id.slice(0, 8), rec, job }, deps.roleOf, ['stopped']); } catch (error) {
    if (error instanceof SupervisorError) return refused(error.message);
    throw error;
  }
  rec.ingested = false;
  deps.save();
  await deps.jobs.resume(id);
  return done(true, `job ${id.slice(0, 8)} restarted`, { before: { status: 'stopped' }, after: { status: 'queued' } });
}
