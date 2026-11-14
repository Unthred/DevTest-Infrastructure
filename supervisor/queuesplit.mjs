// Issue #928, #1378: the split behind the dashboard's Queued items tile. It counts work items, not queue entries.
//   - A pull request counts once. One with review entries is a review, however many reviewers, and its own entry is skipped.
//   - An 'issue' entry is implement work.
//   - A pull request entry is held (fix limit or the homeowner's decision: nothing will run on it), waiting (CI, a rebase carry
//     waiting for CI, merge), rebase (conflict or not mergeable) or fix (CHANGES, red CI, draft).
// The queue entries carry only free text as the reason, so the carry and held texts are tested before the rebase and fix words.
const HELD_REASON = /fix limit reached|continue limit reached|needs the homeowner|waiting for the homeowner|parked/i;

function pullRequestKind(reason) {
  if (/rebase carry/i.test(reason)) return 'waiting';
  if (HELD_REASON.test(reason)) return 'held';
  if (/rebase|conflict|not mergeable/i.test(reason)) return 'rebase';
  if (/CHANGES|CI failing|draft|fix/i.test(reason)) return 'fix';
  return 'waiting';
}

export function queueSplit(view) {
  const n = { implement: 0, review: 0, fix: 0, rebase: 0, waiting: 0, held: 0, total: 0 };
  const entries = Object.values(view.queues || {}).flat();
  const reviewed = new Set(entries.filter(e => e.type === 'review').map(e => e.ref));
  const seen = new Set();
  for (const e of entries) {
    if (e.type === 'pr' && reviewed.has(e.ref)) continue;
    const key = e.ref ? `${e.type === 'review' ? 'pr' : e.type}:${e.ref}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    n.total++;
    if (e.type === 'issue') n.implement++;
    else if (e.type === 'review') n.review++;
    else n[pullRequestKind(e.reason || '')]++;
  }
  return n;
}

export function queueText(n, running) {
  const parts = [`${n.implement} implement`, `${n.review} review`, `${n.fix} fix`, `${n.rebase} rebase`];
  if (n.waiting) parts.push(`${n.waiting} waiting on CI or merge`);
  if (n.held) parts.push(`${n.held} held for the homeowner or the fix limit`);
  return `${parts.join(', ')}; ${running} running now`;
}
