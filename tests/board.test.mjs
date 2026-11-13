// Issue #1310: the pure live board builder (supervisor/board.mjs). No server, no clock: the view and the time are given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, boxOf, BOXES, LANDED_LIMIT } from '../supervisor/board.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const MIN = 60000;
const H = 3600000;
const at = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m);
const config = { models: { agents: {
  claude: { implement: { model: 'sonnet' }, review: { model: 'opus' }, 'ci-fix': { model: 'sonnet' }, low: { model: 'sonnet' }, review_candidates: [{ model: 'opus' }] },
  codex: { implement: { effort: 'high' }, review: { effort: 'low' } },
} } };
const job = (id, o) => ({ id, fullId: id.repeat(4), agent: 'claude', kind: 'implement', ref: 1, status: 'completed', model: 'sonnet', tokens: 1000, cost: 0.4, startedAt: NOW - 3 * H, elapsedMs: H, ...o });
const baseView = (o = {}) => ({
  agents: [{ name: 'claude', jobs: [] }, { name: 'codex', jobs: [] }], budget: {}, budgetLimits: {}, jobs: [], olderJobs: [], prs: [], issues: [], verdicts: [],
  panels: { needsYou: [], next: [] }, planned: null, estimates: { stats: {} }, display: { gbpPerUsd: 0.75 }, ...o,
});
const board = (view, cfg = config) => buildBoard(view, NOW, cfg);
const landedOf = (view, id) => board(view).landed.find(l => l.job_id === id);

test('issue 1307: a completed implement by claude on sonnet that opened PR 1308 is to_review with 0 laps in lane claude/sonnet', () => {
  const view = baseView({ jobs: [job('a1', { ref: 1307, startedAt: at(13, 8), elapsedMs: 30 * MIN })], prs: [{ number: 1308, issue: 1307, status: 'open', title: 'Outcomes read model' }], issues: [{ number: 1307, title: 'Outcomemodel' }] });
  const l = landedOf(view, 'a1');
  assert.deepEqual([l.lane_id, l.box, l.laps, l.number, l.title, l.job_type], ['claude/sonnet', 'to_review', 0, 1307, 'Outcomemodel', 'implement']);
  assert.equal(l.ended_at, '2026-11-13T08:30:00.000Z');
  assert.equal(l.tokens, 1000);
  assert.equal(l.cost_pence, 30);   // 0.4 USD x 0.75 GBP per USD = 30 pence
});

const review = (id, start, o) => job(id, { kind: 'review', ref: 1244, model: 'opus', startedAt: start, elapsedMs: 10 * MIN, ...o });
const changes = baseView({
  jobs: [review('6ff7be3f', at(13, 8, 30)), review('e1', at(13, 4, 40))],
  verdicts: [{ pr: 1244, verdict: 'CHANGES', at: at(13, 8, 45) }, { pr: 1244, verdict: 'CHANGES', at: at(13, 4, 55) }],
  prs: [{ number: 1244, issue: 1224, status: 'open', title: 'PR 1244' }],
});

test('PR 1244: review 6ff7be3f on claude/opus with CHANGES is changes_asked and has at least 1 lap; named in Needs you it is needs_you', () => {
  const l = landedOf(changes, '6ff7be3f');
  assert.deepEqual([l.lane_id, l.box], ['claude/opus', 'changes_asked']);
  assert.ok(l.laps >= 1);
  const named = { ...changes, panels: { needsYou: [{ ref: { kind: 'pull', n: 1244 } }], next: [] } };
  const n = landedOf(named, '6ff7be3f');
  assert.equal(n.box, 'needs_you');
  assert.ok(n.laps >= 1, 'the lap count ignores the Needs you list');
});

test('each review takes its own verdict: the first one after its start and before the next review job starts', () => {
  const l = board(changes).landed;
  assert.equal(l.find(x => x.job_id === 'e1').box, 'changes_asked');
  const noVerdict = baseView({ jobs: [review('x1', at(13, 4, 40)), review('x2', at(13, 8, 30))], verdicts: [{ pr: 1244, verdict: 'PASS', at: at(13, 8, 45) }] });
  assert.equal(landedOf(noVerdict, 'x1').box, 'done');
  assert.equal(landedOf(noVerdict, 'x2').box, 'passed');
});

