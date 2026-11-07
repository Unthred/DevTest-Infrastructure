// Issue #487: idle time by cause (waiting for the next tick, upgrade, tick run time, a named hold, no eligible work), a hold that
// applies to one agent only, the report command and the dashboard hold naming. Fixture figures are counted by hand in the comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOLD_KEY_CHARS, HOLD_REASON_CHARS, HOLD_TEXT_CHARS, holdCause, classifyIdle, idleBreakdown, idleReport, renderIdleReport } from '../supervisor/idlecause.mjs';
import { idleReason } from '../supervisor/dashboard.mjs';
import { recordTick, readSnapshots } from '../supervisor/dashdata.mjs';

const M = 60000, B = Date.UTC(2026, 10, 3, 6, 0, 0), at = m => B + m * M;
const agents = { claude: 'claude', codex: 'codex' };
const job = (provider, from, to, status = 'completed') => ({ id: `${provider}-${from}`.padEnd(32, '0'), provider, status, createdAt: at(from), updatedAt: at(to) });
const idle = (claude, codex) => ({ ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) });
const NO = { cause: 'no-eligible-work' }, HOLD = { cause: 'named-hold', hold: 'review slot full: PR #9' }, UP = { cause: 'upgrade' };

// Window 0..60 min. claude: job 0-10, job 30-40. codex: job 0-20.
const jobs = [job('claude', 0, 10), job('claude', 30, 40), job('codex', 0, 20)];
const snapshots = [
  { at: at(9), startedAt: at(8.9), idle: idle(null, null) },        // both running
  { at: at(12), startedAt: at(11.5), idle: idle(HOLD, null) },      // claude: named hold; codex still running
  { at: at(17), startedAt: at(16.8), idle: idle(UP, null) },
  { at: at(22), startedAt: at(21.9), idle: idle(NO, NO) },
  { at: at(27), startedAt: at(26), idle: idle(NO, NO) },
  { at: at(31), startedAt: at(28), idle: idle(null, NO), plan: [{ agent: 'claude', type: 'implement', ref: 5 }] },   // the tick that started claude's job at 30
  { at: at(41), startedAt: at(40.5), idle: idle(NO, NO) },
  { at: at(46), startedAt: at(45.5), idle: idle(UP, NO) },
];

test('each cause is counted, with the hand-counted minutes, for the agent that has it', () => {
  const r = idleBreakdown({ jobs, snapshots, agents, from: at(0), to: at(60) }).claude;
  // gap 10-30: [10,12] named hold (the tick that ends it names the hold) 2, [12,17] after the hold tick 5 => 7; [17,22] upgrade 5;
  // [22,27] nothing eligible 5; [27,28] ends at the tick that started the job: waiting for the tick 1; 28-30 tick run time 2.
  // tail 40-60: [40,41] nothing eligible 1, [41,46] nothing eligible 5, [46,60] upgrade 14.
  assert.deepEqual(r.minutes, { 'waiting-for-tick': 1, upgrade: 19, 'tick-run': 2, 'named-hold': 7, 'no-eligible-work': 11, unrecorded: 0 });
  assert.equal(r.busyMinutes, 20); assert.deepEqual(r.holds, { 'review slot full: PR #9': 7 });
  const total = r.busyMinutes + Object.values(r.minutes).reduce((a, b) => a + b, 0);
  assert.equal(total, 60, 'busy plus every cause covers the whole window');
});

test('tick run time is measured from the start of the tick that started the job to the job start', () => {
  const r = idleBreakdown({ jobs: [job('claude', 0, 10), job('claude', 30, 40)], snapshots, agents: { claude: 'claude' }, from: at(0), to: at(40) }).claude;
  assert.equal(r.minutes['tick-run'], 2);
  // a tick that took 4.5 minutes before the job started
  const slow = snapshots.map(s => (s.at === at(31) ? { ...s, startedAt: at(25.5) } : s));
  assert.equal(idleBreakdown({ jobs, snapshots: slow, agents, from: at(0), to: at(60) }).claude.minutes['tick-run'], 4.5);
});

