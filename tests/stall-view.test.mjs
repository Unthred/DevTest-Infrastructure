// Issue #1222: the stall rule, the card and the app bar marks, and the same through the real view and page render.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { stallRows, plannedSince, healthWithStall, withStall, stallLimitMs, NO_REASON } from '../supervisor/stallview.mjs';
import { renderRoute, lt, dur } from '../supervisor/dashrender.mjs';
import { stallBody } from '../supervisor/stallcard.mjs';
import { currentView } from '../supervisor/dashserver.mjs';
import { NOW, JOB_ID, config, jobRecord, writeRoot } from './helpers/stall-fixture.mjs';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MIN = 60000;
const LIMIT = 15 * MIN;
const held = (type, ref, extra = {}) => ({ type, agent: 'a1', ref, outcome: 'held', kind: 'slot', reason: 'slot full', ...extra });
const mkView = (idleMin, planned, extra = {}) => ({ agents: [{ name: 'a1', state: 'idle', lastActivityAt: NOW - idleMin * MIN }], planned,
  prs: [{ number: 7, title: 'Seven', needsHomeowner: false }, { number: 8, title: 'Eight', needsHomeowner: true }], issues: [{ number: 3, title: 'Three', needsHomeowner: false }], ...extra });
const rows = (view, extra = {}) => stallRows({ view, now: NOW, limitMs: LIMIT, providerOf: { a1: 'p1' }, ...extra });

test('idle 14 minutes with planned work is not stalled; 16 minutes is', () => {
  assert.equal(rows(mkView(14, [held('fix', 7)])).stalled, false);
  const r = rows(mkView(16, [held('fix', 7)]));
  assert.equal(r.stalled, true);
  assert.equal(r.agents[0].agent, 'a1');
  assert.equal(r.agents[0].idleMs, 16 * MIN);
  assert.deepEqual(r.agents[0].actions.map(a => [a.type, a.ref, a.title]), [['fix', 7, 'Seven']]);
});

test('idle with no planned action, or only launched actions, is not stalled', () => {
  assert.equal(rows(mkView(120, [])).stalled, false);
  assert.equal(rows(mkView(120, null)).stalled, false);
  assert.equal(rows(mkView(120, [{ type: 'fix', agent: 'a1', ref: 7, outcome: 'launched' }])).stalled, false);
});

test('a recorded reason is shown; none (or the unexplained ledger entry) says No reason recorded and still counts as stalled', () => {
  const r = rows(mkView(60, [held('fix', 7), held('review', 7, { kind: 'unexplained', reason: 'planned but neither started nor held, and no reason was recorded' }), held('implement', 3, { reason: '' })]));
  assert.equal(r.stalled, true);
  assert.deepEqual(r.agents[0].actions.map(a => a.reason), ['slot full', null, null]);
  assert.equal(r.agents[0].actions[2].title, 'Three', 'an implement action names its issue');
  const html = stallBody({ esc, lt, dur }, r);
  assert.equal((html.match(/data-no-reason/g) || []).length, 2);
  assert.ok(html.includes(NO_REASON));
});

test('a paused job past its resume time is listed with its last error; before the grace period or running agent it is not', () => {
  const paused = (extra = {}) => ({ id: 'd'.repeat(32), provider: 'p1', kind: 'continue', status: 'paused_limit', nextAttemptAt: NOW - 20 * MIN, resumeCheck: { message: 'boom: it threw' }, ...extra });
  const base = { agents: [{ name: 'a1', state: 'paused', lastActivityAt: NOW - 3600000 }], planned: [], prs: [], issues: [] };
  const r = rows(base, { jobs: [paused()] });
  assert.equal(r.stalled, true);
  assert.deepEqual([r.jobs[0].id, r.jobs[0].agent, r.jobs[0].error, r.jobs[0].overdueMs], ['dddddddd', 'a1', 'boom: it threw', 20 * MIN]);
  assert.equal(rows(base, { jobs: [paused({ resumeCheck: null })] }).jobs[0].error, null, 'no error recorded is stated, not invented');
  assert.equal(rows(base, { jobs: [paused({ nextAttemptAt: NOW - 14 * MIN })] }).stalled, false, 'not yet past resume time plus the limit');
  assert.equal(rows(base, { jobs: [paused({ nextAttemptAt: NOW + MIN })] }).stalled, false, 'not yet due');
  assert.equal(rows(base, { jobs: [paused({ nextAttemptAt: null, resetAt: NOW - 3600000 })] }).stalled, true, 'the reset time is the resume time when no retry is set');
  assert.equal(rows({ ...base, agents: [{ name: 'a1', state: 'running' }] }, { jobs: [paused()] }).stalled, false, 'an agent with work running is not stalled');
});

