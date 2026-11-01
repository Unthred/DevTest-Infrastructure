// Fresh context per job (issue #74). Every turn re-sends the whole context and the provider's prompt cache expires after
// about an hour idle, so a stale or large session is more expensive to resume than to restart from the job's handover.
// Policy: the first attempt of a job always starts a fresh provider session (a job never inherits a session id). A later
// attempt of the same job (auto-resume, retry, limit pause) resumes the provider session only when it was active within
// the cache window and its context is under a size limit; otherwise it starts fresh, seeded from the handover and prompt.
import fs from 'node:fs';
import { saveJob } from './core.mjs';

export const CACHE_WINDOW_MS = 55 * 60 * 1000; // below the ~1 h prompt-cache lifetime
export const MAX_CONTEXT_TOKENS = 150000;
const HANDOVER_SEED_CHARS = 6000;

const positive = v => (Number.isFinite(v) && v > 0 ? v : null);
export function sessionPolicy(job) {
  // Per-job overrides come from the job spec; the window can be shortened but never extended beyond the cache lifetime.
  return { windowMs: Math.min(positive(job.sessionResumeWindowMs) ?? CACHE_WINDOW_MS, CACHE_WINDOW_MS),
    maxContextTokens: positive(job.sessionMaxContextTokens) ?? MAX_CONTEXT_TOKENS };
}
export function emptyStats() {
  return { started: 0, resumes: 0, freshRestarts: 0, tokensRecached: 0, lastActiveAt: null, contextTokens: 0, lastDecision: null };
}
export function stats(job) { return (job.sessions ||= emptyStats()); }

// Returns { resume, reason }. Pure apart from reading the job.
export function decide(job, now) {
  const s = stats(job), p = sessionPolicy(job);
  if (!(job.attempts > 1)) return { resume: false, reason: 'new_job' };
  if (!job.sessionId) return { resume: false, reason: 'no_session' };
  if (!Number.isFinite(s.lastActiveAt)) return { resume: false, reason: 'activity_unknown' };
  if (now - s.lastActiveAt > p.windowMs) return { resume: false, reason: 'cache_window_expired' };
  if (s.contextTokens > p.maxContextTokens) return { resume: false, reason: 'context_too_large' };
  return { resume: true, reason: 'within_window' };
}

// Applies the decision to the job and records it. A fresh start clears the stored session id so no adapter can resume it.
export function begin(root, job, clock) {
  const decision = decide(job, clock.now()), s = stats(job);
  if (!decision.resume) { job.sessionId = null; s.contextTokens = 0; }
  s.started += decision.resume ? 0 : 1;
  if (decision.resume) s.resumes++;
  else if (job.attempts > 1) s.freshRestarts++;
  s.lastDecision = decision.reason;
  s.lastActiveAt = clock.now();
  saveJob(root, job, clock);
  return decision;
}
export function touch(job, clock) { stats(job).lastActiveAt = clock.now(); }
export function recordUsage(job, line) {
  const s = stats(job);
  if (line.recached) s.tokensRecached += line.recached;
  if (line.context) s.contextTokens = line.context;
}

// Text added to the prompt of a fresh restart so the new session needs none of the old one's context.
export function seed(job) {
  let text = 'This is a FRESH provider session for a job that already ran earlier; the previous session was not reused (stale or too large). Do not assume anything from it.';
  if (job.checkpoint?.head) text += ` Last checkpoint HEAD: ${job.checkpoint.head}.`;
  if (job.handover && fs.existsSync(job.handover) && fs.statSync(job.handover).isFile()) {
    const fd = fs.openSync(job.handover, 'r');
    try {
      const buffer = Buffer.alloc(HANDOVER_SEED_CHARS); const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      text += `\n\nStart of the handover (${job.handover}; read the file for the rest):\n${buffer.subarray(0, n).toString('utf8')}`;
    } finally { fs.closeSync(fd); }
  }
  return text;
}
