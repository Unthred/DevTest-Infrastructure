// Issue #963: one-off fold of the open review follow-ups whose parent PR has merged into their area batch issues.
// Dry run by default (nothing written); --apply appends to the batch, then closes each issue with a link to it. No model call.
import { planFold, foldItems, batchMarker, appendToBatch, newBatchBody, isBatchIssue } from './followups.mjs';

export async function foldBacklog(gh, { apply = false } = {}) {
  const open = await gh.listOpenIssues();
  const followCount = list => list.filter(i => i && (isBatchIssue(i) || /follow-up/i.test(`${i.title}`) || /devtest-(review-followup|split)/.test(i.body || ''))).length;
  const parents = new Map();
  for (const n of new Set(open.map(i => (/PR\s*#(\d+)/i.exec(`${i.body}\n${i.title}`) || [])[1]).filter(Boolean).map(Number))) {
    try { const p = await gh.getPullState(n); if (p) parents.set(n, p); } catch { /* unreadable parent: listed as unclassified */ }
  }
  const plan = planFold(open, parents);
  const result = { applied: apply, before: { open: open.length, followUps: followCount(open) }, folded: [], failed: [], keep: plan.keep, unclassified: plan.unclassified };
  if (!apply) { result.planned = plan.fold; result.after = { followUps: followCount(open) - plan.fold.length }; return result; }
  const batches = new Map();   // area -> { number, body }
  for (const f of plan.fold) {
    try {
      const issue = open.find(i => i.number === f.issue);
      const entry = { job: `fold-${f.issue}`, pr: f.parent, head: 'merged', items: foldItems(issue) };
      let b = batches.get(f.area);
      if (!b) {
        const found = await gh.findOpenIssueByMarker(batchMarker(f.area));
        b = found ? { number: found.number, body: found.body } : null;
        if (!b) { const body = newBatchBody(f.area, entry); b = { number: await gh.createIssue(`Review follow-ups: ${f.area}`, body), body }; batches.set(f.area, b); result.folded.push({ ...f, batch: b.number }); await gh.closeIssue(f.issue, `Folded into #${b.number} (${f.area} batch): its findings are listed there. Parent PR #${f.parent} is merged.`); continue; }
        batches.set(f.area, b);
      }
      const { body } = appendToBatch(b.body, entry);
      if (body !== b.body) { await gh.updateIssueBody(b.number, body); b.body = body; }
      await gh.closeIssue(f.issue, `Folded into #${b.number} (${f.area} batch): its findings are listed there. Parent PR #${f.parent} is merged.`);
      result.folded.push({ ...f, batch: b.number });
    } catch (e) { result.failed.push({ issue: f.issue, error: String(e?.message || e).slice(0, 200) }); }
  }
  result.after = { followUps: followCount(open) - result.folded.length };
  return result;
}
