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
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN', body = '', labels = []) => ({ number: n, title: `Issue ${n} title here`, state, body, labels });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';

function world(t, { pulls = [], issues = [], cfg = config(), allowance = {}, jobRecords = [], snapshots = [], alert = null, now = NOW, out = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [], alerts: [] };
  const gh = { pulls, issues, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues,
    comment: async () => {}, addLabel: async () => {}, board: async () => {}, listMergedPulls: async () => [], hasComment: async () => false };
  const jobs = { active: [], states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const clock = { t: now, now: () => clock.t };
  const usage = { allowance, jobs: jobRecords, snapshots };
  const limitedOf = a => (out[a] ? { out: true, reason: out[a].reason ?? `${a} out`, until: out[a].until } : { out: false });
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock, usage, limitedOf, timeZone: 'Europe/London',
    alert: alert || (async text => { calls.alerts.push(text); }) });
  return { dir, gh, jobs, team, calls, clock, usage, out };
}

test('31 Oct numbers: codex at 92% with 3.5 days left is reviews only until Wed 07:18 by the high-water rule; claude at 40% keeps normal mode', () => {
  const cx = assessAgent({ allowance: codexAl(0.92), now: NOW });
  assert.equal(cx.mode, 'reviews_only'); assert.equal(cx.rule, 'high-water');
  assert.ok(Math.abs(cx.projected - 1.84) < 0.01, `projected ${cx.projected}`);   // the estimate is still computed
  assert.equal(cx.until, RESET); assert.ok(Math.abs(cx.hoursLeft - 84) < 1e-9);
  assert.ok(cx.runsOutAt > NOW && cx.runsOutAt < RESET, 'runs out before the reset');
  assert.match(cx.reason, /weekly 92%: at or above 85% with more than 24h/);
  assert.doesNotMatch(cx.reason, /projected|estimate/);
  assert.equal(modeLine('codex', cx, 'Europe/London').split(' — ')[0], 'codex: reviews only until Wed 07:18');
  assert.match(modeLine('codex', cx, 'Europe/London'), /— weekly 92%/);
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

test('issue #680: a projection never holds work back, however high; the estimate is kept and labelled', () => {
  const left = 120;   // 48h into the week
  for (const used of [0.2, 0.3, 0.5, 0.8]) {
    const a = assessAgent({ allowance: codexAl(used, { resetsAt: NOW + left * HOUR }), now: NOW });
    assert.equal(a.mode, 'normal', `${used}: ${a.reason}`); assert.ok(a.projected >= 0.69);
    assert.match(a.reason, /estimate at reset \d+%.*for information only/); assert.doesNotMatch(a.reason, /held|runs out/);
  }
  // a very high recent rate at 10% used: 5%/h over the last 2 hours is an estimate of 610% at reset, and still nothing is held back
  const resetsAt = NOW + left * HOUR, history = [{ at: NOW - 2 * HOUR, used: 0, resetsAt }, { at: NOW, used: 0.1, resetsAt }];
  const a = assessAgent({ allowance: codexAl(0.1, { resetsAt }), history, now: NOW });
  assert.equal(a.mode, 'normal'); assert.equal(a.rateSource, 'recent'); assert.ok(a.projected > 6, `projected ${a.projected}`); assert.ok(a.runsOutAt < resetsAt);
  for (const type of ['implement', 'continue', 'review', 'fix']) assert.deepEqual(admits(a, type), { ok: true }, type);
  // the settings that used to drive the rule are still accepted, so an installed team.local.json keeps loading, and they change nothing
  const legacy = { ...DEFAULT_BUDGET, projected_limit: 0.5, recent_min_window_hours: 0, recent_min_samples: 2 };
  assert.equal(assessAgent({ allowance: codexAl(0.1, { resetsAt }), history, now: NOW, settings: legacy }).mode, 'normal');
});

test('recent rate from the snapshot history overrides a lower window average, as an estimate only', () => {
  // 20% used after 4 days (average 0.21%/h) but readings in the last 6 hours at 2.5%/h: 3 days left
  const resetsAt = NOW + 72 * HOUR;
  const snaps = [6, 3].map(h => ({ at: NOW - h * HOUR, allowance: { codex: { observedAt: NOW - h * HOUR, windows: [{ type: 'secondary', windowMinutes: 10080, utilization: h === 6 ? 0.05 : 0.12, resetsAt }] } } }));
  const current = codexAl(0.2, { resetsAt });
  const history = weeklyHistory(snaps, 'codex', current);
  assert.equal(history.length, 3);
  assert.ok(Math.abs(recentRate(history, resetsAt, NOW, 24) - 0.15 / 6) < 1e-9);
  const a = assessAgent({ allowance: current, history, now: NOW });
  assert.equal(a.rateSource, 'recent'); assert.ok(a.projected > 1); assert.equal(a.mode, 'normal');
  assert.equal(assessAgent({ allowance: current, now: NOW }).rateSource, 'window average', 'without history the window average alone is used');
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
  assert.deepEqual([fix.model, fix.modelSource], ['sonnet', 'configured'], 'escalation never changes the model (issue #316)');
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
  validateBudgetConfig({ enabled: true, projected_limit: 0.9, recent_min_window_hours: 6, recent_min_samples: 8, high_water: 0.85, high_water_min_hours: 24, recent_hours: 24, exhausted_at: 0.995, can_take_over: ['claude'] }, names);
  for (const bad of [[], { nope: 1 }, { projected_limit: 2 }, { high_water: 0.2 }, { high_water_min_hours: -1 }, { recent_hours: 0 }, { enabled: 'yes' }, { exhausted_at: 0.5 }, { can_take_over: ['gemini'] }, { can_take_over: 'claude' }])
    assert.throws(() => validateBudgetConfig(bad, names), /invalid budget config/, JSON.stringify(bad));
  const shipped = validateTeamConfig(config({ budget: { projected_limit: 1, high_water: 0.85 } }));
  const merged = applyLocalOverride(shipped, { budget: { projected_limit: 0.9 } });
  assert.deepEqual(merged.budget, { projected_limit: 0.9, high_water: 0.85 });
  assert.throws(() => applyLocalOverride(shipped, { budget: { high_water: 7 } }), /high_water/);
  assert.throws(() => validateTeamConfig(config({ budget: { bogus: true } })), /unknown key bogus/);
  const real = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  validateTeamConfig(real);
  assert.equal(real.budget.projected_limit, undefined, 'issue #680: the shipped file no longer sets the retired forecast limit'); assert.equal(real.budget.high_water, 0.85);
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
  assert.match(view.queues.codex.find(q => q.type === 'issue' && q.ref === 2).reason, /reassigned for allowance from codex to claude: codex has no allowance until/);
  // the 'until' time is shown in the configured zone, not the host's (issue #151)
  const zoned = async tz => (await buildView({ config: cfg, root: '/nonexistent', jobs, events: [], state, cache, snapshots: [], now: NOW, tz })).queues.codex.find(q => q.type === 'issue' && q.ref === 2).reason;
  const untilIn = async tz => (await zoned(tz)).match(/ until (\w{3} \d\d:\d\d)/)[1];
  assert.notEqual(await untilIn('Pacific/Auckland'), await untilIn('Pacific/Pago_Pago'));
  assert.match(view.queues.codex.find(q => q.type === 'issue' && q.ref === 3).reason, /waits: codex is reviews only/);
  assert.match(view.agents.find(a => a.name === 'codex').idleReason.text, /^reviews only: weekly 92%/);
  assert.ok(view.panels.next.find(n => n.agent === 'claude').why.startsWith('reassigned for allowance'));
  const { renderPage } = await import('../supervisor/dashrender.mjs');
  for (const page of ['usage', 'agents']) {
    const html = renderPage(view, { route: { page } });
    assert.match(html, /data-mode="reviews_only"/); assert.match(html, /estimate at reset <b>184%<\/b>/); assert.match(html, /an estimate only, it does not hold work back/); assert.match(html, /Why: weekly 92%/);
  }
  assert.match(renderPage(view, { route: { page: 'overview' } }), /reassigned for allowance: codex is reviews only/);
  const s = await buildStatus({ config: cfg, root: '/nonexistent', jobs, events: [], state, cache, snapshots: [], leases: [], now: NOW, tz: 'Europe/London' });
  const out = renderStatus(s);
  assert.match(out, /=== Allowance\n {2}claude: normal — weekly 40%; estimate at reset 80%[^\n]*; weekly resets Wed 07:18\n {2}codex: reviews only until Wed 07:18 — weekly 92%/);
  assert.match(out, /claude → implement #2 Issue 2 title here \(reassigned from codex for allowance\)/);
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

test('#104 a taker in reviews-only mode takes nothing', async t => {
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

test('#104 a prerequisite owned by another, out owner is taken so the taker can then do its own dependant', async t => {
  const w = world(t, { issues: [issue(23, 'OPEN', 'Prerequisites: #3'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3)], allowance: { codex: codexAl(0.92), claude: claudeAl(0.4) } });
  const p = await w.team.plan();
  assert.deepEqual(p.filter(a => a.agent === 'claude').map(a => [a.type, a.issue, a.reassignedFrom]), [['implement', 3, 'codex']], 'claude takes codex prerequisite #3, not its own blocked #23');
});

test('#104 ownership returns when the owner mode resets from reviews only or waiting to normal', async t => {
  const seen = [];
  for (const out of [codexAl(0.92), codexAl(1, { status: 'rejected' })]) {
    const w = world(t, { issues: [issue(2), issue(3, 'CLOSED'), issue(23, 'CLOSED'), issue(5, 'CLOSED')], allowance: { codex: out, claude: claudeAl(0.4) } });
    const before = await w.team.plan();
    seen.push(w.team.modes.codex.mode);
    assert.ok(before.some(a => a.agent === 'claude' && a.issue === 2 && a.reassignedFrom === 'codex'), `taken while codex is ${w.team.modes.codex.mode}`);
    w.usage.allowance.codex = codexAl(0.3);
    const after = await w.team.plan();
    assert.equal(w.team.modes.codex.mode, 'normal');
    assert.ok(!after.some(a => a.agent === 'claude' && a.reassignedFrom), 'nothing is taken from a normal owner');
    assert.deepEqual(after.filter(a => a.agent === 'codex').map(a => [a.type, a.issue]), [['implement', 2]]);
  }
  assert.deepEqual(seen, ['reviews_only', 'waiting']);
});

// Issue #212 reverses PR #146: an open issue in no agent's list is eligible by default; only the excluding labels keep it out.
test('#212 an issue no agent lists is implemented unless it carries an excluding label', async t => {
  const issues = [issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED'), issue(40), issue(41, 'OPEN', '', ['agent-ok']), issue(42, 'OPEN', '', ['enhancement'])];
  const allowance = { codex: codexAl(0.3), claude: claudeAl(0.3) };
  const plan = await world(t, { issues, allowance }).team.plan();
  assert.ok(plan.some(a => a.type === 'implement' && a.issue === 40), 'an unlabelled unlisted issue is planned without a config edit');
  const excluded = [issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED'), ...['epic', 'tracking', 'parked', 'needs-homeowner'].map((l, i) => issue(50 + i, 'OPEN', '', [l]))];
  assert.deepEqual(await world(t, { issues: excluded, allowance }).team.plan(), [], 'each excluding label keeps an issue out');
});

test('#212 a draft for an unlisted eligible issue is continued by its author', async t => {
  const w = world(t, { issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED'), issue(40)], pulls: [pr(60, 'claude/issue-40-x', H(2), { isDraft: true })], allowance: { codex: codexAl(0.3), claude: claudeAl(0.3) } });
  w.team.s.jobs.x = { kind: 'implement', agent: 'claude', issue: 40, unowned: true, ingested: true };
  assert.ok((await w.team.plan()).some(a => a.type === 'continue' && a.issue === 40));
});

test('issue #187: the cost of jobs already planned this tick is charged to the next candidate, and the held reason says so', async t => {
  const { jobs, resetsAt } = calibrated();
  const mk = used => world(t, { issues: [issue(2), issue(3), issue(23, 'CLOSED'), issue(5, 'CLOSED')], cfg: config({ limits: { roles: { implementer: 2, reviewer: 1 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 } }),
    allowance: { codex: codexAl(used, { resetsAt }), claude: claudeAl(0.95, { resetsAt: NOW + 2 * HOUR }) }, jobRecords: jobs });
  const tight = mk(0.75), roomy = mk(0.65);
  const impl = async w => (await w.team.plan()).filter(a => a.agent === 'codex' && a.type === 'implement').length;
  assert.equal(await impl(tight), 1, '75% + 15% fits once; the second would need 15% more');
  assert.equal(await impl(roomy), 2, 'at 65% both fit');
  const why = tight.team.held.codex.implement;
  assert.match(why, /weekly limit at 90%/);
  assert.match(why, /75% recorded plus 15% for jobs planned this tick/);
  assert.doesNotMatch(roomy.team.held.codex?.implement || '', /planned this tick/);
});

test('issue #187: an agent at a usage limit (mode still normal) does not take another agent\'s issue over either', async t => {
  const w = world(t, { issues: [issue(2), issue(23, 'CLOSED'), issue(5, 'CLOSED')], allowance: { codex: codexAl(0.92), claude: claudeAl(0.4, { resetsAt: RESET }) } });
  assert.equal((await w.team.plan()).find(a => a.agent === 'claude')?.reassignedFrom, 'codex', 'control: claude in allowance takes it');
  w.out.claude = { reason: 'claude 5-hour limit' };
  assert.ok(!(await w.team.plan()).some(a => a.agent === 'claude' && a.type === 'implement'));
});

// issue #185: the served dashboard path (currentView) passes a zone, so the 'until' time is not shown in UTC
test('currentView shows the reassignment time in the given zone, and in the host zone by default', async t => {
  const { currentView } = await import('../supervisor/dashserver.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tz185-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const jobs = [{ id: 'c'.repeat(32), provider: 'codex', kind: 'review', issue: 40, status: 'completed', createdAt: NOW - 5 * HOUR, updatedAt: NOW - 4 * HOUR, allowance: codexAl(0.92, { at: NOW - 4 * HOUR }) },
    { id: 'd'.repeat(32), provider: 'claude', kind: 'review', issue: 41, status: 'completed', createdAt: NOW - 5 * HOUR, updatedAt: NOW - 4 * HOUR, allowance: claudeAl(0.4, { at: NOW - 4 * HOUR, resetsAt: RESET }) }];
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [issue(2), issue(3)], merged: [] }));
  const cfg = config();
  const until = async extra => (await currentView({ root, config: cfg, now: NOW, ...extra })).queues.codex.find(q => q.type === 'issue' && q.ref === 2).reason.match(/ until (\w{3} \d\d:\d\d)/)[1];
  const utc = await until({ tz: 'UTC' }), auckland = await until({ tz: 'Pacific/Auckland' });
  assert.notEqual(utc, auckland, 'an explicit zone reaches the rendered time');
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(await until({}), auckland, 'with no tz the host zone is used, not UTC');
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

// Issue #680 (supersedes the forecast rules of #627). 5 Nov 2026: the weekly window began at 04:00; 5% used by 07:45 was projected as 280% and Claude was held.
const R0 = Date.parse('2026-11-05T04:00:00Z'), R1 = R0 + 7 * 24 * HOUR;
const burst = upto => { const h = []; for (let t = R0 + 5 * 60000; t <= upto; t += 5 * 60000) h.push({ at: t, used: Math.min(0.08, 0.05 * (t - R0) / (3.75 * HOUR)), resetsAt: R1 }); return h; };
const claudeAt = (at, used) => claudeAl(used, { at, resetsAt: R1 });
test('budget #680: 5% by 07:45 and 8% by 10:00 after a 04:00 reset stays normal and admits implement jobs, with or without an old latch', () => {
  const oldLatch = { mode: 'reviews_only', since: R0 + 2.3 * HOUR, until: R1, reason: 'weekly 5%, projected 280% at reset' };   // recorded by the old rule: no rule field
  for (const [at, used] of [[R0 + 3.75 * HOUR, 0.05], [R0 + 6 * HOUR, 0.08], [R0 + 20 * HOUR, 0.38]]) {
    for (const l of [null, oldLatch]) {
      const a = assessAgent({ allowance: claudeAt(at, used), history: burst(at), now: at, latched: l });
      assert.equal(a.mode, 'normal', `${used} latched=${!!l}: ${a.reason}`);
      assert.equal(admits(a, 'implement').ok, true);
    }
  }
  assert.ok(assessAgent({ allowance: claudeAt(R0 + 3.75 * HOUR, 0.05), history: burst(R0 + 3.75 * HOUR), now: R0 + 3.75 * HOUR }).projected > 1, 'the estimate is still shown');
});
test('budget #680: 85% used with days left gives reviews_only, and that latch holds; overage and exhausted still stop everything', () => {
  const now = R0 + 40 * HOUR;
  const hw = assessAgent({ allowance: claudeAt(now, 0.86), now });
  assert.equal(hw.mode, 'reviews_only'); assert.equal(hw.rule, 'high-water'); assert.equal(admits(hw, 'implement').ok, false); assert.equal(admits(hw, 'review').ok, true); assert.equal(admits(hw, 'fix').ok, true);
  // a high-water latch holds while the reading is below the mark again, until the reset (or a fresh probe)
  const latch = { mode: 'reviews_only', rule: 'high-water', since: now - HOUR, until: R1, reason: 'weekly 86%: at or above 85% with more than 24h to go' };
  const held = assessAgent({ allowance: claudeAt(now, 0.5), now, latched: latch });
  assert.equal(held.mode, 'reviews_only'); assert.match(held.reason, /held until the weekly reset/);
  const over = assessAgent({ allowance: claudeAl(0.05, { at: now, resetsAt: R1, overage: true }), now });
  assert.equal(over.mode, 'waiting'); assert.equal(admits(over, 'review').ok, false);
  const gone = assessAgent({ allowance: claudeAt(now, 0.999), now });
  assert.equal(gone.mode, 'waiting'); assert.equal(admits(gone, 'review').ok, false);
  const short = claudeAl(0.1, { at: now, resetsAt: R1 }); short.windows[0].utilization = 0.999;
  assert.equal(assessAgent({ allowance: short, now }).mode, 'waiting');
});
test('budget #682: a genuine old high-water latch (no rule field) keeps holding to the reset in the last day; an old forecast latch does not', () => {
  const now = R1 - 10 * HOUR;
  const old = { mode: 'reviews_only', since: now - 30 * HOUR, until: R1, reason: 'weekly 86%, projected 120% at reset (60h left, window average): at or above 85% with more than 24h to go' };
  const a = assessAgent({ allowance: claudeAt(now, 0.9), now, latched: old });
  assert.equal(a.mode, 'reviews_only'); assert.equal(a.rule, 'high-water'); assert.match(a.reason, /held until the weekly reset/);
  const early = { ...old, reason: 'weekly 86%, projected 86% at reset (60h left, window average); no forecast yet, under 6h into the window: judged by actual use against the 85% high-water mark: at or above 85% with more than 24h to go' };
  assert.equal(assessAgent({ allowance: claudeAt(now, 0.9), now, latched: early }).mode, 'reviews_only', 'early-window format');
  const fc = { mode: 'reviews_only', since: now - 30 * HOUR, until: R1, reason: 'weekly 5%, projected 280% at reset (60h left, recent): runs out before the reset at the current rate (rule: recent rate over the limit)' };
  assert.equal(assessAgent({ allowance: claudeAt(now, 0.9), now, latched: fc }).mode, 'normal');
  assert.equal(assessAgent({ allowance: claudeAt(now, 0.9), now, latched: { ...old, until: R1 - 7 * 24 * HOUR } }).mode, 'normal', 'another window');
});
test('budget #680: a token-shaped value in a latched reason does not reach the reason or the mode line', () => {
  const secret = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');   // assembled at run time
  const now = R0 + 40 * HOUR;
  const a = assessAgent({ allowance: claudeAt(now, 0.5), now, latched: { mode: 'reviews_only', rule: 'high-water', since: R0, until: R1, reason: `weekly 86%, token ${secret}` } });
  assert.equal(a.mode, 'reviews_only');
  assert.match(a.reason, /held until the weekly reset/, 'the latched-hold branch was reached');
  assert.ok(!a.reason.includes(secret)); assert.match(a.reason, /\[token\]/);
  assert.ok(!modeLine('claude', { ...a, reason: `x token ${secret}` }, 'UTC').includes(secret));
});
test('budget #680: the retired forecast settings are still accepted and range-checked, and the other settings are validated', () => {
  validateBudgetConfig({ projected_limit: 1.5, recent_min_window_hours: 6, recent_min_samples: 8, recent_hours: 12 }, ['claude']);
  for (const bad of [{ recent_min_window_hours: -1 }, { recent_min_samples: 1 }, { projected_limit: 3 }, { recent_hours: 0 }]) assert.throws(() => validateBudgetConfig(bad, ['claude']), /invalid budget config/, JSON.stringify(bad));
  assert.equal(DEFAULT_BUDGET.projected_limit, undefined); assert.equal(DEFAULT_BUDGET.recent_min_window_hours, undefined); assert.equal(DEFAULT_BUDGET.recent_hours, 24);
  const local = validateTeamConfig(applyLocalOverride(validateTeamConfig(config({ budget: { high_water: 0.85 } })), { budget: { projected_limit: 1.5 } }));
  assert.equal(local.budget.projected_limit, 1.5);   // an installed team.local.json that still sets it loads
});

test('just after a weekly reset a short burst is not extrapolated: 4% used is not projected as hundreds of percent (issue #619)', () => {
  const left = 156, resetsAt = NOW + left * HOUR;   // 12h into the week
  const history = [{ at: NOW - 2 * HOUR, used: 0, resetsAt }, { at: NOW, used: 0.04, resetsAt }];
  const a = assessAgent({ allowance: codexAl(0.04, { resetsAt }), history, now: NOW });
  assert.equal(a.rateSource, 'window average'); assert.ok(a.projected < 1, `projected ${a.projected}`); assert.equal(a.mode, 'normal');
  // once the window has run as long as the recent span, the recent rate counts again
  const later = NOW + 20 * HOUR, r2 = NOW + 120 * HOUR, h2 = [{ at: later - 3 * HOUR, used: 0.1, resetsAt: r2 }, { at: later, used: 0.3, resetsAt: r2 }];
  assert.equal(assessAgent({ allowance: codexAl(0.3, { resetsAt: r2, at: later }), history: h2, now: later }).rateSource, 'recent');
});

test('the recent rate blends in gradually: no cliff at recent_hours (issue #698)', () => {
  const proj = elapsedH => {
    const now = NOW, resetsAt = NOW + (168 - elapsedH) * HOUR;
    const history = [{ at: now - 3 * HOUR, used: 0.0, resetsAt }, { at: now, used: 0.04, resetsAt }];
    return assessAgent({ allowance: codexAl(0.04, { resetsAt }), history, now });
  };
  const at12 = proj(12), at18 = proj(18), at23 = proj(23), at24 = proj(24);
  assert.equal(at12.rateSource, 'window average');
  assert.ok(at18.projected > at12.projected && at23.projected < at24.projected);
  // continuity: the step between 23h and 24h is small relative to the old 29% -> 196% jump
  assert.ok(at24.projected - at23.projected < 0.3, `${at23.projected} -> ${at24.projected}`);
  assert.ok(at23.projected > 0.3, 'the recent rate already counts at 23h');
});

test('the blend weight is 0 at recent_hours/2 and 1 from recent_hours, for a non-default recent_hours (issue #698)', () => {
  const settings = { ...DEFAULT_BUDGET, recent_hours: 12 };
  const run = elapsedH => {
    const now = NOW, resetsAt = NOW + (168 - elapsedH) * HOUR;
    const history = [{ at: now - 3 * HOUR, used: 0.0, resetsAt }, { at: now, used: 0.04, resetsAt }];
    return assessAgent({ allowance: codexAl(0.04, { resetsAt }), history, settings, now });
  };
  const recentRatePerHour = 0.04 / 3;
  assert.equal(run(6).rateSource, 'window average', 'weight 0 at exactly recent_hours/2');
  assert.equal(run(5).rateSource, 'window average');
  assert.ok(run(9).ratePerHour > 0.04 / 9 && run(9).ratePerHour < recentRatePerHour, 'partial weight between the half span and the span');
  assert.ok(Math.abs(run(12).ratePerHour - recentRatePerHour) < 1e-9, 'weight 1 at recent_hours');
  assert.ok(Math.abs(run(30).ratePerHour - recentRatePerHour) < 1e-9, 'weight stays 1 after recent_hours');
});
