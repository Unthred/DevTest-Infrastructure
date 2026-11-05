// Live processes per agent and job (issue #568). Every case builds a fake /proc on disk and reads it through the same code the
// server uses, so attribution, leftovers, exits during a read, stale readings and the page itself are exercised for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { attribute, createSampler, readProcess, readTable, readingStatus, STALE_AFTER_MS, SAMPLE_TTL_MS } from '../supervisor/procsample.mjs';
import { processesFragment, matchRoute } from '../supervisor/dashrender.mjs';
import { handler, STATIC } from '../supervisor/dashserver.mjs';

// Secret-shaped fixture assembled at run time, never a literal (issue #142).
const FLAG = ['to', 'ken'].join(''), SECRET = ['zq', '9x', 'Lm4', 'Rt7'].join('');
const BOOT = 1000000, BOOT_MS = BOOT * 1000, at = ticks => BOOT_MS + ticks * 10;   // wall-clock ms of a process started at `ticks`
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'procs-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// A fake /proc entry. `start` is the clock tick the process began at; rss is in 4 KiB pages.
function proc(root, { pid, ppid = 1, pgrp = pid, sid = pgrp, start = 100, name = 'node', rssPages = 256, swapKb = 0, state = 'S', cmdline = null, environ = null }) {
  const dir = path.join(root, String(pid)); fs.mkdirSync(dir, { recursive: true });
  const f = new Array(22).fill('0'); f[0] = state; f[1] = ppid; f[2] = pgrp; f[3] = sid; f[19] = String(start); f[21] = String(rssPages);
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${name}) ${f.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'status'), `Name:\t${name}\nVmSwap:\t${String(swapKb).padStart(8)} kB\n`);
  if (cmdline) fs.writeFileSync(path.join(dir, 'cmdline'), cmdline);
  if (environ) fs.writeFileSync(path.join(dir, 'environ'), environ);
}
const fakeProc = t => { const r = tmp(t); fs.writeFileSync(path.join(r, 'stat'), `cpu 1 2 3\nbtime ${BOOT}\n`); fs.writeFileSync(path.join(r, 'meminfo'), 'MemTotal: 1000000 kB\nMemAvailable: 400000 kB\nSwapTotal: 800000 kB\nSwapFree: 300000 kB\n'); return r; };
const job = (over = {}) => ({ id: 'a'.repeat(32), provider: 'claude', kind: 'implement', issue: 7, status: 'running', createdAt: at(50), updatedAt: at(5000),
  workerPid: 100, workerStart: '100', childPid: 200, childStart: '110', childGroup: 200, childEndedAt: null, ...over });
const NOW = at(6000);

test('attribution follows the whole tree: worker, provider child, test runner, a browser that left the group, and its helpers', t => {
  const r = fakeProc(t);
  proc(r, { pid: 100, ppid: 1, start: 100, name: 'node', rssPages: 1000 });                       // worker
  proc(r, { pid: 200, ppid: 100, pgrp: 200, start: 110, name: 'claude', rssPages: 2000 });         // provider child (group leader)
  proc(r, { pid: 210, ppid: 200, pgrp: 200, start: 120, name: 'node', rssPages: 500, swapKb: 4096 }); // test runner
  proc(r, { pid: 211, ppid: 210, pgrp: 211, sid: 211, start: 130, name: 'chrome', rssPages: 3000, swapKb: 1000 }); // own group and session
  proc(r, { pid: 212, ppid: 211, pgrp: 211, sid: 211, start: 131, name: 'chrome', rssPages: 100 });
  proc(r, { pid: 300, ppid: 1, start: 90, name: 'sshd', rssPages: 50 });                           // belongs to nobody
  const table = readTable(r), out = attribute(table, [job()], NOW);
  const c = out.agents.find(a => a.agent === 'claude');
  assert.equal(c.processes, 5); assert.equal(out.unattributed.processes, 1); assert.deepEqual(out.unattributed.top, [{ name: 'sshd', count: 1 }]);
  assert.equal(c.rssKb, (1000 + 2000 + 500 + 3000 + 100) * 4); assert.equal(c.swapKb, 5096);
  assert.equal(out.total.processes, 6); assert.equal(out.jobs.length, 1);
  assert.deepEqual([out.jobs[0].kind, out.jobs[0].issue, out.jobs[0].processes, out.jobs[0].leftover], ['implement', 7, 5, false]);
  assert.equal(out.jobs[0].ageMs, NOW - at(50));
  assert.equal(table.host.swapUsedKb, 500000);
});

