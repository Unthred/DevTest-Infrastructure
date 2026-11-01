// Allowance-aware scheduling (issue #56): weekly burn, modes, reassignment, cost fit, alerts, dashboard and `team status`.
// Fake GitHub, fake jobs and a fake clock; allowance records have the shapes the adapters store. No model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { assessAgent, admits, jobCosts, modeLine, recentRate, weeklyHistory, validateBudgetConfig, DEFAULT_BUDGET, HOUR } from '../supervisor/budget.mjs';
import { resolveModel } from '../supervisor/models.mjs';
import { claudeAllowance, codexAllowance, limitFromAllowance } from '../supervisor/allowance.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { buildStatus, renderStatus } from '../supervisor/teamstatus.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
// 31 Oct 2026: Codex at 92% weekly with 3.5 days to its reset on Wed 4 Nov 07:18 (London, GMT); Claude at 40%.
const RESET = Date.parse('2026-11-04T07:18:00Z');
const NOW = RESET - 3.5 * 24 * HOUR;
const codexAl = (weekly, { at = NOW, resetsAt = RESET, short = 0.1, overage = false, credits = false, status = 'allowed' } = {}) => ({ provider: 'codex', status, observedAt: at,
  windows: [{ type: 'primary', windowMinutes: 300, utilization: short, resetsAt: at + 2 * HOUR, status: 'unknown' }, { type: 'secondary', windowMinutes: 10080, utilization: weekly, resetsAt, status: 'unknown' }],
  billing: { creditsAvailable: credits, usingOverage: overage } });
const claudeAl = (weekly, { at = NOW, resetsAt = RESET, overage = false } = {}) => ({ provider: 'claude', status: 'allowed', observedAt: at,
  windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: at + 3 * HOUR, status: 'allowed' }, { type: 'seven_day', utilization: weekly, resetsAt, status: 'allowed' }],
  billing: { overageStatus: 'rejected', usingOverage: overage } });
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN', body = '', labels = []) => ({ number: n, title: `Issue ${n} title here`, state, body, labels });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';

function world(t, { pulls = [], issues = [], cfg = config(), allowance = {}, jobRecords = [], snapshots = [], alert = null, now = NOW } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [], alerts: [] };
  const gh = { pulls, issues, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues,
    comment: async () => {}, addLabel: async () => {}, board: async () => {}, listMergedPulls: async () => [], hasComment: async () => false };
  const jobs = { active: [], states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const clock = { t: now, now: () => clock.t };
  const usage = { allowance, jobs: jobRecords, snapshots };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock, usage, timeZone: 'Europe/London',
    alert: alert || (async text => { calls.alerts.push(text); }) });
  return { dir, gh, jobs, team, calls, clock, usage };
}

test('31 Oct numbers: codex at 92% with 3.5 days left is reviews only until Wed 07:18; claude at 40% keeps normal mode', () => {
  const cx = assessAgent({ allowance: codexAl(0.92), now: NOW });
  assert.equal(cx.mode, 'reviews_only');
  assert.ok(Math.abs(cx.projected - 1.84) < 0.01, `projected ${cx.projected}`);
  assert.equal(cx.until, RESET); assert.ok(Math.abs(cx.hoursLeft - 84) < 1e-9);
  assert.ok(cx.runsOutAt > NOW && cx.runsOutAt < RESET, 'runs out before the reset');
  assert.match(cx.reason, /weekly 92%, projected 184% at reset/);
  assert.equal(modeLine('codex', cx, 'Europe/London').split(' — ')[0], 'codex: reviews only until Wed 07:18');
  assert.match(modeLine('codex', cx, 'Europe/London'), /— weekly 92%/);
  // The 85% rule also holds alone for these numbers: above 85% with more than 24h to go.
  const highOnly = assessAgent({ allowance: codexAl(0.92), now: NOW, settings: { ...DEFAULT_BUDGET, projected_limit: 2 } });
  assert.equal(highOnly.mode, 'reviews_only'); assert.match(highOnly.reason, /at or above 85% with more than 24h/);
  const cl = assessAgent({ allowance: claudeAl(0.4, { resetsAt: RESET }), now: NOW });
  assert.equal(cl.mode, 'normal'); assert.ok(Math.abs(cl.projected - 0.8) < 0.01);
});