test('codex implement db849b9f paused for a usage limit: out_of_allowance, agent codex out until 14:09 UTC, lane codex with a null model', () => {
  const paused = job('db849b9f', { agent: 'codex', model: null, ref: 1166, status: 'paused_limit', startedAt: at(12, 12), elapsedMs: 2 * H });
  const view = baseView({ jobs: [paused], agents: [{ name: 'claude', jobs: [] }, { name: 'codex', jobs: [{ status: 'paused_limit' }], job: { status: 'paused_limit', resetAt: at(12, 14, 9) } }] });
  const b = board(view);
  assert.deepEqual([b.landed[0].box, b.landed[0].lane_id], ['out_of_allowance', 'codex/default']);
  const codex = b.agents.find(a => a.id === 'codex');
  assert.equal(codex.out_until, '2026-11-12T14:09:00.000Z');
  assert.match(codex.out_reason, /usage limit/);
  const lane = b.lanes.find(l => l.id === 'codex/default');
  assert.equal(lane.model, null);
  assert.ok(lane.job_types.includes('implement'));
});

test('out_until: null when the agent can take work; the allowance hold end when no job is paused; a paused job without a reset time says so', () => {
  const free = board(baseView()).agents;
  assert.deepEqual(free.map(a => [a.out_until, a.out_reason]), [[null, null], [null, null]]);
  const hold = board(baseView({ budget: { claude: { mode: 'waiting', until: NOW + H } } })).agents[0];
  assert.equal(hold.out_until, new Date(NOW + H).toISOString());
  assert.match(hold.out_reason, /allowance hold/);
  const past = board(baseView({ budget: { claude: { mode: 'waiting', until: NOW - H } } })).agents[0];
  assert.equal(past.out_until, null);
  const noReset = board(baseView({ agents: [{ name: 'claude', jobs: [{ status: 'paused_limit' }] }] })).agents[0];
  assert.equal(noReset.out_until, null);
  assert.match(noReset.out_reason, /not reported/);
});

test('agents carry the app bar shape: windows, condition and reading', () => {
  const a = board(baseView()).agents[0];
  assert.deepEqual(Object.keys(a), ['id', 'display_name', 'condition', 'weekly', 'short', 'reading', 'out_until', 'out_reason']);
  assert.equal(a.weekly.state, 'unknown');
  assert.equal(a.weekly.window_seconds, 7 * 24 * 3600);
  assert.equal(a.reading.stale, true);
});

test('an agent with an unknown allowance window stays listed with reason codes and no used fraction', () => {
  const view = baseView({ budget: { claude: { reading: { limits: [{ kind: 'session_5h', used: 0.5, resetsAt: NOW + H, expired: false }], ageMinutes: 1, maxAgeMinutes: 30, observedAt: NOW - MIN } } } });
  const a = board(view).agents[0];
  assert.equal(a.weekly.state, 'unknown');
  assert.equal(a.weekly.reason_code, 'not_reported');
  assert.equal(a.weekly.used_fraction, null);
  assert.equal(a.short.state, 'known');
});

test('lanes come from the configuration (every model an agent can use) and from jobs, including a model the configuration never names', () => {
  const view = baseView({ jobs: [job('z', { agent: 'claude', model: 'haiku', kind: 'rebase' })] });
  const ids = board(view).lanes.map(l => l.id);
  assert.deepEqual(ids, ['claude/sonnet', 'claude/opus', 'codex/default', 'claude/haiku']);
  const sonnet = board(view).lanes[0];
  assert.deepEqual(sonnet.job_types, ['cifix', 'implement']);
  assert.deepEqual(board(view).lanes[1].job_types, ['review']);
  assert.deepEqual(board(view).lanes[3].job_types, ['rebase']);
});

test('lanes without any configuration: each agent has one default lane', () => {
  assert.deepEqual(buildBoard(baseView(), NOW, null).lanes.map(l => [l.id, l.model]), [['claude/default', null], ['codex/default', null]]);
});

test('waiting: plan order with a place, the tie to the writer, the pinned issue and the held reason; a launched action is not waiting', () => {
  const view = baseView({
    panels: { needsYou: [], next: [
      { agent: 'claude', type: 'fix', ref: 7 }, { agent: null, type: 'review', ref: 8 }, { agent: 'codex', type: 'implement', ref: 9 }, { agent: 'claude', type: 'implement', ref: 10 }, { type: 'implement', ref: 11 },
    ] },
    planned: [{ type: 'review', agent: null, ref: 8, outcome: 'held', kind: 'slot', reason: 'slot full' }, { type: 'implement', agent: 'claude', ref: 10, outcome: 'launched' }],
    prs: [{ number: 7, title: 'Seven', status: 'open' }, { number: 8, title: 'Eight', status: 'open' }],
    issues: [{ number: 9, title: 'Nine', agent: 'codex' }, { number: 11, title: 'Eleven', agent: null }],
  });
  const w = board(view).waiting;
  assert.deepEqual(w.map(x => [x.place, x.number, x.title, x.job_type, x.tied_agent, x.held?.kind ?? null]), [
    [1, 7, 'Seven', 'fix', 'claude', null], [2, 8, 'Eight', 'review', null, 'slot'], [3, 9, 'Nine', 'implement', 'codex', null], [4, 11, 'Eleven', 'implement', null, null],
  ]);
  assert.equal(w[1].held.reason, 'slot full');
});

