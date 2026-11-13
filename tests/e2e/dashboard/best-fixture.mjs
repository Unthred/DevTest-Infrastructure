// Issue #1326: a stored best day record for the dashboard fixture. The record is 45 of 53 first reviews approved (06 Nov 08:00 to 07 Nov
// 08:00 UTC) and 106 merged (06 Nov 22:00 to 07 Nov 22:00 UTC). An optional current spec adds verdicts and merges to the last 24 hours.
const HOUR = 3600000;
const record = {
  approval: { start: '2026-11-06T08:00:00.000Z', end: '2026-11-07T08:00:00.000Z', approved: 45, reviewed: 53, merged: 55, rate: 84.9, verdicts: 60, verdicts_per_merged: 1.09 },
  merges: { start: '2026-11-06T22:00:00.000Z', end: '2026-11-07T22:00:00.000Z', approved: 0, reviewed: 0, merged: 106, rate: null, verdicts: 0, verdicts_per_merged: null }
};

function currentActivity({ reviewed = 0, approved = 0, merged = 0 }, now) {
  const verdicts = Array.from({ length: reviewed }, (_, index) => ({ pr: 9000 + index, at: now - HOUR - index * 1000, verdict: index < approved ? 'PASS' : 'CHANGES' }));
  const merges = Array.from({ length: merged }, (_, index) => ({ pr: 9500 + index, at: now - HOUR - index * 1000 }));
  return { verdicts, merges };
}

export function bestFixture(spec, now) {
  const { verdicts, merges } = currentActivity(spec.current || {}, now);
  return { version: 1, built: true, through: now, commentsThrough: now, verdicts, merges, records: spec.record ? record : { approval: null, merges: null }, updatedAt: now };
}