test('85% rule: at 85% with 25h left it is reviews only although the projection stays under 100%; with 23h left it is normal', () => {
  const at = h => assessAgent({ allowance: codexAl(0.85, { resetsAt: NOW + h * HOUR }), now: NOW });
  const a = at(25);
  assert.ok(a.projected < 1, `projected ${a.projected}`); assert.equal(a.mode, 'reviews_only'); assert.match(a.reason, /at or above 85%/);
  const b = at(23);
  assert.ok(b.projected < 1); assert.equal(b.mode, 'normal');
  assert.equal(assessAgent({ allowance: codexAl(0.84, { resetsAt: NOW + 25 * HOUR }), now: NOW }).mode, 'normal', 'below the high-water mark');
});

test('projection rule: run out before the reset at the current rate; the margin is configurable', () => {
  const left = 120;   // 48h into the week
  const at = (used, limit = 1) => assessAgent({ allowance: codexAl(used, { resetsAt: NOW + left * HOUR }), now: NOW, settings: { ...DEFAULT_BUDGET, projected_limit: limit } });
  assert.equal(at(0.3).mode, 'reviews_only'); assert.match(at(0.3).reason, /runs out before the reset/);    // 0.3 + 0.3/48*120 = 1.05
  assert.equal(at(0.2).mode, 'normal');                                                                    // 0.7
  assert.equal(at(0.27).mode, 'normal'); assert.equal(at(0.27, 0.9).mode, 'reviews_only', 'a 90% margin is stricter');
});

test('recent rate from the snapshot history overrides a lower window average', () => {
  // 20% used after 4 days (average 0.21%/h) but 15 points in the last 6 hours (2.5%/h): 3 days left -> runs out
  const resetsAt = NOW + 72 * HOUR;
  const snaps = [6, 3].map(h => ({ at: NOW - h * HOUR, allowance: { codex: { observedAt: NOW - h * HOUR, windows: [{ type: 'secondary', windowMinutes: 10080, utilization: h === 6 ? 0.05 : 0.12, resetsAt }] } } }));
  const current = codexAl(0.2, { resetsAt });
  const history = weeklyHistory(snaps, 'codex', current);
  assert.equal(history.length, 3);
  assert.ok(Math.abs(recentRate(history, resetsAt, NOW, 24) - 0.15 / 6) < 1e-9);
  const a = assessAgent({ allowance: current, history, now: NOW });
  assert.equal(a.rateSource, 'recent'); assert.equal(a.mode, 'reviews_only');
  assert.equal(assessAgent({ allowance: current, now: NOW }).mode, 'normal', 'without history the window average alone is used');
  // negative: readings from another window, or under two hours apart, give no recent rate
  assert.equal(recentRate(history.map(p => ({ ...p, resetsAt: p.resetsAt - 7 * 24 * HOUR })), resetsAt, NOW, 24), null);
  assert.equal(recentRate([{ at: NOW - HOUR, used: 0.1, resetsAt }, { at: NOW, used: 0.2, resetsAt }], resetsAt, NOW, 24), null);
});

test('waiting: a used-up window or paid overage stops every job; credits alone do not; unknown and reset windows are normal', () => {
  const full = assessAgent({ allowance: codexAl(1), now: NOW });
  assert.equal(full.mode, 'waiting'); assert.equal(full.until, RESET);
  assert.deepEqual([admits(full, 'review').ok, admits(full, 'fix').ok, admits(full, 'implement').ok], [false, false, false]);
  const over = assessAgent({ allowance: claudeAl(0.3, { overage: true }), now: NOW });
  assert.equal(over.mode, 'waiting'); assert.match(over.reason, /overage/);
  assert.equal(assessAgent({ allowance: codexAl(0.3, { credits: true }), now: NOW }).mode, 'normal', 'credits available are never relied on, but do not stop work either');
  const short = assessAgent({ allowance: codexAl(0.3, { short: 1 }), now: NOW });
  assert.equal(short.mode, 'waiting'); assert.equal(short.until, NOW + 2 * HOUR);
  assert.equal(assessAgent({ allowance: null, now: NOW }).mode, 'normal');
  const old = assessAgent({ allowance: codexAl(0.99), now: RESET + HOUR });
  assert.equal(old.mode, 'normal'); assert.equal(old.known, false, 'the window reset since the reading');
  const off = assessAgent({ allowance: codexAl(1), now: NOW, settings: { ...DEFAULT_BUDGET, enabled: false } });
  assert.equal(off.mode, 'normal');
  // reviews_only admits reviews and own-PR fixes only
  const ro = assessAgent({ allowance: codexAl(0.92), now: NOW });
  assert.deepEqual(['review', 'fix', 'cifix', 'rebase', 'continue', 'implement'].map(k => admits(ro, k).ok), [true, true, true, true, false, false]);
});

