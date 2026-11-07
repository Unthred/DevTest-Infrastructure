// Issue #635: foreman_diagnostics, foreman_waste, foreman_config and foreman_budget (D-030). Real dashboard handler over a temporary state root, real
// MCP tools over HTTP. Every secret-shaped fixture is assembled at run time; no model is called and no real state is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { wasteByCause, scrubConfig, configDiff, configView } from '../supervisor/mcpreads.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { applyLocalOverride } from '../supervisor/team.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { getJson } from '../foreman-mcp/source.mjs';

const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const PW = ['pass', 'word'].join(''), PWVAL = ['hunter2', 'hunter2x'].join('');
const SK = ['sk', 'abcdefghijklmnop1234567890'].join('-');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reads1-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const SHIPPED = new URL('../supervisor/team.json', import.meta.url).pathname;
const BASE = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/nonexistent/repo', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  budget: { enabled: true, high_water: 0.85, exhausted_at: 0.995 }, limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [3] } } };
const DAY = 86400000, NOW = Date.UTC(2026, 10, 6, 12);
const w = (job, ago, cost, cause, tokens = 100) => ({ job, at: NOW - ago, type: 'review', cause, agent: 'claude', pr: 9, tokens, cost });

test('wasteByCause groups cost and tokens by cause, per UTC day, newest first, and honours days', () => {
  const waste = Object.fromEntries([w('a', 1000, 1.256, 'review:no-verdict'), w('b', 2000, 0.5, 'review:no-verdict'), w('c', 3000, 2, 'ci-fix:failed'), w('d', 2 * DAY, 0.4, 'review:no-verdict'), w('e', 6.5 * DAY, 9, 'old')].map(x => [x.job, x]));
  const r = wasteByCause({ breaker: { waste } }, { now: NOW, days: 3 });
  assert.equal(r.jobs, 4); assert.equal(r.totalTokens, 400); assert.equal(r.totalCostUsdEquivalent, 4.16);
  assert.deepEqual(r.byCause.map(c => [c.cause, c.jobs, c.costUsdEquivalent]), [['review:no-verdict', 3, 2.16], ['ci-fix:failed', 1, 2]], 'sorted by cost, the old record is outside the span');
  assert.deepEqual(r.byDay.map(d => d.day), ['2026-11-06', '2026-11-04']);
  assert.equal(r.byDay[0].causes.find(c => c.cause === 'review:no-verdict').jobs, 2);
  assert.equal(wasteByCause({ breaker: { waste } }, { now: NOW, days: 30 }).jobs, 5);
  assert.equal(wasteByCause({ breaker: { waste } }, { now: NOW, days: 'junk' }).days, 7, 'bad days falls back to 7');
});

test('wasteByCause copes with missing, empty and damaged state and redacts the cause', () => {
  for (const s of [null, {}, { breaker: {} }, { breaker: { waste: { x: null, y: 'junk', z: { at: 'no' } } } }]) { const r = wasteByCause(s, { now: NOW }); assert.equal(r.jobs, 0); assert.deepEqual(r.byCause, []); assert.deepEqual(r.byDay, []); }
  const r = wasteByCause({ breaker: { waste: { a: w('a', 10, 1, `review:x ${PW}=${PWVAL} ${GH}`) } } }, { now: NOW });
  for (const bad of [GH, PWVAL]) assert.ok(!JSON.stringify(r).includes(bad));
});

test('scrubConfig removes secret-named values, alert command arguments and secret-shaped strings, and keeps numbers and booleans', () => {
  const out = scrubConfig({ webhook_secret: 'abc', githubToken: GH, max_tokens: 5, ok: true, note: `uses ${SK} here`, alerts: { command: ['/usr/bin/notify', '--key', GH] }, nested: [{ api_key: { a: 1 } }, { name: 'fine' }] });
  assert.equal(out.webhook_secret, '[removed]'); assert.equal(out.githubToken, '[removed]'); assert.equal(out.max_tokens, 5); assert.equal(out.ok, true);
  assert.deepEqual(out.alerts.command, ['/usr/bin/notify', '[2 argument(s) removed]']);
  assert.equal(out.nested[0].api_key, '[removed]'); assert.equal(out.nested[1].name, 'fine');
  for (const bad of [GH, SK]) assert.ok(!JSON.stringify(out).includes(bad));
});

