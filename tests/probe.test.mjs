// Allowance probe (issue #110): when a probe is due, what it stores, the latch release, the CLI/dashboard trigger.
// No provider is called: the probe command is a local node script, the agents are fakes, the clock is fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot, provider, validateManifest, defaultRegistry } from '../supervisor/core.mjs';
import { assessAgent, DEFAULT_BUDGET, HOUR, validateBudgetConfig } from '../supervisor/budget.mjs';
import { probeDue, overageRisk, runProbeCommand, hasProbe, refreshProvider, acquireProbeLock, cleanProbeRecord, MINUTE } from '../supervisor/probe.mjs';
import { probeNow } from '../supervisor/probenow.mjs';
import { mergeProbes, readCache, storeProbes, latestAllowance } from '../supervisor/dashdata.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import * as claudeAdapter from '../supervisor/adapters/claude.mjs';

const RESET = Date.parse('2026-11-05T04:00:00Z');
const NOW = RESET - 3.5 * 24 * HOUR;
const claudeAl = (weekly, { at = NOW, resetsAt = RESET, source, overage = false } = {}) => ({ provider: 'claude', status: 'allowed', observedAt: at, ...(source ? { source } : {}),
  windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: at + 3 * HOUR, status: 'allowed' }, { type: 'seven_day', utilization: weekly, resetsAt, status: 'allowed' }],
  billing: { overageStatus: 'rejected', usingOverage: overage } });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// ---- when a probe is due
const S = DEFAULT_BUDGET;
test('a held agent with a stale reading is due; a fresh reading or a normal agent is not', () => {
  const stale = claudeAl(0.9, { at: NOW - 3 * HOUR });
  assert.equal(probeDue({ mode: 'reviews_only', allowance: stale, settings: S, now: NOW }).reason, 'stale');
  assert.equal(probeDue({ mode: 'waiting', allowance: null, settings: S, now: NOW }).reason, 'stale', 'no reading at all counts as stale');
  assert.equal(probeDue({ mode: 'reviews_only', allowance: claudeAl(0.9, { at: NOW - HOUR }), settings: S, now: NOW }), null, 'under the 2 h age');
  assert.equal(probeDue({ mode: 'normal', allowance: stale, settings: S, now: NOW }), null, 'never while normal: jobs refresh the reading');
  assert.equal(probeDue({ mode: 'reviews_only', allowance: stale, settings: { ...S, probe_age_hours: 4 }, now: NOW }), null, 'the age is configurable');
  assert.equal(probeDue({ mode: 'reviews_only', allowance: stale, settings: { ...S, probe: false }, now: NOW }), null, 'switchable off');
});
test('at most one probe per agent per interval, whether or not it found a reading', () => {
  const stale = claudeAl(0.9, { at: NOW - 3 * HOUR });
  assert.equal(probeDue({ mode: 'reviews_only', allowance: stale, state: { at: NOW - 59 * MINUTE }, settings: S, now: NOW }), null);
  assert.equal(probeDue({ mode: 'reviews_only', allowance: stale, state: { at: NOW - 61 * MINUTE }, settings: S, now: NOW }).reason, 'stale');
});
test('one probe just after a reported reset time passes, once per reset, even though the agent now computes as normal', () => {
  const stored = { mode: 'waiting', until: NOW - 5 * MINUTE };
  const old = claudeAl(1, { at: NOW - 2 * HOUR, resetsAt: NOW - 5 * MINUTE });
  assert.equal(probeDue({ mode: 'normal', stored, allowance: old, settings: S, now: stored.until + 30000 }), null, 'not before the grace period');
  const due = probeDue({ mode: 'normal', stored, allowance: old, settings: S, now: NOW });
  assert.deepEqual(due, { reason: 'reset', resetFor: stored.until });
  assert.equal(probeDue({ mode: 'normal', stored, allowance: old, state: { at: NOW - 2 * HOUR, resetFor: stored.until }, settings: S, now: NOW }), null, 'already probed for this reset');
  assert.equal(probeDue({ mode: 'normal', stored, allowance: claudeAl(0.1, { at: NOW - MINUTE }), settings: S, now: NOW }), null, 'a reading newer than the reset needs no probe');
  assert.equal(probeDue({ mode: 'normal', stored: { mode: 'normal', until: null }, allowance: old, settings: S, now: NOW }), null, 'a normal agent is not probed');
});
test('no probe while the last reading reports paid overage in use for a window that has not reset', () => {
  assert.equal(probeDue({ mode: 'waiting', allowance: claudeAl(0.5, { at: NOW - 5 * HOUR, overage: true, resetsAt: NOW + HOUR }), settings: S, now: NOW }), null);
});
test('budget config: probe keys are validated', () => {
  validateBudgetConfig({ probe: true, probe_age_hours: 1, probe_interval_minutes: 30 }, []);
  for (const bad of [{ probe: 'yes' }, { probe_age_hours: 0 }, { probe_interval_minutes: 1 }]) assert.throws(() => validateBudgetConfig(bad, []), /invalid budget config/);
});

