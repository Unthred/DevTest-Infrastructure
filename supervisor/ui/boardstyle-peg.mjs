// Issue #1315: the first board style, the peg board. It draws the pegs that fill the middle of the board and plans the path a ball takes
// through them. Moved here from boardsvg.mjs and boardmotion.mjs (issue #1313) with no change in what is drawn or how a ball moves.
// A style is a module of the UI folder named boardstyle-<name>.mjs that exports `name`, `label`, `draw` and `plan`.
import { LAYOUT } from './boardlayout.mjs';
import { MOTION, hashOf, clamp } from './boardtiming.mjs';

export const name = 'peg';
export const label = 'Peg board';

// The pegs of the peg board: a pattern anchored at the origin of the drawing.
export const PEG = Object.freeze({ pitch: 28, radius: 2.5, spots: Object.freeze([[7, 7], [21, 21]]) });

// The scenery of the middle area from the layout table: what goes in <defs> and what is drawn under the lanes. `svg` builds an element.
export function draw(geometry, svg) {
  const pattern = svg('pattern', { id: 'peg', width: PEG.pitch, height: PEG.pitch, patternUnits: 'userSpaceOnUse' },
    ...PEG.spots.map(([cx, cy]) => svg('circle', { cx, cy, r: PEG.radius, class: 'peg-dot' })));
  const field = svg('rect', { class: 'pegs', x: geometry.pegs.x, y: geometry.pegs.y, width: geometry.pegs.w, height: geometry.pegs.h, rx: 8 });
  return { defs: [pattern], nodes: [field] };
}

const touchDistance = LAYOUT.ballRadius + PEG.radius;
const margin = touchDistance;

// Every peg of a peg board rectangle, top row first.
export function pegPoints(pegs) {
  const found = [];
  for (const [ox, oy] of PEG.spots) {
    for (let x = ox; x < pegs.x + pegs.w; x += PEG.pitch) {
      for (let y = oy; y < pegs.y + pegs.h; y += PEG.pitch) {
        if (x >= pegs.x + margin && x <= pegs.x + pegs.w - margin && y >= pegs.y + margin && y <= pegs.y + pegs.h - margin) found.push({ x, y });
      }
    }
  }
  return found.sort((a, b) => a.y - b.y || a.x - b.x);
}

const inside = (point, rect) => ({
  x: clamp(point.x, rect.x + LAYOUT.ballRadius, rect.x + rect.w - LAYOUT.ballRadius),
  y: clamp(point.y, rect.y + LAYOUT.ballRadius, rect.y + rect.h - LAYOUT.ballRadius),
});

// The ball is tangent to the peg, up and to the side it is heading for.
const contactAt = (peg, side) => ({ x: peg.x + side * touchDistance * Math.SQRT1_2, y: peg.y - touchDistance * Math.SQRT1_2 });

// The path of a land: from start, bouncing off pegs towards the box, ending at end inside the box. Returns the points, the pegs touched
// (with the point of contact) and the duration, all from the job id and the geometry.
export function planLand({ jobId, start, box, end, geometry }) {
  const seed = hashOf(jobId);
  const pegs = geometry.pegs;
  const all = pegPoints(pegs);
  const rows = [...new Set(all.map(peg => peg.y))];
  const count = Math.min(MOTION.contacts, rows.length);
  const stride = count > 0 ? rows.length / count : 1;
  const left = pegs.x + margin;
  const right = pegs.x + pegs.w - margin;
  const target = inside(end, box);
  const aim = clamp(target.x, left, right);
  const entry = clamp(start.x, left, right);
  const touches = [];
  for (let index = 0; index < count; index += 1) {
    const row = all.filter(peg => peg.y === rows[Math.floor(index * stride + stride / 2)]);
    const fraction = (index + 1) / count;
    const sway = (((seed >>> (index * 4)) & 15) - 7.5) * 12 * (1 - fraction);
    const want = entry + (aim - entry) * fraction + sway;
    const peg = row.reduce((best, candidate) => (Math.abs(candidate.x - want) < Math.abs(best.x - want) ? candidate : best));
    touches.push({ peg, at: contactAt(peg, want >= peg.x ? 1 : -1) });
  }
  const points = [start];
  for (const { at } of touches) {
    const last = points[points.length - 1];
    if (points.length > 1) points.push({ x: (last.x + at.x) / 2, y: Math.max(0, Math.min(last.y, at.y) - 6) });
    points.push(at);
  }
  const lastTouch = touches.length ? touches[touches.length - 1].at : start;
  points.push({ x: clamp(lastTouch.x, left, right), y: pegs.y + pegs.h }, target);
  const bounded = points.map(point => ({ x: clamp(point.x, 0, geometry.width), y: clamp(point.y, 0, geometry.height) }));
  const durationMs = clamp(MOTION.landBaseMs + (seed % MOTION.landSpreadMs) + touches.length * 20, MOTION.landMinMs, MOTION.landMaxMs);
  return { points: bounded, touches, durationMs };
}


// The travel path of one step. kind is launch, land or return; from and to are the points the common code found (a lane, a hopper place,
// a place in a box); the lane and the box are the entries of the layout table. Returns the points and the duration in milliseconds,
// and for a land the pegs touched. A function of its inputs only: the job id decides every variety.
export function plan({ kind, jobId, lane, box, from, to, geometry }) {
  if (kind === 'land') return planLand({ jobId, start: from, box, end: to, geometry });
  if (kind === 'launch') return { points: [from, to], durationMs: MOTION.launchMs };
  const floor = geometry.height - LAYOUT.bottomPad - LAYOUT.ballRadius;
  return { points: [from, { x: from.x, y: floor }, { x: to.x, y: floor }, to], durationMs: MOTION.returnMs };
}
