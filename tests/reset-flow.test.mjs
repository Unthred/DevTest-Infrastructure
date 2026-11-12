// Issue #1162: records, the dashboard route, the Needs you item (once per window), the tick step, the history event and the capacity rule.
// The dashboard cases go through the real handler; the tick cases go through the real tick step with a team-shaped object.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { readRecords, addRecord, markUsed, editRecord, deleteRecord } from '../supervisor/resetrecords.mjs';
import { limitResetStep } from '../supervisor/resetstep.mjs';
import { limitResetsFor } from '../supervisor/resetsbuild.mjs';
import { budgetView } from '../supervisor/budgetview.mjs';
import { planNotices, detectDrop, readSeen, windowKeyOf } from '../supervisor/resetnotices.mjs';
import { readTimeline, entryText } from '../supervisor/history.mjs';
import { capacitySamples, learnCapacity } from '../supervisor/capacity.mjs';
import { validateBudgetConfig } from '../supervisor/budget.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const CONFIG = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  models: { agents: { claude: { implement: { model: 'sonnet' }, review: { model: 'opus' } } } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
const NAMES = ['claude', 'codex'];
const tmp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset1162-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

// ---- records
test('records: add, edit, mark used and delete keep one shared shape for every agent and refuse bad input', t => {
  const root = tmp(t);
  const added = addRecord(root, { agent: 'claude', limit: 'weekly', scope: 'Fable', expiry: '2027-03-08', note: 'three left' }, NAMES, NOW);
  assert.equal(added.ok, true);
  assert.deepEqual({ ...added.record, id: 'x', createdAt: 0 }, { id: 'x', agent: 'claude', limit: 'weekly', scope: 'fable', expiry: Date.UTC(2027, 2, 8, 23, 59, 59), note: 'three left', state: 'available', createdAt: 0 });
  assert.equal(addRecord(root, { agent: 'codex', limit: 'five_hour', scope: 'all', expiry: '' }, NAMES, NOW).record.expiry, null);
  for (const bad of [{ agent: 'nobody', limit: 'weekly' }, { agent: 'claude', limit: 'daily' }, { agent: 'claude', limit: 'weekly', scope: 'a b' }, { agent: 'claude', limit: 'weekly', expiry: 'soon' }]) {
    assert.equal(addRecord(root, bad, NAMES, NOW).ok, false, JSON.stringify(bad));
  }
  const id = added.record.id;
  assert.equal(editRecord(root, id, { agent: 'claude', limit: 'five_hour', scope: 'all', expiry: '2027-01-01' }, NAMES).record.limit, 'five_hour');
  assert.equal(readRecords(root).find(r => r.id === id).note, undefined, 'an edit replaces every field');
  assert.equal(markUsed(root, id, NOW).record.state, 'used');
  assert.equal(markUsed(root, id, NOW).ok, false, 'a second mark is refused');
  assert.equal(deleteRecord(root, id).ok, true);
  assert.equal(readRecords(root).length, 1);
  assert.equal(deleteRecord(root, 'deadbeef').ok, false);
});