test('waiting on a provider-reported limit without numeric windows (review of PR #73): the dispatcher starts nothing for that agent', async t => {
  // The shapes allowance.mjs produces for a rejected event: Claude's fallback window (rateLimitType + resetsAt, utilization
  // null), a Codex record with limit_reached and no windows, and a window whose own status is rejected.
  const claudeRejected = { ...claudeAllowance({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: RESET / 1000 }), observedAt: NOW };
  assert.equal(claudeRejected.windows[0].utilization, null);
  assert.equal(limitFromAllowance(claudeRejected, NOW).event, 'usage_limit', 'allowance.mjs calls it a limit');
  const cl = assessAgent({ allowance: claudeRejected, now: NOW });
  assert.equal(cl.mode, 'waiting'); assert.equal(cl.until, RESET); assert.match(cl.reason, /limit reached/);
  assert.deepEqual(['review', 'fix', 'implement'].map(k => admits(cl, k).ok), [false, false, false]);
  assert.equal(assessAgent({ allowance: claudeRejected, now: RESET + 60000 }).mode, 'normal', 'the reported reset has passed');
  // No reset time at all: waits one hour from the report (D-019's first wait), then the next launch reads anew.
  const codexReached = { ...codexAllowance({ rate_limit_reached_type: 'weekly' }), observedAt: NOW };
  assert.deepEqual(codexReached.windows, []);
  const cx = assessAgent({ allowance: codexReached, now: NOW + 30 * 60000 });
  assert.equal(cx.mode, 'waiting'); assert.equal(cx.until, NOW + HOUR); assert.match(cx.reason, /without a reset time/);
  assert.equal(assessAgent({ allowance: codexReached, now: NOW + HOUR }).mode, 'normal');
  assert.equal(assessAgent({ allowance: { status: 'rejected', observedAt: NOW }, now: NOW }).mode, 'waiting', 'a record without a windows list');
  // A window that reports its own rejected status with no numeric reading, under an "allowed" record status.
  const win = { provider: 'claude', status: 'allowed', observedAt: NOW, windows: [{ type: 'five_hour', utilization: null, resetsAt: NOW + 2 * HOUR, status: 'rejected' }, { type: 'seven_day', utilization: null, resetsAt: RESET, status: 'allowed' }], billing: { usingOverage: false } };
  const ww = assessAgent({ allowance: win, now: NOW });
  assert.equal(ww.mode, 'waiting'); assert.equal(ww.until, NOW + 2 * HOUR, 'waits for the rejected window, not the latest of all');
  // Unflagged records without numeric windows stay normal.
  assert.equal(assessAgent({ allowance: { ...codexAllowance({}), observedAt: NOW }, now: NOW }).mode, 'normal');
  // Through the dispatcher: claude reviews nothing and implements nothing; codex (normal) still works its own issues.
  const w = world(t, { issues: [issue(2), issue(3), issue(23), issue(5)], pulls: [pr(40, 'codex/issue-2-x', H(1))], allowance: { codex: codexAl(0.3), claude: claudeRejected } });
  const plan = await w.team.plan();
  assert.ok(!plan.some(a => a.agent === 'claude'), JSON.stringify(plan));
  assert.ok(plan.some(a => a.agent === 'codex'));
  await w.team.tick();
  assert.ok(!w.calls.created.some(s => s.provider === 'claude'), 'no claude job created');
  assert.equal(w.team.s.budget.claude.mode, 'waiting');
});

