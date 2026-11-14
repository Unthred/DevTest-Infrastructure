// Issue #1411: a pull request waiting on CI is watched and Foreman wakes when the run finishes.
// Real data: PR #1358 on 13 Nov 2026, whose test check was pending after a description round and whose approval and merge followed once it was green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startCiWatchers, runWatch, pendingHeads, takeReads, MAX_WATCHERS, POLL_MS, MAX_WATCH_MS } from '../supervisor/ciwatch.mjs';
import { requestWake, pendingRequest, wakeStatus, TRIGGERS, labelOf } from '../supervisor/wake.mjs';
import { passStats } from '../supervisor/idlecause.mjs';
import { recordTickWithSkips } from '../supervisor/tickrecord.mjs';
import { readLastSnapshot } from '../supervisor/dashdata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = t => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ciwatch-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sha = n => String(n).padStart(40, 'a');
const pull = (number, state, head = sha(number)) => ({ number, headRefOid: head, isDraft: false, statusCheckRollup: [{ name: 'test', status: state === 'pending' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: state === 'pending' ? null : 'SUCCESS' }] });

// A fake clock and a fake GitHub adapter whose answer for the head changes on a schedule. Each "tick" starts watchers through the real
// startCiWatchers, and the started watcher runs the real runWatch with the real wake request.
function world(t, answerAt) {
  const root = tmp(t), clock = { now: 1_000_000 }, spawned = [], reads = [], watchers = [];
  const wake = () => requestWake({ root, reason: 'ci', now: clock.now, spawnPass: r => spawned.push(r) });
  // The tick is the real recordTickWithSkips (view -> pendingHeads -> watcher record); only the process start is replaced.
  const startWatcher = h => {
    const pid = process.pid;   // a live process stands in for the detached watcher: the record names a running pid
    const readHead = async () => { reads.push(clock.now); return answerAt(h, clock.now); };
    watchers.push({ h, done: runWatch({ root, ...h, readHead, wake, now: () => clock.now, sleep: async ms => { clock.now += ms; await Promise.resolve(); } }) });
    return { pid };
  };
  const tick = pulls => {
    let out;
    const team = { c: { repository: 'o/r', agents: {} }, delivered: [], view: { prs: pulls, issues: [] } };
    recordTickWithSkips(root, { now: clock.now, status: 'ok', jobs: [], ghCalls: 1, team, startWatcher, onWatchers: o => { out = o; } });
    return out;
  };
  return { root, clock, spawned, reads, watchers, tick };
}

test('PR #1358: pending then green gives one wake with the ci reason, and the watcher ends', async t => {
  const g = world(t, (h, now) => ({ state: 'OPEN', headRefOid: h.sha, statusCheckRollup: pull(1358, now >= 1_000_000 + 3 * POLL_MS ? 'green' : 'pending').statusCheckRollup }));
  assert.deepEqual(g.tick([pull(1358, 'pending')]).started, [1358]);
  assert.equal(await g.watchers[0].done, 'finished');
  assert.deepEqual(g.spawned, ['ci']);
  assert.deepEqual(pendingRequest(g.root).reasons, ['ci']);
  assert.equal(g.clock.now - 1_000_000, 3 * POLL_MS, 'the wake came within one polling interval of the finish');
  assert.equal(g.reads.length, 4);
  assert.equal(takeReads(g.root), 4, 'the watcher reads are counted for the pass record');
  assert.equal(takeReads(g.root), 0, 'and counted once');
  assert.equal(fs.readdirSync(path.join(g.root, 'team', 'ci-watch')).length, 0, 'the record goes with the watcher');
});

test('two ticks while pending start one watcher; a green or draft head gets none', async t => {
  const g = world(t, () => ({ state: 'OPEN', statusCheckRollup: pull(1358, 'pending').statusCheckRollup }));
  const pulls = [pull(1358, 'pending'), pull(1359, 'green'), { ...pull(1360, 'pending'), isDraft: true }];
  assert.deepEqual(g.tick(pulls).started, [1358]);
  const second = g.tick(pulls);
  assert.deepEqual([second.started, second.already], [[], [1358]]);
  assert.equal(g.watchers.length, 1);
  g.clock.now += MAX_WATCH_MS;
  assert.equal(await g.watchers[0].done, 'timeout');
});

test('a seventh pending head is not watched and is left to the scheduled pass', async t => {
  const g = world(t, () => ({ state: 'OPEN', statusCheckRollup: pull(1, 'pending').statusCheckRollup }));
  const pulls = [1, 2, 3, 4, 5, 6, 7].map(n => pull(n, 'pending'));
  const out = g.tick(pulls);
  assert.equal(out.started.length, MAX_WATCHERS);
  assert.deepEqual(out.unwatched, [7]);
  assert.deepEqual(g.tick(pulls).unwatched, [7]);
  g.clock.now += MAX_WATCH_MS;
  await Promise.all(g.watchers.map(w => w.done));
});