// ---- the probe run itself
const claudeSpec = script => ({ command: process.execPath, args: ['-e', script], timeout_seconds: 20 });
const eventLine = (weekly, extra = {}) => JSON.stringify({ type: 'rate_limit_event', session_id: 'sess-1', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(RESET / 1000), rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: Math.floor((NOW + 3 * HOUR) / 1000), status: 'allowed' }, seven_day: { utilization: weekly, resetsAt: Math.floor(RESET / 1000), status: 'allowed' } }, ...extra } });
const config = { manifest: { launch: { env_allowlist: ['PATH', 'HOME'] } } };
test('a probe run stores allowance fields only: source probe, no message text, no session id', async () => {
  const secretText = ['MESSAGE', 'BODY', 'MARKER'].join('-');
  const script = `console.log(JSON.stringify({type:'system',session_id:'sess-1'}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:${JSON.stringify(secretText)}}]}}));console.log(${JSON.stringify(eventLine(0.07))});console.log(JSON.stringify({type:'result',result:${JSON.stringify(secretText)}}));`;
  const record = await runProbeCommand({ spec: claudeSpec(script), adapter: claudeAdapter, config, now: NOW });
  assert.equal(record.source, 'probe'); assert.equal(record.observedAt, NOW); assert.equal(record.provider, 'claude');
  const weekly = record.windows.find(w => w.type === 'seven_day');
  assert.equal(weekly.utilization, 0.07); assert.equal(weekly.resetsAt, RESET);
  const text = JSON.stringify(record);
  assert.ok(!text.includes(secretText) && !text.includes('sess-1'), 'no message text or session id in the record');
  assert.deepEqual(Object.keys(record).sort(), ['billing', 'observedAt', 'provider', 'source', 'status', 'windows']);
  // and it survives the cache merge unchanged in kind
  assert.equal(mergeProbes({}, { claude: record }).claude.source, 'probe');
  assert.equal(latestAllowance([], { claude: record }).claude.source, 'probe');
});
test('the probe runs outside any repository: its working directory is an empty temporary directory', async () => {
  const script = `const fs=require('fs'),os=require('os');if(process.cwd().startsWith(os.tmpdir())&&fs.readdirSync('.').length===0&&!fs.existsSync('.git'))console.log(${JSON.stringify(eventLine(0.2))});`;
  assert.ok(await runProbeCommand({ spec: claudeSpec(script), adapter: claudeAdapter, config, now: NOW }));
  const cwdBefore = process.cwd(); assert.equal(process.cwd(), cwdBefore);
});
test('no allowance event, a failing command, a hang, or a missing binary all give no reading and never throw', async () => {
  assert.equal(await runProbeCommand({ spec: claudeSpec(`console.log(JSON.stringify({type:'result',result:'ok'}))`), adapter: claudeAdapter, config, now: NOW }), null);
  assert.equal(await runProbeCommand({ spec: claudeSpec(`process.exit(3)`), adapter: claudeAdapter, config, now: NOW }), null);
  assert.equal(await runProbeCommand({ spec: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeout_seconds: 0.3 }, adapter: claudeAdapter, config, now: NOW }), null, 'a hung probe is killed at its timeout');
  assert.equal(await runProbeCommand({ spec: { command: '/nonexistent/claude-x', args: [] }, adapter: claudeAdapter, config, now: NOW }), null);
});
test('the probe environment is the allow-list only', async () => {
  const script = `if(!process.env.FOREMAN_PROBE_LEAK&&process.env.PATH)console.log(${JSON.stringify(eventLine(0.2))});`;
  assert.ok(await runProbeCommand({ spec: claudeSpec(script), adapter: claudeAdapter, config, now: NOW, env: { PATH: process.env.PATH, FOREMAN_PROBE_LEAK: '1' } }));
});
test('cleanProbeRecord drops anything that is not an allowance field', () => {
  assert.equal(cleanProbeRecord({ windows: [] }, NOW), null);
  const r = cleanProbeRecord({ provider: 'claude', status: 'allowed', prompt: 'x', windows: [{ type: 'seven_day', utilization: 0.1, resetsAt: 5, status: 'ok', note: 'y' }] }, NOW);
  assert.ok(!('prompt' in r) && !('note' in r.windows[0]));
});

