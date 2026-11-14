// Issue #1346: the dispatcher's side of choosing the agent for a free slot. For every slot whose best candidate is not a review it builds one
// candidate per agent (slotcandidate.mjs), asks the choice core (agentchoice.mjs) and returns the winner with the recorded reason.
// Reviews keep the dispatcher's own ranking. Only the hold of an unchosen group is written to the team.
import { chooseAgent, describeChoice } from './agentchoice.mjs';
import { candidateOf, plannedShares } from './slotcandidate.mjs';

const NOT_OFFERED = 'does not do this job type';
const REASON_LIMIT = 700;
const DATA_PROBLEM = /is missing|is not a number|is invalid|or invalid/;   // the core's skip reasons for a reading it cannot use

// The issues budget.choice.pins requires on this agent, so it offers them even when its own list does not name them.
export function withRequiredPins(config, agent, listed) {
  const pins = config.budget?.choice?.pins ?? {};
  const pinned = Object.entries(pins)
    .filter(([, pin]) => pin.mode === 'required' && pin.agent === agent)
    .map(([issue]) => Number(issue));
  return [...listed, ...pinned.filter(issue => !listed.includes(issue))];
}

// The fields a started job keeps from its choice (none for a job the choice core did not run for).
export const chosenFields = act => (act.choice ? { choice: act.choice, chosenWhy: act.why } : {});

// No agent qualifies: only the compared group waits, marked taken so the loop moves on to lower ranked work of other agents.
export function holdUnchosen(team, group, why) {
  for (const { agent, act } of group) {
    team.taken.add(`${act.type}:${act.key}`);
    if (act.issue) team.taken.add(`issue:${act.issue}`);
    team.hold(agent, act.type, why, act.pr ?? null);
    team.choiceHolds.add(`${agent}:${act.type}`);
  }
}

// An agent that offered nothing says why: its slot is full, or the reason the planner noted for it, unless that note is one this module wrote
// earlier in the tick.
function withOwnHold(team, row, type) {
  if (row.skipped !== NOT_OFFERED) return;
  if (!row.freeSlot) { row.skipped = 'no free slot'; return; }
  if (team.choiceHolds.has(`${row.id}:${type}`)) return;
  const noted = team.held?.[row.id]?.[type];
  if (noted) row.skipped = `${NOT_OFFERED} (${noted})`;
}

// An agent whose allowance or capacity is not known cannot be compared, and unknown data never holds work back (issue #680): when the core finds
// nobody to compare, the first ranked agent that offered the job, has a free slot and lacks only data takes it in the dispatcher's order, with no choice recorded.
function unknownDataFallback(group, result) {
  const lacksData = row => DATA_PROBLEM.test(row.skipped ?? '') && row.freeSlot;
  const lacking = new Set(result.candidates.filter(lacksData).map(row => row.id));
  return group.find(c => lacking.has(c.agent)) ?? null;
}

// `cands` are { agent, act, rank } from the dispatch loop. Returns { best, why, choice, group }; `best` is null when no agent qualifies.
export function chooseForSlot(team, cands, { prs, usedBy, role, planned }) {
  const ranked = [...cands].sort((x, y) => x.rank - y.rank);   // stable: ties keep the team.json agent order
  const first = ranked[0];
  if (first.act.type === 'review') return { best: first, why: team.reviewWhy(first.agent, first.act, prs) };
  if (!team.modes) return { best: first, why: null };
  const group = ranked.filter(c => c.act.type !== 'review' && Math.floor(c.rank) === Math.floor(first.rank));
  const now = team.clock.now();
  const candidates = team.agents().map(([agent, a], order) => {
    const offered = group.find(c => c.agent === agent)?.act ?? null;
    const slotFree = !team.providerSlotFull(a.provider, role, usedBy);
    const spent = plannedShares(team, agent, planned, now);
    return candidateOf(team, { agent, order, offered, job: offered ?? first.act, slotFree, spent, now });
  });
  const result = chooseAgent({ candidates, now });
  for (const row of result.candidates) withOwnHold(team, row, first.act.type);
  const fallback = result.chosen === null ? unknownDataFallback(group, result) : null;
  if (fallback) return { best: fallback, why: null };   // no choice was made, so none is recorded
  const choice = { rule: result.rule, chosen: result.chosen, candidates: result.candidates };
  return { best: group.find(c => c.agent === result.chosen) ?? null, why: describeChoice(result).slice(0, REASON_LIMIT), choice, group };
}
