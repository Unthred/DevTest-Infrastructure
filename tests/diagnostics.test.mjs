// Issue #496: the Diagnostics tab. Every measure is checked against a fixture counted by hand (the arithmetic is in the comments), the
// retention bound, the bounded recorder read, and a missing, unreadable or damaged recorder log (the page says so instead of failing).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tickGaps, jobTurnaround, verdictLag, idleHistory, readRecorder, buildDiagnostics, clearRecorderCache, RETENTION_DAYS, DAY_MS, MAX_FILE_BYTES, MAX_RECORDER_FILES } from '../supervisor/diagnostics.mjs';
import { idleReport } from '../supervisor/idlecause.mjs';
import { handler, currentView } from '../supervisor/dashserver.mjs';
import { renderRoute, NAV, matchRoute } from '../supervisor/dashrender.mjs';

const M = 60000, D0 = Date.UTC(2026, 10, 3), NOW = Date.UTC(2026, 10, 4, 12, 0, 0), FROM = NOW - RETENTION_DAYS * DAY_MS;
const at = (day, h, m = 0) => Date.UTC(2026, 10, day, h, m);
const agents = { claude: 'claude', codex: 'codex' };
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

const CONFIG = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } };
function stateRoot(t, ticks = [at(4, 8), at(4, 8, 5), at(4, 8, 30)]) {
  const root = tmp(t);
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - M, status: 'ok', error: null, lastOkAt: NOW - M }, fetchedAt: NOW - M, delivered: [], pulls: [], issues: [] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'snapshots.jsonl'), ticks.map(a => JSON.stringify({ at: a, status: 'ok', plan: [], agents: {}, idle: {} })).join('\n') + '\n');
  return root;
}
async function get(t, root, recorderDir, p = '/diagnostics') {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config: CONFIG, host: '127.0.0.1', port, now: () => NOW, recorderDir }));
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
}

test('tick gaps: planned versus actual, missed ticks and lost minutes (hand counted)', () => {
  // 3 Nov ticks at 06:00 06:05 06:10 06:25 06:30 -> gaps 5 5 15 5. Planned 5, a missed tick is 10 or more.
  // Median of 5,5,15,5 = 5; longest 15; missed 1 (the 15); lost = 0+0+10+0 = 10. Five ticks. 4 Nov: one tick, no gap.
  const snaps = [[6, 0], [6, 5], [6, 10], [6, 25], [6, 30]].map(([h, m]) => ({ at: at(3, h, m) })).concat({ at: at(4, 8) }, { at: at(3, 6, 5) });  // duplicate time counts once
  const r = tickGaps(snaps, FROM, NOW);
  assert.equal(r.plannedMinutes, 5); assert.equal(r.lateAtMinutes, 10);
  const d3 = r.days.find(d => d.day === '2026-11-03');
  assert.deepEqual({ ...d3 }, { day: '2026-11-03', count: 4, medianMinutes: 5, maxMinutes: 15, totalMinutes: 30, lateCount: 1, lostMinutes: 10, ticks: 5 });
  // The 4 Nov 08:00 tick follows the 06:30 tick on 3 Nov: a 25.5 hour gap, counted on the later tick's day.
  const d4 = r.days.find(d => d.day === '2026-11-04');
  assert.equal(d4.count, 1); assert.equal(d4.maxMinutes, 1530); assert.equal(d4.lateCount, 1); assert.equal(d4.ticks, 1);
});

test('job turnaround: end of one job to the start of the next, per agent; overlapping jobs are one busy span', () => {
  const job = (provider, a, b, status = 'completed') => ({ id: `${provider}${a}`.padEnd(32, '0'), provider, status, createdAt: a, updatedAt: b });
  // claude: 06:00-06:10, 06:30-06:40 (gap 20), 06:35-06:50 overlaps the second (busy 06:30-06:50), 06:55-07:00 (gap 5).
  // Gaps 20 and 5: count 2, median 12.5, longest 20, total 25. codex has one job: no gap at all.
  const jobs = [job('claude', at(3, 6), at(3, 6, 10)), job('claude', at(3, 6, 30), at(3, 6, 40)), job('claude', at(3, 6, 35), at(3, 6, 50)), job('claude', at(3, 6, 55), at(3, 7)), job('codex', at(3, 6), at(3, 8)), { unreadable: true }];
  const r = jobTurnaround(jobs, agents, FROM, NOW);
  assert.deepEqual({ ...r.claude.days.find(d => d.day === '2026-11-03') }, { day: '2026-11-03', count: 2, medianMinutes: 12.5, maxMinutes: 20, totalMinutes: 25 });
  assert.equal(r.codex.days.find(d => d.day === '2026-11-03').count, 0); assert.equal(r.codex.days.find(d => d.day === '2026-11-03').medianMinutes, null);
});