test('an ended job with a child still running is flagged as a leftover; a later process that reused the group id is not', t => {
  const r = fakeProc(t);
  const ended = job({ status: 'completed', workerPid: null, workerStart: null, childPid: null, childStart: null, childGroup: 300, createdAt: at(50), childEndedAt: at(2000), updatedAt: at(2000) });
  proc(r, { pid: 301, ppid: 1, pgrp: 300, sid: 300, start: 150, name: 'chrome', rssPages: 800 });  // started during the job, survived it
  proc(r, { pid: 302, ppid: 301, pgrp: 300, sid: 300, start: 160, name: 'node', rssPages: 100 });
  proc(r, { pid: 303, ppid: 1, pgrp: 300, sid: 300, start: 4000, name: 'unrelated' });          // same group id, started long after the job ended
  const out = attribute(readTable(r), [ended], NOW);
  assert.equal(out.jobs.length, 1); assert.equal(out.jobs[0].leftover, true); assert.equal(out.jobs[0].processes, 2);
  assert.equal(out.agents[0].leftoverProcesses, 2); assert.equal(out.agents[0].leftoverJobs, 1);
  assert.equal(out.unattributed.processes, 1, 'the late process is unattributed, not blamed on the ended job');
  // Negative control: the same table with the job still alive reports it as running, not as a leftover.
  proc(r, { pid: 100, ppid: 1, start: 100 });
  const alive = attribute(readTable(r), [{ ...ended, status: 'running', workerPid: 100, workerStart: '100', childEndedAt: null }], NOW);
  assert.equal(alive.jobs[0].leftover, false);
});

test('a process reparented to init in its own session is still counted while the job runs and flagged as a leftover after it ends', t => {
  const r = fakeProc(t), id = 'a'.repeat(32);
  // What Claude Code's Bash tool does: a command in its own session leaves a runner behind, reparented to init. Only the inherited marker ties it to the job.
  const env = ['PATH=/usr/bin', `${FLAG.toUpperCase()}=${SECRET}`, `DEVTEST_JOB_ID=${id}`, 'HOME=/root'].join('\0') + '\0';
  proc(r, { pid: 100, ppid: 1, start: 100 }); proc(r, { pid: 200, ppid: 100, pgrp: 200, start: 110, name: 'claude' });
  proc(r, { pid: 900, ppid: 1, pgrp: 900, sid: 900, start: 140, name: 'vitest', rssPages: 700, environ: env });
  proc(r, { pid: 901, ppid: 900, pgrp: 900, sid: 900, start: 141, name: 'chrome', rssPages: 300, environ: env });
  proc(r, { pid: 950, ppid: 1, start: 150, name: 'other', environ: 'PATH=/usr/bin\0DEVTEST_JOB_ID=' + 'b'.repeat(32) + '\0' });   // another (unknown) job's marker: nobody's
  const live = attribute(readTable(r), [job()], NOW);
  assert.equal(live.jobs[0].processes, 4); assert.equal(live.jobs[0].leftover, false); assert.equal(live.unattributed.processes, 1);
  const ended = attribute(readTable(r), [job({ status: 'completed', workerPid: null, workerStart: null, childPid: null, childStart: null, childEndedAt: at(2000) })], NOW);
  assert.equal(ended.jobs[0].leftover, true); assert.equal(ended.jobs[0].processes, 3); assert.equal(ended.agents[0].leftoverProcesses, 3);
  assert.equal(ended.unattributed.processes, 2);
  const text = JSON.stringify([readTable(r), ended]);
  assert.ok(!text.includes(SECRET) && !text.includes('/root'), 'only the marker is taken from environ');
  assert.equal(readProcess(r, 900).marker, id); assert.equal(readProcess(r, 100).marker, null);
  fs.writeFileSync(path.join(r, '100', 'environ'), 'XDEVTEST_JOB_ID=' + id + '\0'); assert.equal(readProcess(r, 100).marker, null, 'must be a whole variable name');
});