test('dispatcher on the 31 Oct numbers: codex takes only reviews; its implementation goes to claude, which keeps the owner and D-011', async t => {
  const w = world(t, { issues: [issue(2), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED')], pulls: [pr(40, 'claude/issue-7-x', H(1))],
    allowance: { codex: codexAl(0.92), claude: claudeAl(0.4, { resetsAt: RESET }) } });
  const plan = await w.team.plan();
  const cx = plan.find(a => a.agent === 'codex'), cl = plan.find(a => a.agent === 'claude');
  assert.equal(cx.type, 'review', 'codex still reviews'); assert.equal(cx.pr, 40);
  assert.equal(cl.type, 'implement'); assert.equal(cl.issue, 2); assert.equal(cl.reassignedFrom, 'codex'); assert.match(cl.reassignReason, /reassigned for allowance: codex is reviews only/);
  assert.ok(!plan.some(a => a.agent === 'codex' && ['implement', 'continue'].includes(a.type)));
  const report = await w.team.tick();
  assert.equal(report.skipped.length, 0, JSON.stringify(report.skipped));
  const spec = w.calls.created.find(s => s.kind === 'implement');
  assert.equal(spec.provider, 'claude'); assert.match(spec.postcondition.branch, /^claude\/issue-2-/);
  assert.match(spec.prompt, /belongs to codex/);
  const rec = Object.values(w.team.s.jobs).find(j => j.kind === 'implement');
  assert.equal(rec.reassignedFrom, 'codex'); assert.equal(rec.agent, 'claude');
  assert.deepEqual(w.team.c.agents.codex.issues, [2, 3], 'ownership in the config is unchanged');
  // one alert for the codex change; claude's first normal reading is not a change
  assert.equal(w.calls.alerts.length, 1); assert.match(w.calls.alerts[0], /^Allowance: codex: reviews only until Wed 07:18 — weekly 92%/);
  assert.equal(report.budget.find(b => b.agent === 'codex').to, 'reviews_only');
  // the reassigned PR is claude's: codex (the opposite agent) reviews it; claude never does
  for (const j of Object.values(w.team.s.jobs)) j.ingested = true;
  w.jobs.active = [];
  w.gh.pulls = [pr(41, spec.postcondition.branch, H(2))];
  const next = await w.team.plan();
  assert.ok(next.some(a => a.agent === 'codex' && a.type === 'review' && a.pr === 41));
  assert.ok(!next.some(a => a.agent === 'claude' && a.type === 'review' && a.pr === 41));
  assert.ok(!next.some(a => a.type === 'implement' && a.issue === 2), 'issue 2 is not implemented twice');
  // a second tick does not alert again
  await w.team.tick(); assert.equal(w.calls.alerts.length, 1);
});

test('reassigned draft: the taker continues it; the owner never continues another agent\'s branch', async t => {
  const w = world(t, { issues: [issue(2), issue(23, 'CLOSED'), issue(5, 'CLOSED')], pulls: [pr(41, 'claude/issue-2-x', H(2), { isDraft: true })],
    allowance: { codex: codexAl(0.5, { resetsAt: RESET + 48 * HOUR }), claude: claudeAl(0.3) } });
  w.team.s.jobs.x = { kind: 'implement', agent: 'claude', issue: 2, reassignedFrom: 'codex', ingested: true };
  const plan = await w.team.plan();
  assert.equal(plan.find(a => a.agent === 'claude')?.type, 'continue');
  assert.ok(!plan.some(a => a.agent === 'codex'));
});

test('no reassignment to an agent that is itself low, has no known allowance, or whose role does not allow it', async t => {
  const issues = [issue(2), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED')];
  const low = world(t, { issues, allowance: { codex: codexAl(0.92), claude: claudeAl(0.9) } });
  assert.deepEqual(await low.team.plan(), [], 'both low: nothing new is implemented');
  assert.match(low.team.held.codex.implement, /reviews only/);
  const unknown = world(t, { issues, allowance: { codex: codexAl(0.92) } });
  assert.deepEqual(await unknown.team.plan(), [], 'claude has no reported allowance, so no proven headroom');
  const role = world(t, { issues, cfg: config({ budget: { can_take_over: ['codex'] } }), allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) } });
  assert.deepEqual(await role.team.plan(), [], 'claude may not take work over');
  // a reviews-only agent's own draft waits (it is implementation work and stays with its author)
  const draft = world(t, { issues, pulls: [pr(30, 'codex/issue-3-x', H(1), { isDraft: true })], allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) } });
  const p = await draft.team.plan();
  assert.ok(!p.some(a => a.type === 'continue')); assert.ok(!p.some(a => a.agent === 'claude' && a.issue === 3), 'an issue with an open draft is not reassigned');
});

