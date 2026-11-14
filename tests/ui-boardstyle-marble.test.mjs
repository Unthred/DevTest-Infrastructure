// Issue #1318: the Marble run board style: its shape, its scenery, the land path through the sorting rail and the gate, and the shared rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as marble from '../supervisor/ui/boardstyle-marble.mjs';
import { MARBLE, marbleLayout } from '../supervisor/ui/boardstyle-marble.mjs';
import { planChange, offsetsOf } from '../supervisor/ui/boardmotion.mjs';
import { LAYOUT, BOXES, boardGeometry } from '../supervisor/ui/boardlayout.mjs';
import { MOTION } from '../supervisor/ui/boardtiming.mjs';
import { Travels } from '../supervisor/ui/boardtravel.mjs';
import { checkStyleRules, checkStyleReadsNoRandomOrClock, checkOtherKinds, boardWith, landInput } from './boardstyle-rules.mjs';

const WIDTH = 1280;
const quiet = () => {};
const lane = (agent, model) => ({ id: `${agent}/${model}`, agent, model, job_types: ['implement'] });
const agent = id => ({ id, display_name: id, condition: { state: 'idle' }, weekly: null, short: null, reading: null, out_until: null, out_reason: null });
const board = (parts = {}) => ({ agents: [agent('claude')], lanes: [lane('claude', 'sonnet'), lane('claude', 'opus')], waiting: [], running: [], landed: [],
  counts: {}, truncated: false, skipped_jobs: 0, ...parts });
const running = (id, laneId, number, type) => ({ job_id: id, lane_id: laneId, job_type: type, number, title: null, laps: 0, started_at: '2026-11-13T08:00:00Z', typical_seconds: 300 });
const landed = (id, laneId, number, box, type) => ({ job_id: id, lane_id: laneId, job_type: type, number, title: null, laps: 0, ended_at: '2026-11-13T08:45:00Z', box, tokens: 1, cost_pence: 1 });

// Review job 6ff7be3f on pull request 1244 (claude, opus) lands with CHANGES; implement job aaaa1307 on issue 1307 (claude, sonnet) lands in To review.
const runningBoth = board({ running: [running('6ff7be3f', 'claude/opus', 1244, 'review'), running('aaaa1307', 'claude/sonnet', 1307, 'implement')] });
const landedBoth = (box1307 = 'to_review') => board({ landed: [landed('6ff7be3f', 'claude/opus', 1244, 'changes_asked', 'review'),
  landed('aaaa1307', 'claude/sonnet', 1307, box1307, 'implement')] });
const lands = (after = landedBoth()) => planChange(runningBoth, after, { width: WIDTH, now: Date.now(), style: marble }, quiet).travels.filter(travel => travel.kind === 'land');

const geometry = boardGeometry(board(), WIDTH);
const boxOf = id => geometry.boxes.find(box => box.id === id);
const gateX = box => box.x + box.w / 2;
const lengthOf = points => points.reduce((sum, point, index) => (index === 0 ? 0 : sum + Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y)), 0);
const planFor = (boxId, jobId = '6ff7be3f', lanes = 2) => {
  const g = boardGeometry(boardWith(lanes), WIDTH);
  const entry = g.groups[0].lanes[0];
  const box = g.boxes.find(candidate => candidate.id === boxId);
  return { g, box, result: marble.plan(landInput(g, entry, box, jobId)) };
};

test('valid: the style is named marble, labelled Marble run, and exports the shape of a style', () => {
  assert.equal(marble.name, 'marble');
  assert.equal(marble.label, 'Marble run');
  assert.equal(typeof marble.draw, 'function');
  assert.equal(typeof marble.plan, 'function');
});

test('valid: the shared path rules hold for every lane and box pair, for one lane and for six lanes', () => {
  checkStyleRules(marble, [1, 2, 6]);
  checkOtherKinds(marble);
  checkStyleReadsNoRandomOrClock(marble);
});

test('valid: the scenery is zigzag tracks, a sorting rail and one gate above each of the nine boxes from the layout table', () => {
  const svg = (tag, attributes = {}, ...children) => ({ tag, attributes, children });
  const scenery = marble.draw(geometry, svg);
  const tracks = scenery.nodes.filter(node => node.attributes.class === 'marble-track');
  const gates = scenery.nodes.filter(node => node.attributes.class === 'marble-gate');
  assert.equal(tracks.length, MARBLE.tracks);
  assert.deepEqual(gates.map(gate => gate.attributes['data-gate']), BOXES.map(box => box.id));
  const slope = track => Math.sign(track.attributes.x2 - track.attributes.x1);
  for (let index = 1; index < tracks.length; index += 1) assert.equal(slope(tracks[index]), -slope(tracks[index - 1]), 'each track runs the opposite way to the one above');
  for (const track of tracks) assert.ok(track.attributes.y2 > track.attributes.y1, 'each track slopes down');
  const layout = marbleLayout(geometry);
  gates.forEach((gate, index) => assert.equal(gate.children[0].attributes.x1, layout.gates[index].x - MARBLE.gateHalf));
  assert.ok(layout.surface < geometry.boxes[0].y, 'the rail is above the boxes');
  assert.equal(layout.rail.from, geometry.boxes[0].x);
  assert.equal(layout.rail.to, geometry.boxes[8].x + geometry.boxes[8].w);
});