test('names with markup are escaped once in the drill-down', t => {
  const r = fakeProc(t); proc(r, { pid: 100, ppid: 1, start: 100 }); proc(r, { pid: 200, ppid: 100, pgrp: 200, start: 110, name: 'a<b>&c' });
  const html = processesFragment({ generatedAt: NOW, refs: { issue: {}, pr: {}, job: {} } }, createSampler({ readJobs: () => [job()], procRoot: r, now: () => NOW }).get(), 'claude');
  assert.ok(html.includes('a&lt;b&gt;&amp;c') && !html.includes('&amp;lt;'));
});

test('a process with no job is unattributed; a reused worker pid, a job without records and an unreadable record attribute nothing', t => {
  const r = fakeProc(t);
  proc(r, { pid: 100, start: 999 });   // pid 100 exists but with another start time than the job recorded
  proc(r, { pid: 500, ppid: 1, name: 'ffmpeg' });
  const out = attribute(readTable(r), [job({ childPid: null, childGroup: null }), { unreadable: true, status: 'unreadable' }, job({ id: 'b'.repeat(32), provider: undefined })], NOW);
  assert.equal(out.agents.length, 0); assert.equal(out.jobs.length, 0); assert.equal(out.unattributed.processes, 2);
});

test('a process claimed by two jobs is unattributed rather than guessed', t => {
  const r = fakeProc(t);
  proc(r, { pid: 100, start: 100 }); proc(r, { pid: 200, ppid: 100, pgrp: 200, start: 110 });
  proc(r, { pid: 400, ppid: 1, pgrp: 400, start: 100 }); proc(r, { pid: 401, ppid: 400, pgrp: 200, start: 120, name: 'shared' });   // in job A's group, child of job B's worker
  const a = job(), b = job({ id: 'b'.repeat(32), provider: 'codex', workerPid: 400, workerStart: '100', childPid: null, childStart: null, childGroup: null });
  const out = attribute(readTable(r), [a, b], NOW);
  assert.equal(out.ambiguous, 1);
  assert.equal(out.agents.find(x => x.agent === 'claude').processes, 2); assert.equal(out.agents.find(x => x.agent === 'codex').processes, 1);
  assert.equal(out.unattributed.processes, 1);
});

test('a process that exits during the read is counted as vanished, not as an error; a lost status file keeps the process', t => {
  const r = fakeProc(t);
  proc(r, { pid: 100 });
  fs.mkdirSync(path.join(r, '777'));                                       // listed, then gone before stat could be read
  proc(r, { pid: 101 }); fs.rmSync(path.join(r, '101', 'status'));         // status vanished: still counted, swap unknown
  fs.mkdirSync(path.join(r, '778')); fs.writeFileSync(path.join(r, '778', 'stat'), 'garbage');   // half-written
  const table = readTable(r);
  assert.equal(table.procs.length, 2); assert.equal(table.vanished, 2); assert.equal(readProcess(r, 101).swapKb, 0);
  assert.equal(readProcess(r, 4242), null);
  assert.throws(() => readTable(path.join(r, 'missing')));
  const out = attribute(table, [], NOW); assert.equal(out.vanished, 2);
});

test('a comm with spaces and parentheses parses; command lines are never read', t => {
  const r = fakeProc(t);
  proc(r, { pid: 100, name: 'a b) (c' , cmdline: `node\0--${FLAG}=${SECRET}\0` });
  const p = readProcess(r, 100); assert.equal(p.name, 'a b) (c'.slice(0, 32)); assert.equal(p.ppid, 1);
  assert.doesNotMatch(JSON.stringify(attribute(readTable(r), [], NOW)), new RegExp(SECRET));
});

