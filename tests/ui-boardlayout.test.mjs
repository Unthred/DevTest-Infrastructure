// Issue #1312: the pure module of the live board screen: the layout table, the places of balls in the hopper, the lanes and the boxes, the ride height.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT, BOXES, boardGeometry, hopperBalls, boxBalls, runningBalls, rideHeight, boxOf, groupLanes, allowanceView, isOut, ballDetail, ballName, pounds, inboxLink, jobClass }
  from '../supervisor/ui/boardlayout.mjs';
import { dateTime } from '../supervisor/ui/format.mjs';

const window = (used, resets = '2026-11-19T04:00:00Z') => ({ state: 'known', used_fraction: used, level: 'normal', resets_at: resets, window_seconds: 604800, reason_code: null, reason_text: null });
const unknown = { state: 'unknown', used_fraction: null, level: null, resets_at: null, window_seconds: 18000, reason_code: 'no_reading', reason_text: 'no reading' };
const agent = (id, extra = {}) => ({ id, display_name: id, condition: { state: 'idle' }, weekly: window(0.2), short: window(0.1), reading: { read_at: null, age_seconds: 60, stale: false, max_age_seconds: 3600 },
  out_until: null, out_reason: null, ...extra });
const lane = (agentId, model) => ({ id: `${agentId}/${model ?? 'default'}`, agent: agentId, model, job_types: ['implement'] });
const NOW = Date.parse('2026-11-13T12:00:00Z');
const base = () => ({ agents: [agent('claude'), agent('codex', { out_until: '2026-11-12T14:09:00Z', out_reason: 'usage limit' })],
  lanes: [lane('claude', 'sonnet'), lane('claude', 'opus'), lane('codex', 'gpt')], waiting: [], running: [], landed: [], counts: {}, truncated: false, skipped_jobs: 0 });
const implement1307 = { job_id: 'aaaa1307', lane_id: 'claude/sonnet', job_type: 'implement', number: 1307, title: 'Outcomes read model', laps: 0, ended_at: '2026-11-13T09:00:00Z', box: 'to_review', tokens: 1000, cost_pence: 30 };
const review1244 = { job_id: '6ff7be3f', lane_id: 'claude/opus', job_type: 'review', number: 1244, title: 'Review of 1244', laps: 1, ended_at: '2026-11-13T08:45:00Z', box: 'changes_asked', tokens: 5000, cost_pence: 125 };

test('the layout is one frozen table and the geometry reads only from it', () => {
  assert.ok(Object.isFrozen(LAYOUT));
  const g = boardGeometry(base(), 1280);
  assert.equal(g.drawn, true);
  assert.equal(g.groups[0].lanes[0].x, LAYOUT.leftPad);
  assert.equal(g.groups[0].lanes[1].x, LAYOUT.leftPad + LAYOUT.laneWidth + LAYOUT.laneGap);
  assert.ok(g.hopper.y > LAYOUT.laneBottom, 'the hopper is at the foot of the lanes');
  assert.ok(g.boxes.every(box => box.y > g.hopper.y), 'the boxes run along the bottom');
  assert.ok(g.pegs.x > g.hopper.x + g.hopper.w - 1, 'the peg board is to the right of the lanes');
  assert.deepEqual(g.boxes.map(box => box.id), BOXES.map(box => box.id));
});

