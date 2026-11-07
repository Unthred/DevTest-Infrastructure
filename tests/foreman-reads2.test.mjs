// Issue #636: foreman_host additions, foreman_tests, foreman_ticks, foreman_item_timeline and the finished marker of foreman_reports (D-030).
// Real dashboard handler over a temporary state root, real MCP tools over HTTP, fake /proc trees. Every secret-shaped fixture is assembled at run
// time; no model is called and no real state is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { handler } from '../supervisor/dashserver.mjs';
import { recordTestEvent, readTestEvents, acquireTestSlot } from '../supervisor/testslots.mjs';
import { recordSkip } from '../supervisor/skips.mjs';
import { testRunsView, ticksView } from '../supervisor/mcpreads.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { createReports, FINISHED_MARKER } from '../foreman-mcp/reports.mjs';
import { itemTimeline } from '../foreman-mcp/insights.mjs';
import { hostActivity, topProcesses, getJson } from '../foreman-mcp/source.mjs';

const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const PW = ['pass', 'word'].join(''), PWVAL = ['hunter2', 'hunter2x'].join('');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reads2-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const BASE = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/nonexistent/repo', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  budget: { enabled: true }, limits: { per_agent: 1, overall: 2, test_slots: 3 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] } } };
const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;

// ---- host additions
const fakeProc = (vals) => {
  const files = {
    '/p/vmstat': `nr_free_pages 1\npswpin ${vals.pswpin}\npswpout ${vals.pswpout}\n`,
    '/p/stat': `cpu  ${vals.cpu.join(' ')} 0 0 0\nprocs_blocked ${vals.blocked}\n`,
    '/p/diskstats': `   8 0 sda 1 2 3 4 5 6 7 8 9 ${vals.sda} 11 12\n   8 1 sda1 1 2 3 4 5 6 7 8 9 99999 11 12\n   7 0 loop0 1 2 3 4 5 6 7 8 9 99999 11 12\n   9 0 md1 1 2 3 4 5 6 7 8 9 ${vals.md} 11 12\n 259 1 md2p1 1 2 3 4 5 6 7 8 9 ${vals.md} 11 12\n`,
    '/p/10/status': `Name:\tbigproc\nVmRSS:\t 2097152 kB\nVmSwap:\t 524288 kB\n`, '/p/11/status': `Name:\tsmall\nVmRSS:\t 1024 kB\n`, '/p/12/status': `Name:\tkthread\n`, '/p/13/status': `Name:\tmid\nVmRSS:\t 1048576 kB\nVmSwap:\t 0 kB\n`,
    '/p/10/cmdline': `bigproc\0--token=${GH}`,
  };
  const reads = [];
  return { reads, fsRead: f => { reads.push(f); if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[f]; }, readDir: () => ['10', '11', '12', '13', 'self', 'cpuinfo'], files };
};

test('hostActivity: swap rate, iowait, busy percent for whole disks only, and the top processes by memory; no command line is ever read', async () => {
  const a = fakeProc({ pswpin: 100, pswpout: 1000, cpu: [100, 0, 100, 700, 100], blocked: 5, sda: 0, md: 0 }), b = fakeProc({ pswpin: 300, pswpout: 1000, cpu: [150, 0, 150, 800, 400], blocked: 7, sda: 250, md: 0 });
  let n = 0; const fsRead = f => (n < 6 ? a : b).fsRead(f);   // first counters() makes 3 reads (vmstat, stat, diskstats), the second the next 3
  const r = await hostActivity({ proc: '/p', fsRead: f => { const v = fsRead(f); if (['/p/vmstat', '/p/stat', '/p/diskstats'].includes(f)) n += 2; return v; }, readDir: a.readDir, sleep: async () => { n = 6; } });
  assert.ok(r.swap.pagesInPerSecond > 0, 'swap in moved'); assert.equal(r.swap.pagesOutPerSecond, 0);
  assert.equal(r.diskWait.processesBlocked, 7); assert.equal(r.diskWait.cpuIowaitPercent, 60);
  assert.deepEqual(Object.keys(r.diskWait.busyPercentByDisk).sort(), ['md1', 'md2p1', 'sda'], 'disk partitions and loop devices are left out; Unraid\'s partitioned array devices (mdNpM) are kept');
  assert.deepEqual(r.topProcessesByMemory.top.map(p => [p.name, p.rssMb, p.swapMb]), [['bigproc', 2048, 512], ['mid', 1024, 0], ['small', 1, null]], 'sorted by RSS, kernel threads (no VmRSS) skipped');
  assert.ok(![...a.reads, ...b.reads].some(f => /cmdline|environ/.test(f)), 'no command line or environment read');
  assert.ok(!JSON.stringify(r).includes(GH));
});

