// Issue #1159: limit resets (record, scope, expiry, applied-reset detection, the Usage card and its write route).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { handler, DASHBOARD_VIEW_TTL_MS } from '../supervisor/dashserver.mjs';
const NOW = Date.UTC(2026, 10, 2, 15, 0, 0);
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [11] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash467w-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  const cache = { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
  const clock = { now: NOW };
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const port = server.address().port;
  server.on('request', handler({ root, config: { ...config, ...MODELS }, host: '127.0.0.1', port, now: () => clock.now, viewTtlMs: DASHBOARD_VIEW_TTL_MS }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } };
    const r = http.request(options, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); r.end(body);
  });
  const formHeaders = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' };
  const form = (p, body, extra = {}) => req('POST', p, { headers: { ...formHeaders, ...extra }, body: `${body}&proof=${writeToken(root)}` });
  return { clock, root, port, req, form, get: p => req('GET', p) };
}

import { appliedResets, isAppliedReset, restoredIn } from '../supervisor/resetdetect.mjs';
import { capacitySamples, learnCapacity } from '../supervisor/capacity.mjs';
import { assessAgent, weeklyHistory, DEFAULT_BUDGET } from '../supervisor/budget.mjs';
import { scopeCovers, expiryOf, helpsForeman, resetsView, modelsOf, holdingLimit } from '../supervisor/resetsview.mjs';
import { applyReset, readResets, scopeOf } from '../supervisor/limitresets.mjs';
import { limitResetEntries } from '../supervisor/resetsentries.mjs';
import { recordTimeline, readTimeline, entryText } from '../supervisor/history.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const WEEK_END = NOW + 2 * DAY;
const MODELS = { models: { agents: { claude: { implement: { model: 'sonnet' }, review: { model: 'opus' } } } } };
const point = (hoursAgo, used, resetsAt = WEEK_END) => ({ at: NOW - hoursAgo * HOUR, used, resetsAt });
const tmpRoot = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'limres-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); return r; };

test('scope matching against the model config: Fable only does not cover Sonnet and Opus, all models does', () => {
  const models = modelsOf(MODELS, 'claude');
  assert.deepEqual(models, ['sonnet', 'opus']);
  assert.equal(scopeCovers('fable', models), false);
  assert.equal(scopeCovers('all', models), true);
  assert.equal(scopeCovers('opus', models), true);
  assert.equal(scopeCovers('fable', ['claude-fable-5-2']), true, 'a full model name holding the family is covered');
  assert.equal(scopeCovers('all', []), true);
  assert.equal(scopeOf('  Fable '), 'fable');
  assert.equal(scopeOf(''), 'all');
  assert.equal(scopeOf('no spaces allowed'), null);
});

test('Helps Foreman now: yes only when the scope is covered and the agent is held; otherwise it says why', () => {
  const held = { mode: 'reviews_only', label: 'reviews only', used: 0.97, hoursLeft: 19, capacity: { capacity: 6e6 }, shortWindow: null };
  const expiry = expiryOf('2027-03-08', NOW);
  const base = { models: ['sonnet', 'opus'], expiry, now: NOW };
  const all = helpsForeman({ ...base, reset: { limit: 'weekly', scope: 'all', usedAt: null }, budget: held });
  assert.equal(all.yes, true);
  assert.match(all.text, /about 5\.8M tokens restored/);
  assert.match(all.text, /19h to the natural weekly reset, which a reset does not move/);
  const fable = helpsForeman({ ...base, reset: { limit: 'weekly', scope: 'fable', usedAt: null }, budget: held });
  assert.equal(fable.yes, false);
  assert.equal(fable.text, 'covers fable only; Foreman runs sonnet and opus');
  const free = helpsForeman({ ...base, reset: { limit: 'weekly', scope: 'all', usedAt: null }, budget: { ...held, mode: 'normal' } });
  assert.equal(free.yes, false);
  assert.match(free.text, /not held by allowance/);
  assert.equal(helpsForeman({ ...base, reset: { limit: 'weekly', scope: 'all', usedAt: NOW }, budget: held }).text, 'already used');
  const unknown = helpsForeman({ ...base, reset: { limit: 'weekly', scope: 'all', usedAt: null }, budget: { ...held, capacity: null } });
  assert.match(unknown.text, /tokens restored not known/);
});