test('lanes are grouped under their agent in the order the model serves, whatever their number', () => {
  const groups = groupLanes(base());
  assert.deepEqual(groups.map(group => [group.agent.id, group.lanes.map(l => l.model)]), [['claude', ['sonnet', 'opus']], ['codex', ['gpt']]]);
  const none = { ...base(), lanes: [] };
  assert.equal(boardGeometry(none, 1280).groups.every(group => group.lanes.length === 0), true, 'no lanes: only allowance groups remain');
  const one = { ...base(), agents: [agent('claude')], lanes: [lane('claude', 'sonnet')] };
  assert.equal(boardGeometry(one, 1280).groups.length, 1);
  const six = { ...base(), lanes: ['a', 'b', 'c', 'd', 'e', 'f'].map(model => lane('claude', model)) };
  const g6 = boardGeometry(six, 1280);
  assert.equal(g6.groups[0].lanes.length, 6);
  assert.ok(g6.width >= g6.groups[0].lanes[5].x + LAYOUT.laneWidth);
  const stranger = { ...base(), lanes: [...base().lanes, lane('newbie', 'x')] };
  assert.equal(groupLanes(stranger).at(-1).agent.display_name, 'newbie');
});

test('a board width of 0, a missing width or a phone width is not drawn', () => {
  for (const width of [0, NaN, undefined, null, -5, 390, 639]) assert.deepEqual(boardGeometry(base(), width), { drawn: false }, String(width));
  assert.equal(boardGeometry(base(), 640).drawn, true);
});

test('the hopper holds the waiting entries in plan order, the next one first, and reports what does not fit', () => {
  const g = boardGeometry(base(), 1280);
  const waiting = [3, 1, 2].map(place => ({ place, number: 100 + place, title: null, job_type: 'implement', tied_agent: null, held: null }));
  const { placed, hidden } = hopperBalls(waiting, g);
  assert.deepEqual(placed.map(p => p.item.place), [1, 2, 3]);
  assert.equal(hidden, 0);
  assert.ok(placed[0].y <= placed[2].y && placed[0].x < placed[1].x);
  const many = Array.from({ length: 100 }, (_, index) => ({ place: index + 1, number: index + 1, title: null, job_type: 'review', tied_agent: null, held: null }));
  const big = hopperBalls(many, g);
  assert.equal(big.placed.length + big.hidden, 100);
  assert.ok(big.hidden > 0);
  assert.ok(big.placed.every(p => p.x < g.hopper.x + g.hopper.w && p.y < g.hopper.y + g.hopper.h));
});

test('real example: the implement job on issue 1307 lands in To review and the review of PR 1244 in Changes asked with its lap', () => {
  const g = boardGeometry(base(), 1280);
  const boxes = boxBalls([implement1307, review1244], g);
  const placedIn = id => boxes.find(entry => entry.box.id === id).placed.map(p => p.item.job_id);
  assert.deepEqual(placedIn('to_review'), ['aaaa1307']);
  assert.deepEqual(placedIn('changes_asked'), ['6ff7be3f']);
  const data = { ...base(), landed: [implement1307, review1244] };
  const rows = Object.fromEntries(ballDetail('landed', review1244, data, { dateTime }));
  assert.deepEqual([rows.Agent, rows.Model, rows.Box, rows.Laps, rows['Job type'], rows.Cost, rows.Tokens], ['claude', 'opus', 'Changes asked', '1', 'review', '£1.25', '5000']);
  assert.match(rows.Ended, /13 Nov/);
  assert.equal(ballName(review1244), '#1244 review, 1 lap');
  assert.equal(ballName(implement1307), '#1307 implement');
  const lane1307 = ballDetail('landed', implement1307, data, { dateTime });
  assert.equal(lane1307.find(([k]) => k === 'Model')[1], 'sonnet');
});

test('an unknown box name goes to Done and a warning is logged', () => {
  const warnings = [];
  const g = boardGeometry(base(), 1280);
  const odd = { ...implement1307, job_id: 'odd', box: 'mystery' };
  const boxes = boxBalls([odd], g, message => warnings.push(message));
  assert.deepEqual(boxes.find(entry => entry.box.id === 'done').placed.map(p => p.item.job_id), ['odd']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mystery/);
  assert.equal(boxOf('merged', () => assert.fail('no warning for a known box')), 'merged');
});

