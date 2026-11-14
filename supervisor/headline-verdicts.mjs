// Issue #1376: a pull request's verdicts for the headline cards, from the live state and the archived timeline together.
// A description only round, a requested second review and a changed requirements hash archive the CHANGES verdict and remove it from the
// live state, so the live state alone shows a later approval as the first verdict ever given. Pure: no I/O.
const fin = Number.isFinite;
const headOf = v => (typeof v?.head === 'string' && v.head ? v.head.slice(0, 7) : null);

// Archived review verdicts by pull request number. A second opinion or review exception carries a detail and is not a review of the head;
// a carried copy has the job of the verdict it was copied from, so it is the same review and is left out.
function archivedByPr(timeline) {
  const byPr = new Map();
  const entries = (Array.isArray(timeline) ? timeline : []).filter(e => e && e.kind === 'verdict' && !e.detail && Number.isSafeInteger(e.pr) && fin(e.at));
  for (const e of entries.sort((a, b) => a.at - b.at)) {
    if (!byPr.has(e.pr)) byPr.set(e.pr, []);
    byPr.get(e.pr).push(e);
  }
  return byPr;
}

// Returns the pull requests with `verdicts` holding the live and the archived verdicts in time order. A pull request with nothing archived is returned as is.
export function withArchivedVerdicts(prs, timeline) {
  const byPr = archivedByPr(timeline);
  return prs.map(p => {
    const archived = byPr.get(p.number);
    if (!archived || !Array.isArray(p.verdicts)) return p;
    const live = p.verdicts.filter(v => v && fin(v.at));
    const seenAt = new Set(live.map(v => Math.floor(v.at)));
    const seenJob = new Set(live.map(v => v.job).filter(Boolean));
    const extra = [];
    for (const e of archived) {
      if (seenAt.has(e.at) || (e.job && seenJob.has(e.job))) continue;
      seenAt.add(e.at);
      if (e.job) seenJob.add(e.job);
      extra.push({ verdict: e.verdict, at: e.at, reviewer: e.reviewer, head: e.head, archived: true });
    }
    return extra.length ? { ...p, verdicts: [...p.verdicts, ...extra] } : p;
  });
}

// The pull request and head (7 characters) of every finished description round: the postcondition of its job names both.
export function descriptionRoundHeads(jobs) {
  const out = new Set();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    const c = j?.postcondition;
    if (j?.status === 'completed' && c?.kind === 'description_edited' && Number.isSafeInteger(c.pr) && typeof c.baseHead === 'string' && c.baseHead) out.add(`${c.pr}:${c.baseHead.slice(0, 7)}`);
  }
  return out;
}

// True when the first verdict was an archived CHANGES whose head then had a description round. A requirements change or a requested second
// review archives a CHANGES the same way and re-reviews the same head, but has no description round job, so it is not counted here.
export const descriptionOnlyFirst = (first, pr, roundHeads) => first?.archived === true && first.verdict === 'CHANGES' && !!headOf(first) && roundHeads.has(`${pr}:${headOf(first)}`);