test('Helps Foreman now matches the reset limit to the window that holds the agent', () => {
  const base = { models: ['sonnet', 'opus'], expiry: expiryOf('2027-03-08', NOW), now: NOW };
  const weeklyHold = { mode: 'reviews_only', label: 'reviews only', used: 0.97, hoursLeft: 19, capacity: { capacity: 6e6 }, shortWindow: { used: 0.1, resetsAt: NOW + HOUR } };
  const fiveHold = { mode: 'waiting', label: 'waiting', reason: 'short window 100%: used up; waits for its reset', used: 0.4, hoursLeft: 100, capacity: { capacity: 1e7 }, shortWindow: { used: 1, resetsAt: NOW + HOUR } };
  const r = limit => ({ limit, scope: 'all', usedAt: null });
  const a = helpsForeman({ ...base, reset: r('five_hour'), budget: weeklyHold });
  assert.equal(a.yes, false, 'a five-hour reset frees nothing under a weekly hold');
  assert.match(a.text, /held by the weekly limit/);
  const b = helpsForeman({ ...base, reset: r('weekly'), budget: fiveHold });
  assert.equal(b.yes, false, 'a weekly reset frees nothing while the five-hour window is exhausted');
  assert.match(b.text, /held by the five-hour limit/);
  assert.equal(helpsForeman({ ...base, reset: r('five_hour'), budget: fiveHold }).yes, true);
  assert.equal(helpsForeman({ ...base, reset: r('weekly'), budget: weeklyHold }).yes, true);
  assert.equal(helpsForeman({ ...base, reset: r('weekly'), budget: { mode: 'waiting', reason: 'the provider reports paid overage in use', label: 'waiting' } }).yes, false);
});

test('holdingLimit agrees with the reasons the real budget assessment gives', () => {
  const win = (type, used, mins) => ({ type, utilization: used, resetsAt: NOW + 5 * HOUR, windowMinutes: mins });
  const run = windows => assessAgent({ allowance: { observedAt: NOW, windows }, now: NOW });
  assert.equal(holdingLimit(run([win('seven_day', 0.999, 10080)])), 'weekly');
  assert.equal(holdingLimit(run([win('seven_day', 0.3, 10080), win('five_hour', 0.999, 300)])), 'five_hour');
});

test('expiry colouring: amber within 14 days, plain beyond, red once expired', () => {
  const date = days => new Date(NOW + days * DAY).toISOString().slice(0, 10);
  assert.equal(expiryOf(date(14), NOW).severity, 'warning');
  assert.equal(expiryOf(date(15), NOW).severity, 'ok');
  assert.equal(expiryOf(date(3), NOW).severity, 'warning');
  assert.equal(expiryOf(date(40), NOW).severity, 'ok');
  assert.equal(expiryOf(date(-2), NOW).severity, 'action');
  assert.equal(expiryOf(null, NOW).severity, 'info');
  assert.match(expiryOf(date(3), NOW).text, /3 days left/);
});

test('a mid-window drop is an applied reset; a real window rollover is not', () => {
  const drop = [point(10, 0.9), point(8, 0.95), point(6, 0.4)];
  assert.equal(appliedResets(drop).length, 1);
  assert.equal(appliedResets(drop)[0].restored.toFixed(2), '0.55');
  const rollover = [point(10, 0.9, NOW - 2 * HOUR), point(1, 0.05, NOW + 7 * DAY)];
  assert.equal(appliedResets(rollover).length, 0, 'the reset time moved: a new window, not a reset');
  const expired = [point(10, 0.9, NOW - 3 * HOUR), { at: NOW - 1 * HOUR, used: 0.1, resetsAt: NOW - 3 * HOUR }];
  assert.equal(isAppliedReset(expired[0], expired[1]), false, 'a reading after the reset time is a stale window, not an applied reset');
  assert.equal(appliedResets([point(5, 0.5), point(4, 0.45)]).length, 0, 'a small dip is noise');
  assert.equal(restoredIn(drop, WEEK_END).toFixed(2), '0.55');
});

const job = (hoursAgo, used, tokens, resetsAt = WEEK_END) => ({ usage: { inputTokens: tokens, outputTokens: 0 },
  allowance: { observedAt: NOW - hoursAgo * HOUR, windows: [{ type: 'seven_day', utilization: used, resetsAt }] } });

