// Issue #1319: the Launch pad board style: its scenery, the plan of a land, a launch and a return, and the shared path rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as launch from '../supervisor/ui/boardstyle-launch.mjs';
import { LAYOUT, boardGeometry, BOXES } from '../supervisor/ui/boardlayout.mjs';
import { MOTION } from '../supervisor/ui/boardtiming.mjs';
import { planChange } from '../supervisor/ui/boardmotion.mjs';
import { checkStyleRules, checkStyleReadsNoRandomOrClock, checkOtherKinds, boardWith } from './boardstyle-rules.mjs';

const make = (tag, attributes = {}) => ({ tag, attributes });
const quiet = () => {};

// The two lanes of the real board: claude opus and claude sonnet.
const realBoard = () => ({ ...boardWith(0), lanes: [
  { id: 'claude/opus', agent: 'claude', model: 'opus', job_types: ['review'] },
  { id: 'claude/sonnet', agent: 'claude', model: 'sonnet', job_types: ['implement'] }] });
const geometryOf = (board, width = 1280) => boardGeometry(board, width);
const laneEntry = (geometry, id) => geometry.groups.flatMap(group => group.lanes).find(entry => entry.lane.id === id);
const head = lane => ({ x: lane.x + lane.w / 2, y: LAYOUT.laneTop + LAYOUT.ballRadius });
const landOf = (geometry, laneId, boxId, jobId) => {
  const lane = laneEntry(geometry, laneId);
  const box = geometry.boxes.find(candidate => candidate.id === boxId);
  return { kind: 'land', jobId, lane, box, from: head(lane), to: { x: box.x + 20, y: box.y + 60 }, geometry };
};
const peak = points => Math.min(...points.map(point => point.y));

test('valid: the style is named launch, labelled Launch pad and exports the shape of a style', () => {
  assert.equal(launch.name, 'launch');
  assert.equal(launch.label, 'Launch pad');
  assert.equal(typeof launch.draw, 'function');
  assert.equal(typeof launch.plan, 'function');
});

test('valid: one launch pad per lane and one landing pad per box, and nothing else', () => {
  const geometry = geometryOf(realBoard());
  const scenery = launch.draw(geometry, make);
  assert.deepEqual(scenery.defs, []);
  assert.equal(scenery.nodes.filter(node => node.attributes.class === 'launch-pad').length, 2);
  assert.equal(scenery.nodes.filter(node => node.attributes.class === 'landing-pad').length, BOXES.length);
  assert.equal(scenery.nodes.length, 2 + BOXES.length);
  for (const node of scenery.nodes) {
    const { x, y, width, height } = node.attributes;
    const { pegs } = geometry;
    const inMiddle = x < pegs.x + pegs.w && x + width > pegs.x && y < pegs.y + pegs.h && y + height > pegs.y;
    assert.equal(inMiddle, false, 'a pad is not in the middle area');
  }
});

test('boundary: the pads follow the layout table for one lane, six lanes and no lane', () => {
  for (const count of [0, 1, 6]) {
    const scenery = launch.draw(geometryOf(boardWith(count)), make);
    assert.equal(scenery.nodes.filter(node => node.attributes.class === 'launch-pad').length, count);
    assert.equal(scenery.nodes.filter(node => node.attributes.class === 'landing-pad').length, 9);
  }
});

test('valid: each pad sits at the head of its lane or on the top edge of its box', () => {
  const geometry = geometryOf(realBoard());
  const pads = launch.draw(geometry, make).nodes;
  const opus = laneEntry(geometry, 'claude/opus');
  const lanePad = pads.find(node => node.attributes['data-launch-pad'] === 'claude/opus').attributes;
  assert.equal(lanePad.x, opus.x);
  assert.ok(lanePad.y + lanePad.height <= LAYOUT.laneTop);
  const changes = geometry.boxes.find(box => box.id === 'changes_asked');
  const boxPad = pads.find(node => node.attributes['data-landing-pad'] === 'changes_asked').attributes;
  assert.equal(boxPad.x + boxPad.width / 2, changes.x + changes.w / 2);
  assert.equal(boxPad.y + boxPad.height / 2, changes.y);
});

test('valid: review job 6ff7be3f of claude opus with CHANGES lifts off at the head of the lane and lands on Changes asked', () => {
  const geometry = geometryOf(realBoard());
  const input = landOf(geometry, 'claude/opus', 'changes_asked', '6ff7be3f');
  const flight = launch.plan(input);
  const pad = launch.padPoint(input.box);
  assert.deepEqual(flight.points[0], head(input.lane));
  assert.deepEqual(flight.trail.at(-1), pad);
  assert.ok(flight.points.includes(flight.trail.at(-1)));
  assert.deepEqual(flight.points.at(-1), input.to);
  assert.equal(flight.points.length, flight.offsets.length);
  assert.deepEqual(launch.plan(input), flight, 'planned twice, the same path');
});

