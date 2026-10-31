// Issue #75: usage cards and the chart must show the last known allowance reading with its age, mark readings whose reset
// time has passed as expired everywhere, end the chart line at the reset, and refresh paused agents' readings through a
// model-free probe. Times and values below are the real ones seen on Tower on 2026-10-31 (both agents paused on limits).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexAllowance, codexAllowanceProbe, hasReading, limitFromAllowance, windowExpired } from '../supervisor/allowance.mjs';
import { buildView, pauseDisagreement, readingText } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';
import { latestAllowance, mergeProbes, readCache, readSnapshots, recordTick } from '../supervisor/dashdata.mjs';
import { weeklyUtilization } from '../supervisor/models.mjs';

const T = iso => Date.parse(iso);
const NOW = T('2026-10-31T22:57:00Z');
const limitHit = JSON.parse(fs.readFileSync(new URL('./fixtures/allowance/codex-0.166.0-exec-limit-hit.token_count.json', import.meta.url), 'utf8'));
const notReached = JSON.parse(fs.readFileSync(new URL('./fixtures/allowance/codex-0.166-token_count.not-reached.json', import.meta.url), 'utf8'));
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [72] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const id = c => c.repeat(32);
// Codex: last job reading 14:36 (weekly 99%), probe reading 14:41 (weekly 100%), limit hit 22:55 with an empty record.
const codexWin = (p, s) => [{ type: 'primary', windowMinutes: 300, utilization: p, resetsAt: T('2026-10-31T18:20:15Z'), status: 'unknown' }, { type: 'secondary', windowMinutes: 10080, utilization: s, resetsAt: T('2026-11-04T07:18:35Z'), status: 'unknown' }];
const codexDone = { id: id('b'), provider: 'codex', kind: 'review', issue: 73, status: 'completed', lastEvent: 'completed', createdAt: T('2026-10-31T14:35:00Z'), updatedAt: T('2026-10-31T14:36:30Z'),
  allowance: { provider: 'codex', status: 'allowed', windows: codexWin(0.21, 0.99), observedAt: T('2026-10-31T14:36:20Z') } };
const codexPaused = { id: id('c'), provider: 'codex', kind: 'review', issue: 82, status: 'paused_limit', lastEvent: 'usage_limit', createdAt: T('2026-10-31T22:55:00Z'), updatedAt: T('2026-10-31T22:55:25Z'),
  resetAt: null, nextAttemptAt: T('2026-10-31T23:55:25Z'), attempts: 1, allowance: { ...codexAllowance(limitHit.payload.rate_limits), observedAt: T('2026-10-31T22:55:25Z') } };
const codexProbe = { provider: 'codex', status: 'allowed', windows: codexWin(0.26, 1), observedAt: T('2026-10-31T14:41:28Z'), source: 'session-log' };
// Claude: paused at 21:27 with 5-hour 100% (resets 21:40, i.e. 1h 17m before NOW) and weekly 76%.
const claudePaused = { id: id('a'), provider: 'claude', kind: 'implement', issue: 72, status: 'paused_limit', lastEvent: 'usage_limit', createdAt: T('2026-10-31T18:05:00Z'), updatedAt: T('2026-10-31T21:27:10Z'),
  resetAt: null, nextAttemptAt: T('2026-10-31T23:27:10Z'), attempts: 2,
  allowance: { provider: 'claude', status: 'rejected', windows: [{ type: 'five_hour', utilization: 1, resetsAt: T('2026-10-31T21:40:00Z'), status: 'rejected' }, { type: 'seven_day', utilization: 0.76, resetsAt: T('2026-11-05T04:00:00Z'), status: 'allowed_warning' }], observedAt: T('2026-10-31T21:27:05Z') } };

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'al75-')); fs.chmodSync(d, 0o700); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const cacheOf = (probes = {}) => ({ tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls: [], issues: [], probes });
const view = (t, { jobs, probes, snapshots = [], now = NOW }) => buildView({ config: config(), root: tmp(t), jobs, events: [], state: {}, cache: cacheOf(probes), snapshots, now });
const usageHtml = v => renderPage(v, { route: { page: 'usage' } });
const section = (html, name) => html.slice(html.indexOf(`data-card="u-${name}"`), html.indexOf('</section>', html.indexOf(`data-card="u-${name}"`)));

