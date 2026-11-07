// Issue #331: an inconsistent check run is not "pending forever", a stuck one is named and clears, and the version header never
// claims "Up to date" from a stale main while the upgrade is rate-limited.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checksState, unfinishedChecks, waitingOnText, stuckChecks, STUCK_CHECK_MS } from '../supervisor/team.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { readVersion } from '../supervisor/dashdata.mjs';
import { versionStatus } from '../supervisor/dashui/logic.mjs';
import { SelfUpgrade, MIN_UPGRADE_INTERVAL_MS } from '../supervisor/upgrade.mjs';

const NOW = Date.parse('2026-11-02T15:30:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const iso = ms => new Date(ms).toISOString();
const run = (over = {}) => ({ name: 'ci-lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: iso(NOW - 30 * 60000), completedAt: iso(NOW - 25 * 60000), ...over });

test('a check with a conclusion and a completed time is done whatever its status says', () => {
  assert.equal(checksState([run({ status: 'IN_PROGRESS' })]), 'green');
  assert.equal(checksState([run({ status: 'IN_PROGRESS', conclusion: 'FAILURE' })]), 'red');
  assert.equal(checksState([run({ status: 'IN_PROGRESS' }), run({ name: 'unit', status: 'IN_PROGRESS', conclusion: '', completedAt: null })]), 'pending', 'a genuinely running check still waits');
});

test('a conclusion without a completed time stays pending, and is stuck only after the limit', () => {
  const c = run({ status: 'IN_PROGRESS', completedAt: null });
  assert.equal(checksState([c]), 'pending');
  const seen = new Map();
  assert.deepEqual(stuckChecks([c], NOW, seen), [], 'first sighting starts the clock, even though startedAt is long ago');
  assert.deepEqual(stuckChecks([c], NOW + STUCK_CHECK_MS - 60000, seen), []);
  assert.equal(stuckChecks([c], NOW + STUCK_CHECK_MS + 60000, seen).length, 1);
  assert.equal(stuckChecks([c], NOW + STUCK_CHECK_MS + 60000, seen)[0].ageMs, STUCK_CHECK_MS + 60000, 'age is measured from first seen');
  assert.deepEqual(stuckChecks([run({ status: 'IN_PROGRESS', conclusion: '', completedAt: null })], NOW + STUCK_CHECK_MS * 3, seen), [], 'a plainly running check is not inconsistent');
  assert.equal(seen.size, 0, 'a check that is no longer inconsistent is forgotten');
});

test('waiting text names the unfinished check and how long', () => {
  const t = waitingOnText([run(), run({ name: 'unit-tests', status: 'IN_PROGRESS', conclusion: '', completedAt: null, startedAt: iso(NOW - 12 * 60000) })], NOW);
  assert.equal(t, 'waiting on CI: unit-tests unfinished for 12 min');
  assert.equal(unfinishedChecks([run()], NOW).length, 0);
  assert.match(waitingOnText([run({ name: 'bad\nname', status: 'QUEUED', conclusion: '', completedAt: null, startedAt: iso(NOW - 12 * 60000) })], NOW), /a check unfinished for 12 min/);
});

const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } };
const viewWith = async (roll, t, now = NOW, headOid = H(9)) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pull = { number: 329, title: 't', headRefName: 'claude/issue-30-x', headRefOid: headOid, isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: roll };
  return buildView({ config, root, jobs: [], events: [], state: {}, cache: { tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, pulls: [pull], issues: [] }, snapshots: [], now });
};

test('a stuck check raises one Inbox item that says to re-run it, and it clears when the check finishes', async t => {
  const stuck = [run({ status: 'IN_PROGRESS', completedAt: null })], ids = v => v.attention.filter(a => a.id.startsWith('ci-stuck-'));
  const head = H(7);
  assert.equal(ids(await viewWith(stuck, t, NOW, head)).length, 0, 'first sighting starts the clock; startedAt is not used');
  const later = NOW + 12 * 60000, items = ids(await viewWith(stuck, t, later, head));
  assert.equal(items.length, 1);
  assert.match(items[0].text, /"ci-lint".*inconsistent for 12 min; re-run that job/);
  assert.equal(ids(await viewWith(stuck, t, later + 60000, head)).length, 1, 'still one on the next look');
  assert.equal(ids(await viewWith([run()], t, later + 120000, head)).length, 0, 'cleared once it finishes');
  assert.equal(ids(await viewWith([run({ status: 'IN_PROGRESS' })], t, later + 180000, head)).length, 0, 'conclusion plus completed time is just done');
});