test('a retry capped PR and a needs-homeowner item go under Waiting for you and are not a stall', () => {
  const r = rows(mkView(60, [held('rebase', 7, { kind: 'retry_cap', reason: 'retry cap: 3 attempts' }), held('fix', 8)]));
  assert.equal(r.stalled, false, 'every action waits for the homeowner');
  assert.deepEqual(r.waiting.map(w => [w.type, w.ref, w.reason]), [['rebase', 7, 'retry cap: 3 attempts'], ['fix', 8, 'slot full']]);
  const mixed = rows(mkView(60, [held('rebase', 7, { kind: 'retry_cap' }), held('fix', 7)]));
  assert.equal(mixed.stalled, true);
  assert.deepEqual(mixed.agents[0].actions.map(a => a.type), ['fix'], 'the capped one is not listed as a fault');
  assert.equal(mixed.waiting.length, 1);
});

test('the limit is configurable and the waiting time starts when the work was first planned, not when the agent went idle', () => {
  assert.equal(stallLimitMs({ idle_stall_minutes: 30 }), 30 * MIN);
  assert.equal(stallLimitMs({}), 15 * MIN);
  assert.equal(stallLimitMs({ idle_stall_minutes: 0 }), 15 * MIN);
  assert.equal(rows(mkView(20, [held('fix', 7)]), { limitMs: 30 * MIN }).stalled, false);
  const snaps = [{ at: NOW - 5 * MIN, planned: [held('fix', 7)] }, { at: NOW - 10 * MIN, planned: [held('fix', 7)] }, { at: NOW - 15 * MIN, planned: [] }, { at: NOW - 20 * MIN, planned: [held('fix', 7)] }];
  assert.equal(plannedSince(snaps, 'a1'), NOW - 10 * MIN, 'the unbroken run ends at the tick with nothing planned');
  assert.equal(plannedSince([{ at: NOW, planned: [] }], 'a1'), null);
  assert.equal(rows(mkView(600, [held('fix', 7)]), { snapshots: snaps }).stalled, false, 'idle for 10 hours, but planned only 10 minutes ago');
});

test('the pill keeps its count and gains the marker, or says Stalled when nothing else is open; no stall changes nothing', () => {
  const on = { stalled: true }, off = { stalled: false };
  const open = { state: 'needs_you', label: 'Needs you (2)', count: 2, severity: 'action' };
  assert.deepEqual(healthWithStall(open, on), { ...open, stalled: true });
  assert.deepEqual(healthWithStall({ state: 'idle', label: 'Idle', severity: 'ok' }, on), { state: 'needs_you', label: 'Stalled', count: 0, severity: 'action', stalled: true });
  assert.equal(healthWithStall(open, off), open);
});