test('verdict lag: review end to the recorded verdict; carried, non-review and impossible rows are not counted', () => {
  const rev = (id, end, kind = 'review') => ({ id: id.padEnd(32, '0'), kind, provider: 'claude', status: 'completed', createdAt: end - 5 * M, updatedAt: end });
  const jobs = [rev('a', at(3, 9)), rev('b', at(3, 10)), rev('c', at(3, 11), 'implement'), rev('d', at(3, 12))];
  const verdicts = {
    '1:x': { job: 'a'.padEnd(32, '0'), at: at(3, 9, 3), verdict: 'PASS' },            // 3 min
    '2:x': { job: 'b'.padEnd(32, '0'), at: at(3, 10, 7), verdict: 'CHANGES' },        // 7 min
    '3:x': { job: 'c'.padEnd(32, '0'), at: at(3, 11, 1), verdict: 'PASS' },           // not a review job
    '4:x': { job: 'd'.padEnd(32, '0'), at: at(3, 11, 59), verdict: 'PASS' },          // recorded before the job ended: clock error, skipped
    '5:x': { job: 'a'.padEnd(32, '0'), at: at(3, 13), carriedFrom: 'sha' },           // a carried verdict has no review of its own
    '6:x': { job: 'zz'.padEnd(32, '0'), at: at(3, 14) }                               // no such job
  };
  const d = verdictLag(jobs, verdicts, FROM, NOW).days.find(x => x.day === '2026-11-03');
  assert.deepEqual({ ...d }, { day: '2026-11-03', count: 2, medianMinutes: 5, maxMinutes: 7, totalMinutes: 10 });
});

test('idle by cause is #487\'s figure, taken from idleReport and not recomputed', () => {
  const jobs = [{ id: 'j'.padEnd(32, '0'), provider: 'claude', status: 'completed', createdAt: at(3, 6), updatedAt: at(3, 7) }];
  const day = idleHistory({ jobs, snapshots: [], agents, from: FROM, to: NOW }).find(r => r.day === '2026-11-03');
  const direct = idleReport({ jobs, snapshots: [], agents, from: D0, to: D0 + DAY_MS });
  assert.equal(day.agents.claude.busyMinutes, 60); assert.equal(day.agents.claude.busyMinutes, direct.agents.claude.busyMinutes);
  assert.deepEqual(day.agents.claude.minutes, direct.agents.claude.minutes); assert.equal(day.agents.codex.busyMinutes, 0);
});

test('retention: nothing older than the stated window is counted or shown', async t => {
  const old = FROM - 2 * DAY_MS, snaps = [{ at: old }, { at: old + 5 * M }, { at: at(3, 6) }, { at: at(3, 6, 5) }];
  const d = buildDiagnostics({ snapshots: snaps, agents, now: NOW, recorderDir: null });
  assert.equal(d.retentionDays, 7); assert.equal(d.ticks.ticks, 2, 'the two ticks older than the window are dropped');
  assert.ok(d.ticks.days.every(x => x.day >= new Date(FROM).toISOString().slice(0, 10)) && d.ticks.days.length <= 8);
  const page = await get(t, stateRoot(t, [old, old + 5 * M, at(3, 6), at(3, 6, 5)]), null);
  assert.match(page.body, /last 7 days/); assert.doesNotMatch(page.body, new RegExp(new Date(old).toISOString().slice(0, 10)), 'a day older than the window is not listed');
});