test('waiting reviewer: the implementer keeps working on other unblocked items instead of idling', async t => {
  const w = world(t, { issues: [issue(23), issue(5), issue(2)], pulls: [pr(40, 'claude/issue-23-x', H(1))], allowance: { codex: codexAl(1), claude: claudeAl(0.3) } });
  const plan = await w.team.plan();
  assert.ok(!plan.some(a => a.agent === 'codex'), 'codex has nothing left: no review, no fix, no implement');
  const cl = plan.find(a => a.agent === 'claude');
  assert.deepEqual([cl.type, cl.issue], ['implement', 5]);
  // and once claude's own work is done it picks up codex's unstarted issue
  w.gh.issues = [issue(23), issue(5, 'CLOSED'), issue(2)];
  assert.equal((await w.team.plan()).find(a => a.agent === 'claude').reassignedFrom, 'codex');
});

test('the reset returns ownership: a latched reviews-only mode holds until the weekly reset, then goes back with one alert', async t => {
  const w = world(t, { issues: [issue(2), issue(23, 'CLOSED'), issue(5, 'CLOSED')], allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) } });
  await w.team.tick();
  assert.equal(w.team.s.budget.codex.mode, 'reviews_only');
  for (const j of Object.values(w.team.s.jobs)) j.ingested = true;
  w.team.s.implemented = {}; w.team.s.jobs = {};
  // later the same week the projection drops under the limit (no more codex use), but the latch holds until the reset
  w.clock.t = RESET - 10 * HOUR;
  const held = w.team.budgets().codex;
  assert.equal(held.mode, 'reviews_only'); assert.match(held.reason, /held until the weekly reset/);
  // after the reset the old reading no longer counts: codex is normal and implements its own issue again
  w.clock.t = RESET + 5 * 60000;
  w.usage.allowance.claude = claudeAl(0.5, { at: w.clock.t, resetsAt: RESET + 48 * HOUR });
  const report = await w.team.tick();
  assert.equal(w.team.s.budget.codex.mode, 'normal');
  assert.equal(report.actions.find(a => a.agent === 'codex')?.type, 'implement');
  assert.equal(report.actions.find(a => a.agent === 'codex').reassignedFrom, undefined);
  assert.equal(w.calls.alerts.length, 2); assert.match(w.calls.alerts[1], /^Allowance: codex: normal/);
});

test('alert delivery failure is retried on the next tick and then sent once', async t => {
  let fail = true; const sent = [];
  const w = world(t, { allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) }, issues: [], alert: async text => { if (fail) throw new Error('down'); sent.push(text); } });
  const r1 = await w.team.tick();
  assert.ok(r1.skipped.some(s => s.what === 'alert allowance codex'));
  fail = false;
  await w.team.tick(); await w.team.tick();
  assert.equal(sent.length, 1); assert.match(sent[0], /codex: reviews only/);
});

// Jobs whose stored allowance readings rise by 1% per 100k tokens; implement jobs use 1.5M tokens, reviews 200k.
const calibrated = () => {
  const resetsAt = NOW + 10 * HOUR, out = [];
  let used = 0.5;
  for (let i = 0; i < 6; i++) {
    const kind = i % 2 ? 'review' : 'implement', tok = kind === 'implement' ? 1500000 : 200000;
    used += tok / 1e7;
    out.push({ id: String(i).repeat(32), provider: 'codex', kind, createdAt: NOW - (20 - i) * HOUR, usage: { inputTokens: tok, outputTokens: 0, costUsdEstimate: null },
      allowance: { observedAt: NOW - (19 - i) * HOUR, windows: [{ type: 'secondary', windowMinutes: 10080, utilization: used, resetsAt }] } });
  }
  return { jobs: out, resetsAt };
};

