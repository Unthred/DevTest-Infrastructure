// Issue #949: foreman_alerts (D-030). Real dashboard handler over a temporary state root, real MCP tool over HTTP. Secret-shaped fixtures are
// assembled at run time; no model is called and no real state is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { alertsView, normaliseAlert } from '../supervisor/alertsview.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { getJson } from '../foreman-mcp/source.mjs';

const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const PW = ['pass', 'word'].join(''), PWVAL = ['hunter2', 'hunter2x'].join('');
const HOUR = 3600000, DAY = 86400000, NOW = Date.UTC(2026, 10, 7, 12);
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const write = (root, rows, raw = '') => { fs.mkdirSync(path.join(root, 'team'), { recursive: true }); fs.writeFileSync(path.join(root, 'team', 'alerts.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n' + raw); };
const rows = () => [
  { at: NOW - 1 * HOUR, text: 'PR #538 needs you: head abc1234def is stuck', delivered: true },
  { at: NOW - 2 * HOUR, text: 'PR #540 needs you: head 9f8e7d6c5b is stuck', delivered: false },
  { at: NOW - 3 * HOUR, text: `Job 12 failed ${PW}=${PWVAL} ${GH}`, delivered: true },
  { at: NOW - 30 * HOUR, text: 'PR #12 needs you: head 1111111aaa is stuck', delivered: true },
  { at: NOW - 9 * DAY, text: 'ancient', delivered: true },
];

test('normaliseAlert strips numbers, SHAs, paths, URLs and quoted names', () => {
  assert.equal(normaliseAlert('PR #538 head abc1234def'), normaliseAlert('PR #12 head 9f8e7d6c5b'));
  assert.equal(normaliseAlert('branch claude/issue-9-x failed'), normaliseAlert('branch codex/issue-77-y failed'));
  assert.equal(normaliseAlert('job "alpha" took 5 min'), normaliseAlert("job 'beta' took 90 min"));
  assert.notEqual(normaliseAlert('merge failed'), normaliseAlert('review failed'), 'different words stay different');
  assert.equal(normaliseAlert(undefined), '');
});

test('alertsView: last day newest first, groups, per-day totals, redaction', t => {
  const root = tmp(t); write(root, rows());
  const v = alertsView(root, { now: NOW });
  assert.equal(v.matching, 3); assert.deepEqual(v.alerts.map(a => a.delivered), [true, false, true]);
  assert.ok(v.alerts[0].at > v.alerts[1].at);
  const g = v.groups[0]; assert.equal(g.count, 2); assert.equal(g.delivered, 1); assert.equal(g.notDelivered, 1); assert.ok(g.firstAt < g.lastAt);
  assert.equal(v.perDay.reduce((n, d) => n + d.total, 0), 4, 'seven days, not the 9 day old one'); assert.equal(v.perDay[0].day, '2026-11-07');
  for (const bad of [GH, PWVAL]) assert.ok(!JSON.stringify(v).includes(bad));
});

test('alertsView filters: since, contains, delivered, limit; bad values are refused', t => {
  const root = tmp(t); write(root, rows());
  assert.equal(alertsView(root, { now: NOW, since: new Date(NOW - 2 * DAY).toISOString() }).matching, 4);
  assert.equal(alertsView(root, { now: NOW, contains: 'STUCK' }).matching, 2);
  assert.equal(alertsView(root, { now: NOW, contains: 'nothing like this' }).matching, 0);
  assert.equal(alertsView(root, { now: NOW, delivered: false }).matching, 1);
  assert.equal(alertsView(root, { now: NOW, delivered: 'true' }).matching, 2);
  const one = alertsView(root, { now: NOW, limit: 1 }); assert.equal(one.shown, 1); assert.equal(one.matching, 3);
  assert.throws(() => alertsView(root, { now: NOW, since: 'yesterday-ish' }), /since/);
  assert.throws(() => alertsView(root, { now: NOW, delivered: 'maybe' }), /delivered/);
});

test('alertsView copes with a missing file, damaged lines and a cut first line', t => {
  const root = tmp(t);
  assert.equal(alertsView(root, { now: NOW }).matching, 0);
  write(root, rows().slice(0, 1), 'not json\n{"at":"x"}\n[1]\n');
  assert.equal(alertsView(root, { now: NOW }).matching, 1);
});

async function serve(t, root) {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config: () => ({}), host: '127.0.0.1', port, recorderDir: null }));
  const raw = (method, p) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}` } }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b })); }); q.on('error', rej); q.end(); });
  return { base: `http://127.0.0.1:${port}`, raw };
}

test('end to end: GET-only route, the tool, filters, errors, and an unchanged log', async t => {
  const root = tmp(t); const at = Date.now(); write(root, [{ at: at - HOUR, text: 'PR #1 stuck', delivered: true }, { at: at - 2 * HOUR, text: `PR #2 stuck ${GH}`, delivered: false }]);
  const before = fs.readFileSync(path.join(root, 'team', 'alerts.jsonl'), 'utf8');
  const s = await serve(t, root);
  assert.notEqual((await s.raw('POST', '/api/alerts.json')).status, 200);
  assert.equal((await s.raw('GET', '/api/alerts.json?since=garbage')).status, 400);
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), getPath: p => getJson(new URL(p, `${s.base}/api/view.json`).href) });
  const def = tools.list().find(x => x.name === 'foreman_alerts'); assert.ok(def); assert.equal(def.annotations.readOnlyHint, true); assert.equal(def.annotations.destructiveHint, false);
  const all = await tools.call('foreman_alerts'); assert.equal(all.isError, false);
  const v = JSON.parse(all.text); assert.equal(v.matching, 2); assert.equal(v.groups.length, 2, 'a redacted token makes its own pattern'); assert.ok(!all.text.includes(GH));
  assert.equal(JSON.parse((await tools.call('foreman_alerts', { delivered: false })).text).matching, 1);
  assert.equal(JSON.parse((await tools.call('foreman_alerts', { limit: 1 })).text).shown, 1);
  assert.equal((await tools.call('foreman_alerts', { since: 'garbage' })).isError, true);
  assert.equal((await createTools({ source: { get: async () => ({}) }, readHost: () => ({}) }).call('foreman_alerts')).isError, true, 'no dashboard address');
  assert.equal(fs.readFileSync(path.join(root, 'team', 'alerts.jsonl'), 'utf8'), before, 'log untouched');
});
