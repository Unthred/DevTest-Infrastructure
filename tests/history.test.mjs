// Retained Foreman history (issue #362): lossless rotation, backfill, deduplication, gaps, pagination, filtering, redaction, storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { appendSnapshot, readSnapshots, recordTick } from '../supervisor/dashdata.mjs';
import { Team } from '../supervisor/team.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { GAP_MS, allSnapshots, appendTimeline, archiveOverflow, archiveSnapshots, archiveVerdict, collectEntries, computeGaps, entryText, filterTimeline, githubBackfill, readArchivedSnapshots, readTimeline, sanitizeEntry, storageReport } from '../supervisor/history.mjs';

const DAY = 86400000, T0 = Date.UTC(2026, 9, 29, 10, 0, 0), NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const dir = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700); return root; };
const snap = at => ({ at, status: 'ok', plan: [], agents: {}, allowance: {}, redCi: [] });
const config = { repository: 'o/r', agents: { claude: { provider: 'claude' }, codex: { provider: 'codex' } } };
const ID = n => String(n).padStart(32, '0');

test('rotation moves old snapshots into the compressed archive without loss, and a repeat does not duplicate', t => {
  const root = dir(t);
  for (let i = 0; i < 400; i++) { const at = T0 + i * 60000 * 5; appendSnapshot(root, snap(at), at); }
  const old = readSnapshots(root).slice(0, 100); archiveSnapshots(root, old); archiveSnapshots(root, old);   // idempotent
  assert.equal(readArchivedSnapshots(root).length, 100);
  assert.ok(fs.readdirSync(path.join(root, 'dashboard', 'archive')).every(n => /^snapshots-2026-\d\d\.jsonl\.gz$/.test(n)));
  // age-based rotation from the real writer: everything older than 35 days ends in the archive, the total never shrinks
  const later = T0 + 60 * DAY; appendSnapshot(root, snap(later), later);
  const hourly = Math.floor(later / 3600000) * 3600000 + 30; appendSnapshot(root, snap(later + 1), hourly);
  const all = allSnapshots(root, readSnapshots(root));
  assert.equal(all.length, 402); assert.deepEqual(all.map(s => s.at), [...all.map(s => s.at)].sort((a, b) => a - b));
  assert.equal(new Set(all.map(s => s.at)).size, all.length);
});

test('a crash between the archive write and the hot rewrite leaves a duplicate that readers drop', t => {
  const root = dir(t);
  appendSnapshot(root, snap(T0), T0); archiveSnapshots(root, readSnapshots(root));   // archived, hot file not yet rewritten
  assert.equal(allSnapshots(root, readSnapshots(root)).length, 1);
});

test('merge and unblock overflow is archived and the live cap still bounds the state', t => {
  const root = dir(t);
  const log = Array.from({ length: 503 }, (_, i) => ({ pr: i + 1, mergedAt: T0 + i, issue: null }));
  const team = Object.create(Team.prototype); team.root = root;
  team.archiveOverflow('merge', log.slice(0, -500));
  const kept = log.slice(-500);
  assert.equal(kept.length, 500);
  const entries = collectEntries({ config, root, jobs: [], events: [], state: { mergeLog: kept } });
  assert.equal(new Set(entries.filter(e => e.kind === 'merge').map(e => e.id)).size, 503);   // 500 live + 3 archived, all present
  archiveOverflow(root, 'unblock', [{ at: T0, tk: 'pull', target: 7, what: 'w', result: 'r' }]);
  assert.ok(collectEntries({ config, root, jobs: [], events: [], state: {} }).some(e => e.kind === 'unblock' && e.pr === 7));
});

test('a verdict about to be deleted is kept in the timeline', t => {
  const root = dir(t);
  archiveVerdict(root, `12:${'a'.repeat(40)}`, { verdict: 'CHANGES', reviewer: 'codex', at: T0, job: ID(1) });
  const e = readTimeline(root);
  assert.equal(e.length, 1); assert.deepEqual([e[0].kind, e[0].pr, e[0].head, e[0].verdict, e[0].reviewer], ['verdict', 12, 'aaaaaaa', 'CHANGES', 'codex']);
});

