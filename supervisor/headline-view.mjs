import { headlineStats } from './headline.mjs';
import { readTimeline } from './history.mjs';
// Issue #1376: the headline for the dashboard view. It reads the history timeline so that archived verdicts count with the live ones.
export const headlineView = ({ root, ...inputs }) => headlineStats({ ...inputs, timeline: readTimeline(root) });