test('stale and failed readings are marked, with the age of the figures, and fresh ones are not', t => {
  const r = fakeProc(t); proc(r, { pid: 100, start: 100 }); proc(r, { pid: 200, ppid: 100, pgrp: 200, start: 110 });
  let clock = NOW, broken = false, reads = 0;
  const s = createSampler({ procRoot: r, now: () => clock, readJobs: () => [job()], read: root => { reads += 1; if (broken) throw new Error('proc unreadable'); return readTable(root); } });
  const view = () => ({ generatedAt: clock, refs: { issue: {}, pr: {}, job: {} } });
  const first = s.get();
  assert.equal(readingStatus(first, clock), 'fresh'); assert.doesNotMatch(processesFragment(view(), first), /Stale reading|Reading failed/);
  // Several tabs inside the TTL share one reading.
  clock += SAMPLE_TTL_MS - 1; s.get(); s.get(); assert.equal(reads, 1, 'cached across tabs');
  // The reading is not refreshed (nobody asked) and ages past the limit: stale.
  assert.equal(readingStatus(first, NOW + STALE_AFTER_MS + 1), 'stale');
  const stale = processesFragment({ ...view(), generatedAt: NOW + STALE_AFTER_MS + 1 }, first);
  assert.match(stale, /Stale reading/); assert.match(stale, /not current/);
  // A failed read keeps the last good figures, labelled with their age, and says it failed.
  broken = true; clock = NOW + 2 * SAMPLE_TTL_MS;
  const failed = s.get(); assert.equal(failed.ok, false); assert.equal(readingStatus(failed, clock), 'failed'); assert.ok(failed.reading, 'last good reading kept');
  const html = processesFragment(view(), failed);
  assert.match(html, /Reading failed/); assert.match(html, /proc unreadable/); assert.match(html, /from 0m ago; they are not current/);
  // Recovery returns to fresh.
  broken = false; clock += SAMPLE_TTL_MS; assert.equal(readingStatus(s.get(), clock), 'fresh');
  // No reading ever: says so instead of showing zeros.
  const none = createSampler({ now: () => clock, readJobs: () => [], read: () => { throw new Error('boom'); } }).get();
  assert.equal(readingStatus(none, clock), 'failed'); assert.match(processesFragment(view(), none), /No reading yet: boom/);
  assert.equal(readingStatus(null, clock), 'none');
});

test('history keeps a bounded series per agent and the unattributed row', t => {
  const r = fakeProc(t); proc(r, { pid: 100, start: 100 }); proc(r, { pid: 9, ppid: 1 });
  let clock = NOW; const s = createSampler({ procRoot: r, now: () => clock, readJobs: () => [job()] });
  for (let i = 0; i < 130; i++) { s.get(); clock += SAMPLE_TTL_MS; }
  const h = s.get().history; assert.equal(h.claude.length, 120); assert.ok(h['(unattributed)'].length > 0);
});