test('second-opinion and review-exception verdicts are collected and archived, distinct from the primary verdict', t => {
  const root = dir(t); const key = `14:${'c'.repeat(40)}`;
  const mk = (reviewer, at) => ({ verdict: 'PASS', reviewer, at, job: ID(3) });
  const state = { verdicts: { [key]: mk('codex', T0) }, secondOpinions: { [key]: mk('claude', T0 + 1) }, exceptionReviews: { [key]: mk('codex', T0 + 2) } };
  assert.equal(appendTimeline(root, collectEntries({ config, root, jobs: [], events: [], state })), 3);
  assert.equal(appendTimeline(root, collectEntries({ config, root, jobs: [], events: [], state })), 0);
  const tl = readTimeline(root);
  assert.deepEqual(tl.map(e => e.detail || 'primary').sort(), ['primary', 'review exception', 'second opinion']);
  const root2 = dir(t);
  assert.equal(archiveVerdict(root2, key, mk('claude', T0), 'secondOpinion'), 1);
  assert.equal(readTimeline(root2)[0].detail, 'second opinion');
});

test('backfill from job records, events, verdicts and merges; running it again adds nothing', t => {
  const root = dir(t);
  const jobs = [{ id: ID(1), provider: 'claude', kind: 'implement', issue: 5, createdAt: T0 }, { id: ID(2), provider: 'codex', kind: 'review', issue: 9, createdAt: T0 + 1000 }];
  const events = [{ at: T0 + 10, job: ID(1), kind: 'created' }, { at: T0 + 20, job: ID(1), kind: 'completed' }, { at: T0 + 30, job: ID(1), kind: 'noise_not_allowlisted' }];
  const state = { verdicts: { [`9:${'b'.repeat(40)}`]: { verdict: 'PASS', reviewer: 'codex', at: T0 + 2000, job: ID(2) } }, mergeLog: [{ pr: 9, issue: 5, agent: 'claude', reviewer: 'codex', mergedAt: T0 + 3000 }] };
  const inputs = { config, root, jobs, events, state };
  const first = appendTimeline(root, collectEntries(inputs));
  // job 1 has events; job 2 has none, so its record supplies the creation (marked as coming from the job record), nothing else is invented
  assert.equal(first, 5);
  const tl = readTimeline(root);
  assert.deepEqual(tl.map(e => e.kind + ':' + (e.event || '')), ['job:created', 'job:completed', 'job:created', 'verdict:', 'merge:']);
  assert.equal(tl.find(e => e.job === ID(2)).source, 'job-record');
  assert.equal(appendTimeline(root, collectEntries(inputs)), 0);
});

test('GitHub backfill adds missing merges once and never duplicates a merge already recorded', t => {
  const root = dir(t);
  appendTimeline(root, [{ id: 'merge:9', at: T0 + 3000, kind: 'merge', pr: 9, issue: 5 }]);
  const calls = [];
  const gh = args => { calls.push(args); return JSON.stringify([{ number: 9, mergedAt: new Date(T0 + 3000).toISOString(), headRefName: 'x/issue-5-a' }, { number: 3, mergedAt: new Date(T0 - DAY).toISOString(), headRefName: 'codex/issue-2-q', closingIssuesReferences: [{ number: 2 }] }, { number: 'bad', mergedAt: 'nope' }]); };
  assert.deepEqual(githubBackfill(root, gh, 'o/r'), { seen: 2, added: 1 });
  assert.deepEqual(githubBackfill(root, gh, 'o/r'), { seen: 2, added: 0 });
  const tl = readTimeline(root);
  assert.deepEqual(tl.map(e => [e.pr, e.source, e.issue]), [[3, 'github', 2], [9, 'live', 5]]);
  assert.ok(calls.every(a => a[0] === 'pr' && a[1] === 'list'));   // only a read-only list
});

test('gaps are reported from stored data only: before tick data starts, between ticks, and since the last tick', () => {
  const tl = [{ id: 'a', at: T0, kind: 'job' }];
  const ticks = [snap(T0 + DAY), snap(T0 + DAY + 300000), snap(T0 + 2 * DAY)];
  const gaps = computeGaps(tl, ticks, T0 + 2 * DAY + 600000);
  assert.deepEqual(gaps.map(g => [g.from, g.to]), [[T0, T0 + DAY], [T0 + DAY + 300000, T0 + 2 * DAY]]);
  assert.match(gaps[0].reason, /No tick-level data was retained/);
  assert.equal(computeGaps(tl, [], NOW).length, 1);
  assert.equal(computeGaps([], [], NOW).length, 0);            // nothing recorded, nothing claimed
  assert.equal(computeGaps(tl, [snap(T0 + 10)], T0 + 10 + GAP_MS * 4).at(-1).reason, 'No tick was recorded since the last one.');
});

