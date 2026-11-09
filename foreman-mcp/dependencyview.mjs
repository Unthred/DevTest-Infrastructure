// Issue #1103: the read side of dependency gating. Imports nothing: the MCP server is confined to this folder, and the supervisor
// imports the same words from here so both always say the same thing.
export const STATE_TEXT = {
  open: 'still open',
  merged_not_installed: 'merged but not installed yet',
  installed: 'installed',
  closed_not_planned: 'closed as not planned',
  unknown: 'status unknown'
};

// Open issues that list `number` as a prerequisite, from { issueNumber -> { dependsOn: [{ number }] } }.
export function unlocksOf(byIssue, number) {
  return [...byIssue].filter(([, e]) => (e.dependsOn || []).some(d => d.number === number)).map(([n]) => n).sort((a, b) => a - b);
}

// dependsOn / blockedBy / unlocks for one issue, from the plain cache data { issues: { "<n>": { dependsOn, malformed, cycle, since } } }.
export function dependencyView(plain, number) {
  const by = new Map(Object.entries(plain?.issues || {}).map(([n, e]) => [Number(n), e]));
  const e = by.get(number);
  const unlocks = unlocksOf(by, number);
  if (!e && !unlocks.length) return null;
  const dependsOn = (e?.dependsOn || []).map(d => ({ number: d.number, state: d.state, text: STATE_TEXT[d.state] || d.state }));
  return { dependsOn, blockedBy: dependsOn.filter(d => d.state !== 'installed'), unlocks, malformed: e?.malformed ?? null, cycle: e?.cycle ?? null, waitingSince: e?.since ?? null };
}

// Issues the planner skipped because of a prerequisite (foreman_plan): number and the reason in plain words.
export const dependencySkips = excluded => (excluded || []).filter(e => e.kind === 'dependency').map(e => ({ number: e.number, reason: e.reason }));