const host = (ts, load, swapUsed, io, blocked) => JSON.stringify({ type: 'host', schema: 1, timestamp_utc: ts, load_average: [load, 1, 1], memory_kb: { swap_used_kb: swapUsed, swap_total_kb: 1000 }, cpu_iowait_percent: io, blocked_tasks: blocked });
test('recorder: hourly and daily load, swap and disk wait from a hand-counted log; damaged and foreign lines are skipped and said so', t => {
  clearRecorderCache();
  const dir = tmp(t);
  // 3 Nov 10:00 hour: load 2 and 4 (avg 3, peak 4), swap 100 and 500 of 1000 (peak 50%), iowait 1 and 3 (avg 2, peak 3), blocked 5 and 9 (peak 9).
  // 3 Nov 11:00 hour: load 10 (avg 10), swap 200 (20%), iowait 6, blocked 1. Day: 3 samples, load avg (2+4+10)/3 = 5.3, peak 10, swap peak 50, io avg (1+3+6)/3 = 3.3.
  fs.writeFileSync(path.join(dir, 'host-20261103.jsonl'), [host('2026-11-03T10:00:00Z', 2, 100, 1, 5), host('2026-11-03T10:30:00Z', 4, 500, 3, 9), 'not json', JSON.stringify({ type: 'detail', timestamp_utc: '2026-11-03T10:31:00Z' }), host('2026-11-03T11:00:00Z', 10, 200, 6, 1)].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'host-20260101.jsonl'), host('2026-01-01T10:00:00Z', 99, 1, 1, 1) + '\n');     // far outside the window: never opened
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'); fs.writeFileSync(path.join(dir, 'detail-20261103.jsonl'), '{}\n');     // not host logs
  const r = readRecorder(dir, FROM, NOW);
  assert.equal(r.status, 'partial'); assert.equal(r.files, 1); assert.equal(r.samples, 3); assert.equal(r.skippedLines, 2); assert.match(r.note, /2 lines were not valid samples/);
  assert.deepEqual(r.hourly.map(h => [h.samples, h.loadAvg, h.loadMax, h.swapMaxPercent, h.iowaitAvg, h.iowaitMax, h.blockedMax]), [[2, 3, 4, 50, 2, 3, 9], [1, 10, 10, 20, 6, 6, 1]]);
  const day = r.days.find(d => d.day === '2026-11-03');
  assert.deepEqual({ ...day }, { day: '2026-11-03', samples: 3, loadAvg: 5.3, loadMax: 10, swapMaxPercent: 50, swapMaxKb: 500, iowaitAvg: 3.3, iowaitMax: 6, blockedMax: 9 });
  assert.equal(r.days.find(d => d.day === '2026-11-02').samples, 0);
});

test('recorder: a finished file is read once and a growing file only from where it stopped', t => {
  clearRecorderCache();
  const dir = tmp(t), f = path.join(dir, 'host-20261104.jsonl');
  fs.writeFileSync(f, host('2026-11-04T08:00:00Z', 1, 1, 1, 1) + '\n' + host('2026-11-04T08:01:00Z', 3, 1, 1, 1) + '\n');
  assert.equal(readRecorder(dir, FROM, NOW).samples, 2);
  // Append one complete line and one half-written line: only the complete line is taken; the rest is read when it is finished.
  fs.appendFileSync(f, host('2026-11-04T08:02:00Z', 5, 1, 1, 1) + '\n' + host('2026-11-04T08:03:00Z', 7, 1, 1, 1).slice(0, 40));
  const r = readRecorder(dir, FROM, NOW);
  assert.equal(r.samples, 3); assert.equal(r.hourly[0].loadAvg, 3);      // (1+3+5)/3, not counted twice
  fs.appendFileSync(f, host('2026-11-04T08:03:00Z', 7, 1, 1, 1).slice(40) + '\n');
  assert.equal(readRecorder(dir, FROM, NOW).samples, 4);
});

test('recorder: one huge file is read from its newest part only, within the size cap', t => {
  clearRecorderCache();
  const dir = tmp(t), line = host('2026-11-04T09:00:00Z', 2, 1, 1, 1) + '\n', fresh = host('2026-11-04T10:00:00Z', 8, 1, 1, 1) + '\n';
  const n = Math.ceil((MAX_FILE_BYTES + 1024 * 1024) / line.length);
  fs.writeFileSync(path.join(dir, 'host-20261104.jsonl'), line.repeat(n) + fresh);
  const r = readRecorder(dir, FROM, NOW);
  assert.equal(r.status, 'partial'); assert.match(r.note, /newest part only/);
  assert.ok(r.samples < n && r.samples > 1000, `read ${r.samples} of ${n}`); assert.ok(r.samples * line.length <= MAX_FILE_BYTES + 2 * line.length);
  assert.equal(r.hourly.at(-1).loadMax, 8, 'the newest line is the one kept');
});

test('recorder: over the file limit the newest files are kept and the oldest dropped, and it says so', t => {
  clearRecorderCache();
  const dir = tmp(t);
  // 8 days (28 Oct to 4 Nov) x 6 files = 48 files, over the limit of 40. Load encodes the day so the kept days are visible.
  for (let day = 28; day <= 35; day++) {
    const d = day > 31 ? day - 31 : day, mo = day > 31 ? '11' : '10', dd = String(d).padStart(2, '0'), stamp = `2026${mo}${dd}`;
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, i === 0 ? `host-${stamp}.jsonl` : `host-${stamp}-00${i}.jsonl`), host(`2026-${mo}-${dd}T0${i}:00:00Z`, day, 1, 1, 1) + '\n');
  }
  assert.equal(fs.readdirSync(dir).length, 48); assert.ok(48 > MAX_RECORDER_FILES);
  const r = readRecorder(dir, FROM, NOW);
  assert.equal(r.status, 'partial'); assert.equal(r.files, MAX_RECORDER_FILES); assert.match(r.note, /newest log files were read \(file limit\)/);
  assert.equal(r.hourly.at(-1).loadMax, 35, 'today (4 Nov) is kept');
  assert.equal(r.days.find(d => d.day === '2026-10-28').samples, 0, 'the oldest day is the one dropped');
  assert.equal(r.days.find(d => d.day === '2026-11-04').samples, 6);
});

