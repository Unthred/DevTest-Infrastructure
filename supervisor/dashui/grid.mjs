// Free card layout (pure logic, no DOM). Each card on a desktop or tablet page has a saved position and size in grid cells:
// { x, y, w, h } = column, row, width in columns, height in rows. Empty space is allowed. Saved per page and per breakpoint in the
// viewer's own browser storage (convenience only; the server stays read-only). A phone keeps its separate, order-only layout.
//
// The grid: 24 columns on desktop and 12 on tablet (twice as fine as the old 12 and 6, so a card is never forced onto a coarse
// step), and rows of ROW_PX with a ROW_GAP gap, a pitch of 24 px. A card h rows tall is h * 24 - 12 px high. The CSS in style.css
// reads the same numbers (--row, --row-gap); a test keeps them in step.

export const COLS = { desktop: 24, tablet: 12 };
export const ROW_PX = 12;
export const ROW_GAP = 12;
export const ROW_PITCH = ROW_PX + ROW_GAP;
// The only size limits: a card keeps a header that can be used (3 columns, 4 rows = 84 px) and never grows past MAX_H rows.
export const MIN_W = 3;
export const MIN_H = 4;
export const MAX_H = 400;
export const UNDO_LIMIT = 50;
// Cards that need an action can never be hidden (also any card the server marks data-pin, such as a health card in the Action state).
export const PINNED = ['approvals', 'needs', 'breaker'];
export const canHide = (id, pinAttr = false) => !pinAttr && !PINNED.includes(id);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isInt = v => Number.isInteger(v);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A usable rectangle from anything: integers only, inside the grid, at least the minimum size. null when it is not a rectangle.
export function cleanRect(r, cols) {
  if (!isObj(r) || !['x', 'y', 'w', 'h'].every(k => isInt(r[k]))) return null;
  const w = clamp(r.w, MIN_W, cols), h = clamp(r.h, MIN_H, MAX_H);
  return { x: clamp(r.x, 0, cols - w), y: Math.max(0, r.y), w, h };
}
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const bottom = pos => Object.values(pos).reduce((m, r) => Math.max(m, r.y + r.h), 0);
const copy = pos => Object.fromEntries(Object.entries(pos).map(([k, r]) => [k, { ...r }]));
const byReading = pos => (a, b) => pos[a].y - pos[b].y || pos[a].x - pos[b].x || (a < b ? -1 : 1);

// Move cards out of the way of the ones in `settled`, as little as possible: a colliding card goes straight down to just below
// what it hits (and, if that now hits something else, below that), and cards it lands on are pushed in turn. Cards that collide
// with nothing never move, and nothing ever moves up or sideways. Mutates and returns pos.
function pushClear(pos, settled) {
  for (;;) {
    const hit = Object.keys(pos).filter(id => !settled.has(id) && [...settled].some(s => overlaps(pos[id], pos[s])));
    if (!hit.length) return pos;
    const id = hit.sort(byReading(pos))[0];
    for (let moved = true; moved;) {
      moved = false;
      for (const s of settled) if (overlaps(pos[id], pos[s])) { pos[id].y = pos[s].y + pos[s].h; moved = true; }
    }
    settled.add(id);
  }
}
// Put `id` at `rect` (clamped to the grid and the minimum size) and push the others out of its way. Pure: returns a new map.
// A drag preview is always computed from the layout as it was when the drag started, so moving back undoes the pushing.
export function placeCard(pos, id, rect, cols) {
  const r = cleanRect(rect, cols), out = copy(pos);
  if (!r || !out[id]) return out;
  out[id] = r;
  return pushClear(out, new Set([id]));
}
// Make a layout from untrusted data collision-free (cards keep their place unless they overlap an earlier one in reading order).
export function settleAll(pos) {
  const out = copy(pos), placed = [];
  for (const id of Object.keys(out).sort(byReading(out))) {
    for (let moved = true; moved;) { moved = false; for (const s of placed) if (overlaps(out[id], out[s])) { out[id].y = out[s].y + out[s].h; moved = true; } }
    placed.push(id);
  }
  return out;
}

// Auto-tidy (only when asked): every card slides up as far as it can without touching another; columns never change.
export function compact(pos) {
  const out = copy(pos), placed = [];
  for (const id of Object.keys(out).sort(byReading(out))) {
    let y = 0;
    for (let moved = true; moved;) { moved = false; for (const s of placed) if (overlaps({ ...out[id], y }, out[s])) { y = out[s].y + out[s].h; moved = true; } }
    out[id].y = y; placed.push(id);
  }
  return out;
}

// The first free spot (top to bottom, left to right) for a w x h card; used for cards that have no saved place.
export function firstFit(pos, w, h, cols) {
  const r = cleanRect({ x: 0, y: 0, w, h }, cols), others = Object.values(pos);
  for (let y = 0; ; y++) for (let x = 0; x + r.w <= cols; x++) if (!others.some(o => overlaps({ ...r, x, y }, o))) return { ...r, x, y };
}