test('hostActivity and topProcesses survive an unreadable /proc (nulls, not a crash)', async () => {
  const fsRead = () => { throw new Error('EACCES'); };
  const r = await hostActivity({ proc: '/nowhere', fsRead, readDir: () => { throw new Error('EACCES'); }, sleep: async () => {} });
  assert.equal(r.swap.pagesInPerSecond, null); assert.equal(r.diskWait.cpuIowaitPercent, null); assert.deepEqual(r.diskWait.busyPercentByDisk, {}); assert.equal(r.topProcessesByMemory, null);
  assert.equal(topProcesses({ proc: '/nowhere', readDir: () => { throw new Error('x'); } }), null);
});

test('foreman_host keeps the old fields and adds activity; an activity failure leaves them in place', async () => {
  const ok = createTools({ source: {}, readHost: () => ({ load: { one: 1 } }), readActivity: async () => ({ swap: { pagesOutPerSecond: 3 } }) });
  const r = JSON.parse((await ok.call('foreman_host')).text); assert.equal(r.load.one, 1); assert.equal(r.activity.swap.pagesOutPerSecond, 3);
  const bad = createTools({ source: {}, readHost: () => ({ load: { one: 2 } }), readActivity: async () => { throw new Error('boom'); } });
  const r2 = await bad.call('foreman_host'); assert.equal(r2.isError, false); assert.equal(JSON.parse(r2.text).load.one, 2); assert.equal(JSON.parse(r2.text).activity, null);
});

// ---- tests: slot use, refused, killed, orphaned
test('recordTestEvent / readTestEvents: bounded, ordered, unknown kinds and damaged lines ignored, control characters stripped', t => {
  const root = tmp(t), now = Date.now();
  recordTestEvent(root, { kind: 'refused', label: 'review #9', reason: 'waited too long for a free test slot', at: now - 1000 });
  recordTestEvent(root, { kind: 'orphaned', label: 'x\u0007y', reason: 'survived\nSIGKILL', at: now - 500 });
  recordTestEvent(root, { kind: 'bogus', label: 'z', at: now }); recordTestEvent(root, { kind: 'timeout', label: 'old', at: now - 40 * 86400000 });
  fs.appendFileSync(path.join(root, 'team', 'test-events.jsonl'), 'not json\n{"at":"x"}\n');
  const rows = readTestEvents(root, { since: now - 86400000 });
  assert.deepEqual(rows.map(r => r.kind), ['orphaned', 'refused']); assert.equal(rows[0].label, 'xy'); assert.equal(rows[0].reason, 'survivedSIGKILL');
  assert.deepEqual(readTestEvents(tmp(t)), [], 'no file: empty');
});

test('the CLI records a refused run (class above the maximum) as an event', t => {
  const state = tmp(t);
  const r = spawnSync(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, '--no-reuse', '--class', 'build', '--label', 'review of #5', '--', 'echo', 'x'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 3, r.stderr);
  const ev = readTestEvents(state); assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'refused'); assert.equal(ev[0].label, 'review of #5'); assert.match(ev[0].reason, /owner approval/);
  const ok = spawnSync(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, '--no-reuse', '--', 'echo', 'x'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(ok.status, 0); assert.equal(readTestEvents(state).length, 1, 'a successful run records nothing');
});

test('testRunsView: running and queued runs with ages, free slots, counts by kind; secrets in a label or reason are redacted', async t => {
  const root = tmp(t), now = Date.now();
  const a = await acquireTestSlot(root, { limit: 2, label: `review ${PW}=${PWVAL}`, pollMs: 5 });
  const queued = acquireTestSlot(root, { limit: 1, label: 'second', pollMs: 5, timeoutMs: 300 });   // waits: limit 1 is full as seen by this caller
  await new Promise(r => setTimeout(r, 60));
  recordTestEvent(root, { kind: 'killed', label: 'a', reason: `memory ${GH}`, at: now }); recordTestEvent(root, { kind: 'refused', label: 'b', reason: 'headroom', at: now - 5 });
  const v = testRunsView(root, { limit: 2, now: Date.now() });
  assert.equal(v.slots.inUse, 1); assert.equal(v.slots.free, 1); assert.equal(v.running.length, 1); assert.ok(v.queued.length >= 1 && v.queued[0].position === 1);
  assert.deepEqual(v.counts, { refused: 1, timeout: 0, killed: 1, orphaned: 0 });
  const text = JSON.stringify(v); for (const bad of [GH, PWVAL]) assert.ok(!text.includes(bad), 'no secret-shaped output');
  assert.equal(await queued, null); a();
});
test('testRunsView: counts cover the whole window, only the events list is capped at 50', t => {
  const root = tmp(t), now = Date.now();
  for (let i = 0; i < 70; i++) recordTestEvent(root, { kind: 'refused', label: 'x', reason: 'headroom', at: now - 1000 - i });
  for (let i = 0; i < 3; i++) recordTestEvent(root, { kind: 'timeout', label: 'y', reason: 'long', at: now - 5000 - i });
  const v = testRunsView(root, { limit: 2, now });
  assert.equal(v.counts.refused, 70); assert.equal(v.counts.timeout, 3); assert.equal(v.events.length, 50);
});