// ---- manifest: provider-agnostic
test('the probe command comes from the manifest: both shipped manifests validate, core names no provider, a bad probe is refused', async () => {
  const claude = await provider(defaultRegistry, 'claude'), codex = await provider(defaultRegistry, 'codex');
  assert.equal(claude.config.manifest.probe.kind, 'command'); assert.equal(codex.config.manifest.probe.kind, 'session-log');
  assert.ok(claude.config.manifest.probe.args.includes('--strict-mcp-config') && claude.config.manifest.probe.args.includes('stream-json'));
  assert.ok(hasProbe(defaultRegistry, 'claude') && hasProbe(defaultRegistry, 'codex') && !hasProbe(defaultRegistry, 'nope'));
  const m = JSON.parse(JSON.stringify(claude.config.manifest));
  for (const bad of [{ kind: 'shell' }, { kind: 'command' }, { kind: 'command', command: 'x', args: ['a\nb'] }, { kind: 'command', command: 'x', args: [], timeout_seconds: 1 }, { kind: 'command', command: 'x', args: [], extra: 1 }])
    assert.throws(() => validateManifest({ ...m, probe: bad }, 'claude'), /invalid/);
  const core = fs.readFileSync(new URL('../supervisor/probe.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../supervisor/probenow.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core.replace(/\/\/.*$/gm, ''), /claude|codex/i);
});

// ---- the latch
const latched = { mode: 'reviews_only', until: RESET, since: NOW - 2 * HOUR, reason: 'weekly 90%' };
test('a fresh probe reading below the thresholds releases the reviews-only latch; above them it keeps it', () => {
  const low = assessAgent({ allowance: claudeAl(0.05, { at: NOW, source: 'probe' }), now: NOW, latched });
  assert.equal(low.mode, 'normal'); assert.match(low.reason, /released by a fresh allowance probe/);
  const high = assessAgent({ allowance: claudeAl(0.9, { at: NOW, source: 'probe' }), now: NOW, latched });
  assert.equal(high.mode, 'reviews_only');
  const projected = assessAgent({ allowance: claudeAl(0.6, { at: NOW, source: 'probe' }), now: NOW, latched });
  assert.equal(projected.mode, 'reviews_only', '60% with half the window gone projects past 100%');
});
test('only a probe releases: a low job reading still holds, and a probe older than the latch does not release', () => {
  assert.equal(assessAgent({ allowance: claudeAl(0.05, { at: NOW, source: 'job' }), now: NOW, latched }).mode, 'reviews_only');
  assert.equal(assessAgent({ allowance: claudeAl(0.05, { at: NOW }), now: NOW, latched }).mode, 'reviews_only');
  assert.equal(assessAgent({ allowance: claudeAl(0.05, { at: NOW - 3 * HOUR, source: 'probe' }), now: NOW, latched }).mode, 'reviews_only');
});
test('a probe that reports overage in use or an exhausted window never frees the agent', () => {
  assert.equal(assessAgent({ allowance: claudeAl(0.05, { at: NOW, source: 'probe', overage: true }), now: NOW, latched }).mode, 'waiting');
  const exhausted = claudeAl(0.1, { at: NOW, source: 'probe' }); exhausted.status = 'rejected'; exhausted.windows[1].status = 'rejected';
  assert.equal(assessAgent({ allowance: exhausted, now: NOW, latched }).mode, 'waiting');
});

// ---- the tick: Team picks, notes and alerts
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
function world(t, { allowance, now = NOW, stored = null } = {}) {
  const dir = tmp(t), alerts = [], clock = { t: now, now: () => clock.t };
  const usage = { allowance, jobs: [], snapshots: [] };
  const gh = { listPulls: async () => [], listIssues: async () => [], listMergedPulls: async () => [] };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [] }, git: {}, register: '', clock, usage, timeZone: 'Europe/London', alert: async text => { alerts.push(text); } });
  if (stored) { team.s.budget.claude = stored; team.save(); }
  return { team, alerts, clock, usage };
}
test('team: a reviews-only agent with a stale reading gets exactly one probe; none while normal; none inside the interval; only for probe-capable providers', t => {
  const w = world(t, { allowance: { claude: claudeAl(0.9, { at: NOW - 5 * HOUR }), codex: claudeAl(0.1, { at: NOW - 5 * HOUR }) } });
  const due = w.team.probesDue();
  assert.deepEqual(due.map(d => [d.agent, d.reason]), [['claude', 'stale']], 'codex is normal: no probe');
  assert.deepEqual(w.team.probesDue(id => id !== 'claude'), [], 'a provider without a probe section is skipped');
  w.team.noteProbe('claude', due[0]);
  assert.deepEqual(w.team.probesDue(), [], 'no second probe inside the interval');
  w.clock.t += 61 * MINUTE;
  assert.equal(w.team.probesDue().length, 1, 'allowed again after the interval');
});
test('team: after a reported reset time passes a waiting agent is probed once and returns to normal when the reading allows, alerted once', async t => {
  const stored = { mode: 'waiting', until: NOW - 5 * MINUTE, since: NOW - 30 * HOUR, reason: 'weekly 100%: used up', alerted: true };
  const w = world(t, { allowance: { claude: claudeAl(1, { at: NOW - 6 * HOUR, resetsAt: NOW - 5 * MINUTE }) }, stored });
  const due = w.team.probesDue();
  assert.deepEqual(due.map(d => d.reason), ['reset']);
  w.team.noteProbe('claude', due[0]);
  assert.deepEqual(w.team.probesDue(), [], 'one probe per reset');
  // the probe's reading arrives
  w.usage.allowance.claude = { ...claudeAl(0.0002, { at: NOW, resetsAt: NOW + 7 * 24 * HOUR - 5 * MINUTE, source: 'probe' }) };
  w.team.modes = w.team.budgets();
  assert.equal(w.team.modes.claude.mode, 'normal');
  const report = {}; await w.team.updateBudget(report); await w.team.updateBudget({});
  assert.equal(report.budget[0].from, 'waiting'); assert.equal(report.budget[0].to, 'normal');
  assert.equal(w.alerts.length, 1, 'alerted once'); assert.match(w.alerts[0], /claude: normal/);
});
test('team: the released latch is recorded with its reason and alerted once', async t => {
  const stored = { mode: 'reviews_only', until: RESET, since: NOW - 2 * HOUR, reason: 'weekly 90%', alerted: true };
  const w = world(t, { allowance: { claude: claudeAl(0.04, { at: NOW, source: 'probe' }) }, stored });
  w.team.modes = w.team.budgets();
  const report = {}; await w.team.updateBudget(report); await w.team.updateBudget({});
  assert.equal(w.team.s.budget.claude.mode, 'normal'); assert.match(w.team.s.budget.claude.reason, /released by a fresh allowance probe/);
  assert.equal(w.alerts.length, 1);
});

