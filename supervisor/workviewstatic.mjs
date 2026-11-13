// Issue #1224: the browser scripts of the Work page's Table and Board, in the shape of the dashboard's static table (dashserver.mjs STATIC).
const JS = 'text/javascript; charset=utf-8';
const FILES = ['worktable.mjs', 'workview-draw.mjs', 'workview-ui.mjs', 'viewswitch.mjs'];
export const WORK_VIEW_STATIC = Object.fromEntries(FILES.map(f => [`/static/${f}`, [f, JS]]));