test('scrubConfig matches whole name segments: counts named like secrets are kept, real secrets still go', () => {
  const out = scrubConfig({ chain_passes: 'two', retry_passes: { a: 1 }, max_tokens_by_model: { x: 1 }, tokens_per_job: 'many', passwd: 'a', client_secret: 'b', 'api-key': 'c', apiKey: 'd', access_tokens: { r: 'x' }, secrets: ['y'] });
  assert.equal(out.chain_passes, 'two'); assert.deepEqual(out.retry_passes, { a: 1 }); assert.deepEqual(out.max_tokens_by_model, { x: 1 }); assert.equal(out.tokens_per_job, 'many');
  for (const k of ['passwd', 'client_secret', 'api-key', 'apiKey', 'access_tokens', 'secrets']) assert.equal(out[k], '[removed]', k);
});

test('wasteByCause caps each day at its top causes plus a remainder; byCause stays complete', () => {
  const waste = Object.fromEntries(Array.from({ length: 12 }, (_, i) => w('j' + i, 1000 + i, i + 1, 'cause-' + i)).map(x => [x.job, x]));
  const r = wasteByCause({ breaker: { waste } }, { now: NOW });
  assert.equal(r.byCause.length, 12); assert.equal(r.byDay[0].causes.length, 6);
  const rest = r.byDay[0].causes[5]; assert.equal(rest.remainder, true); assert.equal(rest.jobs, 7); assert.equal(rest.costUsdEquivalent, 28);
  assert.equal(r.byDay[0].causes[0].cause, 'cause-11');
});

test('configDiff reports changed, added and removed settings by path and nothing for equal ones', () => {
  const d = configDiff({ a: 1, b: { c: [1, 2], d: 'x' }, gone: 1 }, { a: 1, b: { c: [1, 3], d: 'x' }, extra: { k: true } });
  assert.deepEqual(d.map(x => [x.path, x.change]), [['b.c', 'changed'], ['extra.k', 'added'], ['gone', 'removed']]);
  assert.deepEqual(configDiff({ a: 1 }, { a: 1 }), []);
});

test('configView against the real shipped file: no local override means no differences; an override shows exactly what it changed; secrets never appear', () => {
  const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  const same = configView({ effective: shipped, shippedFile: SHIPPED, localOverridePresent: false });
  assert.equal(same.differsFromShipped, 0); assert.equal(same.shippedReadable, true);
  const local = { limits: { max_open_prs: 3 }, budget: { high_water: 0.9 }, alerts: { command: ['/usr/bin/notify', GH] } };
  const eff = applyLocalOverride(shipped, local);
  const r = configView({ effective: eff, shippedFile: SHIPPED, localOverridePresent: true, configError: `bad ${PW}=${PWVAL}` });
  const paths = r.differences.map(x => x.path);
  assert.ok(paths.includes('limits.max_open_prs') && paths.includes('budget.high_water') && paths.includes('alerts.command'), paths.join());
  assert.equal(r.differences.find(x => x.path === 'budget.high_water').effective, 0.9); assert.equal(r.differences.find(x => x.path === 'budget.high_water').shipped, 0.85);
  assert.equal(r.differences.find(x => x.path === 'limits.max_open_prs').effective, 3);
  for (const bad of [GH, PWVAL]) assert.ok(!JSON.stringify(r).includes(bad), 'no secret-shaped output');
  assert.equal(configView({ effective: shipped, shippedFile: '/nonexistent/team.json' }).shippedReadable, false);
});

async function serve(t, root, config) {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, recorderDir: null }));
  const raw = (method, p) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}` } }, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); }); q.on('error', rej); q.end(); });
  return { base: `http://127.0.0.1:${port}`, raw };
}
const snapshot = root => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out[p] = fs.readFileSync(p, 'utf8'); } }; walk(root); return out; };