function upgrader(t, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deps = { config: { agents: {} }, installed: () => state.installed, fetchMain: () => state.main, commitsBehind: () => state.behind, isAncestor: () => true, changedFiles: () => [] };
  return { dir, up: new SelfUpgrade({ root: dir, deps, clock: { now: () => state.now } }) };
}

test('while rate-limited, main is still refreshed each tick and the header shows N commits behind with the next try', async t => {
  const state = { now: Date.now() - 20000, installed: H(1), main: H(1), behind: 0 };
  const { dir, up } = upgrader(t, state);
  up.s.lastUpgradeAt = state.now - 10000; up.save();
  assert.equal(await up.step(), 'rate-limited');
  state.main = H(2); state.behind = 2; state.now += 30000;
  assert.equal(await up.step(), 'rate-limited');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'team', 'self-upgrade.json'), 'utf8'));
  assert.deepEqual([saved.main.sha, saved.main.behind], [H(2), 2]);
  fs.mkdirSync(path.join(dir, 'versions', H(1)), { recursive: true }); fs.symlinkSync(`versions/${H(1)}`, path.join(dir, 'current'));
  const v = readVersion(dir, { running: null });
  assert.equal(v.drift, true); assert.equal(v.behind, 2); assert.ok(v.nextTryAt > Date.now());
  const s = versionStatus(v);
  assert.equal(s.level, 'warning');
  assert.match(s.label, /^2 commits behind, next try \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
});

test('a failed fetch while rate-limited changes nothing and the normal up-to-date header stays', async t => {
  const state = { now: Date.now(), installed: H(1), main: H(1), behind: 0 };
  const { dir, up } = upgrader(t, state);
  up.s.lastUpgradeAt = state.now - 60000; up.save();
  state.main = null; up.d.fetchMain = () => { throw new Error('offline'); };
  assert.equal(await up.step(), 'rate-limited');
  assert.equal(versionStatus({ installed: H(1), main: H(1), drift: false, behind: 0, nextTryAt: null, running: null, result: 'verified' }).label, 'Up to date (1111111)');
});

const ZERO = '0001-01-01T00:00:00Z';   // how gh serialises a missing time

test('the Go zero time is unknown: a conclusion with a zero completedAt is stuck, not done; a zero startedAt has no age', () => {
  const c = run({ status: 'IN_PROGRESS', completedAt: ZERO });
  assert.equal(checksState([c]), 'pending');
  const seen = new Map(); stuckChecks([c], NOW, seen);
  assert.equal(stuckChecks([c], NOW + STUCK_CHECK_MS + 1, seen).length, 1);
  assert.equal(stuckChecks([run({ status: 'IN_PROGRESS', completedAt: ZERO, startedAt: ZERO })], NOW).length, 0, 'unknown start cannot be aged');
  const queued = run({ status: 'QUEUED', conclusion: '', completedAt: ZERO, startedAt: ZERO });
  assert.equal(unfinishedChecks([queued], NOW)[0].ageMs, null);
  assert.equal(waitingOnText([queued], NOW), 'waiting on CI: ci-lint unfinished for unknown time');
  assert.equal(checksState([run({ status: 'COMPLETED', completedAt: ZERO })]), 'green', 'COMPLETED status alone is still done');
});

test('buildView gives the per-PR waiting text from its own now (reasons and idle reason)', async t => {
  const queued = [run({ status: 'QUEUED', conclusion: '', completedAt: ZERO, startedAt: iso(NOW - 12 * 60000) })];
  const v = await viewWith(queued, t);
  const text = JSON.stringify(v);
  assert.match(text, /waiting on CI: ci-lint unfinished for 12 min/, 'queue reason uses the view now');
  assert.match(text, /waiting on CI for [^"]*329[^"]*: ci-lint unfinished for 12 min/, 'idle reason uses the view now and names the PR');
  assert.doesNotMatch(text, /unfinished for \d{5,} min/);
});

test('readVersion takes now, and uses the interval constant and one read of the state', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'team')); fs.mkdirSync(path.join(dir, 'versions', H(1)), { recursive: true }); fs.symlinkSync(`versions/${H(1)}`, path.join(dir, 'current'));
  const last = 1_000_000_000_000;
  fs.writeFileSync(path.join(dir, 'team', 'self-upgrade.json'), JSON.stringify({ lastUpgradeAt: last, main: { sha: H(2), from: H(1), behind: 3 } }));
  const at = readVersion(dir, { running: null, now: last + 1000 });
  assert.equal(at.nextTryAt, last + MIN_UPGRADE_INTERVAL_MS);
  assert.equal(at.behind, 3);
  assert.equal(readVersion(dir, { running: null, now: last + MIN_UPGRADE_INTERVAL_MS + 1 }).nextTryAt, null);
});