// ---- the captured limit-hit shape and the reading selection
test('LIVE Codex exec limit hit: both windows null is no reading, status unknown (never allowed), no limit claimed from it', () => {
  const a = codexAllowance(limitHit.payload.rate_limits);
  assert.equal(a.status, 'unknown'); assert.deepEqual(a.windows, []); assert.equal(hasReading(a), false);
  assert.equal(limitFromAllowance(a, NOW), null);
  // the not-reached live record keeps its windows and stays allowed
  const ok = codexAllowance(notReached.payload.rate_limits);
  assert.equal(ok.status, 'allowed'); assert.equal(hasReading(ok), true);
});
test('an empty newer record never hides an older reading; a newer reading still wins; a probe reading competes on its own time', () => {
  assert.deepEqual(latestAllowance([codexDone, codexPaused]).codex.windows.map(w => w.utilization), [0.21, 0.99]);
  assert.equal(latestAllowance([codexDone, codexPaused]).codex.source, 'job');
  const newer = { ...codexDone, id: id('d'), allowance: { ...codexDone.allowance, windows: codexWin(0.3, 0.5), observedAt: T('2026-10-31T15:00:00Z') } };
  assert.deepEqual(latestAllowance([codexDone, newer]).codex.windows.map(w => w.utilization), [0.3, 0.5]);
  const withProbe = latestAllowance([codexDone, codexPaused], { codex: codexProbe });
  assert.equal(withProbe.codex.source, 'session-log'); assert.equal(withProbe.codex.observedAt, codexProbe.observedAt);
  assert.equal(latestAllowance([newer], { codex: codexProbe }).codex.source, 'job');        // the probe is older here: the job reading wins
  assert.equal(latestAllowance([codexPaused]).codex, undefined);                             // nothing but an empty record: no reading at all
});
test('one expiry rule: a window is expired once its reported reset time has passed (inclusive); no reset time never expires', () => {
  assert.equal(windowExpired({ resetsAt: NOW }, NOW), true); assert.equal(windowExpired({ resetsAt: NOW + 1 }, NOW), false);
  assert.equal(windowExpired({ resetsAt: null }, NOW), false); assert.equal(windowExpired({}, NOW), false);
  const weekly = { windows: [{ type: 'seven_day', utilization: 0.9, resetsAt: NOW }] };
  assert.equal(weeklyUtilization(weekly, NOW), null); assert.equal(weeklyUtilization(weekly, NOW - 1), 0.9);   // model routing uses the same rule
});

// ---- the Codex card (seen 31 Oct 17:47 as "Allowance: unknown / No allowance reported")
test('Codex paused on a limit: the card shows the last known reading, its age and "limit reached, resets <time>", not unknown', async t => {
  const v = await view(t, { jobs: [codexDone, codexPaused], probes: { codex: codexProbe } });
  const u = v.usage.codex;
  assert.deepEqual(u.windows.map(w => [w.label, w.utilization, w.expired]), [['5-hour', 0.26, true], ['weekly', 1, false]]);
  assert.equal(u.limit.resetsAt, T('2026-11-04T07:18:35Z')); assert.match(u.limit.basis, /weekly window in the last reading/);
  assert.equal(u.limit.retryAt, codexPaused.nextAttemptAt); assert.equal(u.source, 'session-log');
  const card = section(usageHtml(v), 'codex');
  assert.doesNotMatch(card, /Allowance: <b>unknown/); assert.doesNotMatch(card, /No allowance reported/);
  assert.match(card, /Limit reached/); assert.match(card, /resets <b>2026-11-04 07:18 UTC<\/b> \(in 3d 8h; weekly window in the last reading\)/);
  assert.match(card, /reset 4h 36m ago; current use unknown/); assert.match(card, /\(expired\)/);
  assert.match(card, /Last reading 8h 15m ago \(2026-10-31 14:41 UTC\), read from the local Codex session log \(no model call\)/);
  // a full live weekly window confirms the pause: no disagreement warning
  assert.ok(!v.attention.some(a => a.id === 'pause-codex'));
});
test('Codex without the probe: the job reading (weekly 99%) is shown; the warning carries the reading and its age, not "no allowance data"', async t => {
  const v = await view(t, { jobs: [codexDone, codexPaused] });
  assert.equal(v.usage.codex.limit.resetsAt, null);                        // 99% is not full: no reset time is invented
  assert.match(section(usageHtml(v), 'codex'), /reset time not reported by the provider\. The supervisor retries in 58m\./);
  const w = v.attention.find(a => a.id === 'pause-codex');
  assert.ok(w, 'a pause the reading cannot confirm is still reported');
  assert.doesNotMatch(w.text, /no allowance data/);
  assert.match(w.text, /older than the pause/); assert.match(w.text, /5-hour 21% \(expired: reset 4h 36m ago\), weekly 99%; reported 8h 20m ago/);
  assert.match(renderPage(v), /weekly 99%; reported 8h 20m ago/);            // Overview Warnings card (#76 requirement 6)
});
test('no reading ever: the card still says unknown, and only then', async t => {
  const v = await view(t, { jobs: [codexPaused] });
  const card = section(usageHtml(v), 'codex');
  assert.match(card, /Allowance: <b>unknown/); assert.match(card, /Limit reached/);
  assert.match(v.attention.find(a => a.id === 'pause-codex').text, /no allowance data/);
});

