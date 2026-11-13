// Issue #1162: advice on the #1159 records: the card, the refresh on Mark used, the Needs you item (once per window) and the tick step.
// The dashboard cases go through the real handler; the tick cases go through the real tick step with a team-shaped object.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { readResets, applyReset } from '../supervisor/limitresets.mjs';
import { limitResetStep } from '../supervisor/resetstep.mjs';
import { recordTick } from '../supervisor/dashdata.mjs';
import { resetAdviceFor } from '../supervisor/resetsbuild.mjs';
import { budgetView } from '../supervisor/budgetview.mjs';
import { planNotices, readNotices, windowKeyOf } from '../supervisor/resetnotices.mjs';
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
const add = (root, form) => applyReset(root, 'add', form, { agents: NAMES, now: NOW });
const tmp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset1162-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

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
  const post = (body, { proof = true, origin = `http://127.0.0.1:${port}` } = {}) => req('POST', '/limit-resets', { headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: proof ? `${body}&proof=${writeToken(root)}` : body });
  return { root, req, post, woken, get: p => req('GET', p) };
}

test('dashboard: the Limit resets card lists a Fable reset as not helping Foreman, with its expiry and the spacing for several', async t => {
  const s = await serve(t);
  for (let i = 0; i < 3; i++) assert.equal((await s.post('action=add&agent=claude&limit=weekly&scope=fable&expires=2027-03-08')).status, 303);
  assert.equal((await s.post('action=add&agent=claude&limit=weekly&scope=all&expires=')).status, 303);
  const page = (await s.get('/usage')).body;
  assert.match(page, /data-card="u-resets"|id="u-resets"/);
  assert.equal((page.match(/data-verdict="lost_cause"/g) || []).length, 3);
  assert.match(page, /Does not help Foreman/);
  assert.match(page, /Helps Foreman now: /, 'the #1159 line stays');
  assert.match(page, /3 left, \d+ weeks: one every \d+ weeks? keeps them all/);
  assert.match(page, /no expiry recorded/);
  assert.match(page, /action="\/limit-resets"/);
});