test('a hold that applies to one agent leaves the other agent counted as nothing to do', () => {
  const c = idleBreakdown({ jobs, snapshots, agents, from: at(0), to: at(60) });
  // codex: busy 0-20, then 40 minutes with nothing eligible; the claude hold and upgrade do not reach it
  assert.deepEqual(c.codex.minutes, { 'waiting-for-tick': 0, upgrade: 0, 'tick-run': 0, 'named-hold': 0, 'no-eligible-work': 40, unrecorded: 0 });
  assert.deepEqual(c.codex.holds, {});
});

test('classifyIdle: the upgrade hold, a named hold and a planned job each apply only to their own agent', () => {
  const states = { claude: 'idle', codex: 'idle', third: 'running' };
  const holds = { claude: { review: 'review slot full: PR #9', implement: 'review slot full: PR #9' } };
  assert.deepEqual(classifyIdle({ states, holds }), { claude: { cause: 'named-hold', hold: 'review slot full: PR #9' }, codex: { cause: 'no-eligible-work' } });
  assert.deepEqual(classifyIdle({ states, heldAgents: ['codex'], holds, plan: [{ agent: 'codex', type: 'implement' }] }), { claude: { cause: 'named-hold', hold: 'review slot full: PR #9' }, codex: { cause: 'upgrade' } });
  assert.deepEqual(classifyIdle({ states, plan: [{ agent: 'claude', type: 'review' }] }), { claude: { cause: 'work-planned' }, codex: { cause: 'no-eligible-work' } });
  assert.deepEqual(classifyIdle({ states, plan: [{ agent: 'claude', type: 'merge' }] }).claude, { cause: 'no-eligible-work' }, 'a merge is not a job for the agent');
});

test('no tick record at all is reported as unrecorded, never as work available', () => {
  const r = idleBreakdown({ jobs: [], snapshots: [], agents: { claude: 'claude' }, from: at(0), to: at(30) }).claude;
  assert.equal(r.minutes.unrecorded, 30); assert.equal(idleReport({ jobs: [], snapshots: [], agents: { claude: 'claude' }, from: at(0), to: at(30) }).agents.claude.idleWithWorkPercent, 0);
});

test('the report: idle with work available as a percent of the window, and the text form', () => {
  const rep = idleReport({ jobs, snapshots, agents, from: at(0), to: at(60) });
  // claude: 1 + 19 + 2 + 7 = 29 of 60 minutes = 48.3 %; codex 0 %
  assert.equal(rep.agents.claude.idleWithWorkMinutes, 29); assert.equal(rep.agents.claude.idleWithWorkPercent, 48.3); assert.equal(rep.agents.codex.idleWithWorkPercent, 0);
  const text = renderIdleReport(rep);
  assert.match(text, /claude: busy 20 of 60; idle with work available 29 \(48\.3%\)/); assert.match(text, /hold "review slot full: PR #9": 7/); assert.match(text, /tick run time before the job started: 2/);
});

test('a concurrent second job on one agent does not count as idle time between them', () => {
  const two = [job('claude', 0, 20), job('claude', 10, 30)];
  const r = idleBreakdown({ jobs: two, snapshots: [], agents: { claude: 'claude' }, from: at(0), to: at(30) }).claude;
  assert.equal(r.busyMinutes, 30); assert.equal(Object.values(r.minutes).reduce((a, b) => a + b, 0), 0);
});

test('recordTick stores the tick start and the per-agent idle cause in the snapshot, and nothing else is added', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const team = { c: { repository: 'o/r', agents: { claude: { provider: 'claude' }, codex: { provider: 'codex' } } }, view: { prs: [], issues: [] }, delivered: [], merged: [] };
  recordTick(root, { now: at(5), status: 'ok', team, jobs: [], startedAt: at(4), heldAgents: ['claude'], holds: { codex: { review: 'review slot full: PR #9' } }, actions: [{ agent: 'claude', type: 'implement', issue: 5 }] });
  const s = readSnapshots(root)[0];
  assert.equal(s.startedAt, at(4)); assert.deepEqual(s.idle, { claude: { cause: 'upgrade' }, codex: { cause: 'named-hold', hold: 'review slot full: PR #9' } });
});

