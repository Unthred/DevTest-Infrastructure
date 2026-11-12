// Issue #995: the planner step that drops actions whose (type, item, head) reached the retry cap and holds their agents.
// Moved out of team.mjs unchanged in behaviour (issue #1107), which only counts work outcomes toward the cap.
import * as robust from './robust.mjs';

export function applyRetryCap(team, actions, report) {
  const cap = robust.sameCauseCap(team.c.limits);
  const { kept, stopped } = robust.filterCapped(team.s, actions, cap);
  const causeOf = a => team.s.sameCause[`${a.type}:${a.pr ?? a.issue}`]?.cause;
  if (stopped.length) report.retryCapped = stopped.map(a => ({ type: a.type, ref: a.pr ?? a.issue, cause: causeOf(a) }));
  const gated = (team.gateStops || []).filter(x => x.kind === 'retry');
  if (gated.length) {
    const rows = gated.map(x => ({ type: x.type, ref: x.ref, cause: x.cause, attempts: x.attempts, agent: x.agent, lane: x.lane }));
    report.retryCapped = [...(report.retryCapped || []), ...rows];
  }
  for (const a of stopped) team.hold(a.agent, a.type, `retry cap: ${cap} attempts with the same cause (${causeOf(a)}); needs the homeowner`, a.pr ?? a.issue ?? null);
  return kept;
}
