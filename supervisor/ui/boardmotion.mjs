// Issue #1313: the pure side of ball travel on the live board. It compares two liveboard replies and returns the events between them
// (launch, land, return), and plans the path of each travel from the geometry of boardlayout.mjs. No DOM, no clock, no random numbers:
// the path of a land is a function of the lane, the box and the job id, so the same job always takes the same path.
import { LAYOUT, boardGeometry, hopperBalls, boxBalls, runningBalls, boxOf } from './boardlayout.mjs';

export const MOTION = Object.freeze({
  maxEvents: 12,       // more events than this in one change are shown at once, with a count
  launchMs: 900,
  returnMs: 1800,
  closeUpMs: 400,
  landMinMs: 1500,
  landMaxMs: 3000,
  landBaseMs: 1600,
  landSpreadMs: 1000,
  contacts: 5,         // pegs a land touches, fewer only when the peg board is too small for more
});

// The pegs of the peg board as boardsvg.mjs draws them: a pattern anchored at the origin of the drawing.
export const PEG = Object.freeze({ pitch: 28, radius: 2.5, spots: Object.freeze([[7, 7], [21, 21]]) });

// The newest landing of an item decides: a ball that landed in one of these boxes and is waiting again has gone round once more.
const RETURN_BOXES = new Set(['changes_asked', 'failed', 'out_of_allowance']);

const quiet = () => {};
const identOf = entry => `${entry.job_type}:${entry.number}`;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const isEmpty = data => !data.waiting.length && !data.running.length && !data.landed.length;

// The events between two replies. A first reply that is empty is the open case and gives nothing.
export function diffBoard(prev, next, warn = quiet) {
  if (!prev || !next || isEmpty(prev)) return [];
  const wasRunning = new Set(prev.running.map(job => job.job_id));
  const wasLanded = new Map(prev.landed.map(job => [job.job_id, job]));
  const wasWaiting = new Set(prev.waiting.map(item => item.number));
  const events = [];
  for (const job of next.running) {
    if (!wasRunning.has(job.job_id)) events.push({ type: 'launch', job_id: job.job_id, lane_id: job.lane_id, job_type: job.job_type, number: job.number });
  }
  for (const job of next.landed) {
    if (wasLanded.has(job.job_id)) continue;
    events.push({ type: 'land', job_id: job.job_id, lane_id: job.lane_id, job_type: job.job_type, number: job.number,
      box: boxOf(job.box, warn), from: wasRunning.has(job.job_id) ? 'lane_top' : 'lane_foot' });
  }
  // The landings of both replies: the review that lands in Changes asked and the fix queued behind it often arrive in one reply.
  const latest = new Map();
  for (const job of [...prev.landed, ...next.landed]) {
    if (job.number == null) continue;
    const held = latest.get(job.number);
    if (!held || Date.parse(job.ended_at) > Date.parse(held.ended_at)) latest.set(job.number, job);
  }
  for (const item of next.waiting) {
    const job = latest.get(item.number);
    if (!job || !RETURN_BOXES.has(job.box) || wasWaiting.has(item.number)) continue;
    events.push({ type: 'return', job_id: job.job_id, number: item.number, job_type: item.job_type, box: job.box, laps_from: job.laps, laps_to: job.laps + 1,
      after_land: !wasLanded.has(job.job_id) });
  }
  return events;
}

// More than MOTION.maxEvents events are not shown as travel; the screen says how many things changed instead.
export const splitEvents = events => (events.length > MOTION.maxEvents ? { animate: [], changed: events.length } : { animate: events, changed: 0 });

// The laps a waiting ball shows: the model's waiting entries carry none, so a return remembers the figure it raised.
export function carryLaps(carry, events, next) {
  const kept = new Map();
  const waiting = new Set(next.waiting.map(identOf));
  for (const [ident, laps] of carry) if (waiting.has(ident)) kept.set(ident, laps);
  for (const event of events) if (event.type === 'return') kept.set(identOf(event), event.laps_to);
  return kept;
}

export const withLaps = (data, carry) => (carry.size === 0 ? data
  : { ...data, waiting: data.waiting.map(item => (carry.has(identOf(item)) ? { ...item, laps: carry.get(identOf(item)) } : item)) });

// A 32 bit hash of the job id: the only source of variety in a path.
export function hashOf(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) hash = Math.imul(hash ^ char.codePointAt(0), 0x01000193) >>> 0;
  return hash;
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

// Distance along the path of each point as a fraction of the whole path, so a ball moves at one speed.
export function offsetsOf(points) {
  const lengths = points.map((point, index) => (index === 0 ? 0 : Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y)));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let run = 0;
  return lengths.map((length, index) => {
    run += length;
    if (total > 0) return run / total;
    return index === lengths.length - 1 ? 1 : 0;
  });
}

const slotsByKey = (placed, keyOf) => new Map(placed.map(entry => [keyOf(entry.item), { x: entry.x, y: entry.y }]));
const firstSlot = geometry => ({ x: geometry.hopper.x + 8 + LAYOUT.ballRadius, y: geometry.hopper.y + 6 + LAYOUT.ballRadius });
const boxCentre = box => ({ x: box.x + box.w / 2, y: box.y + box.h * 0.6 });