test('cost estimate from recent tokens per job; a job that would run into the weekly limit is not started when a smaller one fits', async t => {
  const { jobs, resetsAt } = calibrated();
  const c = jobCosts(jobs, { resetsAt, windowMinutes: 10080, utilization: 0.9 }, NOW);
  assert.ok(Math.abs(c.perToken - 1e-7) < 1e-12); assert.ok(Math.abs(c.cost('implement') - 0.15) < 1e-9); assert.ok(Math.abs(c.cost('review') - 0.02) < 1e-9);
  assert.equal(jobCosts(jobs.slice(0, 2), { resetsAt, windowMinutes: 10080 }, NOW).perToken, null, 'one sample is not enough to know');
  // 90% used, 10h left: normal mode (projection under 100%, less than 24h left), but implement (15%) does not fit; a review (2%) does
  const w = world(t, { issues: [issue(2), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED')], pulls: [pr(40, 'claude/issue-7-x', H(1))],
    allowance: { codex: codexAl(0.9, { resetsAt }), claude: claudeAl(0.95, { resetsAt: NOW + 2 * HOUR }) }, jobRecords: jobs });
  const plan = await w.team.plan();
  assert.equal(w.team.modes.codex.mode, 'normal');
  assert.deepEqual(plan.filter(a => a.agent === 'codex').map(a => a.type), ['review']);
  w.gh.pulls = [];
  assert.deepEqual(await w.team.plan(), [], 'with no smaller job, nothing starts');
  assert.match(w.team.held.codex.implement, /would run into the weekly limit at 90%/);
});

test('reserve for pending opposite-agent reviews: implementation that fits alone but eats the reserve is held back', () => {
  const { jobs, resetsAt } = calibrated();
  const a = assessAgent({ allowance: codexAl(0.83, { resetsAt }), jobs, now: NOW });
  assert.equal(a.mode, 'normal');
  assert.equal(admits(a, 'implement', 0).ok, true);          // 0.83 + 0.15 = 0.98
  const r = admits(a, 'implement', 1);                         // + 0.02 kept for one review = 1.00
  assert.equal(r.ok, false); assert.match(r.why, /kept for 1 pending review/);
  assert.equal(admits(a, 'review', 5).ok, true, 'a review draws on the reserve');
  const unknown = assessAgent({ allowance: codexAl(0.83, { resetsAt }), now: NOW });
  assert.equal(admits(unknown, 'implement', 3).ok, true, 'without an estimate nothing is known, so nothing is held');
});

test('re-reviews use the configured lower-cost entry while the reviewer is low; full reviews and normal mode keep the review entry', () => {
  const modelsConfig = { allowance_threshold: 0.8, agents: { claude: { review: { model: 'sonnet', effort: 'medium' }, low: { model: 'haiku', effort: 'low' }, implement: { model: 'opus' } } } };
  const manifestModels = { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] };
  const r = o => resolveModel({ modelsConfig, agent: 'claude', kind: 'review', manifestModels, escalation: null, utilization: null, ...o }).fields;
  assert.deepEqual([r({ reReview: true, low: true }).model, r({ reReview: true, low: true }).modelSource], ['haiku', 'allowance']);
  assert.equal(r({ reReview: false, low: true }).model, 'sonnet');
  assert.equal(r({ reReview: true, low: false }).model, 'sonnet');
  const fix = resolveModel({ modelsConfig: { agents: { claude: { fix: { model: 'sonnet' }, strong: { model: 'opus' } } } }, agent: 'claude', kind: 'fix', manifestModels, escalation: { reason: 'x' }, utilization: null, low: true }).fields;
  assert.deepEqual([fix.model, fix.modelSource], ['sonnet', 'allowance'], 'escalation is suppressed while low');
});

test('dispatcher: a fix-round re-review by a reviews-only agent gets its low entry', async t => {
  const cfg = config({ models: { agents: { codex: { review: { effort: 'medium' }, low: { effort: 'low' } } } } });
  const w = world(t, { cfg, issues: [], pulls: [pr(40, 'claude/issue-7-x', H(2))], allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) } });
  w.team.providerModels = { codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };
  w.team.s.verdicts[`40:${H(1)}`] = { verdict: 'CHANGES', reviewer: 'codex', findings: [{ kind: 'blocking', text: 'x' }], at: NOW - 2 * HOUR };
  w.team.s.jobs.f = { kind: 'fix', agent: 'claude', pr: 40, head: H(1), key: `40:${H(1)}`, ingested: true, at: NOW - HOUR };
  w.jobs.states.f = { id: 'f', status: 'completed' };
  await w.team.tick();
  const spec = w.calls.created.find(s => s.kind === 'review');
  assert.equal(spec.effort, 'low'); assert.equal(spec.modelSource, 'allowance'); assert.match(spec.modelReason, /re-review/);
});