// A drag of the card body by dc columns and dr rows.
export const dragRect = (r, dc, dr, cols) => cleanRect({ ...r, x: r.x + dc, y: r.y + dr }, cols);
// A resize from edge n s e w ne nw se sw by dc columns and dr rows. The opposite edge stays where it is; the size never goes
// below the minimum nor the card outside the grid.
export function resizeRect(r, edge, dc, dr, cols) {
  const e = String(edge), d = Number.isFinite(dc) ? Math.round(dc) : 0, v = Number.isFinite(dr) ? Math.round(dr) : 0;
  let { x, y, w, h } = r;
  if (e.includes('e')) w = clamp(r.w + d, MIN_W, cols - r.x);
  if (e.includes('w')) { const right = r.x + r.w; x = clamp(r.x + d, Math.max(0, right - cols), right - MIN_W); w = right - x; }
  if (e.includes('s')) h = clamp(r.h + v, MIN_H, MAX_H);
  if (e.includes('n')) { const base = r.y + r.h; y = clamp(r.y + v, Math.max(0, base - MAX_H), base - MIN_H); h = base - y; }
  return cleanRect({ x, y, w, h }, cols);
}
// Which edge or corner of a card a pointer is on (m px band inside the border), or '' for the body.
export function edgeAt(box, px, py, m = 8) {
  const l = px - box.left, r = box.right - px, t = py - box.top, b = box.bottom - py;
  if (l < 0 || r < 0 || t < 0 || b < 0) return '';
  const band = Math.min(m, box.width / 3, box.height / 3);
  return (t < band ? 'n' : b < band ? 's' : '') + (r < band ? 'e' : l < band ? 'w' : '');
}

// ---- saved form
// { v: 2, pos: { id: { x, y, w, h } }, hidden: [id], collapsed: [id] }. `collapsed` is owned by the collapse buttons.
// Anything else (an old order/span/h layout, a broken value, another version) returns null: the caller falls back to the default
// flow, or converts an old layout. Cards that no longer exist are dropped, bad rectangles are dropped (such a card is placed in the
// first free spot), a pinned card is never hidden, and overlapping rectangles are settled.
export function sanitizeLayout(saved, ids, cols, pinnedIds = []) {
  if (!isObj(saved) || saved.v !== 2 || !isObj(saved.pos)) return null;
  const pos = {};
  for (const id of ids) { const r = Object.hasOwn(saved.pos, id) ? cleanRect(saved.pos[id], cols) : null; if (r) pos[id] = r; }
  const hidden = Array.isArray(saved.hidden) ? [...new Set(saved.hidden.filter(i => typeof i === 'string' && ids.includes(i) && canHide(i, pinnedIds.includes(i))))] : [];
  for (const id of hidden) delete pos[id];
  return { pos: settleAll(pos), hidden };
}
export const isOldLayout = saved => isObj(saved) && saved.v !== 2 && (Array.isArray(saved.order) || isObj(saved.span) || isObj(saved.h));
export const toSaved = (st, collapsed = []) => ({ v: 2, pos: st.pos, hidden: st.hidden, collapsed });

// From the cards as currently drawn (any old order/span/h layout included) to cells. `boxes` are { id, left, top, width, height }
// in px relative to the grid; colPitch is one column plus its gap. Both edges of a card snap with the same rule (a little upward, so a
// card is rarely cut short and two cards that touched in the flow still touch), which keeps the error to under one row for every
// card and stops it adding up down a column.
const snapRow = px => Math.floor(px / ROW_PITCH + 0.7);
export function fromBoxes(boxes, { colPitch, cols, gap = ROW_GAP }) {
  const pos = {};
  if (!(colPitch > 0)) return pos;
  for (const b of boxes) {
    if (![b.left, b.top, b.width, b.height].every(Number.isFinite)) continue;
    const y = snapRow(b.top), end = snapRow(b.top + b.height + ROW_GAP);
    const r = cleanRect({ x: Math.round(b.left / colPitch), y, w: Math.round((b.width + gap) / colPitch), h: end - y }, cols);
    if (r) pos[b.id] = r;
  }
  return settleAll(pos);
}
// Rows needed to show a card's content in full (its natural height in px).
export const rowsFor = px => clamp(Math.ceil(((Number.isFinite(px) ? px : 0) + ROW_GAP) / ROW_PITCH - 0.05), MIN_H, MAX_H);

// ---- undo / redo: snapshots of { pos, hidden }
export function history() {
  let past = [], future = [];
  const snap = s => JSON.parse(JSON.stringify(s));
  return {
    push(state) { past.push(snap(state)); if (past.length > UNDO_LIMIT) past.shift(); future = []; },
    undo(current) { if (!past.length) return null; future.push(snap(current)); return past.pop(); },
    redo(current) { if (!future.length) return null; past.push(snap(current)); return future.pop(); },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    clear() { past = []; future = []; }
  };
}
