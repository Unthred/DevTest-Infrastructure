// Issue #1313: the pure module of ball travel: the comparison of two liveboard replies and the planned paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOTION, PEG, diffBoard, splitEvents, planLand, planChange, pegPoints, hashOf, offsetsOf, carryLaps, withLaps, targetKey }
  from '../supervisor/ui/boardmotion.mjs';
import { LAYOUT, boardGeometry } from '../supervisor/ui/boardlayout.mjs';

const lane = (agent, model) => ({ id: `${agent}/${model}`, agent, model, job_types: ['implement'] });
const agent = id => ({ id, display_name: id, condition: { state: 'idle' }, weekly: null, short: null, reading: null, out_until: null, out_reason: null });
const board = (parts = {}) => ({ agents: [agent('claude')], lanes: [lane('claude', 'sonnet'), lane('claude', 'opus')], waiting: [], running: [], landed: [],
  counts: {}, truncated: false, skipped_jobs: 0, ...parts });
const waiting = (place, number, type = 'implement') => ({ place, number, title: `Item ${number}`, job_type: type, tied_agent: null, held: null });
const running = (id, laneId, number, type = 'implement', laps = 0) => ({ job_id: id, lane_id: laneId, job_type: type, number, title: null, laps, started_at: '2026-11-13T08:00:00Z', typical_seconds: 300 });
const landed = (id, laneId, number, box, type = 'implement', laps = 0) => ({ job_id: id, lane_id: laneId, job_type: type, number, title: null, laps, ended_at: '2026-11-13T08:45:00Z', box, tokens: 1, cost_pence: 1 });
const quiet = () => {};
const WIDTH = 1280;

// Issue 1307, implement job by claude on sonnet, in three replies.
const first1307 = board({ waiting: [waiting(1, 1307)], landed: [landed('old00001', 'claude/opus', 1200, 'merged', 'review')] });
const second1307 = board({ running: [running('aaaa1307', 'claude/sonnet', 1307)], landed: first1307.landed });
const third1307 = board({ landed: [landed('aaaa1307', 'claude/sonnet', 1307, 'to_review'), ...first1307.landed] });
// Pull request 1244, review job 6ff7be3f by claude on opus, verdict CHANGES at 08:45 UTC on 13 Nov 2026.
const running1244 = board({ running: [running('6ff7be3f', 'claude/opus', 1244, 'review', 1)], landed: first1307.landed });
const changes1244 = board({ landed: [landed('6ff7be3f', 'claude/opus', 1244, 'changes_asked', 'review', 1), ...first1307.landed] });
const again1244 = board({ waiting: [waiting(1, 1244, 'review')], landed: changes1244.landed });

test('boundary: a newer landing in To review hides an older Changes asked landing, so waiting again gives no return', () => {
  const older = landed('r1', 'claude/opus', 1244, 'changes_asked', 'review', 1);
  const newer = { ...landed('f1', 'claude/sonnet', 1244, 'to_review', 'implement'), ended_at: '2026-11-13T09:30:00Z' };
  const before = board({ landed: [newer, older] });
  const after = board({ waiting: [waiting(1, 1244, 'review')], landed: before.landed });
  assert.deepEqual(diffBoard(before, after), []);
});

test('valid: issue 1307 waiting then running gives one launch to the claude sonnet lane', () => {
  const events = diffBoard(first1307, second1307);
  assert.deepEqual(events, [{ type: 'launch', job_id: 'aaaa1307', lane_id: 'claude/sonnet', job_type: 'implement', number: 1307 }]);
});

test('valid: issue 1307 running then landed in To review gives one land whose path ends in To review', () => {
  const events = diffBoard(second1307, third1307);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].type, events[0].box, events[0].from], ['land', 'to_review', 'lane_top']);
  const { travels } = planChange(second1307, third1307, { width: WIDTH, now: Date.parse('2026-11-13T08:10:00Z') });
  const geometry = boardGeometry(third1307, WIDTH);
  const box = geometry.boxes.find(candidate => candidate.id === 'to_review');
  const end = travels[0].points.at(-1);
  assert.ok(end.x >= box.x && end.x <= box.x + box.w && end.y >= box.y && end.y <= box.y + box.h, 'the last point is inside To review');
});

test('valid: pull request 1244 lands in Changes asked, then waiting again gives one return from laps 1 to 2', () => {
  const land = diffBoard(running1244, changes1244);
  assert.deepEqual(land.map(event => [event.type, event.box]), [['land', 'changes_asked']]);
  const back = diffBoard(changes1244, again1244);
  assert.deepEqual(back, [{ type: 'return', job_id: '6ff7be3f', number: 1244, job_type: 'review', box: 'changes_asked', laps_from: 1, laps_to: 2 }]);
  const carry = carryLaps(new Map(), back, again1244);
  assert.equal(withLaps(again1244, carry).waiting[0].laps, 2, 'the waiting ball shows one more lap');
  assert.equal(carryLaps(carry, [], board()).size, 0, 'the figure is forgotten once the item is no longer waiting');
  const { travels } = planChange(changes1244, again1244, { width: WIDTH, now: 0 });
  assert.deepEqual(travels.map(travel => [travel.kind, travel.laps]), [['return', { from: 1, to: 2 }]]);
  const floor = boardGeometry(again1244, WIDTH).height - LAYOUT.bottomPad - LAYOUT.ballRadius;
  assert.ok(travels[0].points.some(point => point.y === floor), 'the ball rolls along the bottom');
});