test('dashboard: a write needs the access proof and the right origin, and changes nothing without them', async t => {
  const s = await serve(t);
  const noProof = await s.post('action=add&agent=claude&limit=weekly&scope=all', { proof: false });
  assert.equal(noProof.status, 403);
  const foreign = await s.post('action=add&agent=claude&limit=weekly&scope=all', { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(readResets(s.root).length, 0);
  const bad = await s.post('action=add&agent=nobody&limit=weekly');
  assert.equal(bad.status, 400);
  assert.equal((await s.post('action=explode')).status, 400);
});

test('dashboard: marking a reset used requests an allowance refresh for that agent and wakes the tick', async t => {
  const probed = [];
  const s = await serve(t, { probe: async o => { probed.push(o.agent); return { ok: true }; } });
  await s.post('action=add&agent=claude&limit=weekly&scope=all');
  const id = readResets(s.root)[0].id;
  const r = await s.post(`action=use&id=${id}`);
  assert.equal(r.status, 303);
  assert.deepEqual(probed, ['claude']);
  assert.equal(readResets(s.root)[0].usedAt !== null, true);
  assert.equal(s.woken.length, 1);
});

// ---- the tick step: notices once per window, the drop event
const job = (provider, from, to, tokens) => ({ id: `${provider}${from}`, provider, createdAt: from, updatedAt: to, usage: { inputTokens: tokens, outputTokens: 0 } });
function team(root, over = {}) {
  const m = { mode: 'reviews_only', used: 0.97, resetsAt: NOW + 4 * DAY, hoursLeft: 96, reason: '', known: true, capacity: { basis: 'absolute', used: 0.97, capacity: 10e6, belowReserve: true }, ...over.mode };
  return { root, clock: { now: () => over.now ?? NOW }, c: CONFIG, modes: { claude: m }, held: over.held ?? { claude: { implement: 'reviews only' } },
    usage: { jobs: [job('claude', NOW - 30 * HOUR, NOW - 20 * HOUR, 1e6), job('claude', NOW - 15 * HOUR, NOW - 5 * HOUR, 1e6)], allowance: {} } };
}
const stepAt = (root, over) => limitResetStep(team(root, over));
const attention = (root, over) => {
  const tm = team(root, over);
  return resetAdviceFor({ root, config: CONFIG, budget: budgetView(tm), jobs: tm.usage.jobs, allowance: {}, now: tm.clock.now() }).attention;
};

test('tick: one Needs you item per reset per weekly window; it closes when marked used or the condition lapses and is not raised again', t => {
  const root = tmp(t);
  const id = (add(root, { agent: 'claude', limit: 'weekly', scope: 'all', expires: '2027-03-08' }), readResets(root).at(-1).id);
  assert.deepEqual(attention(root), [], 'nothing is shown before the tick has raised it');
  stepAt(root);
  stepAt(root);   // a second pass in the same window raises nothing new
  const items = attention(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `resets-${id}`);
  assert.equal(items[0].severity, 'action');
  assert.match(items[0].text, /claude: Applying a limit reset now would turn most of it into work/);
  assert.equal(Object.keys(readNotices(root).notices).length, 1);

  stepAt(root, { held: {} });   // the work ran out: the condition lapsed
  assert.equal(readNotices(root).notices[id].status, 'closed');
  assert.deepEqual(attention(root, { held: {} }), []);
  stepAt(root);   // held again in the SAME window: still not raised again
  assert.equal(readNotices(root).notices[id].status, 'closed');
  assert.deepEqual(attention(root), []);

  stepAt(root, { mode: { resetsAt: NOW + 11 * DAY } });   // the next window: raised once more
  assert.equal(readNotices(root).notices[id].status, 'open');
  assert.equal(attention(root, { mode: { resetsAt: NOW + 11 * DAY } }).length, 1);

  applyReset(root, 'use', { id }, { agents: NAMES, now: NOW });
  assert.deepEqual(attention(root, { mode: { resetsAt: NOW + 11 * DAY } }), [], 'gone at once when marked used');
  stepAt(root, { mode: { resetsAt: NOW + 11 * DAY } });
  assert.equal(readNotices(root).notices[id].status, 'closed');
  assert.match(readNotices(root).notices[id].closedBecause, /marked used/);
});

test('notices: planNotices raises only for use now or use before expiry and keys on the window', () => {
  const advice = [{ id: 'a', agent: 'claude', verdict: 'use_now' }, { id: 'b', agent: 'claude', verdict: 'hold' }, { id: 'c', agent: 'claude', verdict: 'use_before_expiry' }];
  const next = planNotices({ notices: {}, advice, windowKeys: { claude: '5' }, knownIds: new Set(['a', 'b', 'c']), now: NOW });
  assert.deepEqual(Object.keys(next).sort(), ['a', 'c']);
  assert.equal(next.a.window, '5');
  assert.equal(windowKeyOf(undefined), 'none');
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
  const id = (add(s.root, { agent: 'claude', limit: 'weekly', scope: 'fable', expires: new Date(NOW + 5 * DAY).toISOString().slice(0, 10) }), readResets(s.root).at(-1).id);
  stepAt(s.root);
  const page = (await s.get('/')).body;
  assert.match(page, /claude: A limit reset is about to lapse \(weekly fable reset\)/);
  assert.match(page, /does not help Foreman/);
  assert.doesNotMatch(page, /has no decision entry for/);
  assert.equal((await s.post(`action=use&id=${id}`)).status, 303);
  assert.doesNotMatch((await s.get('/')).body, /A limit reset is about to lapse/);
});

test('tick: the recorded tick (the real entry point the dispatcher calls) opens the notice for a reset worth using', t => {
  const root = tmp(t);
  add(root, { agent: 'claude', limit: 'weekly', scope: 'all', expires: '2027-03-08' });
  recordTick(root, { now: NOW, status: 'ok', team: { ...team(root), view: { prs: [], issues: [] }, tickLedger: {} }, jobs: [] });
  assert.deepEqual(Object.values(readNotices(root).notices).map(n => n.status), ['open']);
});