test('recorder: the per-call size budget is spent on the newest files first', t => {
  clearRecorderCache();
  const dir = tmp(t);
  // Seven full-size days (29 Oct to 4 Nov), one distinct load each: 7 x 8 MiB is over the 48 MiB budget, so the oldest day gets what is left.
  for (let day = 29; day <= 35; day++) {
    const d = day > 31 ? day - 31 : day, mo = day > 31 ? '11' : '10', dd = String(d).padStart(2, '0'), line = host(`2026-${mo}-${dd}T09:00:00Z`, day, 1, 1, 1) + '\n';
    fs.writeFileSync(path.join(dir, `host-2026${mo}${dd}.jsonl`), line.repeat(Math.floor(MAX_FILE_BYTES / line.length)));
  }
  const r = readRecorder(dir, FROM, NOW);
  assert.equal(r.status, 'partial'); assert.match(r.note, /per-call size limit/);
  assert.ok(r.days.find(d => d.day === '2026-11-04').samples > 0, 'today is read');
  const n = day => r.days.find(d => d.day === day).samples;
  assert.ok(n('2026-10-29') < n('2026-11-04') / 2, 'the oldest day gets only what is left of the budget');
});

test('recorder: a missing folder, a folder that is a file, an empty folder and an unreadable log each say so', t => {
  clearRecorderCache();
  const dir = tmp(t);
  const missing = readRecorder(path.join(dir, 'nope'), FROM, NOW);
  assert.equal(missing.status, 'missing'); assert.match(missing.note, /does not exist/); assert.deepEqual(missing.hourly, []);
  fs.writeFileSync(path.join(dir, 'afile'), 'x');
  assert.equal(readRecorder(path.join(dir, 'afile'), FROM, NOW).status, 'unreadable');
  const empty = path.join(dir, 'empty'); fs.mkdirSync(empty);
  assert.equal(readRecorder(empty, FROM, NOW).status, 'empty');
  const bad = path.join(dir, 'bad'); fs.mkdirSync(bad); fs.mkdirSync(path.join(bad, 'host-20261104.jsonl'));      // a host log name that is not a readable file
  const b = readRecorder(bad, FROM, NOW);
  assert.equal(b.status, 'unreadable'); assert.match(b.note, /No recorder log file could be read/);
  assert.equal(buildDiagnostics({ agents, now: NOW, recorderDir: null }).recorder.status, 'missing');
});

test('the Diagnostics tab is in the navigation, routes, and renders every section, including a missing recorder, without failing', async t => {
  assert.ok(NAV.some(([p, h]) => p === 'diagnostics' && h === '/diagnostics')); assert.deepEqual(matchRoute('/diagnostics'), { page: 'diagnostics' });
  clearRecorderCache();
  const root = stateRoot(t), rdir = tmp(t);
  fs.writeFileSync(path.join(rdir, 'host-20261104.jsonl'), host('2026-11-04T08:00:00Z', 6, 250, 2, 3) + '\n');
  const serve = recorderDir => get(t, root, recorderDir);
  const ok = await serve(rdir);
  assert.equal(ok.status, 200);
  for (const id of ['diag-about', 'diag-ticks', 'diag-turnaround', 'diag-verdicts', 'diag-idle', 'diag-recorder']) assert.match(ok.body, new RegExp(`data-card="${id}"`), id);
  assert.match(ok.body, /<a href="\/diagnostics" aria-current="page">/); assert.match(ok.body, /data-diag-recorder="ok"/); assert.match(ok.body, /1 samples from 1 log file/);
  assert.match(ok.body, /<td class="num" data-label="Missed ticks">1<\/td>/, 'the 08:05 to 08:30 gap is a missed tick');
  assert.doesNotMatch(ok.body, /undefined|NaN|\/mnt\/|rdir/);
  const gone = await serve(path.join(rdir, 'missing'));
  assert.equal(gone.status, 200); assert.match(gone.body, /data-diag-recorder="missing"/); assert.match(gone.body, /Recorder logs not found/); assert.match(gone.body, /data-card="diag-ticks"/, 'the other sections still show');
  assert.doesNotMatch(gone.body, new RegExp(rdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no path is shown');
});

test('a page rendered without data says so (negative)', async t => {
  const view = await currentView({ root: stateRoot(t), config: CONFIG, now: NOW });
  const out = renderRoute(view, { page: 'diagnostics' }, { pathname: '/diagnostics' });
  assert.equal(out.status, 200); assert.match(out.html, /Diagnostics are not available here/);
});