test('boundary: equal replies give no events and no travel', () => {
  assert.deepEqual(diffBoard(second1307, structuredClone(second1307)), []);
  assert.deepEqual(planChange(second1307, structuredClone(second1307), { width: WIDTH, now: 0 }).travels, []);
});

test('boundary: an empty first reply (the open case) gives no events', () => {
  assert.deepEqual(diffBoard(board(), second1307), []);
  assert.deepEqual(diffBoard(null, second1307), []);
});

test('boundary: 13 events in one change are shown at once with a count, 12 still travel', () => {
  const jobs = count => Array.from({ length: count }, (_, index) => running(`job${String(index).padStart(5, '0')}`, 'claude/sonnet', 2000 + index));
  const next = count => board({ running: jobs(count), landed: first1307.landed });
  assert.equal(diffBoard(first1307, next(13)).length, 13);
  assert.deepEqual(splitEvents(diffBoard(first1307, next(13))).animate, []);
  assert.equal(splitEvents(diffBoard(first1307, next(13))).changed, 13);
  const plan = planChange(first1307, next(13), { width: WIDTH, now: 0 });
  assert.deepEqual([plan.travels.length, plan.changed], [0, 13]);
  const twelve = planChange(first1307, next(12), { width: WIDTH, now: 0 });
  assert.deepEqual([twelve.travels.length, twelve.changed], [12, 0]);
  assert.equal(MOTION.maxEvents, 12);
});

test('boundary: waiting then landed with no running reply between gives one land from the lane foot and no launch', () => {
  const events = diffBoard(first1307, third1307);
  assert.deepEqual(events.map(event => [event.type, event.from]), [['land', 'lane_foot']]);
  const { travels } = planChange(first1307, third1307, { width: WIDTH, now: 0 });
  assert.equal(travels.length, 1);
  assert.equal(travels[0].points[0].y, LAYOUT.laneBottom - LAYOUT.ballRadius);
});

test('invalid: an unknown box name lands in Done, and the path ends there', () => {
  const odd = board({ landed: [landed('aaaa1307', 'claude/sonnet', 1307, 'nonsense'), ...first1307.landed] });
  const warned = [];
  const events = diffBoard(second1307, odd, message => warned.push(message));
  assert.equal(events[0].box, 'done');
  assert.equal(warned.length, 1);
  const { travels } = planChange(second1307, odd, { width: WIDTH, now: 0 }, quiet);
  const done = boardGeometry(odd, WIDTH).boxes.find(candidate => candidate.id === 'done');
  const end = travels[0].points.at(-1);
  assert.ok(end.x >= done.x && end.x <= done.x + done.w && end.y >= done.y && end.y <= done.y + done.h);
});

test('invalid: a lane that is not drawn gives a land from the peg board, no error; a launch without a lane gives no travel', () => {
  const stray = board({ landed: [landed('zzzz0001', 'ghost/none', 9, 'passed'), ...first1307.landed] });
  const { travels } = planChange(first1307, stray, { width: WIDTH, now: 0 });
  assert.equal(travels.length, 1);
  const noLane = board({ running: [running('zzzz0002', 'ghost/none', 9)], landed: first1307.landed });
  assert.deepEqual(planChange(first1307, noLane, { width: WIDTH, now: 0 }).travels, []);
});

test('boundary: below 640 px nothing is planned, the lists only update in place', () => {
  assert.deepEqual(planChange(first1307, second1307, { width: 639, now: 0 }).travels, []);
  assert.deepEqual(planChange(first1307, second1307, { width: 0, now: 0 }).travels, []);
});

test('valid: a launch travels from its hopper place to the lane and the remaining hopper balls close up', () => {
  const before = board({ waiting: [waiting(1, 1307), waiting(2, 1313), waiting(3, 1244, 'review')] });
  const after = board({ running: [running('aaaa1307', 'claude/sonnet', 1307)], waiting: [waiting(1, 1313), waiting(2, 1244, 'review')] });
  const { travels } = planChange({ ...before, landed: first1307.landed }, { ...after, landed: first1307.landed }, { width: WIDTH, now: Date.parse('2026-11-13T08:00:00Z') });
  const launch = travels.find(travel => travel.kind === 'launch');
  const geometry = boardGeometry(after, WIDTH);
  const slot = launch.points[0];
  assert.ok(slot.x > geometry.hopper.x && slot.x < geometry.hopper.x + geometry.hopper.w && slot.y > geometry.hopper.y && slot.y < geometry.hopper.y + geometry.hopper.h);
  const laneEntry = geometry.groups[0].lanes[0];
  assert.ok(launch.points.at(-1).x === laneEntry.x + laneEntry.w / 2 && launch.points.at(-1).y < LAYOUT.laneBottom, 'it ends inside the lane');
  const close = travels.filter(travel => travel.kind === 'close');
  assert.deepEqual(close.map(travel => travel.target.ident), ['implement:1313', 'review:1244']);
  assert.ok(close.every(travel => travel.points[1].x < travel.points[0].x || travel.points[1].y < travel.points[0].y), 'each moves up one place');
});