// ---- the Claude card (seen as 5-hour 100% with "reset time passed 1h17m ago")
test('Claude: a 5-hour 100% reading past its reset is expired: not current on the card, and the pause is called possibly over', async t => {
  const v = await view(t, { jobs: [claudePaused] });
  const five = v.usage.claude.windows.find(w => w.label === '5-hour');
  assert.equal(five.expired, true); assert.equal(v.usage.claude.windows.find(w => w.label === 'weekly').expired, false);
  assert.equal(v.usage.claude.limit.resetsAt, null);                       // the only full window has reset: no future reset claimed
  const card = section(usageHtml(v), 'claude');
  assert.match(card, /<tr class="expired"><td>5-hour<\/td>/); assert.match(card, /reset 1h 17m ago; current use unknown/);
  assert.doesNotMatch(card, /Every window in this reading has reset/);       // weekly is still current
  const f = pauseDisagreement(claudePaused, claudePaused.allowance, NOW);
  assert.equal(f.kind, 'expired'); assert.match(f.text, /full 5-hour window reset 1h 17m ago, so the limit may be over/);
  // before the reset the same reading confirms the pause
  assert.equal(pauseDisagreement(claudePaused, claudePaused.allowance, T('2026-10-31T21:39:00Z')), null);
});
test('every window expired: the card says current use is unknown; the pause cannot be confirmed by it', async t => {
  const later = T('2026-11-05T05:00:00Z');
  const v = await view(t, { jobs: [claudePaused], now: later });
  assert.equal(v.usage.claude.allExpired, true);
  assert.match(section(usageHtml(v), 'claude'), /Every window in this reading has reset since; current use is unknown/);
  const rejectedOnly = { ...claudePaused.allowance, windows: claudePaused.allowance.windows.map(w => ({ ...w, utilization: 0.5, status: 'allowed' })) };
  assert.equal(pauseDisagreement(claudePaused, rejectedOnly, later).kind, 'expired');      // a top-level rejected status from an all-expired reading confirms nothing
  assert.equal(pauseDisagreement(claudePaused, rejectedOnly, NOW), null);                  // while its windows are current it still does
});
test('a reading older than the pause cannot contradict it; one taken at or after the pause can', () => {
  const before = { provider: 'claude', status: 'allowed', windows: [{ type: 'five_hour', utilization: 0.3, resetsAt: NOW + 3600000, status: 'allowed' }], observedAt: claudePaused.updatedAt - 3600000 };
  const own = { ...claudePaused, allowance: { provider: 'claude', status: 'unknown', windows: [], observedAt: claudePaused.updatedAt } };
  assert.equal(pauseDisagreement(own, before, NOW).kind, 'unverifiable');
  assert.equal(pauseDisagreement(own, { ...before, observedAt: claudePaused.updatedAt + 60000 }, NOW).kind, 'disagrees');
  assert.match(readingText(before, NOW), /^5-hour 30%; reported 2h 29m ago$/);
});