// ---- on demand: probeNow (the CLI and the button) and the dashboard route
function cacheRoot(t) {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ schema: 1, tick: { at: NOW, status: 'ok' }, probes: {}, pulls: [], issues: [] }));
  return root;
}
test('probeNow runs the provider probe, stores the record in the cache and reports the reading age', async t => {
  const root = cacheRoot(t), record = cleanProbeRecord(claudeAl(0.3), NOW - 20000);
  const out = await probeNow({ root, registry: 'unused', config: cfg, agent: 'claude', now: NOW, refresh: async () => ({ record }) });
  assert.equal(out.ok, true); assert.equal(out.stored, true); assert.equal(out.ageSeconds, 20); assert.equal(out.source, 'probe');
  assert.equal(readCache(root).probes.claude.source, 'probe');
  assert.ok(!JSON.stringify(out).includes('sess'));
  assert.deepEqual(await probeNow({ root, registry: 'unused', config: cfg, agent: 'claude', now: NOW, refresh: async () => ({ record: null, error: 'no-reading' }) }), { agent: 'claude', ok: false, error: 'no-reading' });
  await assert.rejects(probeNow({ root, registry: 'unused', config: cfg, agent: 'nobody', now: NOW }), /unknown agent/);
});
test('probeNow with no dashboard cache yet still persists the reading (probes-only cache, no tick) and reports it stored', async t => {
  const root = tmp(t), record = cleanProbeRecord(claudeAl(0.3), NOW - 20000);
  const out = await probeNow({ root, registry: 'unused', config: cfg, agent: 'claude', now: NOW, refresh: async () => ({ record }) });
  assert.equal(out.ok, true); assert.equal(out.stored, true); assert.equal(out.ageSeconds, 20);
  const cache = readCache(root);
  assert.equal(cache.probes.claude.source, 'probe'); assert.equal(cache.tick, null);
  assert.equal(latestAllowance([], cache.probes).claude.observedAt, record.observedAt, 'the next tick and the page read it');
  assert.deepEqual(cache.pulls, []);
});
test('refreshProvider through a real registry: a custom manifest probe command is run, and a provider without a probe is unsupported', async t => {
  const dir = tmp(t);
  const manifest = JSON.parse(fs.readFileSync(new URL('../supervisor/providers/claude.json', import.meta.url), 'utf8'));
  manifest.probe = { kind: 'command', command: process.execPath, args: ['-e', `console.log(${JSON.stringify(eventLine(0.11))})`], timeout_seconds: 20 };
  fs.mkdirSync(path.join(dir, 'providers')); fs.writeFileSync(path.join(dir, 'providers', 'claude.json'), JSON.stringify(manifest));
  const noProbe = { ...manifest, id: 'plain' }; delete noProbe.probe; fs.writeFileSync(path.join(dir, 'providers', 'plain.json'), JSON.stringify(noProbe));
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ schemaVersion: 1, providers: { claude: { adapter: 'claude', manifest: 'providers/claude.json' }, plain: { adapter: 'claude', manifest: 'providers/plain.json' } } }));
  const reg = path.join(dir, 'providers.json');
  const r = await refreshProvider(reg, 'claude', { now: NOW });
  assert.equal(r.record.windows.find(w => w.type === 'seven_day').utilization, 0.11);
  assert.deepEqual(await refreshProvider(reg, 'plain', { now: NOW }), { record: null, error: 'unsupported' });
  const [a, b] = await Promise.all([refreshProvider(reg, 'claude', { now: NOW }), refreshProvider(reg, 'claude', { now: NOW })]);
  assert.deepEqual([a.error, b.error].sort(), ['busy', undefined].sort(), 'a second concurrent probe of one provider is refused');
});
async function serve(t, probe) {
  const root = cacheRoot(t), server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', handler({ root, config: cfg, host: '127.0.0.1', port, now: () => NOW, probe }));
  t.after(() => server.close());
  const call = (p, { method = 'POST', headers = {} } = {}) => new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); }); req.on('error', reject); req.end(); });
  return { call, origin: `http://127.0.0.1:${port}` };
}
test('dashboard: POST /probe/<agent> from its own origin runs one probe; other origins, hosts, agents and paths are refused', async t => {
  const calls = []; const s = await serve(t, async o => { calls.push(o.agent); if (o.agent === 'nobody') throw Object.assign(new Error('x'), { name: 'SupervisorError' }); return { ok: true }; });
  const ok = await s.call('/probe/claude', { headers: { origin: s.origin } });
  assert.equal(ok.status, 303); assert.match(ok.headers.location, /^\/usage/); assert.deepEqual(calls, ['claude']);
  assert.equal((await s.call('/probe/claude', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await s.call('/probe/claude')).status, 403, 'no Origin header is refused');
  assert.equal((await s.call('/probe/claude', { headers: { origin: s.origin, host: 'evil.example' } })).status, 421);
  assert.equal((await s.call('/probe/claude', { method: 'GET', headers: { origin: s.origin } })).status, 404);
  assert.equal((await s.call('/probe/../x', { headers: { origin: s.origin } })).status, 405);
  assert.equal((await s.call('/', { headers: { origin: s.origin } })).status, 405);
  assert.deepEqual(calls, ['claude'], 'only the one valid request probed');
});
test('dashboard page: the Refresh allowance button and the reading age appear for a probe-capable provider', async t => {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  const probes = { claude: cleanProbeRecord(claudeAl(0.4), NOW - 3 * HOUR) };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ schema: 1, tick: { at: NOW, status: 'ok', lastOkAt: NOW }, probes, pulls: [], issues: [], delivered: [], merged: [], fetchedAt: NOW }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config: cfg, host: '127.0.0.1', port, now: () => NOW }));
  const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/usage', headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve(b)); }).on('error', reject));
  assert.match(body, /<form method="post" action="\/probe\/claude"/);
  assert.match(body, /Refresh allowance/);
  assert.match(body, /Last reading 3h[^<]*ago[\s\S]*?refreshed by a minimal probe run/);
});