test('while rate-limited, a failing fetch backs off instead of retrying every tick', async t => {
  const state = { now: Date.now(), installed: H(1), main: H(1), behind: 0 };
  const { up } = upgrader(t, state);
  up.s.lastUpgradeAt = state.now - 10000; up.save();
  let calls = 0; up.d.fetchMain = () => { calls++; throw new Error('offline'); };
  assert.equal(await up.step(), 'rate-limited'); assert.equal(calls, 1);
  state.now += 1000;
  assert.equal(await up.step(), 'rate-limited'); assert.equal(calls, 1, 'second tick inside the backoff does not fetch');
  assert.ok(up.s.fetchRetryAt > state.now);
});

test('the "N commits behind, next try" header comes through versionStatus from a fixed-now readVersion', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'team')); fs.mkdirSync(path.join(dir, 'versions', H(1)), { recursive: true }); fs.symlinkSync(`versions/${H(1)}`, path.join(dir, 'current'));
  const last = Date.parse('2026-11-02T10:00:00Z');
  fs.writeFileSync(path.join(dir, 'team', 'self-upgrade.json'), JSON.stringify({ lastUpgradeAt: last, main: { sha: H(2), from: H(1), behind: 3 } }));
  const v = readVersion(dir, { running: H(1), now: last + 1000 });
  const vs = versionStatus(v);
  assert.equal(vs.level, 'warning');
  assert.equal(vs.label, `3 commits behind, next try ${new Date(last + MIN_UPGRADE_INTERVAL_MS).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  assert.equal(versionStatus({ ...v, behind: 1 }).label.startsWith('1 commit behind'), true);
});

test('stuck-check attention items age from first sighting through buildView state', async t => {
  const c = run({ status: 'IN_PROGRESS', completedAt: ZERO });
  const pr = { number: 329, headRefOid: 'f'.repeat(40), statusCheckRollup: [c] };
  const { stuckSeenFor } = await import('../supervisor/dashboard.mjs');
  assert.equal(stuckChecks(pr.statusCheckRollup, NOW, stuckSeenFor(pr)).length, 0);
  assert.equal(stuckChecks(pr.statusCheckRollup, NOW + STUCK_CHECK_MS + 1, stuckSeenFor(pr)).length, 1, 'same head keeps its clock');
  assert.equal(stuckChecks(pr.statusCheckRollup, NOW + STUCK_CHECK_MS + 2, stuckSeenFor({ ...pr, headRefOid: 'e'.repeat(40) })).length, 0, 'a new head restarts it');
});

test('issue #695: the version pill and readVersion say "Next install", and merged is not installed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv3-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'team')); fs.mkdirSync(path.join(dir, 'versions', H(1)), { recursive: true }); fs.symlinkSync(`versions/${H(1)}`, path.join(dir, 'current'));
  const at = Date.parse('2026-11-05T22:00:00Z');
  fs.writeFileSync(path.join(dir, 'team', 'self-upgrade.json'), JSON.stringify({ main: { sha: H(2), from: H(1), behind: 2 }, nextInstall: { to: H(2), at, why: 'batched: x', state: 'batched' } }));
  const v = readVersion(dir, { running: H(1), now: at - 3600000 });
  assert.equal(v.nextInstall.at, at);
  const vs = versionStatus(v);
  assert.equal(vs.label, '2 merged commits not installed. Next install: not before 2026-11-05 22:00 UTC');
  assert.doesNotMatch(vs.label, /installed on|up to date/i);
  assert.equal(versionStatus({ ...v, nextInstall: { at: null, why: 'batched: waiting', state: 'batched' } }).label, '2 merged commits not installed. Next install: batched: waiting');
  // up to date: no next install is claimed
  fs.writeFileSync(path.join(dir, 'team', 'self-upgrade.json'), JSON.stringify({ main: { sha: H(1), from: H(1), behind: 0 }, nextInstall: { to: H(2), at, why: 'old', state: 'batched' } }));
  assert.equal(readVersion(dir, { running: H(1), now: at }).nextInstall, null);
});
