// Issue #1093: the Health page (disk use per volume, /tmp growth, host recorder) and readDiskSamples.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readDiskSamples, DAY_MS, clearRecorderCache } from '../supervisor/diagnostics.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { NAV, matchRoute } from '../supervisor/dashrender.mjs';
import { validateTeamConfig } from '../supervisor/team.mjs';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0), GB = 1073741824;
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'health-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const CONFIG = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, max_review_attempts: 2, max_fix_attempts: 2 }, models: { allowance_threshold: 0.8, agents: {} }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
const vol = (p, pct, status = 'ok') => ({ path: p, usedBytes: pct * GB, totalBytes: 100 * GB, status });
const line = (ago, volumes, tmpEntries) => JSON.stringify({ at: NOW - ago, volumes, tmpEntries });
function root(t, lines) {
  const r = tmp(t); fs.mkdirSync(path.join(r, 'dashboard'));
  if (lines !== null) fs.writeFileSync(path.join(r, 'dashboard', 'disk-samples.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  return r;
}
async function get(t, r, config = CONFIG, p = '/health') {
  const server = http.createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root: r, config, host: '127.0.0.1', port, now: () => NOW, recorderDir: path.join(r, 'no-recorder') }));
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
}

test('readDiskSamples: keeps 7 days, marks unreadable volumes, skips damaged lines, reports missing and empty', t => {
  const r = root(t, [line(8 * DAY_MS, [vol('/', 10)], 1), line(DAY_MS, [vol('/', 50), { path: '/mnt/cache', status: 'unreadable' }], 20), 'not json', JSON.stringify({ at: 'x' }), line(0, [vol('/', 60)], 30)]);
  const f = path.join(r, 'dashboard', 'disk-samples.jsonl'), s = readDiskSamples(f, NOW);
  assert.equal(s.status, 'ok'); assert.equal(s.samples.length, 2, 'the 8 day old line and the damaged lines are dropped');
  assert.deepEqual(s.samples[0].volumes[1], { path: '/mnt/cache', usedBytes: null, totalBytes: null, status: 'unreadable' });
  assert.equal(s.samples[1].tmpEntries, 30);
  assert.equal(readDiskSamples(path.join(r, 'nope'), NOW).status, 'missing');
  fs.writeFileSync(f, ''); assert.equal(readDiskSamples(f, NOW).status, 'empty');
  fs.writeFileSync(f, line(DAY_MS, [vol('/', 1)], 1) + '\n'.repeat(3) + line(0, [vol('/', 2)], 2) + '\n');
  assert.equal(readDiskSamples(f, NOW, line(0, [vol('/', 2)], 2).length + 6).samples.length, 1, 'a read bounded to the last bytes drops the cut first line');
  assert.equal(readDiskSamples(r, NOW).status, 'unreadable', 'a directory is unreadable');
});

test('the Health tab is in the navigation and routes', () => {
  assert.ok(NAV.some(([p, h]) => p === 'health' && h === '/health')); assert.deepEqual(matchRoute('/health'), { page: 'health' });
});

test('root at 90 percent is amber and named in the heading; at 97 percent it is red; /tmp change and Processes link show', async t => {
  const amber = await get(t, root(t, [line(DAY_MS + 60000, [vol('/', 80), vol('/mnt/cache', 40)], 100), line(0, [vol('/', 90), vol('/mnt/cache', 40)], 160)]));
  assert.equal(amber.status, 200);
  assert.match(amber.body, /<a href="\/health" aria-current="page">/);
  assert.match(amber.body, /Disk use: \/ above warning level \(90%\)/);
  assert.match(amber.body, /data-health-volume="\/" data-health-level="warn"/); assert.match(amber.body, /data-health-volume="\/mnt\/cache" data-health-level="ok"/);
  assert.match(amber.body, /health-warn/); assert.match(amber.body, /data-level="warning"/); assert.match(amber.body, /data-level="alert"/, 'both levels are drawn');
  assert.match(amber.body, /data-health-tmp="160"/); assert.match(amber.body, /\+60 over the last 24 hours/);
  assert.match(amber.body, /href="\/system\/processes"/); assert.match(amber.body, /data-card="health-recorder"/);
  assert.doesNotMatch(amber.body, /undefined|NaN/);
  const red = await get(t, root(t, [line(0, [vol('/', 97)], 5)]));
  assert.match(red.body, /Disk use: \/ at alert level \(97%\)/); assert.match(red.body, /health-alert/); assert.match(red.body, /data-health-level="alert"/);
  const fine = await get(t, root(t, [line(0, [vol('/', 40)], 5)]));
  assert.doesNotMatch(fine.body, /above warning|at alert level|health-warn|health-alert/);
});

test('thresholds come from team.json health settings', async t => {
  const r = root(t, [line(0, [vol('/', 70)], 5)]);
  assert.match((await get(t, r, { ...CONFIG, health: { disk_warn_percent: 60, disk_alert_percent: 80 } })).body, /\/ above warning level \(70%\)/);
  assert.doesNotMatch((await get(t, r)).body, /above warning level/, 'defaults are 85 and 95');
});

test('a missing or empty samples file says so and the page still renders; an unreadable volume is listed as unreadable', async t => {
  clearRecorderCache();
  for (const r of [root(t, null), root(t, [])]) {
    const res = await get(t, r);
    assert.equal(res.status, 200); assert.match(res.body, /No disk samples yet/); assert.doesNotMatch(res.body, /<polyline/); assert.match(res.body, /data-card="health-recorder"/);
  }
  const res = await get(t, root(t, [line(0, [vol('/', 30), { path: '/mnt/cache', status: 'unreadable' }], 3)]));
  assert.match(res.body, /data-health-volume="\/mnt\/cache" data-health-level="unreadable"/); assert.match(res.body, /Unreadable/);
});

test('the Diagnostics page no longer shows the recorder card', async t => {
  const res = await get(t, root(t, null), CONFIG, '/diagnostics');
  assert.equal(res.status, 200); assert.doesNotMatch(res.body, /diag-recorder|memory flight recorder/);
});

test('health config validation rejects bad levels', () => {
  assert.doesNotThrow(() => validateTeamConfig({ ...CONFIG, health: { disk_warn_percent: 80 } }));
  for (const health of [{ disk_warn_percent: 95, disk_alert_percent: 90 }, { disk_warn_percent: 0 }, { disk_alert_percent: 101 }, { other: 1 }, []]) assert.throws(() => validateTeamConfig({ ...CONFIG, health }), /health/);
});

test('style.css gives the warn and alert cards amber and red styling', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.card\.health-warn\{[^}]*var\(--warning/);
  assert.match(css, /\.card\.health-alert\{[^}]*var\(--action/);
});
