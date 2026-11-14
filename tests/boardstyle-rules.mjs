// Issue #1315: the path rules every board style must meet, for every lane and box pair. A style test calls checkStyleRules(style) and the
// rules are stated once here, so a style added later (Marble run, Launch pad) is held to the same ones.
import assert from 'node:assert/strict';
import { LAYOUT, boardGeometry } from '../supervisor/ui/boardlayout.mjs';
import { MOTION } from '../supervisor/ui/boardtiming.mjs';

const agent = id => ({ id, display_name: id, condition: { state: 'idle' }, weekly: null, short: null, reading: null, out_until: null, out_reason: null });
const lanesFor = count => Array.from({ length: count }, (_, index) => ({ id: `claude/model${index}`, agent: 'claude', model: `model${index}`, job_types: ['implement'] }));

export const boardWith = laneCount => ({ agents: [agent('claude')], lanes: lanesFor(laneCount), waiting: [], running: [], landed: [],
  counts: {}, truncated: false, skipped_jobs: 0 });

export const JOB_IDS = ['6ff7be3f', 'aaaa1307', 'db849b9f', 'x', '', 'ffffffff', '00000000'];
const WIDTH = 1280;
const onBoard = (point, geometry) => point.x >= 0 && point.x <= geometry.width && point.y >= 0 && point.y <= geometry.height;
const inBox = (point, box) => point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;

// The input of a land the way the common code builds it: from the foot of the lane to a place inside the box.
export function landInput(geometry, lane, box, jobId) {
  return { kind: 'land', jobId, lane, box, from: { x: lane.x + lane.w / 2, y: LAYOUT.laneTop + LAYOUT.ballRadius },
    to: { x: box.x + 20, y: box.y + 60 }, geometry };
}

// Runs the rules; `names` is what the failure message says about the style under test.
export function checkStyleRules(style, laneCounts = [1, 2, 6]) {
  for (const count of laneCounts) {
    const geometry = boardGeometry(boardWith(count), WIDTH);
    const lanes = geometry.groups.flatMap(group => group.lanes);
    assert.equal(lanes.length, count);
    for (const lane of lanes) {
      for (const box of geometry.boxes) {
        for (const jobId of JOB_IDS) {
          const where = `${style.name} ${count} lanes, ${lane.lane.id}, ${box.id}, job ${jobId || '(empty)'}`;
          const first = style.plan(landInput(geometry, lane, box, jobId));
          assert.deepEqual(style.plan(landInput(geometry, lane, box, jobId)), first, `the same job gets the same path: ${where}`);
          assert.ok(first.points.every(point => onBoard(point, geometry)), `the path stays on the board: ${where}`);
          assert.ok(inBox(first.points.at(-1), box), `a land ends inside its box: ${where}`);
          assert.ok(first.durationMs >= MOTION.landMinMs && first.durationMs <= MOTION.landMaxMs, `a land lasts 1.5 to 3 seconds: ${where}, ${first.durationMs}`);
        }
      }
    }
  }
}

// The same plans with the random numbers and the clock made to throw: a style reads neither.
export function checkStyleReadsNoRandomOrClock(style) {
  const geometry = boardGeometry(boardWith(2), WIDTH);
  const lane = geometry.groups[0].lanes[0];
  const box = geometry.boxes[0];
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => { throw new Error('random numbers read'); };
  Date.now = () => { throw new Error('clock read'); };
  try {
    for (const kind of ['launch', 'land', 'return']) style.plan({ ...landInput(geometry, lane, box, '6ff7be3f'), kind });
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
}

// launch and return paths stay on the board and last a positive time.
export function checkOtherKinds(style) {
  const geometry = boardGeometry(boardWith(2), WIDTH);
  const lane = geometry.groups[0].lanes[0];
  for (const box of geometry.boxes) {
    for (const kind of ['launch', 'return']) {
      const plan = style.plan({ ...landInput(geometry, lane, box, '6ff7be3f'), kind, from: { x: box.x + 20, y: box.y + 40 }, to: { x: geometry.hopper.x + 20, y: geometry.hopper.y + 20 } });
      assert.ok(plan.points.length >= 2 && plan.points.every(point => onBoard(point, geometry)), `${kind} stays on the board`);
      assert.ok(plan.durationMs > 0, `${kind} lasts a time`);
    }
  }
}