test('valid: the implement job on issue 1307 of claude sonnet ends on the To review pad', () => {
  const geometry = geometryOf(realBoard());
  const input = landOf(geometry, 'claude/sonnet', 'to_review', 'aaaa1307');
  const flight = launch.plan(input);
  assert.deepEqual(flight.trail.at(-1), launch.padPoint(geometry.boxes.find(box => box.id === 'to_review')));
  assert.deepEqual(launch.plan(input), flight);
});

test('valid: the arc is one smooth arc: it rises first, then falls, and never turns back', () => {
  const geometry = geometryOf(realBoard());
  const { trail } = launch.plan(landOf(geometry, 'claude/opus', 'changes_asked', '6ff7be3f'));
  const apex = trail.findIndex(point => point.y === peak(trail));
  assert.ok(apex > 0 && apex < trail.length - 1, 'the highest point is in the middle');
  assert.ok(trail[apex].y < trail[0].y, 'it rose before it fell');
  for (let index = 1; index <= apex; index += 1) assert.ok(trail[index].y <= trail[index - 1].y + 1e-9, 'rising');
  for (let index = apex + 1; index < trail.length; index += 1) assert.ok(trail[index].y >= trail[index - 1].y - 1e-9, 'falling');
});

test('boundary: the farthest box peaks higher than the nearest and both stay on the board', () => {
  const geometry = geometryOf(realBoard());
  const lane = laneEntry(geometry, 'claude/opus');
  const byDistance = geometry.boxes.map(box => ({ box, distance: Math.hypot(launch.padPoint(box).x - head(lane).x, launch.padPoint(box).y - head(lane).y) }))
    .sort((a, b) => a.distance - b.distance);
  const near = launch.plan(landOf(geometry, 'claude/opus', byDistance[0].box.id, 'x'));
  const far = launch.plan(landOf(geometry, 'claude/opus', byDistance.at(-1).box.id, 'x'));
  assert.ok(peak(far.trail) < peak(near.trail), 'the farther arc is higher');
  const onBoard = point => point.x >= 0 && point.x <= geometry.width && point.y >= 0 && point.y <= geometry.height;
  for (const flight of [near, far]) assert.ok(flight.points.every(onBoard));
});

test('boundary: from every lane each box that is farther has a higher arc, for one lane and for six lanes', () => {
  for (const count of [1, 6]) {
    const geometry = geometryOf(boardWith(count));
    for (const { lane } of geometry.groups.flatMap(group => group.lanes)) {
      const start = head(laneEntry(geometry, lane.id));
      const flights = geometry.boxes.map(box => ({ box, distance: Math.hypot(launch.padPoint(box).x - start.x, launch.padPoint(box).y - start.y),
        top: peak(launch.plan(landOf(geometry, lane.id, box.id, 'x')).trail) }));
      for (const a of flights) for (const b of flights) {
        if (b.distance - a.distance >= 40) assert.ok(a.top - b.top >= 1, `${lane.id}: ${b.box.id} peaks at least 1 px higher than ${a.box.id}`);
      }
    }
  }
});

test('boundary: a lane directly above its box still rises before it falls', () => {
  const geometry = geometryOf(realBoard());
  const lane = laneEntry(geometry, 'claude/opus');
  const box = { ...geometry.boxes[0], x: lane.x + lane.w / 2 - geometry.boxes[0].w / 2 };
  const { trail } = launch.plan({ ...landOf(geometry, 'claude/opus', 'merged', 'x'), box });
  assert.ok(trail.every(point => Math.abs(point.x - trail[0].x) < 1e-9), 'straight above');
  assert.ok(peak(trail) < trail[0].y);
});

test('valid: the speed eases in at lift off and out at landing', () => {
  const geometry = geometryOf(realBoard());
  const flight = launch.plan(landOf(geometry, 'claude/opus', 'changes_asked', '6ff7be3f'));
  const speed = index => Math.hypot(flight.points[index + 1].x - flight.points[index].x, flight.points[index + 1].y - flight.points[index].y)
    / (flight.offsets[index + 1] - flight.offsets[index]);
  const arcSegments = flight.trail.length - 1;
  const middle = Math.max(...Array.from({ length: arcSegments }, (_, index) => speed(index)));
  assert.ok(speed(0) < middle / 4, 'slow at lift off');
  assert.ok(speed(arcSegments - 1) < middle / 4, 'slow at landing');
  assert.ok(flight.offsets.every((offset, index) => index === 0 || offset > flight.offsets[index - 1]), 'time moves forward');
  assert.equal(flight.offsets[0], 0);
  assert.equal(flight.offsets.at(-1), 1);
});

test('valid: every land lasts 1.5 to 3 seconds, a farther box longer', () => {
  const geometry = geometryOf(realBoard());
  const times = geometry.boxes.map(box => launch.plan(landOf(geometry, 'claude/opus', box.id, 'x')).durationMs);
  assert.ok(times.every(ms => ms >= MOTION.landMinMs && ms <= MOTION.landMaxMs));
  assert.ok(new Set(times).size > 1);
});

