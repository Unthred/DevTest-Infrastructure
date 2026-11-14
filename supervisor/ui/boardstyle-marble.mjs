// Issue #1318: the Marble run board style. Balls roll down sloped tracks that zigzag through the middle of the board onto a sorting rail
// that runs level above every result box, and drop through the gate above their own box. Part of the board styles of issue #1315: a style
// module exports `name`, `label`, `draw` and `plan`. No random numbers, no clock and no timer: the path is a function of the lane, the
// box and the geometry, and the gate of the target box opens through `effects` that the common code plays along the ball's own path.
import { LAYOUT } from './boardlayout.mjs';
import { MOTION, clamp } from './boardtiming.mjs';

export const name = 'marble';
export const label = 'Marble run';

const R = LAYOUT.ballRadius;
export const MARBLE = Object.freeze({
  tracks: 3,          // sloped tracks above the sorting rail
  inset: R + 4,       // between the end of a track and the edge of the middle area
  minSpan: 120,       // a middle area narrower than this draws its tracks level
  slope: 0.55,        // the drop of a track as a fraction of the room one track has
  speed: 1,           // pixels per millisecond along the whole path; the duration is kept inside the shared limits
  gateHalf: R + 4,    // half the opening of a gate
  dip: 4,             // how far a ball sinks as it turns over the end of a track
  railClearance: 22,  // from the top of the boxes up to the centre of a ball on the sorting rail
  feederRise: 4,      // the feeder track runs this far above the hopper
  returnRise: 8,      // the return rail: the centre of a ball this far above the bottom of the board
});

const clampPoint = (point, geometry) => ({ x: clamp(point.x, 0, geometry.width), y: clamp(point.y, 0, geometry.height) });
const pathLength = points => points.reduce((sum, point, index) => (index === 0 ? 0
  : sum + Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y)), 0);

// Where everything of the style is, from the layout table: the tracks (each as the line the centre of a ball follows), the sorting rail
// and the gate above each box.
export function marbleLayout(geometry) {
  const area = geometry.pegs;
  const boxTop = geometry.boxes.length ? geometry.boxes[0].y : area.y + area.h;
  const left = area.x + MARBLE.inset;
  const right = Math.max(left, area.x + area.w - MARBLE.inset);
  const top = area.y + R + 6;
  const railCentre = boxTop - MARBLE.railClearance;
  const band = (railCentre - R - 4 - top) / MARBLE.tracks;
  const drop = right - left >= MARBLE.minSpan ? band * MARBLE.slope : 0;
  const tracks = Array.from({ length: MARBLE.tracks }, (_, index) => {
    const y = top + index * band;
    return index % 2 === 0 ? { from: { x: left, y }, to: { x: right, y: y + drop } } : { from: { x: right, y }, to: { x: left, y: y + drop } };
  });
  const gates = geometry.boxes.map(box => ({ id: box.id, x: box.x + box.w / 2 }));
  const first = geometry.boxes[0];
  const last = geometry.boxes[geometry.boxes.length - 1];
  return { tracks, gates, railCentre, surface: railCentre + R + 2,
    rail: { from: first ? first.x : left, to: last ? last.x + last.w : right } };
}

const line = (svg, a, b, cls, extra = {}) => svg('line', { class: cls, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'currentColor', 'stroke-width': 4,
  'stroke-linecap': 'round', opacity: 0.55, ...extra });

// A gate is a closed bar across its opening and, hidden until the ball is on its way, an open one: two short posts hanging from the edges.
function gateNode(svg, gate, surface) {
  const a = { x: gate.x - MARBLE.gateHalf, y: surface };
  const b = { x: gate.x + MARBLE.gateHalf, y: surface };
  const posts = [a, b].map(top => line(svg, top, { x: top.x, y: surface + R }, 'gate-post'));
  const open = svg('g', { class: 'gate-open', opacity: 0 }, ...posts);
  return svg('g', { class: 'marble-gate', 'data-gate': gate.id }, line(svg, a, b, 'gate-closed'), open);
}

// The rail in pieces between the gates, so each gate is a gap that the closed bar or the open posts then fill.
function railNodes(svg, layout) {
  const nodes = [];
  let at = layout.rail.from;
  for (const gate of layout.gates) {
    nodes.push(line(svg, { x: at, y: layout.surface }, { x: gate.x - MARBLE.gateHalf, y: layout.surface }, 'marble-rail'));
    at = gate.x + MARBLE.gateHalf;
  }
  nodes.push(line(svg, { x: at, y: layout.surface }, { x: Math.max(at, layout.rail.to), y: layout.surface }, 'marble-rail'));
  return nodes;
}