// ---- the dashboard, through the real handler
async function serve(t, { probe } = {}) {
  const root = tmp(t);
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [] }));
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const port = server.address().port;
  const woken = [];
  let clock = NOW;   // every read moves it on, so the one second write cooldown never blocks the next call of a test
  server.on('request', handler({ root, config: CONFIG, host: '127.0.0.1', port, now: () => (clock += 2000), probe, wake: (...a) => woken.push(a) }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
  const post = (body, { proof = true, origin = `http://127.0.0.1:${port}` } = {}) => req('POST', '/resets', { headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: proof ? `${body}&proof=${writeToken(root)}` : body });
  return { root, req, post, woken, get: p => req('GET', p) };
}

test('dashboard: the Limit resets card lists a Fable reset as not helping Foreman, with its expiry and the spacing for several', async t => {
  const s = await serve(t);
  for (let i = 0; i < 3; i++) assert.equal((await s.post('action=add&agent=claude&limit=weekly&scope=fable&expiry=2027-03-08')).status, 303);
  assert.equal((await s.post('action=add&agent=claude&limit=weekly&scope=all&expiry=')).status, 303);
  const page = (await s.get('/usage')).body;
  assert.match(page, /id="c-limit-resets"/);
  assert.equal((page.match(/data-verdict="lost_cause"/g) || []).length, 3);
  assert.match(page, /Does not help Foreman/);
  assert.match(page, /3 left, \d+ weeks: one every \d+ weeks? keeps them all/);
  assert.match(page, /no expiry/);
  assert.match(page, /action="\/resets"/);
});

test('dashboard: a write needs the access proof and the right origin, and changes nothing without them', async t => {
  const s = await serve(t);
  const noProof = await s.post('action=add&agent=claude&limit=weekly&scope=all', { proof: false });
  assert.equal(noProof.status, 403);
  const foreign = await s.post('action=add&agent=claude&limit=weekly&scope=all', { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(readRecords(s.root).length, 0);
  const bad = await s.post('action=add&agent=nobody&limit=weekly');
  assert.equal(bad.status, 409);
  assert.equal((await s.post('action=explode')).status, 400);
});

test('dashboard: marking a reset used requests an allowance refresh for that agent and wakes the tick', async t => {
  const probed = [];
  const s = await serve(t, { probe: async o => { probed.push(o.agent); return { ok: true }; } });
  await s.post('action=add&agent=claude&limit=weekly&scope=all');
  const id = readRecords(s.root)[0].id;
  const r = await s.post(`action=used&id=${id}`);
  assert.equal(r.status, 303);
  assert.deepEqual(probed, ['claude']);
  assert.equal(readRecords(s.root)[0].state, 'used');
  assert.equal(s.woken.length, 1);
});

// ---- the tick step: notices once per window, the drop event
const job = (provider, from, to, tokens) => ({ id: `${provider}${from}`, provider, createdAt: from, updatedAt: to, usage: { inputTokens: tokens, outputTokens: 0 } });
function team(root, over = {}) {
  const m = { mode: 'reviews_only', used: 0.97, resetsAt: NOW + 4 * DAY, hoursLeft: 96, reason: '', known: true, capacity: { basis: 'absolute', used: 0.97, capacity: 10e6, belowReserve: true }, ...over.mode };
  return { root, clock: { now: () => over.now ?? NOW }, c: CONFIG, modes: { claude: m }, held: over.held ?? { claude: { implement: 'reviews only' } },
    usage: { jobs: [job('claude', NOW - 30 * HOUR, NOW - 20 * HOUR, 1e6), job('claude', NOW - 15 * HOUR, NOW - 5 * HOUR, 1e6)], allowance: {} } };
}
const stepAt = (root, over) => limitResetStep(team(root, over), {});
const attention = (root, over) => {
  const tm = team(root, over);
  return limitResetsFor({ root, config: CONFIG, budget: budgetView(tm), jobs: tm.usage.jobs, allowance: {}, now: tm.clock.now() }).attention;
};

test('tick: one Needs you item per reset per weekly window; it closes when marked used or the condition lapses and is not raised again', t => {
  const root = tmp(t);
  const id = addRecord(root, { agent: 'claude', limit: 'weekly', scope: 'all', expiry: '2027-03-08' }, NAMES, NOW).record.id;
  assert.deepEqual(attention(root), [], 'nothing is shown before the tick has raised it');
  stepAt(root);
  stepAt(root);   // a second pass in the same window raises nothing new
  const items = attention(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `resets-${id}`);
  assert.equal(items[0].severity, 'action');
  assert.match(items[0].text, /claude: Applying a limit reset now would turn most of it into work/);
  assert.equal(Object.keys(readSeen(root).notices).length, 1);

  stepAt(root, { held: {} });   // the work ran out: the condition lapsed
  assert.equal(readSeen(root).notices[id].status, 'closed');
  assert.deepEqual(attention(root, { held: {} }), []);
  stepAt(root);   // held again in the SAME window: still not raised again
  assert.equal(readSeen(root).notices[id].status, 'closed');
  assert.deepEqual(attention(root), []);

  stepAt(root, { mode: { resetsAt: NOW + 11 * DAY } });   // the next window: raised once more
  assert.equal(readSeen(root).notices[id].status, 'open');
  assert.equal(attention(root, { mode: { resetsAt: NOW + 11 * DAY } }).length, 1);

  markUsed(root, id, NOW);
  assert.deepEqual(attention(root, { mode: { resetsAt: NOW + 11 * DAY } }), [], 'gone at once when marked used');
  stepAt(root, { mode: { resetsAt: NOW + 11 * DAY } });
  assert.equal(readSeen(root).notices[id].status, 'closed');
  assert.match(readSeen(root).notices[id].closedBecause, /marked used/);
});

test('notices: planNotices raises only for use now or use before expiry and keys on the window', () => {
  const advice = [{ id: 'a', agent: 'claude', verdict: 'use_now' }, { id: 'b', agent: 'claude', verdict: 'hold' }, { id: 'c', agent: 'claude', verdict: 'use_before_expiry' }];
  const next = planNotices({ notices: {}, advice, windowKeys: { claude: '5' }, now: NOW });
  assert.deepEqual(Object.keys(next).sort(), ['a', 'c']);
  assert.equal(next.a.window, '5');
  assert.equal(windowKeyOf(undefined), 'none');
});

test('history: a sharp drop in weekly use without the window rolling over is recorded once as "limit reset applied"', t => {
  const root = tmp(t);
  addRecord(root, { agent: 'claude', limit: 'weekly', scope: 'all' }, NAMES, NOW);
  stepAt(root, { now: NOW });
  stepAt(root, { now: NOW + 5 * 60000, mode: { used: 0.04, capacity: { basis: 'absolute', used: 0.04, capacity: 10e6, belowReserve: false } } });
  const events = readTimeline(root).filter(e => e.kind === 'limit_reset');
  assert.equal(events.length, 1);
  assert.equal(events[0].agent, 'claude');
  assert.match(entryText(events[0]), /limit reset applied: weekly use fell from 97% to 4% without the window rolling over/);
});

test('history: a fall because the window rolled over, or a small fall, is not a reset', () => {
  const was = { used: 0.97, resetsAt: NOW + 4 * DAY };
  assert.equal(detectDrop(was, { used: 0.02, resetsAt: NOW + 11 * DAY }), null);
  assert.equal(detectDrop(was, { used: 0.9, resetsAt: NOW + 4 * DAY }), null);
  assert.equal(detectDrop(null, { used: 0.1, resetsAt: NOW }), null);
  assert.deepEqual(detectDrop(was, { used: 0.1, resetsAt: NOW + 4 * DAY + 60000 }), { from: 0.97, to: 0.1 });
});

// ---- capacity learning ignores the drop
test('capacity: a fall in use inside one window is left out of capacity learning', () => {
  const reading = (at, used, tokens) => ({ provider: 'claude', usage: { inputTokens: tokens, outputTokens: 0 },
    allowance: { observedAt: at, windows: [{ type: 'seven_day', utilization: used, resetsAt: NOW + 4 * DAY }] } });
  const jobs = [reading(1000, 0.5, 1e6), reading(2000, 0.9, 1e6), reading(3000, 0.1, 1e6), reading(4000, 0.2, 1e6)];
  const samples = capacitySamples(jobs);
  assert.equal(samples.length, 1);
  assert.ok(Math.abs(samples[0].delta - 0.5) < 1e-9, `the 0.8 fall must not count, got ${samples[0].delta}`);
  assert.equal(samples[0].tokens, 2e6);
  const learned = learnCapacity({ jobs, configured: null, options: { reserve_margin: 0.05, capacity_windows: 4, min_window_delta: 0.03, min_trusted_windows: 2 } });
  assert.ok(learned.capacity === null || learned.capacity > 0, 'a drop never makes capacity negative');
});

// ---- configuration
test('config: budget.resets accepts the two thresholds with ranges and refuses anything else', () => {
  assert.doesNotThrow(() => validateBudgetConfig({ resets: { usable_share: 0.5, expiry_warn_days: 30 } }, NAMES));
  assert.doesNotThrow(() => validateBudgetConfig({ resets: {} }, NAMES));
  for (const bad of [{ usable_share: 0 }, { usable_share: 1.5 }, { expiry_warn_days: 0 }, { other: 1 }, 'x', []]) {
    assert.throws(() => validateBudgetConfig({ resets: bad }, NAMES), /invalid budget config/, JSON.stringify(bad));
  }
});

test('dashboard: an expiring reset the tick has raised shows on Needs you with its decision card, and disappears when marked used', async t => {
  const s = await serve(t, { probe: async () => ({ ok: true }) });
  const id = addRecord(s.root, { agent: 'claude', limit: 'weekly', scope: 'fable', expiry: new Date(NOW + 5 * DAY).toISOString().slice(0, 10) }, NAMES, NOW).record.id;
  stepAt(s.root);
  const page = (await s.get('/')).body;
  assert.match(page, /claude: A limit reset is about to lapse \(weekly fable reset\)/);
  assert.match(page, /does not help Foreman/);
  assert.doesNotMatch(page, /has no decision entry for/);
  assert.equal((await s.post(`action=used&id=${id}`)).status, 303);
  assert.doesNotMatch((await s.get('/')).body, /A limit reset is about to lapse/);
});
