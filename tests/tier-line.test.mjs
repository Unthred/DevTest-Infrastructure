// Issue #1417: the tier cut off when the weekly allowance is short: the pure rule, config validation, and the real Team plan of a tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { validateBudgetConfig, HOUR } from '../supervisor/budget.mjs';
import { tierCutoff, tierHold, tierLineText, validateTierLine, DEFAULT_TIER_LINE } from '../supervisor/tierline.mjs';
import { collectAssignments } from '../supervisor/issueassign.mjs';
import { budgetView } from '../supervisor/budgetview.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const fig = (used, hoursLeft, projected) => ({ known: true, used, hoursLeft, projected });
const HELD_AT = (used, hoursLeft, projected) => tierCutoff(fig(used, hoursLeft, projected), DEFAULT_TIER_LINE).firstHeld;

test('pure rule: estimate above 100% with more than 24h holds tiers 5 and 6; share at 85% holds tiers 3 to 6', () => {
  assert.equal(HELD_AT(0.67, 117.6, 2.4), 5);
  assert.equal(HELD_AT(0.85, 100, 0.9), 3);
  assert.equal(HELD_AT(0.9, 100, 2), 3, 'both rules apply: the lower tier number wins');
  assert.equal(HELD_AT(0.3, 100, 0.8), null);
});

test('pure rule boundaries: exactly 24h lifts it, exactly 100% estimate does not hold, 84% used does not hold', () => {
  assert.equal(HELD_AT(0.67, 24, 2.4), null);
  assert.equal(HELD_AT(0.67, 24.01, 2.4), 5);
  assert.equal(HELD_AT(0.5, 100, 1), null);
  assert.equal(HELD_AT(0.5, 100, 1.001), 5);
  assert.equal(HELD_AT(0.84, 100, 0.9), null);
  assert.equal(tierCutoff({ known: false, used: null, hoursLeft: null, projected: null }).firstHeld, null, 'unknown figures hold nothing');
});

test('tierHold names the tier, the agent and the reason, and only holds tiers at or above the cut off', () => {
  const cut = tierCutoff(fig(0.67, 117.6, 2.4));
  assert.equal(tierHold(cut, 4, 'claude'), null);
  assert.equal(tierHold(cut, 0, 'claude'), null);
  assert.match(tierHold(cut, 5, 'claude'), /^waits for allowance: tier 5 is not started while claude's week would run out before its reset/);
  assert.match(tierLineText(cut), /tiers 5 to 6 wait/);
  assert.match(tierLineText(tierCutoff(fig(0.1, 100, 0.2))), /none/);
});

test('config: thresholds outside 0 to 1 or a non numeric tier are refused at load with a reason; valid values load', () => {
  const agents = ['claude', 'codex'];
  for (const [bad, re] of [[{ used_limit: 1.5 }, /tier_line\.used_limit/], [{ estimate_limit: -0.1 }, /tier_line\.estimate_limit/], [{ estimate_from_tier: 'five' }, /tier_line\.estimate_from_tier/],
    [{ used_from_tier: 7 }, /tier_line\.used_from_tier/], [{ used_from_tier: 3.5 }, /whole tier/], [{ nope: 1 }, /unknown key/], [{ min_hours: 'x' }, /min_hours/]]) {
    assert.throws(() => validateBudgetConfig({ tier_line: bad }, agents), re);
  }
  assert.throws(() => validateTierLine([]), /tier_line/);
  validateBudgetConfig({ tier_line: { used_limit: 0.9, estimate_from_tier: 4 } }, agents);
});

// --- through the real Team plan -------------------------------------------------------------------------------------------------------
// 14 Nov 2026, 06:20 UTC: the first agent at 67% used, 4.9 days to its reset, an estimate at reset of 240% (recent rate 1.472% an hour).
const NOW = Date.parse('2026-11-14T06:20:00Z');
const RESET = NOW + 4.9 * 24 * HOUR;
const H = n => String(n).repeat(40).slice(0, 40);
const al = (provider, used, at = NOW) => ({ provider, status: 'allowed', observedAt: at,
  windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: at + 3 * HOUR, status: 'allowed' }, { type: 'seven_day', utilization: used, resetsAt: RESET, status: 'allowed' }],
  billing: { overageStatus: 'rejected', usingOverage: false } });
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const issue = (n, tier, extra = {}) => ({ number: n, title: `Issue ${n}`, state: 'OPEN', body: `Tier: ${tier}`, labels: [], ...extra });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';