test('the dashboard names the hold for the agent it belongs to, and says "next tick" only without a hold', () => {
  const cfg = { repository: 'o/r', enabled: true, agents: { claude: { issues: [], provider: 'claude' }, codex: { issues: [], provider: 'codex' } }, limits: { max_fix_attempts: 3 } };
  const names = { issue: n => ({ text: `#${n}` }), pr: n => ({ text: `PR #${n}` }) };
  const base = { agent: 'claude', config: cfg, team: { c: cfg }, cache: { issues: [], pulls: [] }, plan: [{ agent: 'claude', type: 'implement', issue: 5 }], state: 'idle', names };
  assert.match(idleReason({ ...base, hold: { cause: 'named-hold', hold: 'implement slot full: #3' } }).text, /about to start implement #5 once the hold clears; held: implement slot full: #3/);
  assert.match(idleReason({ ...base, hold: { cause: 'upgrade' } }).text, /held: an install is in progress/);
  assert.match(idleReason(base).text, /on the next tick/);
  // No planned job (the live plan applies the same cap): the hold is still named, for the agent it belongs to only.
  const noPlan = { ...base, plan: [] };
  assert.equal(idleReason({ ...noPlan, hold: { cause: 'named-hold', hold: 'claude implementer slot full (limits.provider_roles 1)' } }).text, 'held: claude implementer slot full (limits.provider_roles 1)');
  assert.equal(idleReason({ ...noPlan, hold: { cause: 'upgrade' } }).text, 'held: an install is in progress');
  assert.match(idleReason({ ...base, hold: { cause: 'no-eligible-work' } }).text, /on the next tick/);
});

test('the report command reads local records only and prints the range it was asked for', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ['supervisor/cli.mjs', 'team', 'idle-report', '--from', 'not-a-time'], { env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root }, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /idle-report/);
});

// Issue #530: a hold whose figures change on every tick is one cause; two different causes stay separate.
test('a hold whose figures change on every tick is one cause with the latest text and the total time; different causes stay apart', () => {
  const rev = (w, p, d) => ({ cause: 'named-hold', hold: `reviews only: weekly ${w}%, projected ${p}% at reset (${d} days left, window average)` });
  const slot = { cause: 'named-hold', hold: 'review slot full: PR #9' };
  const snaps = [
    { at: at(10), startedAt: at(9.9), idle: { claude: rev(90, 180, 3.5), codex: slot } },
    { at: at(20), startedAt: at(19.9), idle: { claude: rev(91, 181, 3.4), codex: slot } },
    { at: at(30), startedAt: at(29.9), idle: { claude: rev(92, 184, 3.3), codex: slot } },
    { at: at(40), startedAt: at(39.9), idle: { claude: { cause: 'named-hold', hold: 'implement slot full: #3' }, codex: slot } },
  ];
  const r = idleBreakdown({ jobs: [], snapshots: snaps, agents, from: at(0), to: at(50) });
  // claude: 0-40 is the reviews-only hold (read at 10, 20, 30), 40-50 follows the tick at 40 and is the slot hold
  assert.deepEqual(r.claude.holds, { 'reviews only: weekly 92%, projected 184% at reset (3.3 days left, window average)': 40, 'implement slot full: #3': 10 });
  assert.deepEqual(r.codex.holds, { 'review slot full: PR #9': 50 });
  assert.notEqual(holdCause('review slot full: PR #9'), holdCause('review slot full: PR #10'));
  assert.notEqual(holdCause(rev(1, 2, 3).hold), holdCause('implement slot full: #3'));
  assert.equal(holdCause(rev(90, 180, 3.5).hold), holdCause(rev(12, 99, 0.5).hold));
});

