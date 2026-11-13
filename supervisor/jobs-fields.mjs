// Jobs table (issue #1220): the fields a job row carries for the Jobs view, taken from the job record and the dispatcher's failure record.
// Pure: the dashboard view builder calls this once per job row. The cause is the one the failure record holds (the fixed list in
// failcause.mjs); a job that never failed has none. Cost is converted to pounds here, the only place the rate is known.
import { CAUSE_KEYS, FAIL_CAUSES } from './failcause.mjs';
import { gbpAmount } from './money.mjs';
import { redact } from './redact.mjs';

// A job that ended without a result: its tokens are wasted. Running, queued, paused and completed jobs have wasted nothing.
const WASTING = new Set(['failed', 'blocked', 'stopped']);

export function jobTableFields(job, state) {
  const record = state?.failCauses?.records?.[job.id];
  const cause = record && CAUSE_KEYS.includes(record.cause) ? record.cause : null;
  const tokens = job.usage && Number.isFinite(job.usage.inputTokens) && Number.isFinite(job.usage.outputTokens) ? job.usage.inputTokens + job.usage.outputTokens : null;
  const reason = job.incompleteReason || null;
  return {
    verdict: state?.jobs?.[job.id]?.verdict ?? null, // Issue #1310: the review job's own verdict, for the live board.
    cause, causeLabel: cause ? FAIL_CAUSES[cause] : null, causeDetail: record?.detail ? redact(record.detail, 300) : null,
    costGbp: gbpAmount(job.usage?.costUsdEstimate),
    wastedTokens: tokens == null ? null : WASTING.has(job.status) ? tokens : 0,
    postcondition: {
      kind: job.postcondition?.kind ?? null,
      met: job.postcondition ? job.status === 'completed' && !reason : null,
      because: reason ? redact(`${reason.cause || 'not met'}: ${reason.detail || 'no detail recorded'}`, 400) : null,
    },
  };
}

export const failCauseLabel = key => FAIL_CAUSES[key] || key;