const withRoot = async (extraJobs, body) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stall-'));
  try { writeRoot(root, extraJobs); return await body(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
const page = (view, p = 'overview') => renderRoute(view, { page: p }, { query: new URLSearchParams(), pathname: p === 'overview' ? '/' : `/${p}` }).html;

test('the real view and page: the card lists the 12 Nov stalls, the capped PR is under Waiting for you, and the bar marks link to the card', async () => {
  await withRoot([], async root => {
    const v = await currentView({ root, config: config(root), now: NOW, tz: 'UTC' });
    assert.equal(v.stall.stalled, true);
    assert.deepEqual(v.stall.agents[0].actions.map(a => [a.type, a.ref, a.title, a.reason === null]), [['fix', 1180, 'Fix the foo', false], ['fix', 1175, 'Fix the bar', true]]);
    assert.deepEqual(v.stall.jobs.map(j => [j.id, j.agent, j.error]), [['db849b9f', 'codex', 'resume check threw: lease file unreadable']]);
    assert.deepEqual(v.stall.waiting.map(w => [w.type, w.ref]), [['rebase', 1180]]);
    const html = page(v);
    const card = html.slice(html.indexOf('id="c-stalled"'), html.indexOf('</section>', html.indexOf('id="c-stalled"')));
    assert.ok(card.includes('fix PR #1180') && card.includes('Fix the foo') && card.includes('slot full'));
    assert.ok(card.includes('fix PR #1175') && card.includes(NO_REASON));
    assert.ok(card.includes('db849b9f') && card.includes('lease file unreadable'));
    assert.ok(card.indexOf('Waiting for you') > card.indexOf('db849b9f') && card.indexOf('rebase PR #1180', card.indexOf('Waiting for you')) > 0);
    assert.equal(card.slice(0, card.indexOf('Waiting for you')).includes('rebase PR #1180'), false, 'the capped item is only under Waiting for you');
    assert.ok(html.indexOf('id="c-stalled"') < html.indexOf('data-card="hl-issues"'), 'the card is first on Overview');
    const bar = html.slice(html.indexOf('<header class="statusbar"'), html.indexOf('</header>'));
    for (const n of ['claude', 'codex']) assert.ok(bar.includes(`data-stall-mark="${n}"`), `${n} has a stalled mark`);
    assert.equal((bar.match(/href="\/#c-stalled"/g) || []).length, 3, 'two agent marks and the pill marker link to the card');
    assert.ok(bar.includes('data-pill-stall') && bar.includes('Stalled'));
    assert.equal(page(v, 'work').includes('id="c-stalled"'), false, 'the card is on Overview only');
  });
});

test('the card and every mark are gone once a running job is added for each agent', async () => {
  const running = (id, provider) => jobRecord(id, provider, { status: 'running', createdAt: NOW - 60000, updatedAt: NOW - 1000 });
  await withRoot([running('e'.repeat(32), 'claude'), running('f'.repeat(32), 'codex')], async root => {
    const v = await currentView({ root, config: config(root), now: NOW, tz: 'UTC' });
    assert.equal(v.stall.stalled, false);
    const html = page(v);
    assert.equal(html.includes('id="c-stalled"'), false);
    assert.equal(html.includes('data-stall-mark'), false);
    assert.equal(html.includes('data-pill-stall'), false);
    assert.notEqual(v.health.label, 'Stalled');
  });
});

test('every planned action started: nothing is stalled', async () => {
  await withRoot([], async root => {
    const cacheFile = path.join(root, 'dashboard', 'cache.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache.planned = cache.planned.map(p => ({ ...p, outcome: 'launched', kind: null, reason: null }));
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    const v = await currentView({ root, config: { ...config(root), agents: { claude: config(root).agents.claude } }, now: NOW, tz: 'UTC' });
    assert.equal(v.stall.stalled, false);
    assert.equal(page(v).includes('id="c-stalled"'), false);
  });
});

test('withStall adds no agent names of its own and escapes what it shows', () => {
  const v = withStall({ ...mkView(60, [held('fix', 7, { reason: '<img src=x onerror=alert(1)>' })]), health: { state: 'idle', label: 'Idle', severity: 'ok' }, panels: { needsYou: [] } },
    { config: { agents: { a1: { provider: 'p1' } }, limits: {} }, jobs: [], snapshots: [], now: NOW });
  assert.equal(v.agents[0].stalled, true);
  const html = stallBody({ esc, lt, dur }, v.stall);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;img'));
});