// ---- the chart
const snap = (at, u, resetsAt, agent = 'claude') => ({ at, status: 'ok', plan: [], agents: {}, allowance: { [agent]: { observedAt: T('2026-10-31T21:27:05Z'), windows: [{ type: 'five_hour', utilization: u, resetsAt }] } } });
test('chart: a stale 100% stops at the reported reset with an expected-reset marker instead of a flat line to now', async t => {
  const reset = T('2026-10-31T21:40:00Z'), snaps = [];
  for (let at = T('2026-10-31T21:00:00Z'); at <= NOW - 60000; at += 300000) snaps.push(snap(at, 1, reset));   // the tick kept recording the old reading
  const v = await view(t, { jobs: [claudePaused], snapshots: snaps });
  const pts = v.graphs.allowance.claude.series['5-hour'];
  assert.ok(pts.length > 0 && pts.every(p => p.at < reset), 'no point after the reset');
  assert.equal(pts.at(-1).at, T('2026-10-31T21:35:00Z'));
  assert.deepEqual(v.graphs.allowance.claude.expected, [{ at: reset, window: '5-hour' }]);
  const html = renderPage(v, { route: { page: 'usage' }, query: new URLSearchParams('range=24h'), pathname: '/usage' });
  assert.match(html, /class="reset expected" data-series="expected"><title>claude 5-hour window expected to reset 2026-10-31 21:40 UTC/);
  assert.match(html, /Expected reset \(reading expired\)/);
  // 24h range: the line's last x is the 21:35 sample (x≈838), well short of the right edge at now (x=886)
  const xs = [...html.matchAll(/<polyline fill="none" stroke="var\(--claude\)"[^>]*points="([^"]+)"/g)].flatMap(m => m[1].split(' ').map(p => Number(p.split(',')[0])));
  assert.ok(Math.max(...xs) < 845, `line ends before now (max x ${Math.max(...xs)})`);
});
test('chart negative: a current reading keeps drawing to the latest snapshot, with no expected marker', async t => {
  const snaps = [snap(NOW - 600000, 0.4, NOW + 3600000), snap(NOW - 300000, 0.45, NOW + 3600000), snap(NOW - 60000, 0.5, NOW + 3600000)];
  const v = await view(t, { jobs: [], snapshots: snaps });
  assert.equal(v.graphs.allowance.claude.series['5-hour'].length, 3);
  assert.deepEqual(v.graphs.allowance.claude.expected, []);
  assert.doesNotMatch(usageHtml(v), /class="reset expected"/);
});
test('chart: a new reading after the reset starts a new segment (two polylines), and a reset-time change alone is still marked', async t => {
  const r1 = NOW - 1800000, r2 = NOW + 9000000;
  const v = await view(t, { jobs: [], snapshots: [snap(NOW - 3600000, 0.9, r1), snap(NOW - 600000, 0.95, r1), snap(NOW - 300000, 0.05, r2), snap(NOW - 60000, 0.06, r2)] });
  const pts = v.graphs.allowance.claude.series['5-hour'];
  assert.deepEqual(pts.map(p => !!p.gap), [false, true, false]);            // the 0.95 sample was already expired and is dropped
  const g = usageHtml(v).match(/<g data-series="claude 5-hour">(.*?)<\/g>/s)[1];
  assert.equal((g.match(/<polyline/g) || []).length, 2);
  // a reset time that moves later while the old one has not passed is an observed reset, as before
  const w = await view(t, { jobs: [], snapshots: [snap(NOW - 600000, 0.2, NOW + 60000), snap(NOW - 300000, 0.1, NOW + 3600000)] });
  assert.equal(w.graphs.allowance.claude.resets.length, 1); assert.deepEqual(w.graphs.allowance.claude.expected, []);
});