test('real example: codex out until 14:09 UTC on 12 Nov is out and its group is marked, claude is not', () => {
  const data = base();
  assert.equal(isOut(data.agents[1]), true);
  assert.equal(isOut(data.agents[0]), false);
  assert.equal(dateTime(data.agents[1].out_until), 'Thu 12 Nov, 14:09');
});

test('ride height: elapsed against the typical time, capped below the top; no estimate sits mid height; long past the typical time', () => {
  const started = new Date(NOW - 60000).toISOString();
  assert.deepEqual([rideHeight(started, 120, NOW).noEstimate, rideHeight(started, 120, NOW).long], [false, false]);
  assert.ok(Math.abs(rideHeight(started, 120, NOW).fraction - 0.4) < 1e-9);
  const none = rideHeight(started, null, NOW);
  assert.deepEqual([none.fraction, none.noEstimate, none.long], [LAYOUT.noEstimateRide, true, false]);
  const long = rideHeight(new Date(NOW - 1200000).toISOString(), 120, NOW);
  assert.equal(long.long, true);
  assert.ok(long.fraction <= LAYOUT.rideCap && long.fraction < 1, 'ten times the typical time is still below the lane top');
  assert.equal(rideHeight(new Date(NOW + 5000).toISOString(), 120, NOW).fraction, 0, 'a start in the future is not negative');
  assert.equal(rideHeight('not a time', 120, NOW).fraction, 0);
  assert.equal(rideHeight(started, 0, NOW).long, true, 'a zero typical time is long, not a division by zero');
});

test('a running ball sits in its lane at its height; a job whose lane is not drawn is left out', () => {
  const g = boardGeometry(base(), 1280);
  const job = { job_id: 'r1', lane_id: 'claude/opus', job_type: 'review', number: 5, title: 't', laps: 0, started_at: new Date(NOW - 60000).toISOString(), typical_seconds: 120 };
  const lost = { ...job, job_id: 'r2', lane_id: 'ghost/none' };
  const balls = runningBalls([job, lost], g, NOW);
  assert.equal(balls.length, 1);
  const laneX = g.groups[0].lanes[1].x + LAYOUT.laneWidth / 2;
  assert.equal(balls[0].x, laneX);
  assert.ok(balls[0].y > LAYOUT.laneTop && balls[0].y < LAYOUT.laneBottom);
  const late = runningBalls([{ ...job, started_at: new Date(NOW - 1200000).toISOString() }], g, NOW)[0];
  assert.ok(late.y > LAYOUT.laneTop, 'below the lane top');
  assert.ok(late.y < balls[0].y, 'higher than the early one');
});

test('allowance: the fraction left, and unknown is never empty or full', () => {
  assert.deepEqual(allowanceView(window(0.14)), { known: true, left: 0.86 });
  assert.deepEqual(allowanceView(unknown), { known: false, left: null });
  assert.deepEqual(allowanceView(null), { known: false, left: null });
  assert.equal(allowanceView(window(1)).left, 0);
});

test('money is in pounds, a type has a class, the Inbox link searches the number', () => {
  assert.equal(pounds(30), '£0.30');
  assert.equal(pounds(0), '£0.00');
  assert.equal(pounds(null), 'unknown');
  assert.equal(jobClass('implement'), 'job-implement');
  assert.equal(jobClass('something new'), 'job-other');
  assert.equal(inboxLink(1244), '/inbox?state=all&search=1244');
  assert.equal(inboxLink(null), '/inbox?state=all');
});

test('a held waiting ball shows its hold reason in the detail rows', () => {
  const waiting = { place: 2, number: 9, title: 'Nine', job_type: 'implement', tied_agent: 'claude', held: { kind: 'file_overlap', reason: 'overlaps 8' } };
  const rows = ballDetail('waiting', waiting, base(), { dateTime });
  assert.deepEqual(rows.at(-1), ['Held', 'file_overlap: overlaps 8']);
  assert.equal(rows.find(([k]) => k === 'Agent')[1], 'claude');
});
