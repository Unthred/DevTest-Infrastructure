// Issue #1370: the choice of the open batch issue that follow-ups are added to, shared by the review follow-up writer (Team.batchFollowUps)
// and the unreliable-test writer so both apply the same frozen check.
export const WRITER_KINDS = new Set(['implement', 'continue', 'fix', 'cifix', 'rebase', 'inbox']);   // inbox: an approved overseer prompt (issue #124) writes like an implement job

// A batch that a pull request or a job already implements is frozen: editing its body would change that PR's requirements hash and
// withdraw its PASS. Returns the first open issue with the marker that nothing implements, or null (the caller opens a new one).
export async function openFreeBatch(gh, marker, { prs = [], jobs = [] } = {}) {
  const skip = [];
  let open = null;
  while (gh.findOpenIssueByMarker && (open = await gh.findOpenIssueByMarker(marker, skip))) {
    const re = new RegExp(`/issue-${open.number}(\\D|$)`);
    const taken = prs.some(p => re.test(p.headRefName || '')) || jobs.some(x => re.test(x.branch || '') || (x.issue === open.number && WRITER_KINDS.has(x.kind)));
    if (!taken) return open;
    skip.push(open.number);
  }
  return null;
}