test('a new head, a closed pull request and the 45 minute limit end the watcher without a wake', async t => {
  for (const [name, answer, why] of [
    ['head changes', h => ({ state: 'OPEN', headRefOid: sha(99), statusCheckRollup: pull(1, 'pending').statusCheckRollup }), 'changed'],
    ['pull request closes', h => ({ state: 'CLOSED', headRefOid: h.sha, statusCheckRollup: pull(1, 'pending').statusCheckRollup }), 'closed'],
    ['45 minutes pass', h => ({ state: 'OPEN', headRefOid: h.sha, statusCheckRollup: pull(1, 'pending').statusCheckRollup }), 'timeout'],
  ]) {
    const g = world(t, answer);
    g.tick([pull(1, 'pending')]);
    assert.equal(await g.watchers[0].done, why, name);
    assert.deepEqual(g.spawned, [], `${name}: no wake`);
    assert.equal(pendingRequest(g.root), null);
  }
});

test('a failing GitHub read is retried at the next interval and never throws out of the watcher', async t => {
  let calls = 0;
  const g = world(t, (h) => { calls++; if (calls <= 2) throw new Error('HTTP 502'); return { state: 'OPEN', headRefOid: h.sha, statusCheckRollup: pull(1, 'green').statusCheckRollup }; });
  g.tick([pull(1, 'pending')]);
  assert.equal(await g.watchers[0].done, 'finished');
  assert.equal(calls, 3);
  assert.equal(g.clock.now - 1_000_000, 2 * POLL_MS);
  assert.deepEqual(g.spawned, ['ci']);
});

test('a head that cannot be started is reported as unwatched, not thrown', t => {
  const root = tmp(t);
  const out = startCiWatchers({ root, pulls: [pull(1, 'pending')], start: () => { throw new Error('spawn failed'); } });
  assert.deepEqual([out.started, out.unwatched], [[], [1]]);
});

test('a dead watcher record does not block a new watcher', t => {
  const root = tmp(t), dir = path.join(root, 'team', 'ci-watch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `1-${sha(1)}.json`), JSON.stringify({ pid: 2 ** 22 + 5, start: 'gone' }));
  assert.deepEqual(startCiWatchers({ root, pulls: [pull(1, 'pending')], start: () => ({ pid: process.pid }) }).started, [1]);
});

test('the wake module accepts ci and diagnostics count its passes separately', t => {
  const root = tmp(t);
  assert.ok(TRIGGERS.includes('ci'));
  assert.equal(requestWake({ root, reason: 'ci', now: 5000, spawnPass: () => {} }).requested, true);
  assert.equal(wakeStatus(root, 6000).acceptedLastHour, 1);
  assert.equal(wakeStatus(root, 6000).droppedByReason.ci, 0);
  assert.equal(labelOf(['ci', 'job-end']), 'ci');
  const stats = passStats([{ at: 10, trigger: 'ci', plan: [{}] }, { at: 11, trigger: 'schedule', plan: [] }], 0, 100);
  assert.equal(stats.byTrigger.ci.startedSomething, 1);
  assert.equal(stats.byTrigger.schedule.didNothing, 1);
  assert.equal(stats.unlabelled, 0);
  assert.throws(() => requestWake({ root, reason: 'bogus', spawnPass: () => {} }), /unknown wake reason/);
});

test('pendingHeads picks only pending non-draft heads with a sha', () => {
  assert.deepEqual(pendingHeads([pull(1, 'pending'), pull(2, 'green'), { ...pull(3, 'pending'), headRefOid: null }, { ...pull(4, 'pending'), isDraft: true }]), [{ pr: 1, sha: sha(1) }]);
});

// The real entry point: `ciwatch-main.mjs PR SHA` in its own process, with a fake gh on PATH, asks for the ci wake through the real request.
test('the watcher entry point, run as a process, reads GitHub through gh and requests the ci wake', t => {
  const root = tmp(t), bin = path.join(root, 'bin'), counter = path.join(root, 'n');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(root, 'cfg'));
  const run = id => JSON.stringify({ state: 'OPEN', headRefOid: sha(1358), statusCheckRollup: [{ name: 'test', status: id ? 'COMPLETED' : 'IN_PROGRESS', conclusion: id ? 'SUCCESS' : null }] });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 1\nn=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}\nif [ "$n" -ge 1 ]; then echo '${run(1)}'; else echo '${run(0)}'; fi\n`, { mode: 0o755 });
  // The wake starts a detached pass on the installed code; a stub stands in for it so the test leaves no process behind.
  fs.mkdirSync(path.join(root, 'current', 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(root, 'current', 'supervisor', 'cli.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, 'pass-args'))}, process.argv.slice(2).join(' '));\n`);
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true }));
  const r = spawnSync(process.execPath, [path.join(here, '..', 'supervisor', 'ciwatch-main.mjs'), '1358', sha(1358), '--state-root', root],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_SUPERVISOR_CI_WATCH_POLL_MS: '50', AI_SUPERVISOR_STATE_ROOT: root, AI_SUPERVISOR_WAKE_MAX_PER_HOUR: '5' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8').trim(), '2', 'one read pending, one read green');
  assert.deepEqual(pendingRequest(root)?.reasons, ['ci'], r.stderr);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(root, 'pass-args')) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  assert.match(fs.readFileSync(path.join(root, 'pass-args'), 'utf8'), /^reconcile --wake ci /, 'the woken pass is started with the ci reason');
});

