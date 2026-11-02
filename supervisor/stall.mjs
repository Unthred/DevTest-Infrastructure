// Issue #259: a read-only stall check. Per open non-draft PR it keeps a progress timer in durable state and reports the PRs that have
// made no progress for longer than the limit. Progress is a new head commit or a new review verdict. A running job holds the item off
// but never resets the timer, so a job that ends without a new head or verdict (a retry loop) is not progress.
// Pure: it dispatches, retries, rebases and merges nothing. The dashboard turns the stored result into Needs you items.
export const STALL_DEFAULT_HOURS = 3;
export const stallLimitMs = limits => (Number.isFinite(limits?.stall_hours) ? limits.stall_hours : STALL_DEFAULT_HOURS) * 3600000;
const sha7 = s => String(s || '').slice(0, 7);

// prev: { [pr]: { head, verdictAt, at, last, raised } }. prs: open pull requests. running: Set of PR numbers with an active job.
// verdictOf(n): the newest verdict recorded for the PR, { at, verdict, head } or null. lastJobOf(n): { kind, status, at } or null.
// reasonsOf(pr): [{ code, text }]. Returns { progress, items }; a PR that closed, merged or became a draft drops out (its item clears).
export function stallCheck({ prev = {}, prs, running = new Set(), verdictOf, lastJobOf, reasonsOf, now, limitMs }) {
  const progress = {}, items = [];
  for (const pr of prs) {
    if (pr.isDraft) continue;
    const n = pr.number, v = verdictOf(n), vAt = v?.at ?? 0;
    let rec = prev[n];
    if (!rec || !Number.isFinite(rec.at)) rec = { head: pr.headRefOid, verdictAt: vAt, at: now, last: 'first seen by the stall check', raised: false };
    else if (rec.head !== pr.headRefOid) rec = { head: pr.headRefOid, verdictAt: Math.max(vAt, rec.verdictAt || 0), at: now, last: `new head ${sha7(pr.headRefOid)}`, raised: false };
    else if (vAt > (rec.verdictAt || 0)) rec = { ...rec, verdictAt: vAt, at: now, last: `review verdict ${v.verdict || 'recorded'} at ${sha7(v.head)}`, raised: false };
    else rec = { ...rec };
    progress[n] = rec;
    if (now - rec.at <= limitMs) { rec.raised = false; continue; }
    if (running.has(n) && !rec.raised) continue;   // a running job holds the item off; once raised it stays until real progress
    rec.raised = true;
    const job = lastJobOf(n);
    const last = job && job.at > rec.at ? `${rec.last}; then a ${job.kind} job ${job.status || 'ran'} without a new head or review verdict` : rec.last;
    const reasons = reasonsOf(pr);
    items.push({ pr: n, title: pr.title, head: pr.headRefOid, since: rec.at, stalledMs: now - rec.at, last, reasons });
  }
  return { progress, items };
}
