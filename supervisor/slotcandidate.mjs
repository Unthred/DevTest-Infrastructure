// Issue #1346: one candidate row for the choice core (agentchoice.mjs), built from what the tick already knows about an agent: its allowance mode,
// its readings, its job history and the config. Nothing here names an agent or a provider; rows differ only by the data they carry.
// Reads the team, writes nothing.
import { REVIEWS_ONLY_TYPES, shortWindowOf, weeklyWindow } from './budget.mjs';
import { tokensOf } from './capacity.mjs';
import { reserveRefusal } from './capacityrule.mjs';
import { expectedShare } from './jobshare.mjs';
import { recentRate } from './recentrate.mjs';

function readingOf(allowance, now) {
  if (!allowance || !Number.isFinite(allowance.observedAt)) return null;
  const weekly = weeklyWindow(allowance, now);
  const short = shortWindowOf(allowance, now);
  return {
    at: allowance.observedAt,
    weekly: weekly ? { used: weekly.utilization, resetsAt: weekly.resetsAt } : null,
    short,
  };
}

// The agent's dashboard readings (kept per agent name by the tick) and the newest reading of its provider, which is looked up by provider
// exactly as the budget code does, so an agent named unlike its provider gets the same figures.
function readingsOf(team, agent, now) {
  const provider = team.c.agents[agent].provider;
  const saved = (team.usage?.snapshots ?? []).map(snapshot => readingOf(snapshot?.allowance?.[agent], now));
  const newest = readingOf(team.usage?.allowance?.[provider], now);
  return [...saved, newest].filter(Boolean);
}

function jobsOf(team, agent) {
  const provider = team.c.agents[agent].provider;
  return (team.usage?.jobs ?? []).filter(job => job.provider === provider);
}

function shareSettings(team) {
  const choice = team.c.budget?.choice ?? {};
  const settings = {};
  if (choice.min_samples !== undefined) settings.minSamples = choice.min_samples;
  if (choice.short_per_weekly !== undefined) settings.shortPerWeekly = choice.short_per_weekly;
  if (choice.default_shares !== undefined) settings.shares = choice.default_shares;
  return settings;
}

// The share of the agent's weekly and short windows one job of `type` is expected to take.
export function shareOf(team, agent, type, now) {
  const jobs = jobsOf(team, agent);
  const history = jobs.map(job => ({ type: job.kind, tokens: tokensOf(job), finishedAt: job.createdAt }));
  const readings = jobs.map(job => readingOf(job.allowance, now)).filter(reading => reading?.weekly && reading.short);
  return expectedShare({ jobs: history, readings, type, capacity: team.modes?.[agent]?.capacity?.capacity, settings: shareSettings(team) });
}

// What the jobs already planned this tick are expected to cost the agent: the next slot is judged on the allowance left after them.
export function plannedShares(team, agent, planned, now) {
  const total = { weekly: 0, short: 0 };
  for (const action of planned) {
    if (action.agent !== agent || action.type === 'merge') continue;
    const share = shareOf(team, agent, action.type, now);
    total.weekly += share.weekly;
    total.short += share.short;
  }
  return total;
}

function pinOf(team, agent, issues) {
  const pins = team.c.budget?.choice?.pins ?? {};
  const pin = issues.map(issue => pins[String(issue)]).find(candidate => candidate?.agent === agent);
  return pin?.mode ?? null;
}

// `offered` is the job this agent offered for the slot, or null. `job` is the job the row is judged on (the agent's own, else the best ranked one).
export function candidateOf(team, { agent, order, offered, job, slotFree, spent, now }) {
  const mode = team.modes?.[agent];
  const weekly = mode?.known ? { used: mode.used + spent.weekly, resetsAt: mode.resetsAt } : null;
  const short = mode?.shortWindow ? { used: mode.shortWindow.used + spent.short, resetsAt: mode.shortWindow.resetsAt } : null;
  const readings = readingsOf(team, agent, now);
  const issues = [offered?.issue, job.issue].filter(issue => issue != null);
  return {
    id: agent,
    order,
    pool: 'plan',
    mayDo: offered !== null,
    freeSlot: slotFree,
    atOrBelowReserve: weekly ? reserveRefusal({ ...mode, used: weekly.used }, job.type, REVIEWS_ONLY_TYPES) !== null : false,
    weekly,
    short,
    capacity: mode?.capacity?.capacity,
    share: shareOf(team, agent, job.type, now),
    rate: {
      weekly: recentRate({ readings, kind: 'weekly', now }) ?? mode?.ratePerHour ?? 0,
      short: recentRate({ readings, kind: 'short', now }) ?? 0,
    },
    pin: pinOf(team, agent, issues),
  };
}