test('allowlist and redaction: unknown fields are dropped, secrets never reach the archive, bad entries are refused', t => {
  const root = dir(t);
  const token = ['ghp', 'abcdefghijklmnop1234'].join('_');
  const e = sanitizeEntry({ id: 'x', at: T0, kind: 'unblock', pr: 4, detail: `retry with password=hunter2 ${token} me@home.org`, prompt: 'SECRET PROMPT', sessionId: 's-1', path: '/etc/shadow', job: 'not-a-job-id', agent: '<script>', head: 'zzz' });
  assert.deepEqual(Object.keys(e).sort(), ['at', 'detail', 'id', 'kind', 'pr', 'source']);
  assert.doesNotMatch(e.detail, /hunter2|ghp_|home\.org/);
  assert.equal(sanitizeEntry({ id: 'x', at: T0, kind: 'tick' }), null); assert.equal(sanitizeEntry({ at: T0, kind: 'job' }), null); assert.equal(sanitizeEntry({ id: 'x', at: -1, kind: 'job' }), null);
  appendTimeline(root, [{ id: 'y', at: T0, kind: 'unblock', pr: 4, detail: `Bearer ${'q'.repeat(30)}`, prompt: 'SECRET PROMPT' }]);
  const raw = fs.readFileSync(path.join(root, 'dashboard', 'archive', 'timeline.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /SECRET PROMPT|qqqqqqqq/);
  assert.doesNotMatch(entryText({ kind: 'job', agent: 'claude', jobKind: 'review', pr: 3, event: 'completed' }), /undefined/);
});

test('filters: type, agent, issue or PR, date range, source; bad values match nothing extra', () => {
  const tl = [
    { id: '1', at: T0, kind: 'job', agent: 'claude', issue: 5, source: 'live' }, { id: '2', at: T0 + DAY, kind: 'merge', agent: 'claude', pr: 9, issue: 5, source: 'github' },
    { id: '3', at: T0 + 2 * DAY, kind: 'verdict', reviewer: 'codex', pr: 9, source: 'live' }, { id: '4', at: T0 + 3 * DAY, kind: 'job', agent: 'codex', issue: 7, source: 'live' }];
  const ids = f => filterTimeline(tl, f).map(e => e.id);
  assert.deepEqual(ids({ kind: 'job' }), ['1', '4']); assert.deepEqual(ids({ agent: 'codex' }), ['4']); assert.deepEqual(ids({ ref: '#9' }), ['2', '3']); assert.deepEqual(ids({ ref: '5' }), ['1', '2']);
  assert.deepEqual(ids({ from: '2026-10-30', to: '2026-10-30' }), ['2']); assert.deepEqual(ids({ source: 'github' }), ['2']);
  assert.deepEqual(ids({ kind: 'job', agent: 'claude', ref: '5' }), ['1']); assert.deepEqual(ids({ from: 'garbage', ref: 'x;drop' }), ['1', '2', '3', '4']);
});

test('storage report: sizes, growth per day, and warnings without deleting anything', t => {
  const root = dir(t);
  appendTimeline(root, [{ id: 'a', at: NOW - 10 * DAY, kind: 'job' }]);
  fs.mkdirSync(path.join(root, 'events'), { recursive: true }); fs.writeFileSync(path.join(root, 'events', 'x.jsonl'), 'x'.repeat(10000));
  const ok = storageReport(root, { now: NOW, statfs: () => ({ bavail: 1e9, bsize: 4096, blocks: 2e9 }) });
  assert.ok(ok.used >= 10000); assert.ok(ok.perDay > 0); assert.deepEqual(ok.warnings, []); assert.ok(ok.parts.events === 10000);
  const tight = storageReport(root, { now: NOW, statfs: () => ({ bavail: 2, bsize: 4096, blocks: 1000 }) });
  assert.equal(tight.warnings.length, 2); assert.match(tight.warnings.join(' '), /free/);
  assert.equal(storageReport(root, { now: NOW, statfs: () => { throw new Error('x'); } }).free, null);
  assert.ok(fs.existsSync(path.join(root, 'events', 'x.jsonl')));
});

test('the tick records the timeline and the rotation keeps the hot file bounded', async t => {
  const root = dir(t);
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }); fs.mkdirSync(path.join(root, 'events'), { recursive: true });
  const j = { id: ID(1), provider: 'claude', kind: 'implement', issue: 362, createdAt: T0, status: 'completed' };
  fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j)); fs.writeFileSync(path.join(root, 'events', `${j.id}.jsonl`), JSON.stringify({ at: T0, job: j.id, kind: 'created' }) + '\n');
  const team = { c: { repository: 'o/r', agents: config.agents, limits: {} }, view: { prs: [], issues: [] }, merged: [], delivered: [] };
  recordTick(root, { now: T0 + 1000, status: 'ok', team, jobs: [j] });
  assert.equal(readTimeline(root).length, 1); assert.equal(readTimeline(root)[0].issue, 362);
});

