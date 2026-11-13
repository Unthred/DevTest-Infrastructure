// Issue #1166: the dispatcher's side of choosing the agent for a free slot. It turns what the tick already knows (the allowance modes, the job
// history, the config) into the plain candidates agentchoice.mjs ranks, and returns the winner with the recorded reason. No state is written here.
import { chooseAgent, describeChoice } from './agentchoice.mjs';
import { expectedShare } from './jobshare.mjs';

// No agent qualifies for the job (a required pin that cannot run now, or no short window that covers it): it waits, as work always does when
// nobody can take it (#680). It is marked taken so this tick's loop moves on to other work, and the reason is held for the dashboard.
export function holdUnchosen(team, cands, why) {
  for (const { agent, act } of cands) {
    team.taken.add(`${act.type}:${act.key}`);
    if (act.issue) team.taken.add(`issue:${act.issue}`);
    team.hold(agent, act.type, why, act.pr ?? null);
  }
}

// The fields a started job keeps from its choice (none for a job the choice rule did not run for).
export const chosenFields = act => (act.choice ? { choice: act.choice, chosenWhy: act.why } : {});

const jobLabel = act => (act.issue != null ? `${act.type} #${act.issue}` : act.pr != null ? `${act.type} on PR #${act.pr}` : act.type);

// One candidate row for an agent: the job it offers (or, for an agent that offered none, the job of the best-ranked one, so its row still reads).
function candidateOf(team, agent, act, { slotFree, why }) {
  const mode = team.modes?.[agent], settings = team.c.budget?.choice || {};
  const jobs = (team.usage?.jobs || []).filter(j => j.provider === team.c.agents[agent].provider);
  const pin = act.issue != null ? settings.pins?.[String(act.issue)] : null;
  return { agent, job: jobLabel(act), slotFree, why, used: mode?.known ? mode.used : null, rate: mode?.ratePerHour ?? null,
    hoursToReset: mode?.hoursLeft ?? null, short: mode?.shortWindow ?? null,
    share: expectedShare({ jobs, kind: act.type, capacity: mode?.capacity?.capacity, settings }),
    requiredAgent: pin?.mode === 'required' ? pin.agent : null, preferredAgent: pin?.mode === 'preferred' ? pin.agent : null };
}

// `cands` are { agent, act, rank } from the dispatch loop. Reviews keep their own ranking (independence and sole-reviewer rules) and reason.
// For every other job the agents offering the same job as the best-ranked one compete under agentchoice.mjs; the rest of the agents appear in
// the record with why they did not offer it. Returns { best, why, choice } where `best` is null when no agent qualifies (the job waits).
export function chooseForSlot(team, cands, { prs, usedBy, role, planned }) {
  const ranked = [...cands].sort((x, y) => x.rank - y.rank);   // stable: ties keep the team.json agent order
  const first = ranked[0];
  if (first.act.type === 'review') return { best: first, why: team.reviewWhy(first.agent, first.act, prs) };
  const group = ranked.filter(c => c.act.type !== 'review' && Math.floor(c.rank) === Math.floor(first.rank));
  const rows = team.agents().map(([agent, a]) => {
    const own = group.find(c => c.agent === agent);
    const why = team.held?.[agent]?.[first.act.type] || 'it offered no such job now';
    const slotFree = !team.providerSlotFull(a.provider, role, usedBy);
    return { ...candidateOf(team, agent, own?.act ?? first.act, { slotFree, why }), eligible: !!own, planned: planned.filter(x => x.agent === agent).length };
  });
  const result = chooseAgent(rows);
  const choice = { rule: result.rule, chosen: result.chosen, candidates: result.candidates };
  return { best: group.find(c => c.agent === result.chosen) || null, why: describeChoice(result).slice(0, 700), choice };
}