test('running: typical_seconds is the median from the estimates, and null under the minimum samples or with no figure', () => {
  const view = baseView({
    jobs: [job('r1', { status: 'running', kind: 'implement', startedAt: NOW - 5 * MIN, elapsedMs: 5 * MIN }), job('r2', { status: 'running', kind: 'review', ref: 3, model: 'opus', startedAt: NOW - 2 * MIN }), job('r3', { status: 'running', kind: 'rebase', ref: 4, startedAt: NOW - MIN })],
    estimates: { stats: { implement: { n: 5, p50: 1800000, p90: 3000000 }, review: { n: 4, p50: 600000, p90: 700000 } } },
  });
  const r = board(view).running;
  assert.deepEqual(r.map(x => [x.job_id, x.lane_id, x.typical_seconds]), [['r1', 'claude/sonnet', 1800], ['r2', 'claude/opus', null], ['r3', 'claude/sonnet', null]]);
  assert.equal(r[0].started_at, new Date(NOW - 5 * MIN).toISOString());
  assert.equal(board(view).landed.length, 0, 'a running job has not landed');
});

test('landed: a job ending exactly 24 hours ago is kept, one a millisecond earlier is not; no jobs gives empty lists', () => {
  const edge = job('edge', { startedAt: NOW - 25 * H, elapsedMs: H });
  const out = job('out', { startedAt: NOW - 25 * H, elapsedMs: H - 1 });
  assert.deepEqual(board(baseView({ jobs: [edge, out] })).landed.map(l => l.job_id), ['edge']);
  const empty = board(baseView());
  assert.deepEqual([empty.running, empty.landed, empty.waiting, empty.truncated, empty.skipped_jobs], [[], [], [], false, 0]);
  assert.deepEqual(Object.values(empty.counts), BOXES.map(() => 0));
});

test('landed: unknown cost and tokens are null, never 0', () => {
  const l = landedOf(baseView({ jobs: [job('n', { cost: null, tokens: null })] }), 'n');
  assert.deepEqual([l.tokens, l.cost_pence], [null, null]);
});

test('a job with an unknown status is ignored and counted in skipped_jobs, not an error', () => {
  const b = board(baseView({ jobs: [job('u', { status: 'weird' }), job('q', { status: 'queued' }), job('ok')] }));
  assert.deepEqual([b.landed.map(l => l.job_id), b.skipped_jobs], [['ok'], 1]);
});

test('every row of the box table is reached, in the stated order', () => {
  const j = (kind, status) => ({ row: { kind, status }, item: 'pr-1' });
  const ctx = (o = {}) => ({ verdict: null, merged: false, named: null, ...o });
  assert.equal(boxOf(j('review', 'completed'), ctx({ verdict: 'PASS', merged: true, named: new Set(['pr-1']) })), 'merged');
  assert.equal(boxOf(j('review', 'completed'), ctx({ verdict: 'PASS', named: new Set(['pr-1']) })), 'needs_you');
  assert.equal(boxOf(j('review', 'completed'), ctx({ verdict: 'PASS' })), 'passed');
  assert.equal(boxOf(j('review', 'completed'), ctx({ verdict: 'CHANGES' })), 'changes_asked');
  assert.equal(boxOf(j('review', 'paused_limit'), ctx()), 'out_of_allowance');
  assert.equal(boxOf(j('fix', 'failed'), ctx()), 'failed');
  assert.equal(boxOf(j('fix', 'blocked'), ctx()), 'failed');
  assert.equal(boxOf(j('fix', 'stopped'), ctx()), 'stopped');
  assert.equal(boxOf(j('fix', 'paused_manual'), ctx()), 'stopped');
  for (const kind of ['implement', 'continue', 'fix', 'cifix', 'rebase', 'split']) assert.equal(boxOf(j(kind, 'completed'), ctx()), 'to_review', kind);
  assert.equal(boxOf(j('inbox', 'completed'), ctx()), 'done');
  assert.equal(boxOf(j('review', 'completed'), ctx()), 'done');
  // order: a failed job named in Needs you is needs_you, a CHANGES review that was paused is changes_asked
  assert.equal(boxOf(j('fix', 'failed'), ctx({ named: new Set(['pr-1']) })), 'needs_you');
  assert.equal(boxOf(j('review', 'paused_limit'), ctx({ verdict: 'CHANGES' })), 'changes_asked');
});