// ---- ticks
const writeSnaps = (root, snaps) => { fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true }); fs.writeFileSync(path.join(root, 'dashboard', 'snapshots.jsonl'), snaps.map(s => JSON.stringify(s)).join('\n') + '\n'); };
test('ticksView: newest first, duration, trigger, actions, errors only for the cached last tick, skipped ticks; limit is bounded', t => {
  const root = tmp(t), now = Date.now(); fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  writeSnaps(root, [{ at: now - 600000, status: 'ok', plan: [], startedAt: now - 605000 }, { at: now - 300000, status: 'ok', plan: [{ agent: 'claude', type: 'review', ref: 7 }], trigger: 'job-end', startedAt: now - 312500, ghCalls: 4 }, { at: now - 1000, status: 'error', plan: [], noop: true, startedAt: now - 3000, check: { result: 'unchanged', reason: 'etag' } }]);
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 1000, status: 'error', error: `1 action(s) skipped: review: ${PW}=${PWVAL}` } }));
  recordSkip(root, `lock held ${GH}`, now - 2000);
  const v = ticksView(root, { limit: 2, now });
  assert.equal(v.shown, 2); assert.deepEqual(v.ticks.map(x => x.status), ['error', 'ok']);
  assert.equal(v.ticks[0].durationSeconds, 2); assert.equal(v.ticks[0].noop, true); assert.match(v.ticks[0].error, /skipped/); assert.equal(v.ticks[1].error, null);
  assert.equal(v.ticks[1].trigger, 'job-end'); assert.equal(v.ticks[1].durationSeconds, 12.5); assert.deepEqual(v.ticks[1].actions, [{ type: 'review', agent: 'claude', ref: 7 }]); assert.equal(v.ticks[1].ghCalls, 4);
  assert.equal(v.skippedTicks.last24Hours, 1);
  const text = JSON.stringify(v); for (const bad of [GH, PWVAL]) assert.ok(!text.includes(bad), 'no secret-shaped output');
  assert.equal(ticksView(root, { limit: 'junk', now }).shown, 3); assert.equal(ticksView(root, { limit: 1e9, now }).shown, 3);
  assert.deepEqual(ticksView(tmp(t), { now }).ticks, [], 'no snapshots: empty, no crash');
});

// ---- item timeline
const VIEW = { prs: [{ number: 50, title: 'Add x', status: 'open', issue: 12, checks: 'green', verdict: 'PASS', reviewRounds: 2, fixRounds: 1, rebaseRounds: 1 }], issues: [{ number: 12, title: 'x' }, { number: 99, title: 'unrelated' }],
  jobs: [{ fullId: 'a'.repeat(32), kind: 'implement', ref: 12, agent: 'claude', status: 'completed', startedAt: 1000, elapsedMs: 5000, tokens: 10, cost: 0.5, desc: `did ${GH}` }, { fullId: 'b'.repeat(32), kind: 'review', ref: 50, agent: 'codex', status: 'completed', startedAt: 3000, elapsedMs: 2000 }, { fullId: 'c'.repeat(32), kind: 'rebase', ref: 50, agent: 'claude', status: 'running', startedAt: 2000 }, { fullId: 'd'.repeat(32), kind: 'implement', ref: 99, startedAt: 500 }],
  activity: [{ at: 4000, kind: 'review', outcome: 'pass', agent: 'codex', text: 'codex: PASS on #50', link: { url: 'https://github.com/o/r/pull/50', text: '#50' } }, { at: 5000, kind: 'merge', outcome: 'merged', text: 'merged #50', link: { url: 'https://github.com/o/r/pull/50' } }, { at: 4500, kind: 'review', text: 'other', link: { url: 'https://github.com/o/r/pull/51' } }, { at: 6000, kind: 'tick', text: 'tick ok' }] };