test('valid: every gate is drawn closed: the closed bar is whole and the open posts are hidden', () => {
  const svg = (tag, attributes = {}, ...children) => ({ tag, attributes, children });
  for (const gate of marble.draw(geometry, svg).nodes.filter(node => node.attributes.class === 'marble-gate')) {
    assert.equal(gate.children[0].attributes.class, 'gate-closed');
    assert.equal(gate.children[0].attributes.opacity, 0.55);
    assert.equal(gate.children[1].attributes.class, 'gate-open');
    assert.equal(gate.children[1].attributes.opacity, 0);
  }
});

test('valid: review job 6ff7be3f lands in Changes asked: down every track, along the rail, through the gate above Changes asked', () => {
  const [travel] = lands().filter(candidate => candidate.target.id === '6ff7be3f');
  const box = boxOf('changes_asked');
  const layout = marbleLayout(geometry);
  const points = travel.points;
  assert.ok(box.x <= points.at(-1).x && points.at(-1).x <= box.x + box.w && box.y <= points.at(-1).y && points.at(-1).y <= box.y + box.h);
  const drop = points.at(-2);
  assert.equal(drop.x, gateX(box), 'its last drop is at the gate above Changes asked');
  assert.ok(drop.y > layout.surface);
  for (const track of layout.tracks) {
    assert.ok(points.some(point => point.x === track.from.x && point.y === track.from.y), 'the ball is at the top of each track');
    assert.ok(points.some(point => point.x === track.to.x && point.y === track.to.y), 'and at the foot of each track');
  }
  const onRail = points.filter(point => point.y === layout.railCentre);
  assert.ok(onRail.length >= 2 && onRail.some(point => point.x === gateX(box)), 'it rolls along the sorting rail to its gate');
});

test('valid: implement job aaaa1307 lands in To review and its drop is at the To review gate', () => {
  const travel = lands().find(candidate => candidate.target.id === 'aaaa1307');
  assert.equal(travel.points.at(-2).x, gateX(boxOf('to_review')));
  assert.ok(travel.durationMs >= MOTION.landMinMs && travel.durationMs <= MOTION.landMaxMs);
});

test('valid: the same job planned twice gives identical paths', () => {
  assert.deepEqual(lands(), lands());
});

test('boundary: the first box and the last box both arrive, and the path reaches both ends of the sorting rail', () => {
  const first = planFor('merged').result;
  const last = planFor('needs_you').result;
  const layout = marbleLayout(planFor('merged').g);
  const railX = result => result.points.filter(point => point.y === layout.railCentre).map(point => point.x);
  const firstGate = layout.gates[0].x;
  const lastGate = layout.gates[8].x;
  assert.equal(Math.min(...railX(first)), firstGate);
  assert.ok(Math.max(...railX(first)) >= lastGate, 'the ball enters the rail at the end by the last box');
  assert.equal(Math.max(...railX(last)), Math.max(lastGate, layout.tracks[2].to.x));
  assert.ok(first.durationMs <= MOTION.landMaxMs && last.durationMs >= MOTION.landMinMs);
});

test('valid: only the gate of the target box opens, from reaching the rail until the drop, and shuts again', () => {
  const { box, result } = planFor('changes_asked');
  const open = result.effects.find(effect => effect.selector.endsWith('.gate-open'));
  const closed = result.effects.find(effect => effect.selector.endsWith('.gate-closed'));
  assert.equal(result.effects.length, 2);
  assert.ok(open.selector.includes(`[data-gate="${box.id}"]`) && closed.selector.includes(`[data-gate="${box.id}"]`));
  const railAt = result.points.findIndex(point => point.y === marbleLayout(planFor('merged').g).railCentre);
  const dropAt = result.points.length - 2;
  assert.deepEqual(open.frames.map(frame => [frame.at, frame.opacity]), [[0, 0], [railAt, 0], [railAt, 1], [dropAt, 1], [dropAt, 0], [result.points.length - 1, 0]]);
  assert.deepEqual(closed.frames.map(frame => frame.opacity), [1, 1, 0, 0, 1, 1]);
  const offsets = offsetsOf(result.points);
  assert.ok(open.frames.every((frame, index) => index === 0 || offsets[frame.at] >= offsets[open.frames[index - 1].at]), 'the frames run forward along the path');
});

test('valid: the speed is even: the duration is the path length at one speed, kept inside 1.5 to 3 seconds', () => {
  for (const id of BOXES.map(box => box.id)) {
    const { result } = planFor(id);
    const length = lengthOf(result.points);
    const expected = Math.min(MOTION.landMaxMs, Math.max(MOTION.landMinMs, Math.round(length / MARBLE.speed)));
    assert.equal(result.durationMs, expected, id);
  }
});