const geometry = boardGeometry(board(), WIDTH);
const laneTop = { x: LAYOUT.leftPad + LAYOUT.laneWidth / 2, y: LAYOUT.laneTop + LAYOUT.ballRadius };
const planFor = (jobId, boxId = 'to_review') => {
  const box = geometry.boxes.find(candidate => candidate.id === boxId);
  return planLand({ jobId, start: laneTop, box, end: { x: box.x + 20, y: box.y + 60 }, geometry });
};

test('valid: the same job id planned twice gives identical paths, and a different id gives a different one', () => {
  assert.deepEqual(planFor('6ff7be3f'), planFor('6ff7be3f'));
  assert.notDeepEqual(planFor('6ff7be3f').points, planFor('aaaa1307').points);
});

test('valid: a path touches at least three pegs, stays on the board, ends in its box and lasts 1.5 to 3 seconds, for every box and many ids', () => {
  const pegs = pegPoints(geometry.pegs);
  const touchDistance = LAYOUT.ballRadius + PEG.radius;
  for (const box of geometry.boxes) {
    for (const jobId of ['6ff7be3f', 'aaaa1307', 'db849b9f', 'x', '', 'ffffffff', '00000000']) {
      const plan = planFor(jobId, box.id);
      assert.ok(plan.touches.length >= 3, `${jobId} touches ${plan.touches.length} pegs`);
      assert.equal(new Set(plan.touches.map(touch => `${touch.peg.x},${touch.peg.y}`)).size, plan.touches.length, 'each peg once');
      for (const { peg, at } of plan.touches) {
        assert.ok(pegs.some(candidate => candidate.x === peg.x && candidate.y === peg.y), 'a real peg of the drawing');
        assert.ok(Math.abs(Math.hypot(at.x - peg.x, at.y - peg.y) - touchDistance) < 0.001, 'the ball is tangent to the peg');
        assert.ok(plan.points.some(point => point.x === at.x && point.y === at.y), 'the contact is on the path');
      }
      assert.ok(plan.points.every(point => point.x >= 0 && point.x <= geometry.width && point.y >= 0 && point.y <= geometry.height), 'on the board');
      const end = plan.points.at(-1);
      assert.ok(end.x >= box.x && end.x <= box.x + box.w && end.y >= box.y && end.y <= box.y + box.h, `ends in ${box.id}`);
      assert.ok(plan.durationMs >= MOTION.landMinMs && plan.durationMs <= MOTION.landMaxMs, `duration ${plan.durationMs}`);
    }
  }
});

test('valid: a land is planned without random numbers or the clock', () => {
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => { throw new Error('random used'); };
  Date.now = () => { throw new Error('clock used'); };
  try {
    assert.equal(planFor('6ff7be3f').touches.length >= 3, true);
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
});

test('boundary: an end outside its box is moved inside it, and a tiny peg board still gives a path', () => {
  const box = geometry.boxes[0];
  const far = planLand({ jobId: 'a', start: laneTop, box, end: { x: 5000, y: -40 }, geometry });
  const end = far.points.at(-1);
  assert.ok(end.x <= box.x + box.w && end.y >= box.y);
  const tiny = { ...geometry, pegs: { x: 300, y: 36, w: 60, h: 70 } };
  const plan = planLand({ jobId: 'a', start: laneTop, box, end: { x: box.x + 10, y: box.y + 50 }, geometry: tiny });
  assert.ok(plan.touches.length >= 1 && plan.durationMs >= MOTION.landMinMs);
  const none = planLand({ jobId: 'a', start: laneTop, box, end: { x: box.x + 10, y: box.y + 50 }, geometry: { ...geometry, pegs: { x: 300, y: 36, w: 4, h: 4 } } });
  assert.equal(none.touches.length, 0);
});

test('valid: hashOf is stable, offsetsOf runs from 0 to 1, targetKey finds the ball a travel stands for', () => {
  assert.equal(hashOf('6ff7be3f'), hashOf('6ff7be3f'));
  assert.deepEqual(offsetsOf([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }]), [0, 1 / 3, 1]);
  assert.deepEqual(offsetsOf([{ x: 1, y: 1 }, { x: 1, y: 1 }]), [0, 1]);
  assert.equal(targetKey({ kind: 'running', id: 'aaaa1307' }, second1307), 'running:aaaa1307');
  assert.equal(targetKey({ kind: 'running', id: 'aaaa1307' }, third1307), null);
  assert.equal(targetKey({ kind: 'landed', id: 'aaaa1307' }, third1307), 'landed:aaaa1307');
  assert.equal(targetKey({ kind: 'waiting', ident: 'review:1244' }, again1244), 'waiting:1');
  assert.equal(targetKey({ kind: 'waiting', ident: 'review:1244' }, first1307), null);
});
