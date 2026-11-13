// Issue #1310: the live board model, GET /api/v1/liveboard. Everything a screen needs to draw the queue working: the agents with their
// allowance, the lanes, the waiting work, the running jobs and the jobs that landed in the last 24 hours with the box each ended in.
// Built when asked, from the dashboard view and the configuration; no timer, nothing stored. The logic and the box table are in
// supervisor/board.mjs and docs/api-contract.md. A client asks again on the change stream's model_changed event, which names this model.
import { buildBoard } from '../../board.mjs';

export const name = 'liveboard';
export const path = 'liveboard';
export const schema = 'liveboard.schema.json';

export const build = (view, context) => buildBoard(view, context.now, context.config);
