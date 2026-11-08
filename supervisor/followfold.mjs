// Issue #963: one-off fold of the open review follow-ups whose parent PR has merged into their area batch issues.
// Dry run by default (nothing written); --apply appends to the batch, then closes each issue with a link to it. No model call.
import { planFold, foldItems, batchMarker, appendToBatch, newBatchBody, isBatchIssue, isFollowUpIssue, parentPrOf } from './followups.mjs';

export const BODY_LIMIT = 60000;   // GitHub refuses an issue body over 65536 characters; stay clear of it

// Issues a pull request is implementing (branch .../issue-N-...), by number.
function implemented(pulls) {
  const s = new Set();
  for (const p of pulls || []) { const m = /\/issue-(\d+)(\D|$)/.exec(p.headRefName || ''); if (m) s.add(Number(m[1])); }
  return s;
}

export async function foldBacklog(gh, { apply = false } = {}) {
  const open = await gh.listOpenIssues();
  const pulls = await (gh.listPulls?.() ?? Promise.resolve([])).catch(() => []);
  const inFlight = implemented(pulls);
  const followUps = list => list.filter(i => i && isFollowUpIssue(i) && !isBatchIssue(i));
  const batches = list => list.filter(i => i && isBatchIssue(i) && /^\s*Review follow-ups/i.test(i.title || ''));
  const parents = new Map();
  for (const n of new Set(followUps(open).map(parentPrOf).filter(Boolean))) {
    try { const p = await gh.getPullState(n); if (p) parents.set(n, p); } catch { /* unreadable parent: listed as unclassified */ }
  }
  const plan = planFold(open, parents);
  // Work that a pull request is already implementing is left alone: closing it would leave that PR implementing a closed issue.
  const skipped = plan.fold.filter(f => inFlight.has(f.issue)).map(f => ({ issue: f.issue, why: 'a pull request is implementing it' }));
  plan.fold = plan.fold.filter(f => !inFlight.has(f.issue));
  const result = { applied: apply, before: { open: open.length, followUps: followUps(open).length, batches: batches(open).length }, folded: [], failed: [], keep: [...plan.keep, ...skipped], unclassified: plan.unclassified };
  const remaining = () => followUps(open).length - result.folded.length;
  if (!apply) { result.planned = plan.fold; result.after = { followUps: followUps(open).length - plan.fold.length }; return result; }
  const current = new Map();   // area -> { number, body } being appended to
  const link = (f, b) => `Folded into #${b.number} (${f.area} batch): its findings are listed there. Parent PR #${f.parent} is merged.`;
  for (const f of plan.fold) {
    try {
      const issue = open.find(i => i.number === f.issue);
      const entry = { job: `fold-${f.issue}`, pr: f.parent, head: 'merged', items: foldItems(issue) };
      let b = current.get(f.area);
      if (!b) {
        // never edit a batch that a pull request implements: that changes its requirements and withdraws its PASS
        const skip = [];
        let found = null;
        while ((found = await gh.findOpenIssueByMarker(batchMarker(f.area), skip)) && inFlight.has(found.number)) { skip.push(found.number); found = null; }
        b = found ? { number: found.number, body: found.body } : null;
        if (b) current.set(f.area, b);
      }
      let appended = b ? appendToBatch(b.body, entry).body : null;
      if (!b || appended.length > BODY_LIMIT) {
        // a new batch for the area when none is open or the body would pass GitHub's size limit
        const body = newBatchBody(f.area, entry);
        b = { number: await gh.createIssue(`Review follow-ups: ${f.area}`, body), body };
        current.set(f.area, b);
      } else if (appended !== b.body) { await gh.updateIssueBody(b.number, appended); b.body = appended; }
      await gh.closeIssue(f.issue, link(f, b));
      result.folded.push({ ...f, batch: b.number });
    } catch (e) { result.failed.push({ issue: f.issue, error: String(e?.message || e).slice(0, 200) }); }
  }
  result.after = { followUps: remaining() };
  return result;
}