test('itemTimeline: a pull request joins its own jobs, its issue\'s jobs and its reviews and merge, oldest first; others are left out', () => {
  const r = itemTimeline(VIEW, 'pr', 50);
  assert.equal(r.found, true); assert.equal(r.title, 'Add x'); assert.equal(r.total, 5);
  assert.deepEqual(r.entries.map(e => [e.type, e.what]), [['job', 'implement'], ['job', 'rebase'], ['job', 'review'], ['review', 'pass'], ['merge', 'merged']]);
  assert.deepEqual(r.entries.map(e => e.at), [1000, 2000, 3000, 4000, 5000].map(ms => new Date(ms).toISOString()));
  assert.equal(r.counts.implementJobs, 1); assert.equal(r.counts.reviews, 1);
  const i = itemTimeline(VIEW, 'issue', 12); assert.deepEqual(i.entries.map(e => e.what), ['implement', 'rebase', 'review', 'pass', 'merged'], 'an issue also shows the jobs, reviews and merge of the pull request that closes it');
  assert.equal(itemTimeline(VIEW, 'pr', 51).entries.length, 1); assert.equal(itemTimeline(VIEW, 'pr', 404).found, false); assert.equal(itemTimeline({}, 'issue', 1).total, 0);
  assert.equal(itemTimeline(VIEW, 'pr', 50, { limit: 2 }).entries.length, 2, 'limit keeps the newest');
});
test('itemTimeline: reviews and the merge come from the pull request\'s verdicts and mergedAt; counts name activity job rows apart; an issue joins its closing pull request', () => {
  const view = { prs: [{ number: 60, title: 'T', status: 'merged', issue: 20, mergedAt: 9000, verdicts: [{ at: 7000, reviewer: 'codex', verdict: 'CHANGES', head: 'abcdef123' }, { at: 8000, reviewer: 'codex', verdict: 'PASS', head: 'fedcba987' }], jobs: [{ fullId: 'e'.repeat(32), kind: 'fix', agent: 'claude', status: 'completed', startedAt: 7500 }] }], issues: [{ number: 20, title: 'i' }],
    jobs: [{ fullId: 'f'.repeat(32), kind: 'review', ref: 60, agent: 'codex', status: 'completed', startedAt: 6500 }, { fullId: 'g'.repeat(32), kind: 'implement', ref: 20, startedAt: 1000 }],
    activity: [{ at: 8000, kind: 'review', outcome: 'pass', text: 'dup', link: { url: 'https://github.com/o/r/pull/60' } }, { at: 8500, kind: 'job', outcome: 'completed', text: 'rebase row', link: { url: 'https://github.com/o/r/pull/60' } }] };
  const p = itemTimeline(view, 'pr', 60);
  assert.deepEqual(p.entries.map(e => [e.type, e.what]), [['job', 'implement'], ['job', 'review'], ['review', 'changes'], ['job', 'fix'], ['review', 'pass'], ['job', 'completed'], ['merge', 'merged']]);
  assert.deepEqual(p.entries.map(e => e.at), [1000, 6500, 7000, 7500, 8000, 8500, 9000].map(ms => new Date(ms).toISOString()));
  assert.equal(p.counts.reviews, 2, 'the activity duplicate of a verdict is not counted twice'); assert.equal(p.counts.merges, 1); assert.equal(p.counts.jobEvents, 1); assert.equal(p.counts.completedJobs, undefined); assert.equal(p.counts.fixJobs, 1);
  const i = itemTimeline(view, 'issue', 20);
  assert.equal(i.total, 7, 'implement job, review and fix jobs, two verdicts, the job row and the merge of the closing pull request'); assert.equal(i.counts.merges, 1); assert.equal(i.counts.reviewJobs, 1);
  assert.equal(itemTimeline(view, 'issue', 21).total, 0);
});
test('foreman_item_timeline: bad input is refused, output is redacted', async () => {
  const tools = createTools({ source: { get: async () => ({ view: VIEW, ageMs: 0 }) }, readHost: () => ({}) });
  for (const args of [{}, { kind: 'x', number: 1 }, { kind: 'pr', number: 0 }, { kind: 'pr', number: 'a' }]) assert.equal((await tools.call('foreman_item_timeline', args)).isError, true, JSON.stringify(args));
  const r = await tools.call('foreman_item_timeline', { kind: 'pr', number: 50 }); assert.equal(r.isError, false); assert.ok(!r.text.includes(GH)); assert.equal(JSON.parse(r.text).total, 5);
});

