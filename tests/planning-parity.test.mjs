// Issue #121: `team status`, the dashboard and the tick plan from the same allowance. On 1 Nov the dashboard (no probe cache)
// showed "codex about to start a review, reviews only, weekly 99%" while every tick held Codex as waiting (weekly 100%).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { buildStatus } from '../supervisor/teamstatus.mjs';
import { planningInputs } from '../supervisor/planning.mjs';

const T = iso => Date.parse(iso);
const NOW = T('2026-11-01T10:00:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const RESET = T('2026-11-04T07:18:00Z');
const codexAl = (weekly, at) => ({ provider: 'codex', status: 'allowed', observedAt: at,
  windows: [{ type: 'primary', windowMinutes: 300, utilization: 0.1, resetsAt: at + 3600000, status: 'unknown' }, { type: 'secondary', windowMinutes: 10080, utilization: weekly, resetsAt: RESET, status: 'unknown' }] });
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const pulls = [{ number: 119, title: 't', headRefName: 'claude/issue-79-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }];
// The job record says weekly 99% (older); the model-free probe says 100% (newer): the tick uses the probe.
const jobs = [{ id: 'b'.repeat(32), provider: 'codex', kind: 'review', issue: 79, status: 'completed', createdAt: NOW - 7200000, updatedAt: NOW - 7100000, allowance: codexAl(0.99, NOW - 7100000) }];
const probes = { codex: { ...codexAl(1, NOW - 3600000), source: 'session-log' } };
const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues: [], probes, fetchedAt: NOW - 60000 };

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-')); fs.chmodSync(d, 0o700); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

// The tick path: a Team built exactly as cli.mjs teamFor builds it, planning with a dry run.
async function tickPlan(t) {
  const root = tmp(t);
  const gh = { listPulls: async () => pulls, listIssues: async () => [], listMergedPulls: async () => [], getPull: async n => pulls.find(p => p.number === n) || null, hasComment: async () => false };
  const inputs = planningInputs({ config: config(), jobs, probes, snapshots: [], now: NOW });
  const team = new Team({ config: config(), root: stateRoot(path.join(root, 'state')), gh, jobs: { listActive: async () => [] }, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
    clock: { now: () => NOW }, allowanceOf: inputs.allowanceOf, limitedOf: inputs.limitedOf, usage: inputs.usage });
  const report = await team.tick({ dryRun: true });
  return { team, report };
}

test('the dashboard view plans the same actions and modes as the tick on the same state', async t => {
  const { team, report } = await tickPlan(t);
  assert.equal(team.modes.codex.mode, 'waiting', 'the tick holds codex on the probe reading (weekly 100%)');
  const view = await buildView({ config: config(), root: tmp(t), jobs, events: [], state: {}, cache, snapshots: [], now: NOW });
  assert.equal(view.budget.codex.mode, 'waiting');
  for (const a of ['claude', 'codex']) assert.equal(view.budget[a].mode, team.modes[a].mode, a);
  assert.equal(view.budget.codex.used, 1);
  const key = a => `${a.agent}:${a.type}:${a.issue ?? a.pr}`;
  assert.deepEqual(view.plan.map(key), (report.actions || []).map(key));
  assert.ok(!view.plan.some(a => a.agent === 'codex' && a.type === 'review'), 'no codex review is planned while it is waiting');
});

test('`team status` shows the same next action and modes as the tick', async t => {
  const { team, report } = await tickPlan(t);
  const status = await buildStatus({ config: config(), root: tmp(t), jobs, events: [], state: {}, cache, snapshots: [], leases: [], now: NOW, tz: 'UTC' });
  const key = a => `${a.agent}:${a.type}:${a.issue ?? a.pr}`;
  assert.deepEqual(status.next.plan.map(p => `${p.agent}:${p.type}:${p.ref}`), (report.actions || []).map(key));
  for (const a of status.allowance) assert.equal(a.mode, team.modes[a.agent].mode, a.agent);
  assert.equal(status.allowance.find(a => a.agent === 'codex').used, 1);
});

test('negative control: without the probe cache the same state reads weekly 99%, which is what the old dashboard showed', async t => {
  const stale = planningInputs({ config: config(), jobs, probes: {}, now: NOW });
  assert.equal(stale.allowanceOf('codex'), 0.99);
  const live = planningInputs({ config: config(), jobs, probes, now: NOW });
  assert.equal(live.allowanceOf('codex'), 1);
});

test('limitedOf takes usage_limit events from the view the same way the tick does from the event log', () => {
  const blocked = [{ id: 'c'.repeat(32), provider: 'codex', kind: 'review', status: 'blocked', lastEvent: 'retry_exhausted', updatedAt: NOW - 1000, createdAt: NOW - 2000 }];
  const withEvent = planningInputs({ config: config(), jobs: blocked, events: [{ job: 'c'.repeat(32), kind: 'usage_limit' }], now: NOW });
  const without = planningInputs({ config: config(), jobs: blocked, events: [], now: NOW });
  assert.equal(withEvent.limitedOf('codex').out, true);
  assert.equal(without.limitedOf('codex').out, false);
  assert.equal(withEvent.limitedOf('claude').out, false);
});
