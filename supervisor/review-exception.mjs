// One-off homeowner review exception for named pull requests (issue #318, proposal D-027). Pure helpers; the dispatcher (team.mjs)
// applies them. The exception never changes D-024 for an unlisted pull request: every function here answers "no" for a PR that is
// not listed, whose entry has expired or ended, or while D-027 is not homeowner-approved.
import { SupervisorError } from './core.mjs';

export const EXCEPTION_DECISION = 'D-027';
const MAX_ENTRIES = 20;
const MAX_WINDOW_MS = 31 * 86400000;   // an entry may not name an expiry further out than a month: the exception is time-limited by design

const entryOk = e => e && typeof e === 'object' && !Array.isArray(e) && typeof e.model === 'string' && /^[\w.:-]{1,64}$/.test(e.model)
  && (e.effort === undefined || (typeof e.effort === 'string' && /^[\w-]{1,16}$/.test(e.effort))) && Object.keys(e).every(k => k === 'model' || k === 'effort');

// review_exception: { agent, full_review: {model, effort?}, commit_review: {model, effort?}, prs: [{ pr, expires_at }] }
export function validateReviewException(x, agentNames, now = Date.now()) {
  if (x === undefined) return;
  const bad = what => new SupervisorError('invalid review_exception config: ' + what);
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(k => !['agent', 'full_review', 'commit_review', 'prs'].includes(k))) throw bad('shape');
  if (!agentNames.includes(x.agent)) throw bad('agent');
  if (!entryOk(x.full_review) || !entryOk(x.commit_review)) throw bad('full_review and commit_review each need a model');
  if (x.full_review.model === x.commit_review.model) throw bad('the two reviews must use different models');
  if (!Array.isArray(x.prs) || x.prs.length > MAX_ENTRIES) throw bad('prs');
  const seen = new Set();
  for (const e of x.prs) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(k => !['pr', 'expires_at'].includes(k)) || !Number.isSafeInteger(e.pr) || e.pr < 1 || seen.has(e.pr)) throw bad('prs entry');
    seen.add(e.pr);
    const t = typeof e.expires_at === 'string' ? Date.parse(e.expires_at) : NaN;
    if (!Number.isFinite(t)) throw bad(`prs entry #${e.pr} needs an expires_at date`);
    if (t > now + MAX_WINDOW_MS) throw bad(`prs entry #${e.pr} expires more than 31 days from now`);
  }
}

// The listed, unexpired, not-yet-ended entry for a PR number, or null. 'ended' is the dispatcher's record { [pr]: { reason, at } }.
export function activeException(cfg, approved, ended, prNumber, now) {
  if (!cfg || !approved) return null;
  const e = cfg.prs.find(x => x.pr === prNumber);
  if (!e || ended?.[prNumber] || !(now < Date.parse(e.expires_at))) return null;
  return { ...e, agent: cfg.agent, full_review: cfg.full_review, commit_review: cfg.commit_review };
}

// Listed entries that have just ended: expired (still open) or gone from the open list because merged or closed. `stateOf(n)` is
// 'MERGED' | 'CLOSED' | 'OPEN' | null (unknown: never ends an entry on a guess).
export function endedNow(cfg, ended, openNumbers, stateOf, now) {
  const out = [];
  for (const e of cfg?.prs || []) {
    if (ended?.[e.pr]) continue;
    if (!openNumbers.has(e.pr)) { const s = stateOf(e.pr); if (s === 'MERGED') out.push({ pr: e.pr, reason: 'merged' }); else if (s === 'CLOSED') out.push({ pr: e.pr, reason: 'closed' }); }
    else if (!(now < Date.parse(e.expires_at))) out.push({ pr: e.pr, reason: 'expired' });
  }
  return out;
}

// Commit ranges written by the exception's full-review model, from the dispatcher's job records: each writer job on that model covers
// the commits from the head it started from up to the head the next writer job started from (or the current head). A job without a
// start head (implement) starts at the merge base. Data for the second reviewer; never instructions.
export function modelWrittenRanges(jobs, prNumber, branch, model, currentHead, writerKinds) {
  const mine = jobs.filter(j => writerKinds.has(j.kind) && (j.pr === prNumber || (j.branch && j.branch === branch))).sort((a, b) => (a.at || 0) - (b.at || 0));
  return mine.map((j, i) => ({ job: String(j.id || '').slice(0, 8), kind: j.kind, model: j.model ?? null, from: j.kind === 'implement' || !j.head ? 'merge-base' : j.head, to: mine[i + 1]?.head || currentHead })).filter(r => r.model === model);
}
