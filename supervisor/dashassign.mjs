// Issue #1121: the dashboard's share of the per-issue explanation (see issueassign.mjs). Pure functions of one explanation.
// The Issues table and the issue page already show an issue's `reason`, so the full explanation is carried there.
const modelText = a => (a.model ? ` (${a.model})` : '');

export const assignedText = a => (a.agent ? `${a.agent}${modelText(a)}` : 'no agent');
export const rankText = a => (a.rank == null ? 'no rank' : `rank ${a.rank} of ${a.of}`);

// One line: assigned agent and model, the rule that chose them, its rank, and the specific wait (or the fault).
export function explanationText(a) {
  if (a.fault) return `FAULT: ${a.fault}; agent: none; rule: ${a.rule}`;
  const wait = a.wait ? `${a.wait.kind}: ${a.wait.text}` : 'nothing';
  return `agent: ${assignedText(a)}; rule: ${a.rule}; ${rankText(a)}; waiting on: ${wait}`;
}

// One warning for the Warnings panel when open issues have no implementer and no stated reason; null when there are none.
export function faultAttention(faults) {
  if (!faults.length) return null;
  const list = faults.slice(0, 8).map(f => `#${f.issue}`).join(', ');
  const text = `${faults.length} open issue${faults.length === 1 ? ' has' : 's have'} no implementer and no stated reason: ${list}`;
  return { id: 'assignment-fault', text, ref: null, severity: 'warning' };
}