// The tick's own record step (the function the real tick calls) starts a real detached watcher for a pending head and counts its reads.
test('the tick record starts a watcher for a pending head only for a live tick, and adds the watcher reads to the pass call count', async t => {
  const root = tmp(t), bin = path.join(root, 'bin'), marker = path.join(root, 'read');
  fs.mkdirSync(bin);
  // The fake gh reports the pull request closed, so the started watcher reads once and ends without a wake.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 1\ntouch ${marker}\necho '{"state":"CLOSED"}'\n`, { mode: 0o755 });
  const savedPath = process.env.PATH; process.env.PATH = `${bin}:${savedPath}`; t.after(() => { process.env.PATH = savedPath; });
  const team = { c: { repository: 'o/r', agents: {} }, delivered: [], view: { prs: [{ ...pull(1358, 'pending'), title: 't', headRefName: 'b', baseRefName: 'main' }], issues: [] } };
  const base = { now: 5000, status: 'ok', jobs: [], team };
  recordTickWithSkips(root, base);   // a record without a call count is not a live tick: nothing started
  await new Promise(r => setTimeout(r, 400));
  assert.equal(fs.existsSync(marker), false, 'a record without a call count starts no watcher');
  recordTickWithSkips(root, { ...base, ghCalls: 5 });
  const end = Date.now() + 30000;
  while (!fs.existsSync(path.join(root, 'team', 'ci-watch-reads.log')) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(marker), 'the watcher process read the head through gh');
  recordTickWithSkips(root, { ...base, now: 6000, ghCalls: 5, team: { ...team, view: { prs: [], issues: [] } } });   // no pending head left: no second watcher
  assert.equal(readLastSnapshot(root).ghCalls, 6, "the watcher's read is added to the pass call count");
});

// The real tick path from the view: the dashboard copy of a pull request drops the check times, so heads must come from the full view.
test('the tick judges pending on the full view: heads done by the #331 rule or a newer rerun get no watcher, a pending head gets one', async t => {
  const root = tmp(t), bin = path.join(root, 'bin'), marker = path.join(root, 'read');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 1\necho "$3" >> ${marker}\necho '{"state":"CLOSED"}'\n`, { mode: 0o755 });
  const savedPath = process.env.PATH; process.env.PATH = `${bin}:${savedPath}`; t.after(() => { process.env.PATH = savedPath; });
  const done = { ...pull(1358, 'green'), statusCheckRollup: [{ name: 'test', workflowName: 'ci', status: 'IN_PROGRESS', conclusion: 'SUCCESS', startedAt: '2026-11-13T10:00:00Z', completedAt: '2026-11-13T10:05:00Z' }] };
  const rerun = { ...pull(1359, 'green'), statusCheckRollup: [
    { name: 'test', workflowName: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-13T10:10:00Z', completedAt: '2026-11-13T10:12:00Z' },
    { name: 'test', workflowName: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-13T10:00:00Z', completedAt: '2026-11-13T10:02:00Z' }] };
  const tick = prs => ({ now: 5000, status: 'ok', jobs: [], ghCalls: 1, team: { c: { repository: 'o/r', agents: {} }, delivered: [], view: { prs, issues: [] } } });
  recordTickWithSkips(root, tick([done, rerun]));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.existsSync(marker), false, 'no watcher was started for a head the planner judges green');
  recordTickWithSkips(root, tick([done, rerun, pull(1360, 'pending')]));
  const end = Date.now() + 30000;
  while (!fs.existsSync(marker) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['1360'], 'only the pending head was watched');
});