test('learned capacity: a reset-driven drop never corrupts the size of the week; a clean history still learns', () => {
  const w1 = WEEK_END - 7 * DAY, w2 = WEEK_END - 14 * DAY;
  const clean = [job(300, 0.1, 0, w2), job(290, 0.3, 1e6, w2), job(150, 0.1, 0, w1), job(140, 0.3, 1e6, w1)];
  const sizeOfW1 = jobs => capacitySamples(jobs).find(s => s.resetsAt === w1);
  const base = learnCapacity({ jobs: clean });
  assert.equal(base.source, 'learned');
  assert.equal(Math.round(base.capacity), 5e6);
  // Same window with a reset applied inside it: use falls from 0.9 to 0.2 across a job that spent 4M tokens, then a job adds 0.2.
  const withReset = [...clean, job(100, 0.9, 3e6, w1), job(90, 0.2, 4e6, w1), job(80, 0.4, 1e6, w1)];
  const samples = sizeOfW1(withReset);
  assert.equal(samples.tokens, 5e6, 'the 4M tokens of the job across the reset are left out');
  assert.ok(Math.abs(samples.delta - 1.0) < 1e-9, 'and so is the 0.7 fall'); 
  const after = learnCapacity({ jobs: withReset });
  assert.ok(Math.abs(after.capacity - 5e6) / 5e6 < 0.2, `capacity stays near 5M, got ${Math.round(after.capacity)}`);
});

test('run-out estimate: use given back by a reset is not read as a slower burn, and readings before it are not the recent rate', () => {
  const resetsAt = NOW + 3 * DAY;
  const allowance = { observedAt: NOW, windows: [{ type: 'seven_day', utilization: 0.5, resetsAt }] };
  const plain = assessAgent({ allowance, history: [point(40, 0.0, resetsAt), point(0, 0.5, resetsAt)], settings: DEFAULT_BUDGET, now: NOW });
  const given = [point(40, 0.0, resetsAt), point(30, 0.9, resetsAt), point(20, 0.4, resetsAt), point(0, 0.5, resetsAt)];
  const reset = assessAgent({ allowance, history: given, settings: DEFAULT_BUDGET, now: NOW });
  assert.ok(reset.ratePerHour > plain.ratePerHour, 'the gross burn counts what the reset gave back');
  const snapshot = (hoursAgo, used) => ({ at: NOW - hoursAgo * HOUR, allowance: { claude: { observedAt: NOW - hoursAgo * HOUR, windows: [{ type: 'seven_day', utilization: used, resetsAt }] } } });
  const hist = weeklyHistory([snapshot(5, 0.9), snapshot(3, 0.4)], 'claude');
  assert.equal(appliedResets(hist).length, 1);
});

test('the record store: add, edit, mark used, delete, and refusals', t => {
  const root = tmpRoot(t);
  const ctx = { agents: ['claude', 'codex'], now: NOW };
  assert.equal(applyReset(root, 'add', { agent: 'claude', limit: 'weekly', scope: 'Fable', expires: '2027-03-08' }, ctx).ok, true);
  const [r] = readResets(root);
  assert.deepEqual([r.agent, r.limit, r.scope, r.expires, r.usedAt], ['claude', 'weekly', 'fable', '2027-03-08', null]);
  assert.equal(applyReset(root, 'edit', { id: r.id, scope: '', limit: 'five_hour' }, ctx).ok, true);
  assert.deepEqual([readResets(root)[0].scope, readResets(root)[0].limit], ['all', 'five_hour']);
  assert.equal(applyReset(root, 'use', { id: r.id }, ctx).ok, true);
  assert.equal(readResets(root)[0].usedAt, NOW);
  assert.equal(applyReset(root, 'unuse', { id: r.id }, ctx).ok, true);
  assert.equal(readResets(root)[0].usedAt, null);
  const weekly = { agent: 'claude', limit: 'weekly' };
  const refusals = [{ agent: 'nobody', limit: 'weekly' }, { agent: 'claude', limit: 'daily' }, { ...weekly, scope: 'a b' }, { ...weekly, expires: '2027-02-30' }, { ...weekly, expires: 'soon' }];
  for (const bad of refusals) {
    assert.equal(applyReset(root, 'add', bad, ctx).ok, false, JSON.stringify(bad));
  }
  assert.equal(readResets(root).length, 1, 'refused adds changed nothing');
  assert.equal(applyReset(root, 'delete', { id: 'nope' }, ctx).ok, false);
  assert.equal(applyReset(root, 'delete', { id: r.id }, ctx).ok, true);
  assert.deepEqual(readResets(root), []);
  assert.equal(fs.readdirSync(root).includes('limit-resets.json'), true, 'kept in Foreman state, in the state root');
});

test('the card: empty agents show nothing, a reset shows scope, expiry and the Helps Foreman line', () => {
  const none = resetsView({ resets: [], config: MODELS, budget: {}, applied: {}, agents: ['claude', 'codex'], now: NOW });
  assert.deepEqual(none.byAgent, {});
  const record = { id: 'a1', agent: 'claude', limit: 'weekly', scope: 'fable', expires: '2027-03-08', usedAt: null };
  const view = resetsView({ resets: [record], config: MODELS, budget: {}, applied: {}, agents: ['claude', 'codex'], now: NOW });
  assert.deepEqual(Object.keys(view.byAgent), ['claude'], 'codex has no record, so no section');
  assert.equal(view.byAgent.claude.resets[0].helps.text, 'covers fable only; Foreman runs sonnet and opus');
});