function launchTravel(event, ctx) {
  const rest = runningBalls(ctx.next.running, ctx.gNext, ctx.now).find(ball => ball.job.job_id === event.job_id);
  if (!rest) return null;
  const from = ctx.prevHopper.get(identOf(event)) ?? firstSlot(ctx.gPrev);
  return { target: { kind: 'running', id: event.job_id }, kind: 'launch', points: [from, { x: rest.x, y: rest.y }], durationMs: MOTION.launchMs };
}

function landTravel(event, ctx) {
  const box = ctx.gNext.boxes.find(candidate => candidate.id === event.box);
  const end = ctx.nextBoxes.get(event.job_id);
  if (!box || !end) return null;
  const lane = ctx.gNext.groups.flatMap(group => group.lanes).find(entry => entry.lane.id === event.lane_id);
  const x = lane ? lane.x + lane.w / 2 : ctx.gNext.pegs.x + margin;
  const start = { x, y: event.from === 'lane_top' ? LAYOUT.laneTop + LAYOUT.ballRadius : LAYOUT.laneBottom - LAYOUT.ballRadius };
  const plan = planLand({ jobId: event.job_id, start, box, end, geometry: ctx.gNext });
  return { target: { kind: 'landed', id: event.job_id }, kind: 'land', points: plan.points, durationMs: plan.durationMs, touches: plan.touches };
}

function returnTravel(event, ctx) {
  const to = ctx.nextHopper.get(identOf(event));
  if (!to) return null;
  const box = ctx.gPrev.boxes.find(candidate => candidate.id === event.box);
  const from = ctx.prevBoxes.get(event.job_id) ?? ctx.nextBoxes.get(event.job_id) ?? (box ? boxCentre(box) : firstSlot(ctx.gPrev));
  const floor = ctx.gNext.height - LAYOUT.bottomPad - LAYOUT.ballRadius;
  return { target: { kind: 'waiting', ident: identOf(event) }, kind: 'return', points: [from, { x: from.x, y: floor }, { x: to.x, y: floor }, to],
    durationMs: MOTION.returnMs, delayMs: ctx.landMs.get(event.job_id) ?? 0, laps: { from: event.laps_from, to: event.laps_to } };
}

// The remaining hopper balls close up when one of them has left.
function closeUps(events, ctx) {
  if (!events.some(event => event.type === 'launch')) return [];
  const gone = new Set(events.filter(event => event.type === 'launch').map(identOf));
  const moves = [];
  for (const [ident, to] of ctx.nextHopper) {
    const from = ctx.prevHopper.get(ident);
    if (!from || gone.has(ident) || Math.hypot(from.x - to.x, from.y - to.y) < 0.5) continue;
    moves.push({ target: { kind: 'waiting', ident }, kind: 'close', points: [from, to], durationMs: MOTION.closeUpMs });
  }
  return moves;
}

// What travels for a change from prev to next at a drawn width: the events, the travels they make and how many changed at once.
export function planChange(prev, next, { width, now }, warn = quiet) {
  const events = diffBoard(prev, next, warn);
  const gNext = boardGeometry(next, width);
  if (!events.length || !gNext.drawn) return { events, travels: [], changed: 0 };
  const { animate, changed } = splitEvents(events);
  const gPrev = boardGeometry(prev, width);
  const ctx = { next, now, gPrev, gNext,
    prevHopper: slotsByKey(hopperBalls(prev.waiting, gPrev).placed, identOf), nextHopper: slotsByKey(hopperBalls(next.waiting, gNext).placed, identOf),
    prevBoxes: slotsByKey(boxBalls(prev.landed, gPrev, warn).flatMap(entry => entry.placed), job => job.job_id),
    nextBoxes: slotsByKey(boxBalls(next.landed, gNext, warn).flatMap(entry => entry.placed), job => job.job_id) };
  const make = { launch: launchTravel, land: landTravel, return: returnTravel };
  ctx.landMs = new Map();
  // Lands are planned first: a return that arrives with its own land waits until the ball has dropped into its box.
  const ordered = [...animate.filter(event => event.type !== 'return'), ...animate.filter(event => event.type === 'return')];
  const travels = [];
  for (const event of ordered) {
    const travel = make[event.type](event, ctx);
    if (!travel) continue;
    if (event.type === 'land') ctx.landMs.set(event.job_id, travel.durationMs);
    travels.push(travel);
  }
  return { events, travels: [...travels, ...closeUps(animate, ctx)], changed };
}

// The key of the ball in the SVG that a travel target stands for in a reply, or null when the ball is no longer there.
export function targetKey(target, data) {
  if (target.kind === 'waiting') {
    const item = data.waiting.find(entry => identOf(entry) === target.ident);
    return item ? `waiting:${item.place}` : null;
  }
  const pool = target.kind === 'running' ? data.running : data.landed;
  return pool.some(job => job.job_id === target.id) ? `${target.kind}:${target.id}` : null;
}
