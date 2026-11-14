// Issue #1345: select an agent from candidate data only. This is intentionally not wired to the dispatcher.

const EPSILON = 1e-9;
const MIN_SPARE = 0.01;
const HOUR_MS = 60 * 60 * 1000;

function percent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function hoursUntil(resetsAt, now) {
  return (resetsAt - now) / HOUR_MS;
}

function invalidNumber(value, label) {
  return Number.isFinite(value) ? null : `${label} is not a number`;
}

function windowProblem(window, label, now) {
  if (!window) return `${label} window is missing`;
  const usedProblem = invalidNumber(window.used, `${label} use`);
  if (usedProblem) return usedProblem;
  if (window.used < 0) return `${label} use is negative`;
  if (!Number.isFinite(window.resetsAt)) return `${label} reset is not a number`;
  if (window.resetsAt <= now) return `${label} window is exhausted`;
  if (window.used >= 1) return `${label} window is exhausted`;
  return null;
}

function shareProblem(candidate) {
  if (!Number.isFinite(candidate.capacity) || candidate.capacity <= 0) return 'capacity is missing or invalid';
  if (!Number.isFinite(candidate.share?.weekly) || candidate.share.weekly < 0) {
    return 'expected weekly share is missing or negative';
  }
  if (!Number.isFinite(candidate.share?.short) || candidate.share.short < 0) {
    return 'expected short share is missing or negative';
  }
  return null;
}

function rateOf(candidate, kind) {
  const rate = candidate.rate?.[kind];
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function roomOf(window, rate, now) {
  return 1 - window.used - rate * hoursUntil(window.resetsAt, now);
}

function requiredTarget(candidates) {
  return candidates.find(candidate => candidate.pin === 'required')?.id ?? null;
}

function initialReason(candidate, target, now) {
  if (target && candidate.id !== target) return 'required pin selects another candidate';
  if (candidate.mayDo !== true) return 'does not do this job type';
  if (candidate.freeSlot !== true) return 'no free slot';
  if (candidate.atOrBelowReserve === true) return 'at or below reserve';
  return windowProblem(candidate.weekly, 'weekly', now) ?? shareProblem(candidate);
}

function choiceCost(row) {
  return row.expectedShare / Math.max(row.spare, MIN_SPARE);
}

function compare(left, right) {
  const costDifference = choiceCost(left) - choiceCost(right);
  if (Math.abs(costDifference) > EPSILON) return costDifference;
  const leftPreferred = left.pin === 'preferred';
  const rightPreferred = right.pin === 'preferred';
  if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
  return left.order - right.order;
}

function ruleOf(winner, runnerUp) {
  if (winner.pin === 'required') return 'required pin';
  if (!runnerUp) return 'only qualifying candidate';
  if (Math.abs(choiceCost(winner) - choiceCost(runnerUp)) > EPSILON) return 'least plan cost';
  if (winner.pin === 'preferred' && runnerUp.pin !== 'preferred') return 'preferred pin';
  return 'config order';
}

function rowOf(candidate, order, target, now) {
  const weekly = candidate.weekly;
  const short = candidate.short ?? null;
  const shortProblem = short ? windowProblem(short, 'short', now) : null;
  const reason = initialReason(candidate, target, now) ?? shortProblem;
  const weeklyRate = rateOf(candidate, 'weekly');
  const shortRate = rateOf(candidate, 'short');
  const spare = weekly && Number.isFinite(weekly.used) && Number.isFinite(weekly.resetsAt)
    ? roomOf(weekly, weeklyRate, now)
    : null;
  const shortRoom = short && Number.isFinite(short.used) && Number.isFinite(short.resetsAt)
    ? roomOf(short, shortRate, now)
    : null;
  const unknownShort = short === null;
  const shortCannotCover = !reason && shortRoom !== null && shortRoom < candidate.share.short;
  return {
    id: candidate.id,
    order: candidate.order ?? order,
    pool: candidate.pool ?? 'plan',
    pin: candidate.pin ?? null,
    freeSlot: candidate.freeSlot === true,
    spare,
    expectedShare: candidate.share?.weekly ?? null,
    expectedShortShare: candidate.share?.short ?? null,
    shareNote: candidate.share?.note ?? null,
    shareSource: candidate.share?.source ?? null,
    recentRate: weeklyRate,
    shortRate,
    shortRoom,
    shortWindow: unknownShort ? 'unknown' : (shortProblem ? 'invalid' : 'known'),
    skipped: reason ?? (shortCannotCover ? 'short window cannot cover the job' : null),
  };
}

// Choose from plain candidate rows. A credit pool can run only when no plan row qualifies.
export function chooseAgent({ candidates = [], now }) {
  const target = requiredTarget(candidates);
  const rows = candidates.map((candidate, order) => rowOf(candidate, order, target, now));
  const qualified = rows.filter(row => row.skipped === null);
  const plan = qualified.filter(row => row.pool === 'plan');
  const ranked = (plan.length > 0 ? plan : qualified).sort(compare);
  const winner = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  const rule = winner ? ruleOf(winner, runnerUp) : 'no candidate qualifies';

  for (const row of rows) {
    if (plan.length > 0 && row.pool === 'credit' && row.skipped === null) {
      row.skipped = 'plan candidates qualify';
    }
  }

  return { chosen: winner?.id ?? null, rule, candidates: rows };
}

// The one-line record gives every row's figures and why the selection or wait occurred.
export function describeChoice(result) {
  const rows = result.candidates.map(row => {
    const spare = row.spare === null ? 'spare unknown' : `spare ${percent(row.spare)}`;
    const share = row.expectedShare === null ? 'expected share unknown' : `expected share ${percent(row.expectedShare)}`;
    const note = row.shareNote ? `; ${row.shareNote}` : '';
    const short = row.shortWindow === 'unknown'
      ? 'short window unknown'
      : row.shortWindow === 'invalid'
        ? 'short room unknown'
        : `short room ${percent(row.shortRoom)}`;
    const slot = row.freeSlot ? 'free slot' : 'full slot';
    const decision = row.skipped ? `skipped: ${row.skipped}` : 'qualifies';
    return `${row.id}: ${spare}; ${share}${note}; recent rate ${percent(row.recentRate)}/h; ${short}; ${slot}; ${decision}`;
  });
  const lead = result.chosen
    ? `${result.chosen} chosen by ${result.rule}`
    : `job waits: ${result.rule}`;
  return `${lead}. ${rows.join(' | ')}`;
}
