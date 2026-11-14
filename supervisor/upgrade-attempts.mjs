// Issue #1368: a commit the install-time tests refuse gets up to three further attempts, then one Needs you item with a retry control.
// The decisions here are pure functions of the recorded attempts and the clock; SelfUpgrade (supervisor/upgrade.mjs) carries them out.
// The record lives in self-upgrade.json under `refusedAttempts`: { sha, list: [{ n, at, stage }], tests, retryAsked? }.
// Only a refusal by the validator or tests counts. An environmental failure (clone, fetch, GitHub unreachable) keeps its own backoff.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';

export const MAX_FURTHER_ATTEMPTS = 3;
export const MAX_ATTEMPTS = 1 + MAX_FURTHER_ATTEMPTS;
export const ATTEMPT_GAP_MS = 10 * 60 * 1000;   // an attempt starts at least this long after the previous one
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'stopped', 'waiting_on']);
const SHA = /^[0-9a-f]{40}$/;
const sha7 = sha => (SHA.test(sha || '') ? sha.slice(0, 7) : 'an unknown commit');

// The record after one more refusal of `sha`. A record for another commit is dropped: the count starts again when main moves.
export function withRefusal(prev, { sha, now, stage, tests }) {
  const list = prev?.sha === sha ? prev.list : [];
  const names = (tests || []).map(name => String(name).slice(0, 200)).slice(0, 5);
  return { sha, list: [...list, { n: list.length + 1, at: now, stage }], tests: names.length ? names : prev?.tests || [] };
}

// Records one refusal in the state `s` and returns the fields the install history and the install status carry: the attempt number.
export function noteRefusal(s, { sha, now, stage, tests }) {
  s.refusedAttempts = withRefusal(s.refusedAttempts, { sha, now, stage, tests });
  return { attempt: s.refusedAttempts.list.length, ofAttempts: MAX_ATTEMPTS };
}

export const attemptsMade = record => record?.list?.length || 0;

// What the next tick does for a refused commit: 'requested' (the homeowner used the control), 'event' (a job ended since the last attempt and
// none is running), 'fallback' (the existing timer), 'wait', or 'exhausted' (no further attempt until main moves or the control is used).
export function nextStep(record, { now, running, jobEndedAt, fallbackMs }) {
  if (!record?.list?.length) return 'wait';
  if (record.retryAsked) return 'requested';
  if (attemptsMade(record) >= MAX_ATTEMPTS) return 'exhausted';
  const since = now - record.list.at(-1).at;
  if (since < ATTEMPT_GAP_MS) return 'wait';
  if (since >= fallbackMs) return 'fallback';
  return running === 0 && Number.isFinite(jobEndedAt) && jobEndedAt > record.list.at(-1).at ? 'event' : 'wait';
}

// True when this tick starts a further attempt for the refused `target`; a retry the homeowner asked for is spent here, so it starts one attempt.
export async function attemptDue(up, target, now, fallbackMs) {
  const record = up.s.refusedAttempts?.sha === target ? up.s.refusedAttempts : null;
  if (!record) return false;
  const running = await up.d.activeJobs();
  const jobEndedAt = up.d.jobEndedAt ? up.d.jobEndedAt() : lastJobEndAt(up.root);
  const step = nextStep(record, { now, running, jobEndedAt, fallbackMs });
  if (step === 'requested') { delete record.retryAsked; up.save(); }
  return ['requested', 'event', 'fallback'].includes(step);
}

// The latest end of any job, read from the job records; a job that is still active has no end yet.
export function lastJobEndAt(root) {
  const dir = path.join(root, 'jobs');
  let latest = null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names.filter(file => file.endsWith('.json'))) {
    let job = null;
    try { job = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (TERMINAL.has(job?.status) && Number.isFinite(job.updatedAt) && !(job.updatedAt <= latest)) latest = job.updatedAt;
  }
  return latest;
}

const when = at => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// The one Needs you item once the attempts are used up; [] while retries remain, and once the commit installed or main moved on.
export function attemptsAttention(root, ver) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')); } catch { return []; }
  const rec = state?.refusedAttempts;
  const live = rec && SHA.test(rec.sha || '') && attemptsMade(rec) >= MAX_ATTEMPTS && state.main?.sha === rec.sha
    && ver?.installed && ver.installed !== rec.sha && state.main.from === ver.installed;
  if (!live) return [];
  const tests = rec.tests?.length ? rec.tests.join('; ') : 'the test names were not reported';
  const text = `Foreman did not install main ${sha7(rec.sha)}: the install tests refused it on ${attemptsMade(rec)} attempts (${rec.list.map(a => when(a.at)).join(', ')}). `
    + `Failing tests: ${tests}. Foreman makes no further attempt for this commit until main moves or you retry.`;
  return [{ id: 'upgrade-blocked', text: redact(text, 700), ref: null, severity: 'action',
    action: 'Fix or retire the failing test, or use Retry install now to try once more; a newer main is tried on the next tick.' }];
}

// The homeowner's retry: set under upgrade.lock by the command. Refused when nothing is blocked. Returns { ok, reason? }; `state` is parsed
// self-upgrade.json and `installed` the installed commit.
export function askRetry(state, { installed, now }) {
  const rec = state?.refusedAttempts;
  if (!rec?.list?.length || rec.sha === installed || state.main?.sha !== rec.sha) return { ok: false, reason: 'no install is blocked' };
  if (state.pending) return { ok: false, reason: 'an install is waiting for its verification' };
  return { ok: true, state: { ...state, refusedAttempts: { ...rec, retryAsked: now }, urgent: { reason: 'homeowner request', at: now, to: rec.sha } } };
}