test('valid: the shared path rules pass for one lane, two lanes and six lanes', () => {
  checkStyleRules(launch, [1, 2, 6]);
  checkStyleReadsNoRandomOrClock(launch);
  checkOtherKinds(launch);
});

test('valid: the style names no clock and no timer in its source', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../supervisor/ui/boardstyle-launch.mjs', import.meta.url), 'utf8').replace(/^\/\/.*$/gm, '');
  assert.doesNotMatch(source, /Math\.random|Date\.|performance\.|setTimeout|setInterval|requestAnimationFrame|crypto/);
});

test('boundary: nine boxes are all reached and each ends inside its own box', () => {
  const geometry = geometryOf(realBoard());
  for (const box of geometry.boxes) {
    const flight = launch.plan(landOf(geometry, 'claude/sonnet', box.id, 'aaaa1307'));
    assert.deepEqual(flight.trail.at(-1), launch.padPoint(box));
  }
  assert.equal(geometry.boxes.length, 9);
});

test('invalid: an unknown box name lands in Done, so the arc ends on the Done pad', () => {
  const before = realBoard();
  const job = { job_id: 'u1', lane_id: 'claude/sonnet', job_type: 'implement', number: 1, title: null, laps: 0 };
  const after = { ...before, running: [{ ...job, started_at: '2026-11-13T08:00:00Z', typical_seconds: null }] };
  const landed = { ...after, running: [], landed: [{ ...job,
    ended_at: '2026-11-13T08:10:00Z', box: 'plaid', tokens: 1, cost_pence: 1 }] };
  const change = planChange(after, landed, { width: 1280, now: 0, style: launch }, quiet);
  const geometry = geometryOf(landed);
  const travel = change.travels.find(candidate => candidate.kind === 'land');
  assert.deepEqual(travel.trail.at(-1), launch.padPoint(geometry.boxes.find(box => box.id === 'done')));
});

test('valid: a launch is a short hop and a return is one low arc lower than any land arc', () => {
  const geometry = geometryOf(realBoard());
  const lane = laneEntry(geometry, 'claude/opus');
  const hopper = { x: geometry.hopper.x + 20, y: geometry.hopper.y + 20 };
  const foot = { x: lane.x + lane.w / 2, y: LAYOUT.laneBottom - LAYOUT.ballRadius };
  const hop = launch.plan({ kind: 'launch', jobId: 'x', lane, box: null, from: hopper, to: foot, geometry });
  assert.deepEqual([hop.points[0], hop.points.at(-1)], [hopper, foot]);
  assert.equal(hop.durationMs, MOTION.launchMs);
  assert.equal(hop.trail, undefined, 'a hop leaves no trail');
  const back = geometry.boxes.map(box => launch.plan({ kind: 'return', jobId: 'x', lane: null, box,
    from: { x: box.x + 20, y: box.y + 40 }, to: hopper, geometry }));
  const landPeaks = geometry.boxes.map(box => peak(launch.plan(landOf(geometry, 'claude/opus', box.id, 'x')).trail));
  for (const [index, flight] of back.entries()) {
    assert.ok(peak(flight.points) > Math.max(...landPeaks), 'lower than a land arc');
    assert.equal(flight.trail, undefined);
    assert.ok(peak(flight.points) < Math.min(hopper.y, geometry.boxes[index].y + 40), 'it is an arc, not a straight line');
  }
});

test('valid: the common code carries the offsets and the trail of a land into the travel', () => {
  const before = { ...realBoard(), running: [{ job_id: '6ff7be3f', lane_id: 'claude/opus', job_type: 'review', number: 1244, title: 'r', laps: 1,
    started_at: '2026-11-13T08:00:00Z', typical_seconds: 300 }] };
  const after = { ...realBoard(), landed: [{ job_id: '6ff7be3f', lane_id: 'claude/opus', job_type: 'review', number: 1244, title: 'r', laps: 1,
    ended_at: '2026-11-13T08:45:00Z', box: 'changes_asked', tokens: 5000, cost_pence: 125 }] };
  const { travels } = planChange(before, after, { width: 1280, now: 0, style: launch }, quiet);
  const land = travels.find(travel => travel.kind === 'land');
  assert.equal(land.offsets.length, land.points.length);
  assert.ok(land.trail.length > 2);
});

test('boundary: a job the board never saw running starts at the foot of its lane and still lifts off from the head', () => {
  const geometry = geometryOf(realBoard());
  const input = landOf(geometry, 'claude/opus', 'changes_asked', '6ff7be3f');
  const foot = { x: input.from.x, y: LAYOUT.laneTop + 190 };
  const flight = launch.plan({ ...input, from: foot });
  assert.deepEqual(flight.points[0], foot);
  assert.deepEqual(flight.trail[0], input.from);
  assert.equal(flight.points.length, flight.offsets.length);
  assert.ok(flight.offsets.every((offset, index) => index === 0 || offset > flight.offsets[index - 1]));
  assert.ok(peak(flight.trail) < input.from.y);
  assert.deepEqual(launch.plan({ ...input, from: foot }), flight);
});