// ---- the model-free probe
function rollout(dir, name, records, mtime) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}
const tc = (iso, limits) => ({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', rate_limits: limits } });
const reading = (p, s) => ({ ...notReached.payload.rate_limits, primary: { used_percent: p, window_minutes: 300, resets_at: 1793492415 }, secondary: { used_percent: s, window_minutes: 10080, resets_at: 1793776715 } });
test('probe: newest real reading across recent rollouts, timed by the record itself; limit-hit records and message text are skipped', t => {
  const home = tmp(t), day = path.join(home, '.codex/sessions/2026/10/31'), prev = path.join(home, '.codex/sessions/2026/10/30');
  rollout(prev, 'rollout-2026-10-30T10-00-00-aaaa.jsonl', [tc('2026-10-30T10:01:00Z', reading(5, 50))], T('2026-10-30T10:01:00Z'));
  rollout(day, 'rollout-2026-10-31T14-30-00-bbbb.jsonl', [tc('2026-10-31T14:36:00Z', reading(21, 99)), { type: 'response_item', payload: { type: 'message', content: 'PRIVATE-PROMPT rate_limits' } }, tc('2026-10-31T14:41:28.185Z', reading(26, 100))], T('2026-10-31T14:41:30Z'));
  rollout(day, 'rollout-2026-10-31T22-55-23-cccc.jsonl', [limitHit], T('2026-10-31T22:55:25Z'));
  fs.writeFileSync(path.join(day, 'notes.jsonl'), JSON.stringify(tc('2026-10-31T22:56:00Z', reading(1, 1))));        // not a rollout name
  const a = codexAllowanceProbe({ home, now: NOW });
  assert.equal(a.observedAt, T('2026-10-31T14:41:28.185Z')); assert.equal(a.source, 'session-log');
  assert.deepEqual(a.windows.map(w => w.utilization), [0.26, 1]);
  assert.ok(!JSON.stringify(a).includes('PRIVATE-PROMPT'));
});
test('probe negatives: no sessions, only limit-hit records, a symlinked rollout, or a reading beyond the file bound give null', t => {
  const home = tmp(t), day = path.join(home, '.codex/sessions/2026/10/31');
  assert.equal(codexAllowanceProbe({ home, now: NOW }), null);
  rollout(day, 'rollout-2026-10-31T22-55-23-cccc.jsonl', [limitHit], T('2026-10-31T22:55:25Z'));
  assert.equal(codexAllowanceProbe({ home, now: NOW }), null);
  const outside = rollout(path.join(home, 'elsewhere'), 'x.jsonl', [tc('2026-10-31T20:00:00Z', reading(10, 10))], T('2026-10-31T20:00:00Z'));
  fs.symlinkSync(outside, path.join(day, 'rollout-2026-10-31T20-00-00-link.jsonl'));
  assert.equal(codexAllowanceProbe({ home, now: NOW }), null);
  rollout(day, 'rollout-2026-10-31T14-30-00-bbbb.jsonl', [tc('2026-10-31T14:36:00Z', reading(21, 99))], T('2026-10-31T14:36:00Z'));
  rollout(day, 'rollout-2026-10-31T22-56-00-dddd.jsonl', [limitHit], T('2026-10-31T22:56:00Z'));
  assert.equal(codexAllowanceProbe({ home, now: NOW, maxFiles: 2 }), null);              // the only reading is in the third-newest file
  assert.equal(codexAllowanceProbe({ home, now: NOW, maxFiles: 3 }).windows[1].utilization, 0.99);
  // a record time in the future is clamped to the probe time, never shown as newer than now
  rollout(day, 'rollout-2026-10-31T23-30-00-eeee.jsonl', [tc('2026-11-01T09:00:00Z', reading(2, 3))], NOW);
  assert.equal(codexAllowanceProbe({ home, now: NOW }).observedAt, NOW);
});
test('the tick stores probe readings in the cache, keeps the newer one, and the snapshot uses it when no job has a reading', t => {
  const root = tmp(t), team = { c: config(), view: { prs: [], issues: [] }, delivered: [], merged: [] };
  recordTick(root, { now: NOW, status: 'ok', team, jobs: [codexPaused], probes: { codex: { ...codexProbe, extra: 'dropped' } } });
  assert.equal(readCache(root).probes.codex.observedAt, codexProbe.observedAt);
  assert.equal(readCache(root).probes.codex.extra, undefined);
  assert.deepEqual(readSnapshots(root).at(-1).allowance.codex.windows.map(w => w.utilization), [0.26, 1]);
  recordTick(root, { now: NOW + 300000, status: 'ok', team, jobs: [codexPaused], probes: {} });                       // probe found nothing this time
  assert.equal(readCache(root).probes.codex.observedAt, codexProbe.observedAt);
  recordTick(root, { now: NOW + 600000, status: 'ok', team, jobs: [codexPaused], probes: { codex: { ...codexProbe, observedAt: codexProbe.observedAt - 1 } } });
  assert.equal(readCache(root).probes.codex.observedAt, codexProbe.observedAt);            // an older probe never replaces a newer one
  assert.deepEqual(mergeProbes({}, { '../x': codexProbe, codex: { provider: 'codex', windows: [] } }), {});
});
