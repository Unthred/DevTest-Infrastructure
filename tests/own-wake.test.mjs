// Issue #1410: Foreman wakes itself after its own merges and verdicts, and no homeowner command loses its wake.
// The pass runs through the real pass driver (drivePass) and the real wake module on a temporary state root; GitHub is a fake adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { drivePass } from '../supervisor/wakepass.mjs';
import { requestWake, pendingRequest, takeRequest, wakeStatus } from '../supervisor/wake.mjs';
import { requestOwnFollowUp, decideFollowUp, changesOf, MAX_FOLLOW_UP_CHAIN } from '../supervisor/ownwake.mjs';
import { MAX_MERGES_PER_PASS } from '../supervisor/mergebatch.mjs';
import { passStats } from '../supervisor/idlecause.mjs';
import { REASON_ALIASES } from '../supervisor/wakereasons.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: agent-proposal\n';
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const ready = n => ({ number: n, title: `t${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: H(n % 10), baseRefName: 'main', isDraft: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green });

// A world with N ready pull requests, each holding a PASS from the other agent on its exact head. `merged` lists the merges, in order.
function world(t, numbers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-wake-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = stateRoot(path.join(dir, 'state'));
  const gh = { pulls: numbers.map(ready), merged: [], rereads: [],
    listPulls: async () => gh.pulls, listIssues: async () => [], listMergedPulls: async () => [],
    getPull: async n => { gh.rereads.push(n); return gh.pulls.find(p => p.number === n) || null; },
    merge: async (n, head) => { const p = gh.pulls.find(x => x.number === n); if (!p || p.headRefOid !== head) throw new Error('head moved'); gh.merged.push(n); gh.pulls = gh.pulls.filter(x => x !== p); },
    comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => { throw new Error('no job expected'); } };
  const team = new Team({ config: config(), root, gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1000 } });
  for (const p of gh.pulls) team.s.verdicts[`${p.number}:${p.headRefOid}`] = { verdict: 'PASS', reviewer: 'codex', job: `j${p.number}` };
  return { root, gh, team, followUps: [], logs: [] };
}
// What `reconcile` does for one pass: the real driver, the team tick, then the follow-up request (supervisor/cli.mjs teamTick).
async function runPass(w, wake = null) {
  return drivePass({ root: w.root, wake, spawnFollowUp: why => w.followUps.push(why),
    runPass: async () => {
      const report = await w.team.tick();
      requestOwnFollowUp({ root: w.root, report, cap: 40, spawnPass: why => w.spawned.push(why), log: line => w.logs.push(line) });
      return report;
    } });
}

test('valid: a pass that merged is followed by one more pass without waiting for the schedule', async t => {
  const w = world(t, [11]); w.spawned = [];
  const out = await runPass(w);
  assert.deepEqual(w.gh.merged, [11]);
  assert.deepEqual(w.spawned, ['follow-up'], 'the pass asked for a follow-up by its own reason');
  assert.equal(out.followUp, 'follow-up', 'the driver starts exactly one more pass after releasing the lock');
  assert.deepEqual(w.followUps, ['follow-up']);
  assert.equal(pendingRequest(w.root).reasons.includes('follow-up'), true);
});

test('boundary: two ready pull requests merge in one pass, in order, each re-read after the first merge', async t => {
  const w = world(t, [12, 11]); w.spawned = [];
  await runPass(w);
  assert.deepEqual(w.gh.merged, [11, 12]);
  assert.deepEqual(w.gh.rereads.filter(n => n === 12).length >= 1, true, 'the second pull request was read again before its merge');
});

test('boundary: a sixth ready pull request waits for the next pass', async t => {
  const w = world(t, [11, 12, 13, 14, 15, 16]); w.spawned = [];
  await runPass(w);
  assert.equal(MAX_MERGES_PER_PASS, 5);
  assert.deepEqual(w.gh.merged, [11, 12, 13, 14, 15]);
  assert.deepEqual(w.followUps, ['follow-up']);
  const second = await runPass(w, 'follow-up');
  assert.deepEqual(w.gh.merged, [11, 12, 13, 14, 15, 16], 'the follow-up pass merged the sixth');
  assert.equal(second.trigger, 'follow-up');
});

test('negative: a later merge whose pull request moved after the earlier merge is held, not merged', async t => {
  const w = world(t, [11, 12]); w.spawned = [];
  const read = w.gh.getPull;
  w.gh.getPull = async n => { const p = await read(n); return p && w.gh.merged.length && n === 12 ? { ...p, mergeStateStatus: 'BEHIND' } : p; };
  const out = await runPass(w);
  assert.deepEqual(w.gh.merged, [11]);
  const row = out.result.planned.find(r => r.ref === 12);
  assert.equal(row.outcome, 'held');
  assert.match(row.reason, /merge state is behind/);
  assert.deepEqual(w.followUps, ['follow-up'], 'the next pass decides about the held one');
});

test('negative: a pass that changed nothing sets no follow-up', async t => {
  const w = world(t, []); w.spawned = [];
  const out = await runPass(w);
  assert.deepEqual(w.spawned, []);
  assert.equal(pendingRequest(w.root), null);
  assert.equal(out.followUp, null);
});

test('boundary: three follow-up passes in a row without a job starting or ending stop the chain', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-wake-chain-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const merged = { planned: [{ type: 'merge', ref: 1, outcome: 'launched' }] }, spawned = [], logs = [];
  const pass = report => { const r = requestOwnFollowUp({ root, report, cap: 40, spawnPass: why => spawned.push(why), log: line => logs.push(line) }); takeRequest(root); return r; };
  for (let i = 0; i < MAX_FOLLOW_UP_CHAIN; i++) assert.equal(pass(merged).requested, true, `follow-up ${i + 1}`);
  const fourth = pass(merged);
  assert.equal(fourth.requested, false);
  assert.match(fourth.why, /3 follow-up passes ran in a row without a job starting or ending/);
  assert.equal(spawned.length, 3);
  assert.match(logs.at(-1), /no follow-up pass/);
  // A job ending resets the chain; so does a pass that changed nothing.
  assert.equal(pass({ ...merged, ingested: [{ job: 'a' }] }).requested, true);
  assert.equal(pass({}).requested, false);
  assert.equal(pass(merged).requested, true);
});

test('what counts as a change: merge, verdict or report, description round, parked state; nothing else', () => {
  assert.deepEqual(changesOf({ planned: [{ type: 'merge', outcome: 'launched' }] }), ['merged a pull request']);
  assert.deepEqual(changesOf({ planned: [{ type: 'merge', outcome: 'held' }] }), []);
  assert.deepEqual(changesOf({ ingested: [{ job: 'a', verdict: 'PASS' }] }), ['ingested a verdict or report']);
  assert.deepEqual(changesOf({ notified: [{ pr: 1, descriptionRound: 'j' }] }), ['finished a description round']);
  assert.deepEqual(changesOf({ notified: [{ job: 'j', target: 3 }] }), []);
  assert.deepEqual(changesOf({ parkedChanged: [7] }), ['changed a parked state']);
  assert.deepEqual(changesOf({ planned: [{ type: 'implement', outcome: 'launched' }] }), []);
  assert.equal(decideFollowUp({ changes: [], moved: false, chain: 2 }).chain, 0);
});

test('valid: the clear retry cap command for PR #1189 requests a wake and a pass starts', t => {
  // 13 Nov 2026: the cap on rebase-1189 was cleared and the rebase then waited 13.1 minutes for a scheduled pass.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-wake-cmd-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spawned = [];
  const out = requestWake({ root, reason: 'clear-retry-cap', spawnPass: why => spawned.push(why) });
  assert.equal(out.requested, true);
  assert.deepEqual(spawned, ['approve']);
  assert.deepEqual(REASON_ALIASES, { requeue: 'approve', 'accept-split': 'approve', 'clear-retry-cap': 'approve' });
  for (const reason of ['requeue', 'accept-split']) { takeRequest(root); assert.equal(requestWake({ root, reason, spawnPass: why => spawned.push(why) }).requested, true, reason); }
  assert.deepEqual(spawned, ['approve', 'approve', 'approve']);
  assert.equal(wakeStatus(root).acceptedLastHour, 0, 'a person pressing a button is never counted');
});

test('the three commands pass the reasons the map knows', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'supervisor', 'api', 'commands');
  for (const [file, reason] of [['work-item-requeue.mjs', 'requeue'], ['work-item-accept-split.mjs', 'accept-split'], ['work-item-clear-retry-cap.mjs', 'clear-retry-cap']]) {
    assert.match(fs.readFileSync(path.join(dir, file), 'utf8'), new RegExp(`context\\.wake\\?\\.\\('${reason}'\\)`));
    assert.equal(REASON_ALIASES[reason], 'approve');
  }
});

test('invalid: an unknown reason is refused with a logged sentence and a result the caller reads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-wake-bad-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spawned = [], logs = [];
  const out = requestWake({ root, reason: 'bogus', spawnPass: why => spawned.push(why), log: line => logs.push(line) });
  assert.equal(out.requested, false);
  assert.equal(out.refused, true);
  assert.match(out.why, /unknown wake reason "bogus"/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unknown wake reason "bogus"; no pass was requested/);
  assert.deepEqual(spawned, []);
  assert.equal(pendingRequest(root), null);
});

test('the diagnostics count passes started by the follow-up reason', () => {
  const stats = passStats([{ at: 5, trigger: 'follow-up', plan: [{ type: 'merge' }] }, { at: 6, trigger: 'follow-up', plan: [] }, { at: 7, trigger: 'schedule', plan: [] }], 0, 10);
  assert.equal(stats.byTrigger['follow-up'].passes, 2);
  assert.equal(stats.byTrigger['follow-up'].startedSomething, 1);
  assert.equal(stats.unlabelled, 0);
});

// Review of PR #1441: park and unpark through the control route (the decision card's Park button) change a parked state too.
test('valid: parking pull request #1189 through the control route is followed by one more pass', async t => {
  const w = world(t, []); w.spawned = [];
  const inboxDir = path.join(path.dirname(w.root), 'inbox'); for (const d of ['items', 'status']) fs.mkdirSync(path.join(inboxDir, d), { recursive: true });
  w.team.c.inbox = { dir: inboxDir };
  w.gh.pulls = [{ ...ready(1189), headRefOid: H(9), labels: [] }];
  w.gh.addLabelAsApp = async (n, label) => { w.gh.pulls.find(p => p.number === n).labels.push(label); };
  const id = 'c'.repeat(32);
  fs.writeFileSync(path.join(inboxDir, 'items', `${id}.json`), JSON.stringify({ kind: 'control', title: 'park 1189', action: 'park', target: '1189', reason: 'hold it while the split is decided' }));
  inbox.scan(inboxDir, 1000);
  await runPass(w);
  assert.equal(inbox.allStatuses(inboxDir).find(s => s.id === id).state, 'done');
  assert.deepEqual(w.spawned, ['follow-up'], 'the park asked for a follow-up pass');
  await runPass(w);
  assert.deepEqual(w.spawned, ['follow-up'], 'nothing changed the second time, so no further follow-up is asked for');
});