test('end to end: GET-only routes, the four tools, limits, redaction, and an unchanged state tree', async t => {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  const waste = Object.fromEntries([w('a', 1000, 1.5, `review:x ${PW}=${PWVAL}`), w('b', 2000, 0.5, 'ci-fix:failed')].map(x => [x.job, { ...x, at: Date.now() - (NOW - x.at) }]));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {}, breaker: { waste, halts: {}, history: [] } }));
  const local = { alerts: { command: ['/usr/bin/notify', GH] } };
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify(local));
  const s = await serve(t, root, () => applyLocalOverride(BASE, local));
  for (const p of ['diagnostics', 'waste', 'config']) { assert.notEqual((await s.raw('POST', `/api/${p}.json`)).status, 200, `POST ${p}`); assert.equal((await s.raw('GET', `/api/${p}.json`)).status, 200); }
  const before = snapshot(root);
  const view = { budget: { claude: { mode: 'reviews_only', label: 'reviews only', reason: `weekly 90%: at or above 85% ${GH}`, until: NOW + DAY, known: true, used: 0.9, resetsAt: NOW + DAY, hoursLeft: 24.04, ratePerHour: 0.01, rateSource: 'recent', projected: 1.1, runsOutAt: NOW + 3600000, shortWindow: { used: 0.2, resetsAt: NOW + 3600000 }, jobCost: { review: 0.5 }, held: { fix: 'held' } } } };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}), getPath: p => getJson(new URL(p, `${s.base}/api/view.json`).href) });
  const names = ['foreman_diagnostics', 'foreman_waste', 'foreman_config', 'foreman_budget'];
  const mine = tools.list().filter(x => names.includes(x.name)); assert.equal(mine.length, 4); assert.ok(mine.every(x => x.annotations.readOnlyHint === true && x.annotations.destructiveHint === false));
  const out = {}; for (const n of names) { out[n] = await tools.call(n, n === 'foreman_waste' ? { days: 2 } : {}); assert.equal(out[n].isError, false, `${n}: ${out[n].text.slice(0, 200)}`); }
  const dg = JSON.parse(out.foreman_diagnostics.text); assert.equal(dg.retentionDays, 7); assert.ok('ticks' in dg && 'idle' in dg); assert.equal(dg.recorder.hourly, undefined); assert.equal(dg.recorder.hourlySamplesOmitted, 0);
  const wv = JSON.parse(out.foreman_waste.text); assert.equal(wv.days, 2); assert.equal(wv.jobs, 2); assert.equal(wv.totalCostUsdEquivalent, 2);
  const cv = JSON.parse(out.foreman_config.text); assert.equal(cv.localOverridePresent, true); assert.deepEqual(cv.effective.alerts.command, ['/usr/bin/notify', '[1 argument(s) removed]']);
  const bv = JSON.parse(out.foreman_budget.text); assert.equal(bv.agents.claude.mode, 'reviews_only'); assert.match(bv.agents.claude.why, /weekly 90%/); assert.equal(bv.agents.claude.endsAt, new Date(NOW + DAY).toISOString());
  assert.equal(bv.agents.claude.rate.perHour, 0.01); assert.equal(bv.agents.claude.rate.source, 'recent'); assert.equal(bv.agents.claude.weekly.hoursLeft, 24); assert.equal(bv.thresholds.highWater, 0.85, 'thresholds come from the effective configuration');
  for (const bad of [GH, PWVAL]) for (const n of names) assert.ok(!out[n].text.includes(bad), `${n} leaked a secret-shaped value`);
  assert.deepEqual(snapshot(root), before, 'state is untouched');
});

test('foreman_budget answers without a dashboard config route (thresholds null); the other three fail cleanly with no dashboard address', async () => {
  const view = { budget: {} };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}) });
  const b = JSON.parse((await tools.call('foreman_budget')).text); assert.equal(b.thresholds, null); assert.deepEqual(b.agents, {});
  for (const n of ['foreman_diagnostics', 'foreman_waste', 'foreman_config']) assert.equal((await tools.call(n)).isError, true, n);
  const down = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}), getPath: async () => { throw new Error('the dashboard answered HTTP 404'); } });
  assert.equal((await down.call('foreman_budget')).isError, false, 'a missing config route does not break the budget read');
  assert.equal((await down.call('foreman_waste')).isError, true);
});
