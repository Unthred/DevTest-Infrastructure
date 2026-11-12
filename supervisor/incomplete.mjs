// Issue #1188: what a job whose post-condition did not hold does next. Two budgets: the ordinary incomplete run gets one retry; a failed
// Requirements check cite gets CITE_REPAIR_LIMIT repairs in the same job. A repair never counts as a fix round (those are counted per PR in
// the team state when a fix job is launched, not here).
export const CITE_REPAIR_LIMIT = 2;
const DETAIL_CAP = 400;
const CITE_DETAIL_CAP = 1600;   // the one list of row, cite and reason must reach the author whole

// Records why the attempt was incomplete and returns true when the job should run again.
export function markIncomplete(job) {
  const cite = job.citeRepair === true;
  delete job.citeRepair;
  const detail = String(job.postconditionDetail || 'the post-condition did not hold').slice(0, cite ? CITE_DETAIL_CAP : DETAIL_CAP);
  job.incompleteReason = { cause: 'postcondition_not_met', detail, attempt: job.attempts };
  delete job.postconditionDetail;
  const key = cite ? 'citeRepairs' : 'incompleteRetries';
  if ((job[key] || 0) >= (cite ? CITE_REPAIR_LIMIT : 1)) return false;
  job[key] = (job[key] || 0) + 1;
  return true;
}

// A live job whose last incomplete attempt was a failed cite list is still repairing; the team holds review of its PR meanwhile.
export const isCiteRepair = job => /^requirements table cites do not match/.test(String(job?.incompleteReason?.detail || ''));

// What listActive reports for a live job. incompleteReason is kept so the team can see a cite repair in progress (issue #1188).
export const activeJobSummary = job => ({ id: job.id, provider: job.provider, status: job.status, ...(job.incompleteReason ? { incompleteReason: job.incompleteReason } : {}) });