test('merged: a PASS review whose pull request has since merged lands in merged, and in the counts', () => {
  const view = baseView({ jobs: [review('m', at(13, 9))], verdicts: [{ pr: 1244, verdict: 'PASS', at: at(13, 9, 5) }], prs: [{ number: 1244, status: 'merged' }] });
  const b = board(view);
  assert.equal(b.landed[0].box, 'merged');
  assert.equal(b.counts.merged, 1);
});

test('laps: earlier jobs of the same pull request in the last 7 days whose box was changes_asked, failed or out_of_allowance', () => {
  const day = 24 * H;
  const view = baseView({
    prs: [{ number: 50, issue: 5, status: 'open' }],
    jobs: [
      job('last', { kind: 'fix', ref: 50, startedAt: NOW - 2 * H }),
      job('f1', { kind: 'fix', ref: 50, status: 'failed', startedAt: NOW - 5 * H }),
      job('old', { kind: 'fix', ref: 50, status: 'failed', startedAt: NOW - 8 * day }),
      job('ok', { kind: 'fix', ref: 50, startedAt: NOW - 6 * H }),
      job('imp', { kind: 'implement', ref: 5, status: 'paused_limit', startedAt: NOW - 3 * day }),
      job('other', { kind: 'fix', ref: 51, status: 'failed', startedAt: NOW - 4 * H }),
    ],
    olderJobs: [],
  });
  assert.equal(landedOf(view, 'last').laps, 2);   // f1 failed and imp (issue 5 = PR 50) was out of allowance; old, ok and other do not count
  assert.equal(landedOf(view, 'f1').laps, 1);
});

test('landed is newest first, keeps 300 and counts every qualifying job; 301 sets truncated', () => {
  const many = n => Array.from({ length: n }, (_, i) => job(`j${String(i).padStart(4, '0')}`, { ref: 100 + i, startedAt: NOW - 20 * H + i * MIN, elapsedMs: MIN, status: i % 2 ? 'failed' : 'completed' }));
  const exact = board(baseView({ jobs: many(LANDED_LIMIT) }));
  assert.deepEqual([exact.landed.length, exact.truncated], [LANDED_LIMIT, false]);
  const over = board(baseView({ jobs: many(LANDED_LIMIT + 1) }));
  assert.deepEqual([over.landed.length, over.truncated], [LANDED_LIMIT, true]);
  assert.equal(Object.values(over.counts).reduce((a, b) => a + b, 0), LANDED_LIMIT + 1);
  assert.equal(over.landed[0].job_id, `j${String(LANDED_LIMIT).padStart(4, '0')}`);
  assert.ok(!over.landed.some(l => l.job_id === 'j0000'), 'the oldest one is the one dropped');
});

test('the builder does not read a clock or change its input', () => {
  const view = baseView({ jobs: [job('p')] });
  const before = JSON.stringify(view);
  const a = board(view);
  assert.equal(JSON.stringify(view), before);
  assert.deepEqual(board(view), a);
});

test('waiting: a continue action (next list keyed by the issue, plan ledger by the pull request) is held, and gone once launched', () => {
  const next = { panels: { needsYou: [], next: [{ agent: 'claude', type: 'continue', ref: 50 }] }, prs: [{ number: 51, issue: 50, status: 'open', title: 'PR 51' }], issues: [{ number: 50, title: 'Fifty' }] };
  const held = board(baseView({ ...next, planned: [{ type: 'continue', agent: 'claude', ref: 51, outcome: 'held', kind: 'slot', reason: 'slot full' }] })).waiting;
  assert.deepEqual(held.map(x => [x.place, x.number, x.job_type, x.held?.kind]), [[1, 50, 'continue', 'slot']]);
  assert.equal(board(baseView({ ...next, planned: [{ type: 'continue', agent: 'claude', ref: 51, outcome: 'launched' }] })).waiting.length, 0);
});

test('verdict recorded on the review job survives a later review of the same head replacing the head record', () => {
  const view = baseView({
    jobs: [review('r1', at(13, 4), { verdict: 'CHANGES' }), review('r2', at(13, 6), { verdict: 'PASS' }), review('r3', at(13, 8))],
    verdicts: [{ pr: 1244, verdict: 'PASS', at: at(13, 6, 5) }], prs: [{ number: 1244, issue: 1224, status: 'open', title: 'PR 1244' }],
  });
  assert.deepEqual(['r1', 'r2'].map(id => landedOf(view, id).box), ['changes_asked', 'passed']);
  assert.equal(landedOf(view, 'r3').laps, 1, 'the CHANGES review of the same pull request is one lap');
  assert.equal(board(view).counts.changes_asked, 1);
});