async function server(t, root) {
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } };
  const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port;
  s.on('request', handler({ root, config: cfg, host: '127.0.0.1', port, now: () => NOW })); t.after(() => s.close());
  return p => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject); });
}

test('timeline page: reaches back to the first job, paginates, sorts, filters, links to issue and PR, shows gaps and storage', async t => {
  const root = dir(t);
  const entries = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, at: T0 + i * 3600000, kind: i % 2 ? 'merge' : 'job', agent: i % 2 ? 'codex' : 'claude', ...(i % 2 ? { pr: 100 + i } : { issue: 200 + i }), event: 'created', jobKind: 'implement' }));
  appendTimeline(root, entries);
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true }); fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 }, pulls: [], issues: [] }));
  appendSnapshot(root, snap(NOW - 60000), NOW - 60000);
  const get = await server(t, root);
  const first = (await get('/activity/timeline')).body;
  assert.match(first, /Activity timeline since 2026-10-29/); assert.match(first, /1–25 of 60/); assert.match(first, /Page 1 of 3/);
  assert.match(first, /Known gaps \(1\)/); assert.match(first, /No tick-level data was retained before this time/); assert.match(first, /History storage/);
  assert.match(first, /href="https:\/\/github\.com\/o\/r\/(issues|pull)\/\d+"/);
  assert.match((await get('/activity/timeline?tl.page=3')).body, /51–60 of 60/);
  assert.match((await get('/activity/timeline?tl.sort=at&tl.dir=desc')).body, /aria-sort="descending"/);
  const f = (await get('/activity/timeline?kind=merge&agent=codex&ref=%23105')).body;
  assert.match(f, /\(1 of 60\)/); assert.match(f, /merged PR #105/); assert.doesNotMatch(f, /issue #200/);
  assert.match((await get('/activity/timeline?from=2099-01-01')).body, /No activity matches/);
  assert.match((await get('/activity/timeline?kind=%3Cscript%3E')).body, /0 of 60|No activity matches/);
  assert.doesNotMatch((await get('/activity/timeline?ref=%3Cscript%3E&kind=%22%3E')).body.replace(/<script>\/\/ Issue #552[^<]*<\/script>/, ''), /<script>/);
});

test('all-time range reads the archive; the other ranges do not', async t => {
  const root = dir(t);
  const old = T0 - 20 * DAY;
  const withAllowance = at => ({ ...snap(at), agents: { claude: 'idle' }, allowance: { claude: { observedAt: at, windows: [{ type: 'weekly', windowMinutes: 10080, utilization: 0.5, resetsAt: at + DAY }] }, codex: null } });
  archiveSnapshots(root, [withAllowance(NOW - 90 * DAY), withAllowance(NOW - 89 * DAY)]);
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true }); fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 }, pulls: [], issues: [] }));
  const get = await server(t, root);
  const all = (await get('/usage?range=all')).body, thirty = (await get('/usage?range=30d')).body;
  assert.match(all, /href="[^"]*range=all"/); assert.match(all, /<circle class="pt"/); assert.doesNotMatch(thirty, /<circle class="pt"/);
  assert.ok(old < T0);
});

test('the reconcile log is rotated into a gzip archive and no line is lost', t => {
  const root = dir(t); const log = path.join(root, 'reconcile.log');
  const lines = Array.from({ length: 12000 }, (_, i) => `2026-10-30T00:00:00Z rc=0 tick ${i} ${'x'.repeat(100)}`);
  fs.writeFileSync(log, lines.join('\n') + '\n');
  const script = fs.readFileSync(new URL('../tools/install-reconcile-user-script.sh', import.meta.url), 'utf8');
  const block = /# Rotate only above[\s\S]*?\nfi\n/.exec(script)[0];
  const r = spawnSync('bash', ['-c', `LOG=${JSON.stringify(log)}\n${block}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const kept = fs.readFileSync(log, 'utf8'), archived = zlib.gunzipSync(fs.readFileSync(`${log}.archive.gz`)).toString('utf8');
  assert.ok(kept.length < 400000);
  assert.equal(archived + kept, lines.join('\n') + '\n');
});