test('the Usage page: record a reset through the real route, see the card; a bad proof or origin changes nothing', async t => {
  const s = await serve(t);
  const empty = (await s.get('/usage')).body;
  assert.match(empty, /id="u-resets"|data-card="u-resets"|u-resets/);
  assert.match(empty, /No limit resets recorded/);
  const origin = `http://127.0.0.1:${s.port}`;
  const headers = { origin, 'content-type': 'application/x-www-form-urlencoded' };
  const refused = await s.req('POST', '/limit-resets', { headers, body: 'action=add&agent=claude&limit=weekly&proof=wrong' });
  assert.equal(refused.status, 403);
  const crossOrigin = await s.form('/limit-resets', 'action=add&agent=claude&limit=weekly', { origin: 'http://evil.example' });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(readResets(s.root), []);
  const soon = new Date(NOW + 5 * DAY).toISOString().slice(0, 10);
  const ok = await s.form('/limit-resets', `action=add&agent=claude&limit=weekly&scope=fable&expires=${soon}`);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/usage');
  const page = (await s.get('/usage')).body;
  assert.match(page, /data-agent="claude"/);
  assert.match(page, /weekly limit<\/b>, fable models only/);
  assert.match(page, /Helps Foreman now: covers fable only; Foreman runs [a-z ]*/);
  assert.match(page, /data-expiry="amber"/, 'within 14 days is amber');
  assert.doesNotMatch(page, /<section data-agent="codex"/, 'an agent without records shows nothing');
  s.clock.now += 2000;   // past the write cooldown
  const id = readResets(s.root)[0].id;
  const bad = await s.form('/limit-resets', `action=add&agent=claude&limit=hourly`);
  assert.equal(bad.status, 400);
  s.clock.now += 2000;   // past the write cooldown
  assert.equal((await s.form('/limit-resets', `action=use&id=${id}`)).status, 303);
  assert.ok(readResets(s.root)[0].usedAt);
  assert.match((await s.get('/usage')).body, /Helps Foreman now: already used/);
  s.clock.now += 2000;   // past the write cooldown
  assert.equal((await s.form('/limit-resets', `action=delete&id=${id}`)).status, 303);
  assert.deepEqual(readResets(s.root), []);
});

test('an applied reset is recorded in the history timeline once, and a rollover is not', t => {
  const root = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  const snap = (hoursAgo, used, resetsAt) => {
    const windows = [{ type: 'seven_day', utilization: used, resetsAt }];
    return JSON.stringify({ at: NOW - hoursAgo * HOUR, allowance: { claude: { observedAt: NOW - hoursAgo * HOUR, windows } } });
  };
  const lines = [snap(30, 0.9, WEEK_END), snap(20, 0.3, WEEK_END), snap(10, 0.35, WEEK_END), snap(5, 0.02, WEEK_END + 7 * DAY)];
  fs.writeFileSync(path.join(root, 'dashboard', 'snapshots.jsonl'), `${lines.join('\n')}\n`);
  const cfg = { agents: { claude: { provider: 'claude' } } };
  const entries = limitResetEntries({ root, config: cfg });
  assert.equal(entries.length, 1, 'one applied reset; the rollover at the end is not one');
  assert.equal(entries[0].kind, 'limit_reset');
  recordTimeline(root, { config: cfg, jobs: [], events: [], state: {}, incidents: [] });
  recordTimeline(root, { config: cfg, jobs: [], events: [], state: {}, incidents: [] });
  const tl = readTimeline(root).filter(e => e.kind === 'limit_reset');
  assert.equal(tl.length, 1, 'recorded once however many passes see it');
  assert.match(entryText(tl[0]), /limit reset applied: weekly use fell from 90% to 30%/);
});

test('a second write inside the cooldown changes nothing and a refused write gives its slot back', async t => {
  const s = await serve(t);
  const body = 'action=add&agent=claude&limit=weekly';
  assert.equal((await s.form('/limit-resets', body)).status, 303);
  const soon = await s.form('/limit-resets', body);
  assert.match(soon.headers.location, /limit-resets-cooldown/);
  assert.equal(readResets(s.root).length, 1);
  s.clock.now += 2000;
  assert.equal((await s.form('/limit-resets', 'action=add&agent=claude&limit=bad')).status, 400);
  assert.equal((await s.form('/limit-resets', body)).status, 303, 'the refused write did not use the slot');
  assert.equal(readResets(s.root).length, 2);
});
