// Issue #1171 (decision D-040): what a parked pull request or issue holds besides the planner's own work (rebase, fix, review, merge).
// Decisions are plain functions of the labels they are given; nothing here reads or writes GitHub except through the lists the caller passes.
export const PARKED_LABEL = 'parked';
export const isParked = item => !!item?.labels?.includes(PARKED_LABEL);

// True when the pull request or issue a stopped job worked on is parked, so resumeTransient leaves the job alone. `open` is resumeTransient's
// per-tick cache ({ pulls, issues }), filled here only when empty; the job keeps its one resume and is looked at again once the item is released.
export async function jobTargetParked(j, open, gh) {
  if (j.pr != null) return isParked((open.pulls ||= await gh.listPulls()).find(x => x.number === j.pr));
  if (j.issue != null) return isParked((open.issues ||= await gh.listIssues()).find(x => x.number === j.issue));
  return false;
}

export const reReviewParkedText = n => `PR #${n} is parked; a re-review starts a review, which a parked pull request does not get. Unpark it first`;
