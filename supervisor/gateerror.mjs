// Issue #1223: a resume check that throws used to log only "resume check failed: Error". This keeps the error message and a short
// stack summary (redacted, bounded) on the job record, and says when one of them is worth an event: once per distinct message per job
// per hour, so a check that throws every minute does not fill the event log.
import { redact } from './redact.mjs';

export const MESSAGE_CHARS = 200;
export const STACK_CHARS = 400;
export const STACK_FRAMES = 3;
export const RECORD_EVERY_MS = 60 * 60 * 1000;

export function describeGateError(error) {
  const message = redact(String(error?.message || error?.name || error || 'Error'), MESSAGE_CHARS);
  const frames = String(error?.stack || '').split('\n').slice(1, 1 + STACK_FRAMES).map(l => l.trim()).filter(Boolean);
  return { name: String(error?.name || 'Error').slice(0, 48), message, stack: redact(frames.join(' | '), STACK_CHARS) };
}

// Updates job.resumeCheck and returns the gate answer for drive(). `event` (core's event writer) is called when this failure is the first of its message
// for the job or the last recorded one is an hour old. The job record always carries the latest message and a running count.
export function noteGateError(root, job, error, clock, event) {
  const now = clock.now();
  const d = describeGateError(error);
  const prev = job.resumeCheck;
  const same = prev?.message === d.message;
  const record = !same || now - (prev.recordedAt ?? 0) >= RECORD_EVERY_MS;
  job.resumeCheck = { message: d.message, stack: d.stack, firstAt: same ? prev.firstAt : now, lastAt: now, count: same ? (prev.count || 0) + 1 : 1,
    recordedAt: record ? now : prev.recordedAt };
  if (record) event(root, job, 'resume_check_failed', clock);
  return { go: false, reason: `resume check failed: ${d.name}: ${d.message}`.slice(0, 300) };
}