// ---- never spends credits: a used-up window blocks the tick's probe (D-019); with overage not refused it also blocks on demand
const usedUp = (overageStatus, usingOverage = false) => ({ provider: 'claude', status: 'allowed', observedAt: NOW - 3 * HOUR,
  windows: [{ type: 'seven_day', utilization: 1, resetsAt: NOW + 48 * HOUR, status: 'allowed' }], billing: { overageStatus, usingOverage } });
test('probeDue: a used-up live window is never probed, whatever the overage status (D-019: no provider call while waiting)', () => {
  for (const o of ['allowed', 'unknown', 'rejected', 'disabled']) assert.equal(probeDue({ mode: 'waiting', allowance: usedUp(o), settings: S, now: NOW }), null, o);
  // the reproduced case: five-hour window used up or status-limited, reset in 3 h, overage refused, reading 3 h old
  const fiveHour = (w, overageStatus = 'rejected') => ({ provider: 'claude', status: 'allowed', observedAt: NOW - 3 * HOUR,
    windows: [{ type: 'five_hour', resetsAt: NOW + 3 * HOUR, ...w }], billing: { overageStatus, usingOverage: false } });
  for (const w of [{ utilization: 1, status: 'rejected' }, { utilization: 0.999, status: 'allowed' }, { utilization: null, status: 'rejected' }])
    for (const o of ['rejected', 'disabled']) assert.equal(probeDue({ mode: 'waiting', allowance: fiveHour(w, o), settings: S, now: NOW }), null, `${JSON.stringify(w)} ${o}`);
  // once that window has reset, the single post-reset probe still runs
  const stored = { mode: 'waiting', until: NOW + 3 * HOUR };
  assert.deepEqual(probeDue({ mode: 'waiting', stored, allowance: fiveHour({ utilization: 1, status: 'rejected' }), settings: S, now: NOW + 3 * HOUR + 2 * MINUTE }), { reason: 'stale', resetFor: null });
  assert.deepEqual(probeDue({ mode: 'normal', stored, allowance: fiveHour({ utilization: 1, status: 'rejected' }), settings: S, now: NOW + 3 * HOUR + 2 * MINUTE }), { reason: 'reset', resetFor: stored.until });
  // a window under the threshold with overage refused is still probed when stale
  assert.equal(probeDue({ mode: 'waiting', allowance: fiveHour({ utilization: 0.5, status: 'allowed' }), settings: S, now: NOW }).reason, 'stale');
});
test('probeDue: no probe at all while a job of the provider is in the usage-limit wait, not even the reset probe', () => {
  const stale = claudeAl(0.9, { at: NOW - 3 * HOUR });
  assert.equal(probeDue({ mode: 'reviews_only', allowance: stale, settings: S, now: NOW, limitWait: true }), null);
  const stored = { mode: 'waiting', until: NOW - 5 * MINUTE };
  assert.equal(probeDue({ mode: 'normal', stored, allowance: claudeAl(1, { at: NOW - 6 * HOUR, resetsAt: NOW - 5 * MINUTE }), settings: S, now: NOW, limitWait: true }), null);
});
test('team: probesDue skips a provider whose job is paused on a usage limit; a transient rate-limit pause or another provider does not count', t => {
  const w = world(t, { allowance: { claude: claudeAl(0.9, { at: NOW - 5 * HOUR }), codex: claudeAl(0.1, { at: NOW - 5 * HOUR }) } });
  w.usage.jobs = [{ id: 'j1', provider: 'claude', status: 'paused_limit', lastEvent: 'usage_limit' }];
  assert.deepEqual(w.team.probesDue(), []);
  w.usage.jobs = [{ id: 'j1', provider: 'claude', status: 'paused_limit', lastEvent: 'transient_rate_limit' }, { id: 'j2', provider: 'codex', status: 'paused_limit', lastEvent: 'usage_limit' }];
  assert.deepEqual(w.team.probesDue().map(d => d.agent), ['claude']);
});
test('probeNow refuses a model-run probe on overage risk and never calls the provider; a clean reading proceeds', async t => {
  const root = cacheRoot(t); let calls = 0;
  const refresh = async () => { calls++; return { record: cleanProbeRecord(claudeAl(0.3), NOW) }; };
  for (const al of [usedUp('allowed'), claudeAl(0.5, { overage: true })]) {
    storeProbes(root, { claude: { ...al, source: 'probe' } });
    assert.deepEqual(await probeNow({ root, registry: 'unused', config: cfg, agent: 'claude', now: NOW, refresh }), { agent: 'claude', ok: false, error: 'overage-risk' });
  }
  assert.equal(calls, 0);
  storeProbes(root, { claude: { ...usedUp('rejected'), observedAt: NOW + 1000, source: 'probe' } });
  assert.equal((await probeNow({ root, registry: 'unused', config: cfg, agent: 'claude', now: NOW, refresh })).ok, true);
  assert.equal(calls, 1);
});