test('budget config: validated, overridable in team.local.json, unknown keys and bad values refused', () => {
  const names = ['claude', 'codex'];
  validateBudgetConfig(undefined, names);
  validateBudgetConfig({ enabled: true, projected_limit: 0.9, high_water: 0.85, high_water_min_hours: 24, recent_hours: 24, exhausted_at: 0.995, can_take_over: ['claude'] }, names);
  for (const bad of [[], { nope: 1 }, { projected_limit: 2 }, { high_water: 0.2 }, { high_water_min_hours: -1 }, { recent_hours: 0 }, { enabled: 'yes' }, { exhausted_at: 0.5 }, { can_take_over: ['gemini'] }, { can_take_over: 'claude' }])
    assert.throws(() => validateBudgetConfig(bad, names), /invalid budget config/, JSON.stringify(bad));
  const shipped = validateTeamConfig(config({ budget: { projected_limit: 1, high_water: 0.85 } }));
  const merged = applyLocalOverride(shipped, { budget: { projected_limit: 0.9 } });
  assert.deepEqual(merged.budget, { projected_limit: 0.9, high_water: 0.85 });
  assert.throws(() => applyLocalOverride(shipped, { budget: { high_water: 7 } }), /high_water/);
  assert.throws(() => validateTeamConfig(config({ budget: { bogus: true } })), /unknown key bogus/);
  const real = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  validateTeamConfig(real);
  assert.equal(real.budget.projected_limit, 1); assert.equal(real.budget.high_water, 0.85);
});

test('dry-run and the dashboard plan never write the mode or alert', async t => {
  const w = world(t, { issues: [issue(2)], allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) } });
  const r = await w.team.tick({ dryRun: true });
  assert.equal(r.allowance.codex.mode, 'reviews_only');
  assert.deepEqual(w.team.s.budget, {}); assert.equal(w.calls.alerts.length, 0);
});