const feederY = geometry => geometry.hopper.y - MARBLE.feederRise;
const returnY = geometry => geometry.height - MARBLE.returnRise;
const laneCentres = geometry => geometry.groups.flatMap(group => group.lanes.map(entry => entry.x + entry.w / 2));

// The scenery of the middle area, the feeder track from the hopper to the lanes and the return rail under the boxes.
export function draw(geometry, svg) {
  const layout = marbleLayout(geometry);
  const under = point => ({ x: point.x, y: point.y + R + 2 });
  const tracks = layout.tracks.map(track => line(svg, under(track.from), under(track.to), 'marble-track'));
  const centres = laneCentres(geometry);
  const faint = { opacity: 0.2 };
  const across = [{ x: Math.min(...centres), y: feederY(geometry) }, { x: Math.max(...centres), y: feederY(geometry) }];
  const feeder = [line(svg, across[0], across[1], 'marble-feeder', faint),
    ...centres.map(x => line(svg, { x, y: feederY(geometry) }, { x, y: LAYOUT.laneBottom }, 'marble-feeder', faint))];
  const back = [line(svg, { x: LAYOUT.leftPad, y: returnY(geometry) }, { x: geometry.width - LAYOUT.leftPad, y: returnY(geometry) }, 'marble-return'),
    line(svg, { x: LAYOUT.leftPad, y: returnY(geometry) }, { x: LAYOUT.leftPad, y: geometry.hopper.y }, 'marble-return')];
  const nodes = [...tracks, ...railNodes(svg, layout), ...layout.gates.map(gate => gateNode(svg, gate, layout.surface)), ...feeder, ...back];
  return { defs: [], nodes: geometry.boxes.length ? nodes : [] };
}

// The land: out of the lane, down every track with a dip at each end, along the rail and through the gate of the box into its place.
export function planLand({ from, box, to, geometry }) {
  const layout = marbleLayout(geometry);
  const points = [from];
  const mark = point => points.push(point) - 1;
  layout.tracks.forEach(track => {
    mark(track.from);
    mark(track.to);
    const outward = Math.sign(track.to.x - track.from.x) || 1;
    mark({ x: track.to.x + outward * MARBLE.dip, y: track.to.y + MARBLE.dip });
  });
  const entry = Math.max(layout.tracks[layout.tracks.length - 1].to.x, layout.gates.length ? layout.gates[layout.gates.length - 1].x : 0);
  const onRail = mark({ x: entry, y: layout.railCentre });
  const gateX = box.x + box.w / 2;
  mark({ x: gateX, y: layout.railCentre });
  const dropped = mark({ x: gateX, y: layout.surface + R });
  mark(to);
  const bounded = points.map(point => clampPoint(point, geometry));
  const durationMs = clamp(Math.round(pathLength(bounded) / MARBLE.speed), MOTION.landMinMs, MOTION.landMaxMs);
  const last = bounded.length - 1;
  const swing = (selector, shut, open) => ({ selector: `.board-svg [data-gate="${box.id}"] ${selector}`,
    frames: [[0, shut], [onRail, shut], [onRail, open], [dropped, open], [dropped, shut], [last, shut]].map(([at, opacity]) => ({ at, opacity })) });
  return { points: bounded, durationMs, effects: [swing('.gate-open', 0, 1), swing('.gate-closed', 1, 0)] };
}

// A launch along the feeder track: up from the hopper place, along the track above the hopper, up the lane to its foot.
function planLaunch({ from, to, geometry }) {
  const y = feederY(geometry);
  return { points: [from, { x: from.x, y }, { x: to.x, y }, to].map(point => clampPoint(point, geometry)), durationMs: MOTION.launchMs };
}

// A return along the rail under the boxes, and up the left edge to the hopper.
function planReturn({ from, to, geometry }) {
  const y = returnY(geometry);
  return { points: [from, { x: from.x, y }, { x: LAYOUT.leftPad, y }, { x: LAYOUT.leftPad, y: to.y }, to].map(point => clampPoint(point, geometry)),
    durationMs: MOTION.returnMs };
}

// The travel path of one step. kind is launch, land or return; from and to are the points the common code found.
export function plan(step) {
  if (step.kind === 'land') return planLand(step);
  return step.kind === 'launch' ? planLaunch(step) : planReturn(step);
}
