// Issue #1121: the rendered dashboard shows, per open issue, the assigned agent and model, the rule, the rank and the wait,
// and a fault for an open issue with no implementer and no stated reason. Built from the real planner and view.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../supervisor/dashboard.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { explanationText, faultAttention } from '../supervisor/dashassign.mjs';

const NOW = Date.parse('2026-11-02T20:00:00Z');
const tick = { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 };
const config = agents => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents });
const AGENTS = { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } };
const issue = (n, body = '') => ({ number: n, title: `issue ${n}`, state: 'OPEN', body, labels: [] });
const build = async (t, agents, issues) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dasg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  return buildView({ config: config(agents), root, jobs: [], events: [], state: {}, snapshots: [], now: NOW, tz: 'UTC',
    cache: { tick, fetchedAt: NOW - 60000, pulls: [], issues: compactIssues(issues) } });
};
const render = (v, route, pathname) => renderRoute(v, route, { pathname }).html;

test('explanationText: agent and model, rule, rank and wait; the fault and the empty case', () => {
  const a = { agent: 'codex', model: 'gpt-x', rule: 'listed in agents.codex.issues (position 2 of 3)', rank: 2, of: 3, wait: { kind: 'paused', text: 'codex is paused until Mon 10:00' }, fault: null };
  assert.equal(explanationText(a), 'agent: codex (gpt-x); rule: listed in agents.codex.issues (position 2 of 3); rank 2 of 3; waiting on: paused: codex is paused until Mon 10:00');
  assert.match(explanationText({ ...a, agent: null, model: null, wait: null, fault: 'open issue with no implementer and no stated reason' }), /^FAULT: open issue with no implementer/);
  assert.equal(faultAttention([]), null);
  assert.match(faultAttention([{ issue: 8 }, { issue: 9 }]).text, /2 open issues have no implementer and no stated reason: #8, #9/);
});

test('rendered Work and issue pages carry agent, rule, rank and wait for a listed issue', async t => {
  const v = await build(t, AGENTS, [issue(30), issue(2)]);
  const work = render(v, { page: 'work' }, '/work');
  assert.match(work, /agent: claude/);
  assert.match(work, /rule: listed in agents\.claude\.issues/);
  assert.match(work, /rank 1 of 1/);
  assert.match(work, /waiting on: /);
  assert.match(render(v, { page: 'issue', id: 30 }, '/issues/30'), /rule: listed in agents\.claude\.issues/);
});

test('rendered Work page explains an unlisted issue', async t => {
  const v = await build(t, { ...AGENTS, claude: { ...AGENTS.claude, issues: [30, 41] } }, [issue(30), issue(40), issue(41, 'Prerequisites: #40')]);
  const work = render(v, { page: 'work' }, '/work');
  assert.match(work, /in no agent&#39;s issue list|in no agent's issue list/);
});

test('rendered Warnings show the fault warning for an open issue with no implementer and no reason', async t => {
  const v = await build(t, AGENTS, [issue(30)]);
  v.panels.warnings.push(faultAttention([{ issue: 50, fault: 'open issue with no implementer and no stated reason' }]));
  assert.match(render(v, { page: 'overview' }, '/'), /1 open issue has no implementer and no stated reason: #50/);
});

test('no fault warning when every open issue is explained', async t => {
  const v = await build(t, AGENTS, [issue(30)]);
  assert.deepEqual(v.assignmentFaults, []);
  assert.ok(!v.panels.warnings.some(w => w.id === 'assignment-fault'));
});
