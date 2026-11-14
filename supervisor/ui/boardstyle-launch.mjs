// Issue #1319: the Launch pad board style. Each job lifts off from its agent's lane and flies one arc to a landing pad on the top edge of the box
// that says how it ended. The middle area stays empty sky. A style is a module that exports `name`, `label`, `draw` and `plan` (issue #1315);
// plan also returns `offsets` (the share of the time at which each point is reached, which is how the speed eases) and, for a land, `trail`
// (the points of the arc, which the common code draws as a dotted line while the ball is in flight). No random numbers, no clock, no timer.
import { LAYOUT } from './boardlayout.mjs';
import { MOTION, clamp } from './boardtiming.mjs';

export const name = 'launch';
export const label = 'Launch pad';

export const PAD = Object.freeze({
  launchHeight: 4,
  landingWidth: 44,
  landingHeight: 5,
  arcSteps: 24,
  hopSteps: 10,
  hopHeight: 16,
  returnLift: 30,
  riseBase: 6,          // the lift of an arc above its start grows with the distance flown, from this base
  riseGrowth: 60,
  apexShare: 0.2,       // the arc has risen by the time this share of it is flown, then it falls
  settleShare: 0.12,    // the share of the time the ball spends settling from the pad into its place in the box
  landBaseMs: 1700,
  landGrowthMs: 1300,
});

const smooth = t => t * t * (3 - 2 * t);

// The scenery: a launch pad at the head of each lane and a landing pad on the top edge of each box. Nothing is drawn in the middle area.
export function draw(geometry, svg) {
  const launchPads = geometry.groups.flatMap(group => group.lanes).map(({ lane, x, w }) => svg('rect', {
    class: 'launch-pad', 'data-launch-pad': lane.id, x, y: LAYOUT.laneTop - PAD.launchHeight - 1, width: w, height: PAD.launchHeight, rx: 2 }));
  const landingPads = geometry.boxes.map(box => svg('rect', {
    class: 'landing-pad', 'data-landing-pad': box.id, x: padPoint(box).x - PAD.landingWidth / 2, y: box.y - PAD.landingHeight / 2,
    width: PAD.landingWidth, height: PAD.landingHeight, rx: 2 }));
  return { defs: [], nodes: [...launchPads, ...landingPads] };
}

// Where a ball touches down: the middle of the top edge of the box.
export const padPoint = box => ({ x: box.x + box.w / 2, y: box.y });

const onBoard = (point, geometry) => ({ x: clamp(point.x, 0, geometry.width), y: clamp(point.y, 0, geometry.height) });
const evenOffsets = count => Array.from({ length: count }, (_, index) => index / (count - 1));

// The height of the arc at progress s: it rises to its apex, then falls to the pad with the speed of a fall.
function arcY(from, pad, rise, s) {
  const apex = from.y - rise;
  if (s < PAD.apexShare) return from.y - rise * Math.sin((Math.PI / 2) * (s / PAD.apexShare));
  return apex + (pad.y - apex) * ((s - PAD.apexShare) / (1 - PAD.apexShare)) ** 2;
}

// The land: one arc from the start to the pad, flown with the speed easing in at lift off and out at landing, then a short settle into the box.
export function planLand({ box, from, to, geometry }) {
  const pad = padPoint(box);
  const reach = Math.hypot(pad.x - from.x, pad.y - from.y) / Math.hypot(geometry.width, geometry.height);
  const rise = clamp(PAD.riseBase + PAD.riseGrowth * reach, 0, Math.max(0, from.y - LAYOUT.ballRadius));
  const arc = Array.from({ length: PAD.arcSteps + 1 }, (_, index) => {
    const s = smooth(index / PAD.arcSteps);
    return onBoard({ x: from.x + (pad.x - from.x) * s, y: arcY(from, pad, rise, s) }, geometry);
  });
  const flightShare = 1 - PAD.settleShare;
  const offsets = [...arc.map((_, index) => (index / PAD.arcSteps) * flightShare), 1];
  const durationMs = clamp(Math.round(PAD.landBaseMs + PAD.landGrowthMs * reach), MOTION.landMinMs, MOTION.landMaxMs);
  return { points: [...arc, onBoard(to, geometry)], offsets, durationMs, trail: arc };
}

// A hop from the hopper to the foot of the lane.
function planLaunch({ from, to, geometry }) {
  const points = Array.from({ length: PAD.hopSteps + 1 }, (_, index) => {
    const s = smooth(index / PAD.hopSteps);
    return onBoard({ x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s - 4 * PAD.hopHeight * s * (1 - s) }, geometry);
  });
  return { points, offsets: evenOffsets(points.length), durationMs: MOTION.launchMs };
}

// One low arc from the box back to the hopper; it lifts more than the climb, so it tops out before it arrives.
function planReturn({ from, to, geometry }) {
  const lift = Math.max(PAD.returnLift, Math.abs(to.y - from.y) / 3);
  const points = Array.from({ length: PAD.arcSteps + 1 }, (_, index) => {
    const s = smooth(index / PAD.arcSteps);
    return onBoard({ x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s - 4 * lift * s * (1 - s) }, geometry);
  });
  return { points, offsets: evenOffsets(points.length), durationMs: MOTION.returnMs };
}

// The travel path of one step. A function of its inputs only.
export function plan(input) {
  if (input.kind === 'land') return planLand(input);
  return input.kind === 'launch' ? planLaunch(input) : planReturn(input);
}
