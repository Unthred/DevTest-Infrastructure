// Issue #630: Foreman's self-check. Each tick compares its own records with the GitHub lists the tick already fetched and with the jobs
// that are running. No I/O and no model call here: the caller passes in what it already holds and applies the fixes returned.
//
//  safe fix  `flag-label-gone`: Foreman recorded that it added needs-homeowner to a target, the target is in the lists and no longer
//            carries the label. The record is plainly stale (there is nothing left to remove); it is dropped and the change logged once.
//  item      `job-no-process`: a job recorded as running whose worker and child are gone.
//  item      `review-no-verdict`: a review finished and was ingested, no verdict was recorded for that head, no refusal card explains it,
//            the pull request is still open at that head and the reviewer has no attempts left.
//  covered   `implemented-no-pr`: the existing stale-mark item (issue #521) already raises it; it is counted, not raised again.
//
// An item is keyed by a stable id: it exists while the mismatch does and is raised once, not once per tick.
import { redact } from './redact.mjs';
const GRACE_MS = 10 * 60000;   // a label recorded or added moments ago may not be in the list yet
const CAP = 50;                // log entries kept
const short = (s, n = 200) => String(s ?? '').slice(0, n);

export function selfCheck({ pressure = null, state, prs = [], issues = [], active = [], aliveById = {}, stale = {}, maxReviewAttempts = 2, now = Date.now() }) {
  const fixes = [], items = [], covered = [];
  const labelsOf = new Map([...issues, ...prs].map(x => [x.number, x.labels || null]));
  // 1. A label Foreman recorded adding, whose label is gone.
  for (const [target, causes] of Object.entries(state.unblock?.flags || {})) {
    const labels = labelsOf.get(Number(target));
    if (!Array.isArray(labels) || labels.includes('needs-homeowner')) continue;
    if (Object.values(causes || {}).some(c => !Number.isFinite(c?.at) || now - c.at < GRACE_MS)) continue;
    if (Object.values(causes || {}).some(c => c?.kind === 'fixlimit')) continue;   // Team.clearStale owns it: it re-arms only once the cause has cleared
    fixes.push({ kind: 'flag-label-gone', target: Number(target), what: `dropped the record that Foreman added needs-homeowner to #${target}: the label is no longer there` });
  }
  // 2. A job recorded as running with no live process.
  for (const a of active) {
    if (a.status !== 'running' || aliveById[a.id] !== false) continue;
    const id = String(a.id).slice(0, 8);
    items.push({ id: `selfcheck-job-${id}`, kind: 'job-no-process', ref: null, text: `Job ${id} is recorded as running but its worker and provider process are gone.`,
      action: `Run: ai-supervisor reconcile (it blocks the orphaned job so the work can be resumed or released). Inspect it first with: ai-supervisor status ${id}.` });
  }
  // 3. A finished review with no recorded verdict.
  const recorded = new Set([state.verdicts, state.secondOpinions, state.exceptionReviews].flatMap(m => Object.keys(m || {})));
  const openAt = new Map(prs.map(p => [p.number, p.headRefOid]));
  const seen = new Set();
  for (const [id, j] of Object.entries(state.jobs || {})) {
    if (j.kind !== 'review' || !j.ingested || j.postMerge || j.secondOpinion || j.exceptionStage || !Number.isSafeInteger(j.pr) || !j.head) continue;
    if (j.refusal === 'independence' || j.refusal === 'exception-model') continue;   // the refused-verdict card names these
    const key = `${j.pr}:${j.head}`;
    if (seen.has(key) || openAt.get(j.pr) !== j.head || recorded.has(key) || state.refusedReviews?.[key] || state.reviewRefusals?.[j.key] || state.reviewFaults?.[j.key]) continue;
    if ((state.reviewAttempts?.[j.key] || 0) < maxReviewAttempts) continue;   // an attempt is left: the planner retries
    seen.add(key);
    items.push({ id: `selfcheck-review-${j.pr}`, kind: 'review-no-verdict', ref: j.pr, text: `The review of PR #${j.pr} at ${String(j.head).slice(0, 7)} (job ${String(id).slice(0, 8)}) finished but no verdict was recorded${j.refusal ? ` (${redact(j.refusal, 60)})` : ''}, and its attempts are used.`,
      action: `Look at the job (ai-supervisor status ${String(id).slice(0, 8)}), then approve "new_review_attempt" for PR #${j.pr} on the dashboard inbox or have another reviewer review this head.` });
  }
  // 5. Issues #1007, #1151: host pressure (a full root volume, sustained swap activity or low available memory); the tick holds new job starts until it recovers.
  if (pressure) items.push({ id: 'selfcheck-host-pressure', kind: 'host-pressure', ref: null, text: `Host pressure is holding new job starts: ${pressure.text}`, action: 'See foreman_host for the measure named above; a full root volume: remove stale folders in /tmp and <state root>/tmp. Starts resume once each measure is inside its limit.' });
  // 4. An implemented mark with no pull request: already a Needs you item (stale-mark-N).
  for (const n of Object.keys(stale || {})) covered.push({ kind: 'implemented-no-pr', ref: Number(n), item: `stale-mark-${n}` });
  return { fixes, items, covered };
}

// Applies one result to the state: drops stale records, keeps each open item with the time it was first seen (so it is raised once), forgets
// items whose mismatch has gone, and logs each fix once. Returns the fixes applied. Persisting is the caller's job.
export function applySelfCheck(state, result, now = Date.now()) {
  const sc = state.selfcheck ||= {};
  const previous = sc.items || {}, next = {};
  for (const it of result.items) next[it.id] = { ...it, since: previous[it.id]?.since ?? now };
  const applied = [];
  for (const f of result.fixes) {
    if (f.kind === 'flag-label-gone' && state.unblock?.flags?.[f.target]) {
      delete state.unblock.flags[f.target]; applied.push(f);
    }
  }
  sc.items = next; sc.checkedAt = now; sc.covered = result.covered;
  sc.log = [...(sc.log || []), ...applied.map(f => ({ at: now, kind: f.kind, ref: `#${f.target}`, what: short(f.what, 240) }))].slice(-CAP);
  return applied;
}