test('overageRisk: a used-up top-level status with no window reset time is a risk unless overage is refused; no reading is not', () => {
  const noTime = (status, overageStatus) => ({ provider: 'claude', status, observedAt: NOW, windows: [{ type: 'seven_day', status: 'allowed' }], billing: { overageStatus, usingOverage: false } });
  for (const st of ['rejected', 'blocked', 'exhausted', 'limit_reached']) {
    assert.equal(overageRisk(noTime(st, 'allowed'), NOW), true, st);
    assert.equal(overageRisk({ ...noTime(st, 'unknown'), windows: [] }, NOW), true, st + ' without windows');
    assert.equal(overageRisk(noTime(st, 'rejected'), NOW), false, st + ' with overage refused');
  }
  assert.equal(overageRisk(noTime('allowed', 'allowed'), NOW), false);
  assert.equal(overageRisk(null, NOW), false);
  assert.equal(probeDue({ mode: 'waiting', allowance: noTime('rejected', 'allowed'), settings: S, now: NOW }), null);
  assert.equal(probeDue({ mode: 'waiting', allowance: { ...noTime('rejected', 'rejected'), observedAt: NOW - 3 * HOUR }, settings: S, now: NOW }).reason, 'stale');
});

test("the probe lock is cross-process: a held lock refuses a second taker, a dead owner or release frees it", async t => {
  const lockDir = tmp(t);
  const rel = acquireProbeLock("claude", { lockDir });
  assert.equal(typeof rel, "function");
  assert.equal(acquireProbeLock("claude", { lockDir }), null, "a live holder blocks another taker");
  assert.equal(typeof acquireProbeLock("other", { lockDir }), "function", "other providers are independent");
  rel();
  const again = acquireProbeLock("claude", { lockDir });
  assert.equal(typeof again, "function", "released lock can be taken");
  again();
  fs.mkdirSync(path.join(lockDir, "claude")); fs.writeFileSync(path.join(lockDir, "claude", "owner"), "2147483646");
  const taken = acquireProbeLock("claude", { lockDir });
  assert.equal(typeof taken, "function", "a lock owned by a dead process is taken over");
  taken();
  // a held lock makes refreshProvider report busy without running the probe
  const held = acquireProbeLock("claude", { lockDir });
  assert.deepEqual(await refreshProvider("/nonexistent", "claude", { lockDir }), { record: null, error: "busy" });
  held();
});