test('dashboard and team status show the mode, the weekly projection and why work was reassigned', async t => {
  const cfg = validateTeamConfig(config());
  const jobs = [{ id: 'c'.repeat(32), provider: 'codex', kind: 'review', issue: 40, status: 'completed', createdAt: NOW - 5 * HOUR, updatedAt: NOW - 4 * HOUR, allowance: codexAl(0.92, { at: NOW - 4 * HOUR }) },
    { id: 'd'.repeat(32), provider: 'claude', kind: 'review', issue: 41, status: 'completed', createdAt: NOW - 5 * HOUR, updatedAt: NOW - 4 * HOUR, allowance: claudeAl(0.4, { at: NOW - 4 * HOUR, resetsAt: RESET }) }];
  const cache = { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [issue(2), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED')], merged: [] };
  const state = { budget: {} };
  const view = await buildView({ config: cfg, root: '/nonexistent', jobs, events: [], state, cache, snapshots: [], now: NOW });
  assert.equal(view.budget.codex.mode, 'reviews_only'); assert.ok(view.budget.codex.projected > 1.8);
  assert.equal(view.budget.claude.mode, 'normal');
  const p = view.plan.find(a => a.agent === 'claude');
  assert.deepEqual([p.type, p.issue, p.reassignedFrom], ['implement', 2, 'codex']);
  assert.match(view.queues.codex.find(q => q.type === 'issue' && q.ref === 2).reason, /taken from codex by claude: codex has no allowance until/);
  assert.match(view.queues.codex.find(q => q.type === 'issue' && q.ref === 3).reason, /waits: codex is reviews only/);
  assert.match(view.agents.find(a => a.name === 'codex').idleReason.text, /^reviews only: weekly 92%/);
  assert.ok(view.panels.next.find(n => n.agent === 'claude').why.startsWith('reassigned for allowance'));
  const { renderPage } = await import('../supervisor/dashrender.mjs');
  for (const page of ['usage', 'agents']) {
    const html = renderPage(view, { route: { page } });
    assert.match(html, /data-mode="reviews_only"/); assert.match(html, /projected <b>184%<\/b> at reset/); assert.match(html, /Why: weekly 92%/);
  }
  assert.match(renderPage(view, { route: { page: 'overview' } }), /reassigned for allowance: codex is reviews only/);
  const s = await buildStatus({ config: cfg, root: '/nonexistent', jobs, events: [], state, cache, snapshots: [], leases: [], now: NOW, tz: 'Europe/London' });
  const out = renderStatus(s);
  assert.match(out, /=== Allowance\n {2}claude: normal — weekly 40%, projected 80% at reset[^\n]*; weekly resets Wed 07:18\n {2}codex: reviews only until Wed 07:18 — weekly 92%/);
  assert.match(out, /claude → implement issue #2 \(reassigned from codex for allowance\)/);
});

// ---- Issue #104: ownership is a preference, not a lock

test('#104 an owner at a usage limit (mode normal, no numeric window) loses its ready issue to the other agent; ownership stays', async t => {
  const w = world(t, { issues: [issue(2), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED')], allowance: { claude: claudeAl(0.4) } });
  w.team.limitedOf = agent => (agent === 'codex' ? { out: true, reason: 'codex weekly use 97%', until: RESET } : { out: false });
  const plan = await w.team.plan();
  const cl = plan.find(a => a.agent === 'claude');
  assert.deepEqual([cl.type, cl.issue, cl.reassignedFrom], ['implement', 2, 'codex']);
  assert.match(cl.reassignReason, /codex is out of allowance/);
  assert.deepEqual(w.team.c.agents.codex.issues, [2, 3]);
  // owner has allowance again and nothing started: nobody takes it from it
  w.team.limitedOf = () => ({ out: false });
  assert.ok(!(await w.team.plan()).some(a => a.agent === 'claude' && a.reassignedFrom));
});

test('#104 a taker in reviews-only mode takes nothing, owned elsewhere or unowned', async t => {
  const w = world(t, { issues: [issue(2), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(50)], allowance: { codex: codexAl(0.92), claude: claudeAl(0.9) } });
  assert.deepEqual(await w.team.plan(), []);
});

test('#104 in-flight, started and draft issues are never taken', async t => {
  const base = { allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) } };
  const draft = world(t, { ...base, issues: [issue(2), issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(3, 'CLOSED')], pulls: [pr(30, 'codex/issue-2-x', H(1), { isDraft: true })] });
  assert.ok(!(await draft.team.plan()).some(a => a.agent === 'claude'), 'draft stays with its author');
  const started = world(t, { ...base, issues: [issue(2), issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(3, 'CLOSED')] });
  started.team.s.implemented[2] = true;
  assert.ok(!(await started.team.plan()).some(a => a.agent === 'claude'), 'started work is not taken');
  const flight = world(t, { ...base, issues: [issue(2), issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(3, 'CLOSED')] });
  flight.team.s.jobs.j = { kind: 'implement', key: '2', agent: 'codex', issue: 2, ingested: false };
  assert.ok(!(await flight.team.plan()).some(a => a.agent === 'claude'), 'an in-flight job blocks it');
  const prereq = world(t, { ...base, issues: [issue(2, 'OPEN', 'Prerequisites: #3'), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  const p = await prereq.team.plan();
  assert.deepEqual(p.filter(a => a.agent === 'claude').map(a => a.issue), [3], 'the prerequisite (also codex-owned) is taken, not its dependant');
});

test('#104 an unowned ready issue is picked up, the one that unblocks others first; labels and open prerequisites exclude', async t => {
  const w = world(t, { issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED'), issue(40), issue(41), issue(42, 'OPEN', 'Prerequisites: #41'), issue(43, 'OPEN', '', ['needs-homeowner']), issue(44, 'OPEN', 'Prerequisites: #99')],
    allowance: { codex: codexAl(0.3), claude: claudeAl(0.3) } });
  const plan = await w.team.plan();
  assert.ok(plan.length >= 1);
  for (const a of plan) { assert.equal(a.type, 'implement'); assert.equal(a.unowned, true); }
  assert.equal(plan.length, 2, 'one per agent');
  assert.deepEqual(plan.map(a => a.issue).sort(), [40, 41].sort());
  assert.equal(plan.find(a => a.issue === 41).unowned, true);
  // 41 blocks 42, so it is chosen first; it is the first agent in config order
  assert.equal(plan[0].issue, 41);
  await w.team.tick();
  const spec = w.calls.created.find(s => s.postcondition.branch.includes('issue-41'));
  assert.match(spec.prompt, /has no owner/);
  assert.ok(!w.calls.created.some(s => /issue-4[234]-/.test(s.postcondition.branch)));
});

test('#104 an unowned issue with a PR is not offered again, and its draft is continued by the agent that took it', async t => {
  const w = world(t, { issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED'), issue(40)], pulls: [pr(60, 'claude/issue-40-x', H(2), { isDraft: true })], allowance: { codex: codexAl(0.3), claude: claudeAl(0.3) } });
  w.team.s.jobs.x = { kind: 'implement', agent: 'claude', issue: 40, unowned: true, ingested: true };
  const plan = await w.team.plan();
  assert.deepEqual(plan.map(a => [a.agent, a.type, a.issue]), [['claude', 'continue', 40]]);
});
