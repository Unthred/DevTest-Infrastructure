// Issue #1121: the read side of the per-issue assignment explanation. Imports only from this folder (the MCP server is confined to it).
// The view carries `assignments` (one entry per open issue, built by supervisor/issueassign.mjs).

import { dependencyView } from './dependencyview.mjs';

// What foreman_why_blocked adds for an issue: its dependencies (#1103) and its assignment explanation (#1121).
export const issueViews = (view, number) => ({ dependencies: dependencyView(view.dependencies, number), assignment: assignmentOf(view, number, (view.issues || []).find(x => x.number === number)) });

// The explanation of one issue. An open issue the view has no explanation for is itself reported as a fault, never as silence.
export function assignmentOf(view, number, issue) {
  const a = (view.assignments || []).find(x => x.number === number);
  if (a) return { agent: a.agent, model: a.model, rule: a.rule, rank: a.rank, of: a.of, wait: a.wait, fault: a.fault };
  if (issue?.state === 'OPEN') return { agent: null, model: null, rule: null, rank: null, of: null, wait: null, fault: 'open issue with no assignment record in the view; the dashboard is older than issue #1121 or the issue was delivered' };
  return null;
}

// Open issues with no implementer and no stated reason.
// Infrastructure faults (#1107) and unassigned issues (#1121), side by side for foreman_status.
export const faultViews = view => ({ infraFaults: view.robustness?.infraFaults ?? null, assignmentFaults: view.assignmentFaults ?? (view.assignments || []).filter(a => a.fault).map(a => ({ issue: a.number, fault: a.fault })) });