test('the Now card shows one short idle line per agent with a link to the breakdown; the agent page keeps the full holds', async () => {
  const { renderRoute } = await import('../supervisor/dashrender.mjs');
  const { overviewView } = await import('./helpers/lists-fixture.mjs');
  const base = await overviewView();
  const names = base.agents.map(a => a.name), name = names[0];
  const hold = 'reviews only: weekly 92%, projected 184% at reset (3.3 days left, window average)';
  const idleCauses = { agents: { [name]: { idleWithWorkPercent: 40, minutes: { 'named-hold': 300, upgrade: 20, 'waiting-for-tick': 0 }, holds: { [hold]: 300 } } } };
  const view = { ...base, idleCauses };
  const overview = renderRoute(view, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  const line = overview.match(/<div class="sub" data-idle-causes="[^"]*">[^]*?<\/div>/)?.[0] || '';
  assert.match(line, /idle with work available 40%, mostly a named hold/);
  assert.match(line, new RegExp('href="/agents/' + encodeURIComponent(name) + '"'));
  assert.ok(!line.includes('reviews only'), 'no hold text on the Now card');
  assert.ok(line.length < 400);
  const agentPage = renderRoute(view, { page: 'agent', id: name }, { query: new URLSearchParams(), pathname: '/agents/' + name }).html;
  assert.match(agentPage, /<span class="hold-label">reviews only<\/span>: <span class="hold-fig">5 h<\/span>/);   // grouped row, 300 min
  assert.match(agentPage, /<details class="long-text"><summary>details<\/summary>reviews only: weekly 92%/);
});

// Issue #719: other changing counts, joined holds, and the cut position.
test('holdCause masks bare counts, splits joined holds, and is not moved by a figure changing width', () => {
  const a = 'Paused new work: 10 open PRs (cap 10); 12 more waiting', b = 'Paused new work: 11 open PRs (cap 10); 13 more waiting';
  assert.equal(holdCause(a), holdCause(b));
  assert.equal(holdCause('kept for 2 pending review(s)'), holdCause('kept for 3 pending review(s)'));
  // identifiers after '#' stay distinct
  assert.notEqual(holdCause('review slot full: PR #9'), holdCause('review slot full: PR #10'));
  // the same holds in another mix or order are the same parts; a different hold is not
  const x = 'out of allowance: weekly 95%', y = 'review slot full: PR #9';
  assert.equal(holdCause(`${x} | ${y}`), holdCause(`${y} | ${x}`));
  assert.equal(holdCause(`${x} | ${y}`), holdCause(`${x.replace('95', '100')} | ${y} | ${x}`));
  assert.notEqual(holdCause(`${x} | ${y}`), holdCause(x));
  assert.notEqual(holdCause(x), holdCause('review slot full: PR #9'));
  // a figure that changes width before a long text does not move the cut
  const long = w => `reviews only: weekly ${w}%, ${'padding words '.repeat(30)}tail-${'z'.repeat(40)}`;
  assert.equal(holdCause(long(9)), holdCause(long(10)));
});

test('classifyIdle cuts each hold on its own, so a long hold does not hide the others', () => {
  const r = classifyIdle({ states: { codex: 'idle' }, holds: { codex: { a: 'x'.repeat(500), b: 'review slot full: PR #9' } } });
  assert.match(r.codex.hold, /\| review slot full: PR #9$/);
});

test('on an agent card the Now panel shows only that agent\'s idle line; the Overview shows every agent\'s', async () => {
  const { renderRoute } = await import('../supervisor/dashrender.mjs');
  const { overviewView } = await import('./helpers/lists-fixture.mjs');
  const base = await overviewView();
  const names = base.agents.map(a => a.name);
  assert.ok(names.length >= 2);
  const row = { idleWithWorkPercent: 10, minutes: { 'named-hold': 60 }, holds: {} };
  const view = { ...base, idleCauses: { agents: Object.fromEntries(names.map(n => [n, row])) } };
  const opts = p => ({ query: new URLSearchParams(), pathname: p });
  const page = renderRoute(view, { page: 'agent', id: names[0] }, opts('/agents/' + names[0])).html;
  assert.ok(page.includes(`data-idle-causes="${names[0]}"`));
  assert.ok(!page.includes(`data-idle-causes="${names[1]}"`));
  const overview = renderRoute(view, { page: 'overview' }, opts('/')).html;
  for (const n of names) assert.ok(overview.includes(`data-idle-causes="${n}"`));
});

test('one job type carrying several joined reasons: a figure changing width does not change the cause key (issue #719)', () => {
  const review = pct => ['review refused: PR #11 needs a fresh session on a different model than the writer of this head, '.padEnd(120, 'x'),
    'review refused: PR #12 needs a fresh session on a different model than the writer of this head, '.padEnd(120, 'y'),
    `review held: codex is out of allowance (weekly ${pct}% used, projected 100% before the reset on Sat 06:00, rate source window average)`].join(' | ');
  assert.ok(review(9).length > 300);
  const key = pct => holdCause(classifyIdle({ states: { codex: 'idle' }, holds: { codex: { review: review(pct) } } }).codex.hold);
  assert.equal(key(9), key(10));
  assert.match(key(9), /review held: codex is out of allowance/);
});

test('issue #813: the joined hold text is capped at a part boundary, the key still comes from every reason', () => {
  const reason = n => `reason ${String.fromCharCode(97 + n)} ` + 'word '.repeat(56);
  const holds = { codex: { review: [0, 1, 2, 3, 4].map(reason).join(' | '), build: reason(5) } };
  const e = classifyIdle({ states: { codex: 'idle' }, holds }).codex;
  assert.ok(e.hold.length <= HOLD_TEXT_CHARS, `${e.hold.length}`);
  assert.equal(e.hold.split(' | ').length, 2);                       // whole parts only, none cut mid-part
  assert.ok(e.hold.split(' | ').every(p => p.startsWith('reason ')));
  assert.equal(e.holdKey.split(' | ').length, 6);                    // key formed before the cap, stored only when the text was cut
  assert.equal(shortKeyAbsent(), true);
  const shortE = classifyIdle({ states: { codex: 'idle' }, holds: { codex: { review: 'one | two' } } }).codex;
  assert.equal(shortE.hold, 'one | two');                            // under the cap: unchanged
  // idleBreakdown groups by the stored key, so a capped text keeps its cause
  const snaps = [{ at: 1000, idle: { codex: e } }, { at: 2000, idle: { codex: e } }];
  const r = idleBreakdown({ jobs: [], snapshots: snaps, agents: { codex: 'codex' }, from: 0, to: 2000 });
  assert.equal(Object.keys(r.codex.holds).length, 1);
});

test('issue #813: the key cut stays well below the raw per-reason cut', () => {
  assert.ok(HOLD_KEY_CHARS <= HOLD_REASON_CHARS - 50);
  const long = 'held: ' + '12 '.repeat(200);                         // digits mask to shorter text, so masking shrinks the raw cut
  const key = holdCause(classifyIdle({ states: { codex: 'idle' }, holds: { codex: { a: long } } }).codex.hold);
  assert.equal(key.length, HOLD_KEY_CHARS);
});
function shortKeyAbsent() { return !('holdKey' in classifyIdle({ states: { codex: 'idle' }, holds: { codex: { a: 'one | two' } } }).codex); }

// ---- issue #950: cards carry structure, not a wall of joined text
// Only the hidden body of a <details> is dropped; its visible <summary> stays checked.
const hideBodies = html => html.replace(/<details[^>]*>\s*<summary>([^]*?)<\/summary>[^]*?<\/details>/g, '<span>$1</span>').replace(/<details[^>]*>[^]*?<\/details>/g, '');
const textBlocks = html => hideBodies(html).replace(/<(script|style)[^]*?<\/\1>/g, '')
  .split(/<\/?(?:div|p|li|ul|section|header|h\d|span class="badge|tr|td|th|summary|form|a class="tbtn)[^>]*>/).map(t => t.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, 'x').trim()).filter(Boolean);
export const MAX_BLOCK = 240;

test('hold history is grouped by reason with a count and total time, newest first, detail behind a click', () => {
  const reason = pct => `review held: codex is out of allowance (codex weekly use ${pct}% >= 95%)`, other = 'file overlap: waits for PR #7';
  const snaps = [
    { at: at(10), idle: { codex: { cause: 'named-hold', hold: reason(97) } } },
    { at: at(20), idle: { codex: { cause: 'named-hold', hold: reason(97) + ' | ' + other } } },
    { at: at(30), idle: { codex: NO } },
    { at: at(40), idle: { codex: { cause: 'named-hold', hold: reason(98) } } },
    { at: at(50), idle: { codex: NO } },
  ];
  const g = idleReport({ jobs: [], snapshots: snaps, agents: { codex: 'codex' }, from: at(0), to: at(50) }).agents.codex.holdGroups;
  assert.equal(g.length, 2);
  assert.deepEqual(g.map(x => x.label), ['review held: codex is out of allowance', 'file overlap: waits for PR #7'].sort((x, y) => (g.find(z => z.label === x).last < g.find(z => z.label === y).last ? 1 : -1)));
  const rev = g.find(x => x.label.startsWith('review held')), ov = g.find(x => x.label.startsWith('file overlap'));
  assert.equal(rev.count, 2, 'two separate stretches'); assert.equal(rev.minutes, 40);
  assert.equal(ov.count, 1); assert.equal(ov.minutes, 10);
  assert.ok(g[0].last >= g[1].last, 'newest first');
  assert.equal(g[0], rev, 'the review hold ended last (at 50), the overlap at 30');
});

test('a card never renders one long block of text, and nothing is cut mid-word', async () => {
  const { renderRoute } = await import('../supervisor/dashrender.mjs');
  const { overviewView } = await import('./helpers/lists-fixture.mjs');
  const base = await overviewView(), name = base.agents[0].name;
  const reason = 'review held: codex is out of allowance (codex weekly use 97% >= 95%, resets in a few days and then some more words to make it very long indeed)';
  const holds = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${reason} | file overlap ${i}`, 12]));
  const holdGroups = Array.from({ length: 30 }, (_, i) => ({ label: `review held: codex is out of allowance ${i}`, detail: reason, minutes: 1164, count: 14, last: i }));
  const long = 'Paused new work: ' + 'twelve open PRs (cap 12) and nothing may start until a few of them merge, '.repeat(6);
  const parts = [1, 2, 3].map(i => `codex · gpt · ${'a long issue title '.repeat(5)}${i} · implementing`);
  const slots = [{ role: 'implement', label: 'Implement', capacity: 3, held: parts.map(() => ({})), parts, text: 'Implement: ' + parts.join('; ') }];
  const view = { ...base, slots, capNotes: [long], idleCauses: { agents: { [name]: { idleWithWorkPercent: 40, minutes: { 'named-hold': 300 }, holds, holdGroups } } } };
  view.agents = view.agents.map((a, i) => i ? a : { ...a, state: 'idle', job: null, jobs: [], idleReason: { text: 'held: review held: codex is out of allowance (codex weekly use 97% >= 95%) | file overlap: waits for PR #7 | implement held: cap of 12 open PRs reached ' + 'and some more words '.repeat(10) } });
  const q = { query: new URLSearchParams(), pathname: '/' };
  for (const [route, extra] of [[{ page: 'overview' }, q], [{ page: 'agents' }, { query: new URLSearchParams(), pathname: '/agents' }], [{ page: 'agent', id: name }, { query: new URLSearchParams(), pathname: '/agents/' + name }]]) {
    const html = renderRoute(view, route, extra).html;
    for (const t of textBlocks(html)) assert.ok(t.length <= MAX_BLOCK, `block of ${t.length} characters: ${t.slice(0, 80)}`);
    assert.ok(!/\|/.test(hideBodies(html).replace(/<(script|style)[^]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')), 'no joined " | " text outside an expand');
  }
  const html = renderRoute(view, { page: 'agent', id: name }, { query: new URLSearchParams(), pathname: '/agents/' + name }).html;
  assert.match(html, /1164 min|19\.4 h, 14 times/);
  assert.match(html, /<summary>Paused new work: [^<]*…<\/summary>/, 'a long note is clipped at a word, the whole text behind it');
  assert.equal((html.match(/<div class="hold-row">[^<]*implementing/g) || []).length, 3, 'each held slot of a role is its own row');
  assert.match(html, /<div class="hold-row">[^<]*file overlap: waits for PR #7/, 'each idle hold is its own row');
  // negative: the guard sees visible joined text in a summary
  assert.ok(/\|/.test(hideBodies('<details><summary>a | b…</summary>a | b | c</details>').replace(/<[^>]+>/g, ' ')));
  // negative: the guard itself fails on a wall of text
  assert.ok(textBlocks('<div>' + 'word '.repeat(80) + '</div>').some(t => t.length > MAX_BLOCK));
});
