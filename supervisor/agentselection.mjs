// Chooses one agent from plain scheduling facts. The dispatcher gathers readings, role slots and
// job history; this module neither reads them nor starts work. Agent identifiers are opaque data.

const HOUR = 3600000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const share = value => finite(value) && value >= 0 ? value : null;
const left = value => finite(value) && value > 0 ? value : null;

const window = (entry, expected, rate, now) => {
  const used = share(entry?.used);
  const reset = finite(entry?.resetsAt) && entry.resetsAt > now ? entry.resetsAt : null;
  const job = share(expected) ?? 0;
  const burn = share(rate) ?? 0;
  const hours = reset === null ? 0 : (reset - now) / HOUR;
  const room = used === null ? null : 1 - used;
  return {
    used,
    resetsAt: reset,
    expected: job,
    rate: burn,
    room,
    projectedSpare: room === null ? null : room - job - burn * hours
  };
};

const visible = candidate => ({
  agent: candidate.agent,
  freeSlot: candidate.freeSlot === true,
  allowed: candidate.allowed !== false,
  reserve: candidate.reserve === true,
  out: candidate.out === true,
  weekly: candidate.weekly,
  short: candidate.short,
  expected: candidate.expected,
  costSource: candidate.costSource,
  rule: candidate.rule,
  score: candidate.score
});

// `input.candidates` is config order. Each item describes one possible owner of the same action:
// { agent, allowed, freeSlot, reserve, out, weekly, short, rate, expected, costSource, pin }.
// A cost is a plan share, rather than raw tokens, so different plan capacities compare fairly.
export function chooseAgent(input) {
  const now = finite(input?.now) ? input.now : 0;
  const required = input?.pin?.required ?? null;
  const preferred = input?.pin?.preferred ?? null;
  const candidates = (input?.candidates || []).map((source, index) => {
    const expected = {
      weekly: share(source?.expected?.weekly) ?? 0,
      short: share(source?.expected?.short) ?? 0
    };
    const weekly = window(source?.weekly, expected.weekly, source?.rate?.weekly, now);
    const short = window(source?.short, expected.short, source?.rate?.short, now);
    let rule = 'eligible';
    if (source?.allowed === false) rule = 'job type is not allowed';
    else if (source?.freeSlot !== true) rule = 'no free role slot';
    else if (source?.out === true) rule = 'out of an allowance window';
    else if (source?.reserve === true) rule = 'at or below reserve';
    else if (required && source?.agent !== required) rule = 'required pin chooses another agent';
    // A short window that cannot even pay for this job would pause it mid-run. A projected
    // future burn is deliberately not a refusal: forecasts only choose between candidates.
    else if (short.room !== null && short.room < expected.short) rule = 'short window cannot cover expected job share';
    const eligible = rule === 'eligible';
    const spares = [weekly.projectedSpare, short.projectedSpare].filter(finite);
    const spare = spares.length ? Math.min(...spares) : null;
    const relativeCost = spare === null ? 0 : (expected.weekly + expected.short) / Math.max(spare, 0.000001);
    return { agent: source?.agent, index, freeSlot: source?.freeSlot === true, allowed: source?.allowed !== false,
      reserve: source?.reserve === true, out: source?.out === true, weekly, short, expected,
      costSource: source?.costSource || 'unavailable', pin: source?.pin || null, rule, eligible, spare, relativeCost, score: null };
  });
  const eligible = candidates.filter(c => c.eligible);
  eligible.sort((a, b) => {
    const pin = Number(b.pin === preferred) - Number(a.pin === preferred);
    if (pin) return pin;
    if (a.relativeCost !== b.relativeCost) return a.relativeCost - b.relativeCost;
    if (a.spare !== b.spare) return (b.spare ?? -Infinity) - (a.spare ?? -Infinity);
    return a.index - b.index;
  });
  const winner = eligible[0] || null;
  for (const c of candidates) {
    c.score = Number.isFinite(c.relativeCost) ? Math.round(c.relativeCost * 1000000) / 1000000 : null;
    if (winner && c.agent === winner.agent) c.rule = preferred !== null && c.pin === preferred ? 'preferred pin breaks an otherwise equal choice' : 'lowest expected cost relative to projected spare';
  }
  return { agent: winner?.agent ?? null, rule: winner?.rule ?? (required ? 'required pin has no eligible agent' : 'no eligible candidate'),
    candidates: candidates.map(visible) };
}

// A short summary for the dashboard's Next card. The full row list remains available in the
// plan and MCP response, while this stays readable in a compact queue entry.
export function choiceText(choice) {
  if (!choice?.agent) return choice?.rule || 'no eligible agent';
  const selected = choice.candidates.find(c => c.agent === choice.agent);
  const source = selected?.costSource === 'history' ? 'recent job history' : 'configured default';
  return `${choice.agent} selected: ${choice.rule}; expected share from ${source}`;
}
