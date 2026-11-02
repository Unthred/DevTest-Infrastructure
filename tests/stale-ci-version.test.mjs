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
  assert.equal(stuckChecks([c], NOW).length, 1);
  assert.deepEqual(stuckChecks([run({ status: 'IN_PROGRESS', completedAt: null, startedAt: iso(NOW - STUCK_CHECK_MS + 60000) })], NOW), []);
  assert.deepEqual(stuckChecks([run({ status: 'IN_PROGRESS', conclusion: '', completedAt: null })], NOW), [], 'a plainly running check is not inconsistent');
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
const viewWith = async (roll, t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pull = { number: 329, title: 't', headRefName: 'claude/issue-30-x', headRefOid: H(9), isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: roll };
  return buildView({ config, root, jobs: [], events: [], state: {}, cache: { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, pulls: [pull], issues: [] }, snapshots: [], now: NOW });
};

test('a stuck check raises one Needs you item that says to re-run it, and it clears when the check finishes', async t => {
  const stuck = [run({ status: 'IN_PROGRESS', completedAt: null })];
  const items = (await viewWith(stuck, t)).attention.filter(a => a.id.startsWith('ci-stuck-'));
  assert.equal(items.length, 1);
  assert.match(items[0].text, /"ci-lint".*inconsistent for 30 min; re-run that job/);
  assert.equal((await viewWith(stuck, t)).attention.filter(a => a.id.startsWith('ci-stuck-')).length, 1, 'still one on the next look');
  assert.equal((await viewWith([run()], t)).attention.filter(a => a.id.startsWith('ci-stuck-')).length, 0, 'cleared once it finishes');
  assert.equal((await viewWith([run({ status: 'IN_PROGRESS' })], t)).attention.filter(a => a.id.startsWith('ci-stuck-')).length, 0, 'conclusion plus completed time is just done');
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
  assert.match(s.label, /^2 commits behind, next try \d\d:\d\d UTC$/);
});

test('a failed fetch while rate-limited changes nothing and the normal up-to-date header stays', async t => {
  const state = { now: Date.now(), installed: H(1), main: H(1), behind: 0 };
  const { dir, up } = upgrader(t, state);
  up.s.lastUpgradeAt = state.now - 60000; up.save();
  state.main = null; up.d.fetchMain = () => { throw new Error('offline'); };
  assert.equal(await up.step(), 'rate-limited');
  assert.equal(versionStatus({ installed: H(1), main: H(1), drift: false, behind: 0, nextTryAt: null, running: null, result: 'verified' }).label, 'Up to date (1111111)');
});