function world(t, { claudeUsed = 0.67, codexUsed = null, issues, pulls = [], codexOut = false, recent = true, listed = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tierline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { pulls, issues, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues,
    comment: async () => {}, addLabel: async () => {}, board: async () => {}, listMergedPulls: async () => [], hasComment: async () => false };
  const jobs = { active: [], states: {}, listActive: async () => [], get: async () => null, create: async () => ({ id: '0'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const clock = { now: () => NOW };
  // Two readings 10h apart whose rise gives a recent rate of 1.472% an hour: the estimate at reset is 240%.
  const earlier = al('claude', claudeUsed - 0.1472, NOW - 10 * HOUR);
  const allowance = { claude: al('claude', claudeUsed), ...(codexUsed === null ? {} : { codex: al('codex', codexUsed) }) };
  const usage = { allowance, jobs: [], snapshots: recent ? [{ allowance: { claude: earlier } }] : [] };
  const limitedOf = a => (a === 'codex' && codexOut ? { out: true, reason: 'codex out', until: RESET } : { out: false });
  const cfg = config();
  cfg.agents.claude.issues = listed;
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock, usage, limitedOf, timeZone: 'Europe/London', alert: async () => {} });
  return { team, gh };
}
const implementing = plan => plan.filter(a => a.type === 'implement').map(a => `${a.agent}:${a.issue}`);

test('real data, 14 Nov 2026: claude 67% used, 4.9 days left, estimate 240%: tier 5 #1353 waits for allowance and tier 0 #1407 starts', async t => {
  const w = world(t, { issues: [issue(1353, 5), issue(1407, 0)], codexOut: true });
  const plan = await w.team.plan();
  assert.equal(w.team.modes.claude.tierCutoff.firstHeld, 5);
  assert.ok(Math.abs(w.team.modes.claude.projected - 2.4) < 0.01, `estimate ${w.team.modes.claude.projected}`);
  assert.deepEqual(implementing(plan), ['claude:1407']);
  const rows = collectAssignments(w.team, { cache: { issues: w.gh.issues, pulls: [] }, plan, states: {}, activeJobs: [] });
  const waits = rows.find(r => r.number === 1353).wait;
  assert.equal(waits.kind, 'allowance-tier');
  assert.match(waits.text, /waits for allowance: tier 5 is not started while claude's week would run out before its reset/);
  assert.equal(rows.find(r => r.number === 1407).wait.kind, 'next');
});

test('only tier 5 and 6 issues ready: nothing starts for claude, and the hold is recorded on the agent', async t => {
  const w = world(t, { issues: [issue(1353, 5), issue(1354, 6)], codexOut: true });
  assert.deepEqual(implementing(await w.team.plan()), []);
  assert.match(w.team.held.claude.implement, /#1353 waits for allowance: tier 5/);
});

test('a second agent with room takes the tier 5 issue', async t => {
  const w = world(t, { issues: [issue(1353, 5)], codexUsed: 0.2 });
  assert.deepEqual(implementing(await w.team.plan()), ['codex:1353']);
});

test('at 85% used with more than 24h to go tiers 3 to 6 wait through the Team plan, and a tier 2 issue is not held by this rule', async t => {
  const w = world(t, { claudeUsed: 0.85, issues: [issue(30, 3), issue(20, 2)], codexOut: true });
  await w.team.plan();
  assert.equal(w.team.modes.claude.tierCutoff.firstHeld, 3);
  assert.equal(tierHold(w.team.modes.claude.tierCutoff, 2, 'claude'), null);
  assert.match(tierHold(w.team.modes.claude.tierCutoff, 3, 'claude'), /85% used/);
});

test('work on an open pull request is not held by the rule: a fix on a claude PR is still planned at tier 5', async t => {
  const pr = { number: 50, title: 't', headRefName: 'claude/issue-1353-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' }] };
  const w = world(t, { issues: [issue(1353, 5)], pulls: [pr], codexOut: true });
  const plan = await w.team.plan();
  assert.ok(!implementing(plan).length);
  assert.ok(plan.some(a => a.agent === 'claude' && ['fix', 'cifix'].includes(a.type)), `a fix is planned: ${JSON.stringify(plan.map(a => a.type))}`);
});

test('the hold lifts when the estimate falls: 20% used at the window average (67% at reset) starts the tier 5 issue', async t => {
  const w = world(t, { claudeUsed: 0.2, recent: false, issues: [issue(1353, 5)], codexOut: true });
  assert.deepEqual(implementing(await w.team.plan()), ['claude:1353']);
  assert.equal(w.team.modes.claude.tierCutoff.firstHeld, null);
});

test('foreman_budget view carries the cut off in force for each agent', async t => {
  const w = world(t, { issues: [issue(1353, 5)], codexOut: true });
  await w.team.plan();
  const view = budgetView(w.team);
  assert.match(view.claude.tierLine, /tier cut off: tiers 5 to 6 wait/);
  assert.equal(view.claude.tierCutoff.firstHeld, 5);
});

test('an issue in the holding agent\'s own list goes to another agent with room, and every agent holding keeps it waiting', async t => {
  const w = world(t, { issues: [issue(1353, 5)], listed: [1353], codexUsed: 0.2 });
  const plan = await w.team.plan();
  assert.deepEqual(implementing(plan), ['codex:1353']);
  assert.equal(plan.find(a => a.type === 'implement').reassignedFrom, 'claude');
  const held = world(t, { issues: [issue(1353, 5)], listed: [1353], codexOut: true });
  assert.deepEqual(implementing(await held.team.plan()), []);
});

test('foreman_budget shows the thresholds in force with the defaults when no tier_line is configured, and the cut off per agent', async t => {
  const w = world(t, { issues: [issue(1353, 5)], codexOut: true });
  await w.team.plan();
  const view = { budget: budgetView(w.team) };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0, stale: false }) }, readHost: () => ({}),
    getPath: async () => ({ effective: { budget: { enabled: true } } }) });
  const out = JSON.parse((await tools.call('foreman_budget')).text);
  assert.deepEqual(out.thresholds.tierLine, DEFAULT_TIER_LINE);
  assert.equal(out.agents.claude.tierLine.firstHeldTier, 5);
});