// ---- reports: finished marker
test('reports: only a last-line marker makes a report finished; a half-written one is flagged in the list and in the text', t => {
  const dir = tmp(t); const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
  w('done.md', `# Done\nbody\n${FINISHED_MARKER}\n`); w('half.md', '# Half\nstill writing'); w('mid.md', `# Mid\n${FINISHED_MARKER}\nmore text after`); w('crlf.md', `# C\r\n${FINISHED_MARKER}\r\n\r\n`);
  w('big.md', `# Big\n${'x'.repeat(300 * 1024)}\n${FINISHED_MARKER}\n`); w('empty.md', '');
  const rep = createReports(dir), list = rep.list(), by = Object.fromEntries(list.reports.map(r => [r.name, r.finished]));
  assert.deepEqual(by, { 'done.md': true, 'half.md': false, 'mid.md': false, 'crlf.md': true, 'big.md': true, 'empty.md': false }); assert.equal(list.unfinished, 3); assert.equal(list.finishedMarker, FINISHED_MARKER);
  assert.match(rep.read('done.md'), /STATUS: finished/); assert.match(rep.read('half.md'), /STATUS: UNFINISHED/); assert.match(rep.read('mid.md'), /STATUS: UNFINISHED/);
  assert.match(rep.read('big.md', 1000), /STATUS: finished/, 'a report over the read cap still shows its marker status');
  const a = `AKIA${'ABCDEFGHIJKLMNOP'}`; w('sec.md', `# S\n${PW}=${PWVAL} ${GH} ${a}\n${FINISHED_MARKER}\n`);
  const text = rep.read('sec.md'); for (const bad of [GH, PWVAL]) assert.ok(!text.includes(bad), 'redaction still applies');
  fs.symlinkSync(path.join(dir, 'done.md'), path.join(dir, 'link.md')); assert.ok(!createReports(dir).list().reports.some(r => r.name === 'link.md'), 'symlinks are still not listed');
});

// ---- end to end over HTTP
test('end to end: GET-only routes for tests and ticks, the tools return them, nothing writes to the state root, no secret-shaped output', async t => {
  const root = tmp(t), now = Date.now();
  recordTestEvent(root, { kind: 'refused', label: 'r', reason: `no slot ${GH}`, at: now - 100 }); writeSnaps(root, [{ at: now - 1000, status: 'ok', plan: [{ agent: 'claude', type: 'fix', ref: 3 }], startedAt: now - 2000 }]);
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config: () => BASE, host: '127.0.0.1', port, recorderDir: null }));
  const base = `http://127.0.0.1:${port}`;
  const post = await new Promise(res => { const q = http.request({ host: '127.0.0.1', port, path: '/api/tests.json', method: 'POST', headers: { host: `127.0.0.1:${port}` } }, r => { r.resume(); res(r.statusCode); }); q.end(); }); assert.notEqual(post, 200);
  const snap = () => { const o = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (o[p] = fs.readFileSync(p, 'utf8')); } }; walk(root); return o; };
  const before = snap();
  const tools = createTools({ source: { get: async () => ({ view: VIEW, ageMs: 0 }) }, readHost: () => ({}), readActivity: async () => null, getPath: p => getJson(new URL(p, `${base}/api/view.json`).href) });
  for (const n of ['foreman_tests', 'foreman_ticks', 'foreman_item_timeline', 'foreman_host']) { const a = tools.list().find(x => x.name === n); assert.equal(a.annotations.readOnlyHint, true); }
  const tr = await tools.call('foreman_tests'); assert.equal(tr.isError, false, tr.text); const tv = JSON.parse(tr.text); assert.equal(tv.slots.limit, 3, 'the configured slot limit'); assert.equal(tv.counts.refused, 1);
  const kr = await tools.call('foreman_ticks', { limit: 5 }); assert.equal(kr.isError, false, kr.text); assert.equal(JSON.parse(kr.text).ticks[0].actions[0].type, 'fix');
  for (const x of [tr.text, kr.text]) assert.ok(!x.includes(GH), 'no secret-shaped output');
  assert.deepEqual(snap(), before, 'state is untouched');
  const none = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}) });
  for (const n of ['foreman_tests', 'foreman_ticks']) assert.equal((await none.call(n)).isError, true, `${n} fails cleanly with no dashboard address`);
});