// ---- the page and the live fragment through the real server
async function serve(t, { jobs = [], sampler } = {}) {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'jobs'));
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', j.id + '.json'), JSON.stringify(j));
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [7] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } };
  const server = http.createServer(); await new Promise(res => server.listen(0, '127.0.0.1', res)); const port = server.address().port;
  server.on('request', handler({ root, config: cfg, host: '127.0.0.1', port, now: () => NOW, sampler })); t.after(() => server.close());
  return path_ => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: path_, headers: { host: '127.0.0.1:' + port } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject));
}
test('the processes page shows the card, the drill-down and the live fragment; a script poll stays read-only', async t => {
  const r = fakeProc(t);
  proc(r, { pid: 100, start: 100, rssPages: 25600 }); proc(r, { pid: 200, ppid: 100, pgrp: 200, start: 110, name: 'claude', cmdline: `claude\0--${FLAG}=${SECRET}\0` });
  proc(r, { pid: 301, ppid: 1, pgrp: 300, sid: 300, start: 150, name: 'chrome' }); proc(r, { pid: 800, ppid: 1, name: 'sshd' });
  const ended = job({ id: 'c'.repeat(32), status: 'completed', kind: 'review', issue: 9, pr: 12, workerPid: null, workerStart: null, childPid: null, childStart: null, childGroup: 300, childEndedAt: at(2000), updatedAt: at(2000) });
  const get = await serve(t, { jobs: [job(), ended], sampler: createSampler({ procRoot: r, now: () => NOW, readJobs: () => [job(), ended] }) });
  const page = await get('/system/processes');
  assert.equal(page.status, 200);
  assert.match(page.body, /Processes by agent/); assert.match(page.body, /href="\/system\/processes\/claude"/); assert.match(page.body, /Unattributed/); assert.match(page.body, /Tower total/); assert.match(page.body, /1 leftover/);
  assert.match(page.body, /src="\/static\/processes\.js"/); assert.match(page.body, /data-poll="15000"/);
  assert.doesNotMatch(page.body, new RegExp(`${SECRET}|--${FLAG}`));
  const drill = await get('/system/processes/claude');
  assert.equal(drill.status, 200); assert.match(drill.body, /implement/); assert.match(drill.body, /Running/); assert.match(drill.body, /Age/);
  const other = await get('/system/processes/codex'); assert.equal(other.status, 200); assert.match(other.body, /No processes attributed to codex/);
  const ended_ = await (await get('/system/processes/claude')).body; assert.ok(ended_.length > 0);
  assert.equal((await get('/system/processes/nobody')).status, 404);
  const frag = await get('/api/processes'); assert.equal(frag.status, 200); assert.doesNotMatch(frag.body, /<html/); assert.match(frag.body, /Tower total/);
  assert.match((await get('/api/processes?agent=claude')).body, /Largest by name/);
  assert.match((await get('/system')).body, /href="\/system\/processes"/);
  assert.equal(typeof STATIC['/static/processes.js'][0], 'string'); assert.equal((await get('/static/processes.js')).status, 200);
});
test('routes: only well-formed agent names match', () => {
  assert.deepEqual(matchRoute('/system/processes/claude'), { page: 'processes', agent: 'claude' });
  assert.equal(matchRoute('/system/processes/a/b'), null); assert.equal(matchRoute('/system/processes/%2e%2e'), null);
});
test('process.mjs keeps the job group after the child exits (what leftover detection relies on)', () => {
  const src = fs.readFileSync(new URL('../supervisor/process.mjs', import.meta.url), 'utf8');
  assert.match(src, /job\.childGroup = child\.pid/); assert.match(src, /job\.childEndedAt = clock\.now\(\)/);
});

test('history: an idle agent plots zero (no gap) and the Tower total has its own series', t => {
  const r = fakeProc(t); proc(r, { pid: 100, start: 100 }); proc(r, { pid: 9, ppid: 1 });
  let clock = NOW, jobs = [job()]; const s = createSampler({ procRoot: r, now: () => clock, readJobs: () => jobs });
  s.get(); fs.rmSync(path.join(r, '100'), { recursive: true }); clock += SAMPLE_TTL_MS; s.get();
  const h = s.get().history; assert.equal(h.claude.length, 2); assert.equal(h.claude[1].processes, 0);
  assert.equal(h.tower.length, 2);
});

test('server-rendered stale and failed readings are dimmed by the stylesheet, and the client checks age and times out', () => {
  const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.proc-body\[data-state=stale\]/); assert.match(css, /\.proc-body\[data-state=failed\]/);
  const js = fs.readFileSync(new URL('../supervisor/dashui/processes.js', import.meta.url), 'utf8');
  assert.match(js, /AbortController/); assert.match(js, /signal: ctl\.signal/); assert.match(js, /STALE_AFTER/); assert.match(js, /lastOk/);
});

test('issue #639: createJobReader matches readJobs, re-reads only changed records and forgets removed ones', async () => {
  const { createJobReader } = await import('../supervisor/procsample.mjs');
  const { readJobs } = await import('../supervisor/dashdata.mjs');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-639-')), dir = path.join(root, 'jobs');
  try {
    const read = createJobReader(root);
    assert.deepEqual(read(), [], 'no jobs directory yields an empty list');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', status: 'running' }));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'arr.json'), '[1]');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'ignored');
    const norm = l => JSON.stringify(l.map(j => (j.unreadable ? { ...j, at: 0 } : j)).sort((x, y) => String(x.file || x.id).localeCompare(String(y.file || y.id))));
    assert.equal(norm(read()), norm(readJobs(root)));
    assert.equal(read().filter(j => j.unreadable).length, 2, 'unparseable records are kept as unreadable');
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', status: 'completed', pad: 'xx' }));
    assert.equal(read().find(j => j.id === 'a').status, 'completed', 'a changed record is re-read');
    fs.rmSync(path.join(dir, 'a.json'));
    assert.equal(read().find(j => j.id === 'a'), undefined, 'a removed record is forgotten');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
