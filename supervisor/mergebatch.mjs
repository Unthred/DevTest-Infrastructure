// Issue #1410: a pass merges every ready pull request in order, up to MAX_MERGES_PER_PASS. Each merge after the first re-reads the pull
// request first (main moved with the earlier merge), and a pull request that is no longer ready waits for the follow-up pass.
export const MAX_MERGES_PER_PASS = 5;
const NOT_READY_STATES = new Set(['BEHIND', 'DIRTY', 'BLOCKED']);

// Pure: why a freshly read pull request can no longer be merged as planned, or null when it is still ready.
export function notReadyAfterMerge(pr, act) {
  if (!pr) return 'the pull request could not be read again after the earlier merge';
  if (pr.headRefOid !== act.head) return 'its head moved after the earlier merge';
  if (pr.mergeable !== 'MERGEABLE') return `GitHub reports it as ${String(pr.mergeable || 'unknown').toLowerCase()} after the earlier merge`;
  if (NOT_READY_STATES.has(pr.mergeStateStatus)) return `its merge state is ${String(pr.mergeStateStatus).toLowerCase()} after the earlier merge`;
  return null;
}
export async function rereadForMerge(gh, act) {
  try { return notReadyAfterMerge(await gh.getPull(act.pr), act); } catch { return 'the pull request could not be read again after the earlier merge'; }
}
