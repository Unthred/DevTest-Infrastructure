// Issue #1166: which agent runs a job, chosen from spare allowance. Plain data in, plain data out: no clock, no file, no dispatcher object,
// and no agent names (an agent is whatever string the caller gives; the numbers decide, so swapping which plan is large changes the outcome).
//
// Candidate (one per agent that could take the job):
//   { agent, job, slotFree, eligible, why, used, rate, hoursToReset, short: { used } | null,
//     share: { weekly, short, source, note }, requiredAgent, preferredAgent, credit: boolean }
//   requiredAgent / preferredAgent: the job's pins (null when none), the same on every candidate; a required pin leaves the job to that agent alone.
//   used: weekly use as a fraction (null when unknown); rate: use per hour (fraction), projected to the reset over hoursToReset.
//   share: the job's expected cost as a fraction of this agent's weekly window and of its short window.
//
// The rule (issue #1166): drop the agents that cannot take the job; skip an agent whose short window cannot cover it; pick the agent for which
// the job costs least of its plan relative to what that plan has spare; ties go to a preferred pin, then to the agent with fewer starts planned this tick (`planned`), then to config order (`order`, the array index).
// A choice between agents never holds work back (#680): when nobody qualifies the caller leaves the job waiting as before.

const EPSILON = 1e-9;

// What the weekly window has left once the recent rate is projected to the reset; null when the weekly reading is unknown.
export function spareOf(c) {
  if (!Number.isFinite(c.used)) return null;
  const burn = Number.isFinite(c.rate) && Number.isFinite(c.hoursToReset) ? Math.max(0, c.rate) * c.hoursToReset : 0;
  return 1 - c.used - burn;
}

// Short window room left, null when there is no short window.
export const shortRoomOf = c => (c.short && Number.isFinite(c.short.used) ? 1 - c.short.used : null);

// Lower is better: the job's weekly share relative to the spare. An agent with no spare (or an unknown reading) ranks after every agent with some.
function cost(c, spare) {
  if (spare === null) return [2, 0];
  if (spare <= 0) return [1, -spare];
  return [0, (Number.isFinite(c.share?.weekly) ? c.share.weekly : 0) / spare];
}

function compare(x, y) {
  return x.key[0] - y.key[0] || (Math.abs(x.key[1] - y.key[1]) > EPSILON ? x.key[1] - y.key[1] : 0)
    || (pinOf(y.c) === 'preferred') - (pinOf(x.c) === 'preferred') || (x.c.planned || 0) - (y.c.planned || 0) || x.c.order - y.c.order;
}

const pinOf = c => (c.requiredAgent === c.agent ? 'required' : c.preferredAgent === c.agent ? 'preferred' : null);

const refusal = c => {
  if (c.requiredAgent && c.requiredAgent !== c.agent) return `the job is pinned to ${c.requiredAgent}`;
  if (c.eligible === false) return c.why || 'not eligible now';
  if (c.slotFree === false) return 'no free slot for this role';
  return null;
};

function skipReason(c, room) {
  if (Number.isFinite(room) && Number.isFinite(c.share?.short) && room < c.share.short) {
    return `short window cannot cover the job (${pct(room)} left, the job needs about ${pct(c.share.short)})`;
  }
  return null;
}

const pct = fraction => `${Math.round(fraction * 1000) / 10}%`;

function row(c, spare, room, skipped) {
  return { agent: c.agent, job: c.job ?? null, freeSlot: c.slotFree !== false, spare, expectedShare: c.share?.weekly ?? null, expectedShortShare: c.share?.short ?? null,
    shareSource: c.share?.source ?? null, shareNote: c.share?.note ?? null, rate: Number.isFinite(c.rate) ? c.rate : null, shortRoom: room, pin: pinOf(c),
    skipped, ...(c.credit ? { credit: true } : {}) };
}

function ruleOf(ranked) {
  const [first, second] = ranked;
  if (pinOf(first.c) === 'required') return 'required-pin';
  if (!second) return 'sole-candidate';
  if (Math.abs(first.key[1] - second.key[1]) > EPSILON || first.key[0] !== second.key[0]) return 'least-plan-cost-for-spare';
  if (pinOf(first.c) === 'preferred' && pinOf(second.c) !== 'preferred') return 'preferred-pin';
  return (first.c.planned || 0) < (second.c.planned || 0) ? 'fewer-planned' : 'config-order';
}

// Returns { chosen, rule, candidates }: `chosen` is an agent string or null (nobody qualifies: the job waits); `candidates` has a row per input
// with its figures and `skipped` (the reason it could not take the job, or null).
export function chooseAgent(candidates) {
  const rows = [], ranked = [];
  candidates.forEach((c, order) => {
    const withOrder = { ...c, order: c.order ?? order }, spare = spareOf(withOrder), room = shortRoomOf(withOrder);
    const skipped = refusal(withOrder) || skipReason(withOrder, room);
    rows.push(row(withOrder, spare, room, skipped));
    if (!skipped) ranked.push({ c: withOrder, key: cost(withOrder, spare), row: rows.at(-1) });
  });
  const plan = ranked.filter(r => !r.c.credit);
  const pool = (plan.length ? plan : ranked).sort(compare);
  if (plan.length) for (const r of ranked) if (r.c.credit) r.row.skipped = 'plan agents have room; the credit agent takes work only when they are held';
  if (!pool.length) return { chosen: null, rule: 'none-qualifies', candidates: rows };
  return { chosen: pool[0].c.agent, rule: ruleOf(pool), candidates: rows };
}

const RULE_TEXT = {
  'sole-candidate': 'the only agent that can take it',
  'required-pin': 'its required pin',
  'least-plan-cost-for-spare': 'the job costs it least of its plan relative to its spare',
  'preferred-pin': 'a tie on cost, broken by its preferred pin',
  'fewer-planned': 'a tie on cost, broken by fewer starts planned this tick',
  'config-order': 'a tie on cost, broken by config order',
  'none-qualifies': 'no agent qualifies, so it waits',
};

// One line for the dashboard and the MCP: who, why, and each candidate's figures.
export function describeChoice(result) {
  const figures = result.candidates.map(c => {
    if (c.skipped) return `${c.agent}: skipped, ${c.skipped}`;
    const spare = c.spare === null ? 'spare unknown' : `spare ${pct(c.spare)}`;
    const share = c.expectedShare === null ? 'job cost unknown' : `job about ${pct(c.expectedShare)} of its week (${c.shareSource})`;
    const room = c.shortRoom === null ? '' : `, short window room ${pct(c.shortRoom)}`;
    return `${c.agent}: ${spare}, ${share}, rate ${c.rate === null ? 'unknown' : `${pct(c.rate)}/h`}${room}, slot ${c.freeSlot ? 'free' : 'full'}`;
  });
  const job = result.candidates.find(c => c.agent === result.chosen)?.job;
  const lead = result.chosen ? `${result.chosen} runs ${job || 'the job'}: ${RULE_TEXT[result.rule]}` : `the job waits: ${RULE_TEXT[result.rule]}`;
  return `${lead} (${figures.join('; ')})`;
}
