// One description of what an agent is doing (issue #76), used by `team status` AND the dashboard header, so the two cannot
// disagree. `when` renders a time (ms) as text; the dashboard passes a function that marks the time for local rendering.
export function agentLine(a, when) {
  const j = a.job, what = j ? j.name : null;
  if (a.state === 'running') return `running: ${what}`;
  if (a.state === 'paused') return `paused: ${what}${j?.nextAttemptAt ? `, restarts about ${when(j.nextAttemptAt)}` : ''}`;
  if (a.state === 'blocked') return `blocked: ${what}`;
  if (a.state === 'unknown') return 'unknown: the job record could not be read';
  return `idle${a.idleReason ? `: ${a.idleReason.text}` : ''}`;
}
