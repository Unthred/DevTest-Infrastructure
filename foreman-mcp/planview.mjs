// Issue #1223: foreman_plan and foreman_why_blocked return the reason the last tick recorded for each planned action, never the plan alone.
// Imports nothing: the MCP server is confined to this folder. `planned` is the last tick's ledger from the dashboard cache
// ([{ type, agent, ref, outcome: 'launched' | 'held', kind, reason }]).
const NOT_RECORDED = { outcome: 'not recorded', reason: 'this action was planned after the last tick, which recorded no outcome for it' };

const sameItem = (row, action) => row.type === action.type && row.agent === (action.agent ?? null) && row.ref === (action.pr ?? action.issue ?? null);

export function outcomeOf(planned, action) {
  const row = (planned || []).find(e => sameItem(e, action));
  if (!row) return NOT_RECORDED;
  return row.outcome === 'launched' ? { outcome: 'launched', reason: null } : { outcome: 'held', kind: row.kind, reason: row.reason };
}

// The paused jobs of this issue or pull request whose resume check threw on the last tick, with the message.
export const resumeChecksFor = (checks, number) => (checks || []).filter(c => c.ref === number).map(({ job, message, ticks }) => ({ job, message, ticks }));

// The plan with the recorded outcome of each action next to it.
export const withReasons = (plan, planned) => (plan || []).map(a => ({ ...a, lastTick: outcomeOf(planned, a) }));

// What the last tick recorded for one pull request or issue, for foreman_why_blocked.
export const plannedFor = (planned, number) => (planned || []).filter(e => e.ref === number).map(({ type, agent, outcome, kind, reason }) => ({ type, agent, outcome, kind: kind ?? null, reason: reason ?? null }));
