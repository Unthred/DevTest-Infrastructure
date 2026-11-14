// Issue #1407: the one test of whether a pull request is parked, and the one list of parked pull requests the plan views show.
// Plain functions of the rows they are given; a row without a labels field is unparked and nothing throws.
import { isParked } from './parkhold.mjs';

export { isParked };

// The pull requests the planner may act on: a parked one gets no review, fix, CI fix, rebase or merge.
export const unparkedPulls = prs => (Array.isArray(prs) ? prs.filter(p => !isParked(p)) : prs);

export const PARKED_PLAN_REASON = 'parked: no review, fix, CI fix, rebase or merge is planned until the parked label is removed';

// The parked pull requests, each with its reason, for the lists the dashboard and the MCP show beside the plan (never as planned actions).
export const parkedPullList = prs => (Array.isArray(prs) ? prs.filter(isParked).map(p => ({ pr: p.number, reason: PARKED_PLAN_REASON })) : []);

// The labels the dashboard cache keeps of a pull request. The parked label must survive the compaction: the plan the dashboard and the MCP
// show is rebuilt from the cache, and without it a parked pull request looks unparked (issue #1407).
const KEPT_PULL_LABELS = ['needs-homeowner', 'parked'];
export const keptPullLabels = labels => KEPT_PULL_LABELS.filter(k => (labels || []).some(l => (typeof l === 'string' ? l : l?.name) === k));