test('valid: a launch rolls along the feeder track and a return along the rail under the boxes', () => {
  const g = boardGeometry(boardWith(2), WIDTH);
  const entry = g.groups[0].lanes[0];
  const hopper = { x: g.hopper.x + 20, y: g.hopper.y + 20 };
  const place = { x: entry.x + 28, y: 150 };
  const launch = marble.plan({ kind: 'launch', jobId: 'x', lane: entry, box: null, from: hopper, to: place, geometry: g });
  assert.ok(launch.points.some(point => point.y === g.hopper.y - MARBLE.feederRise), 'it rolls along the feeder above the hopper');
  assert.deepEqual([launch.points[0], launch.points.at(-1)], [hopper, place]);
  const box = g.boxes[3];
  const back = marble.plan({ kind: 'return', jobId: 'x', lane: null, box, from: { x: box.x + 20, y: box.y + 60 }, to: hopper, geometry: g });
  assert.ok(back.points.some(point => point.y === g.height - MARBLE.returnRise), 'it rolls along the return rail below the boxes');
  assert.equal(back.durationMs, MOTION.returnMs);
  assert.deepEqual(back.points.at(-1), hopper);
});

test('boundary: nine boxes give nine gates; one box gives one gate and a path that still ends in it', () => {
  const svg = (tag, attributes = {}, ...children) => ({ tag, attributes, children });
  assert.equal(marble.draw(geometry, svg).nodes.filter(node => node.attributes.class === 'marble-gate').length, 9);
  const one = { ...geometry, boxes: [geometry.boxes[4]] };
  assert.equal(marble.draw(one, svg).nodes.filter(node => node.attributes.class === 'marble-gate').length, 1);
  const g = boardGeometry(boardWith(1), WIDTH);
  const result = marble.plan(landInput({ ...g, boxes: [g.boxes[4]] }, g.groups[0].lanes[0], g.boxes[4], 'x'));
  assert.equal(result.points.at(-2).x, gateX(g.boxes[4]));
});

test('invalid: an unknown box name lands in Done, and the path ends there through the Done gate', () => {
  const warnings = [];
  const travels = planChange(runningBoth, landedBoth('plaid'), { width: WIDTH, now: Date.now(), style: marble }, line => warnings.push(line)).travels.filter(t => t.kind === 'land');
  const travel = travels.find(candidate => candidate.target.id === 'aaaa1307');
  assert.ok(warnings.length >= 1 && warnings.every(line => line.includes("plaid")));
  assert.equal(travel.points.at(-2).x, gateX(boxOf('done')));
});

test('boundary: a board too narrow for a slope draws its tracks level, and the rules still pass', () => {
  const narrow = boardGeometry(boardWith(2), WIDTH);
  const squeezed = { ...narrow, pegs: { ...narrow.pegs, w: MARBLE.minSpan / 2 } };
  for (const track of marbleLayout(squeezed).tracks) assert.equal(track.from.y, track.to.y);
  const entry = squeezed.groups[0].lanes[0];
  for (const box of squeezed.boxes) {
    const result = marble.plan(landInput(squeezed, entry, box, '6ff7be3f'));
    assert.ok(result.points.every(point => point.x >= 0 && point.x <= squeezed.width && point.y >= 0 && point.y <= squeezed.height));
    assert.ok(result.durationMs >= MOTION.landMinMs && result.durationMs <= MOTION.landMaxMs);
    assert.equal(result.points.at(-2).x, gateX(box));
  }
});

test('valid: a wide board slopes its tracks', () => {
  for (const track of marbleLayout(geometry).tracks) assert.ok(track.to.y > track.from.y);
});

test('valid: the common code plays the gate effects on the same clock as the ball, and no travel means no effect', () => {
  const calls = [];
  const element = name => ({ animate(frames, options) { const animation = { currentTime: null }; calls.push({ name, frames, options, animation }); return animation; },
    querySelector: () => null });
  const ball = element('ball');
  const gate = element('gate');
  const root = { querySelector: selector => (selector.startsWith('.board-svg [data-ball') ? ball : selector.includes('data-gate') ? gate : null) };
  globalThis.CSS = { escape: text => text };
  const travels = new Travels({ now: () => 1000 });
  const data = landedBoth();
  const planned = lands(data).filter(travel => travel.target.id === '6ff7be3f');
  travels.begin(planned, data);
  travels.apply(root, data);
  const effects = calls.filter(call => call.name === 'gate');
  assert.equal(effects.length, 2);
  assert.equal(effects[0].options.duration, planned[0].durationMs);
  assert.equal(effects[0].animation.currentTime, 0);
  assert.ok(effects[0].frames.every(frame => frame.offset >= 0 && frame.offset <= 1));
  calls.length = 0;
  travels.stop();
  travels.apply(root, data);
  assert.equal(calls.length, 0);
});
