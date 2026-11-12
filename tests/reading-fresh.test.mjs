// Issue #1163: allowance readings show their age, source and limit kind; a refresh is owed before admission when the reading is stale or the
// agent is near its reserve; a stale reading renders as stale in the budget output, the MCP tool and the Usage page. No provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { assessAgent, admits, DEFAULT_BUDGET, HOUR, validateBudgetConfig } from '../supervisor/budget.mjs';
import { probeDue, MINUTE } from '../supervisor/probe.mjs';
import { limitKind, readingInfo, refreshDue } from '../supervisor/readingfresh.mjs';
import { budgetView } from '../supervisor/budgetview.mjs';
import { readingBrief, budgetBrief } from '../foreman-mcp/budgetfigures.mjs';
import { readingLine } from '../supervisor/readingcard.mjs';

const RESET = Date.parse('2026-11-12T04:00:00Z');
const NOW = RESET - 3.5 * 24 * HOUR;
const S = DEFAULT_BUDGET;
const al = (weekly, { ageMin = 5, source, extra = [] } = {}) => ({ provider: 'claude', status: 'allowed', observedAt: NOW - ageMin * MINUTE, ...(source ? { source } : {}),
  windows: [{ type: 'seven_day', utilization: weekly, resetsAt: RESET, status: 'allowed' }, ...extra], billing: { overageStatus: 'rejected', usingOverage: false } });
const fiveHour = u => ({ type: 'five_hour', utilization: u, resetsAt: NOW + 2 * HOUR, status: 'allowed' });

test('limit kinds: 5 hour session, weekly all models, weekly for one model', () => {
  assert.equal(limitKind({ type: 'five_hour' }).kind, 'session_5h');
  assert.equal(limitKind({ type: 'seven_day' }).label, 'weekly, all models');
  assert.deepEqual(limitKind({ type: 'seven_day_sonnet' }), { kind: 'weekly_model', label: 'weekly, sonnet only', detail: 'sonnet only' });
  assert.equal(limitKind({ type: 'secondary', windowMinutes: 10080 }).kind, 'weekly_all');
});

test('readingInfo: time, age, source and limit kind; stale at the configurable age, never current without a time', () => {
  const r = readingInfo(al(0.5, { ageMin: 30, source: 'probe', extra: [fiveHour(0.2)] }), NOW, S);
  assert.equal(r.observedAt, NOW - 30 * MINUTE); assert.equal(r.ageMinutes, 30); assert.equal(r.source, 'probe'); assert.equal(r.stale, false);
  assert.deepEqual(r.limits.map(l => l.kind), ['weekly_all', 'session_5h']); assert.equal(r.sessionTracked, true);
  assert.equal(readingInfo(al(0.5, { ageMin: 61 }), NOW, S).stale, true, 'older than the default 60 minutes');
  assert.equal(readingInfo(al(0.5, { ageMin: 61 }), NOW, { ...S, reading_max_age_minutes: 120 }).stale, false, 'the age limit is configurable');
  const none = readingInfo({ ...al(0.5), observedAt: undefined }, NOW, S);
  assert.equal(none.stale, true); assert.equal(none.ageMinutes, null);
  assert.equal(readingInfo(al(0.5), NOW, S).sessionTracked, false, 'a provider that reports no 5 hour window says so');
});

test('refreshDue: stale reading, or near the reserve; none when fresh and above the reserve', () => {
  const below = { basis: 'absolute', belowReserve: true }, above = { basis: 'absolute', belowReserve: false };
  assert.deepEqual(refreshDue({ allowance: al(0.5, { ageMin: 120 }), capacity: above, used: 0.5, now: NOW, settings: S }), { reason: 'stale' });
  assert.equal(refreshDue({ allowance: al(0.5, { ageMin: 10 }), capacity: above, used: 0.5, now: NOW, settings: S }), null);
  assert.deepEqual(refreshDue({ allowance: al(0.97, { ageMin: 10 }), capacity: below, used: 0.97, now: NOW, settings: S }), { reason: 'reserve' });
  assert.equal(refreshDue({ allowance: al(0.97, { ageMin: 1 }), capacity: below, used: 0.97, now: NOW, settings: S }), null, 'a reading taken a minute ago is not repeated');
  assert.deepEqual(refreshDue({ allowance: al(0.9, { ageMin: 10 }), capacity: { basis: 'percent' }, used: 0.9, now: NOW, settings: S }), { reason: 'reserve' }, 'no capacity known: the high-water share stands in');
  assert.deepEqual(refreshDue({ allowance: null, now: NOW, settings: S }), { reason: 'stale' });
});

test('probeDue: a normal agent is probed only when a refresh is owed, once per interval, never in a used-up window', () => {
  const stale = al(0.5, { ageMin: 120 });
  const owed = refreshDue({ allowance: stale, now: NOW, settings: S });
  assert.equal(probeDue({ mode: 'normal', allowance: stale, settings: S, now: NOW }), null, 'no demand: no probe (no polling)');
  assert.equal(probeDue({ mode: 'normal', allowance: stale, settings: S, now: NOW, owed })?.reason, 'stale');
  assert.equal(probeDue({ mode: 'normal', allowance: stale, settings: S, now: NOW, owed, state: { at: NOW - 10 * MINUTE } }), null, 'one attempt per interval');
  assert.equal(probeDue({ mode: 'normal', allowance: al(0.5, { ageMin: 10 }), settings: S, now: NOW, owed: null }), null, 'fresh and above the reserve: no probe');
  const full = al(0.999, { ageMin: 120 });
  assert.equal(probeDue({ mode: 'normal', allowance: full, settings: S, now: NOW, owed: { reason: 'stale' } }), null, 'a used-up window is out until it resets (D-019)');
});

// ---- Team.probesDue through the real planner inputs
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
function team(t, allowance) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW, now: () => clock.t };
  const gh = { listPulls: async () => [], listIssues: async () => [], listMergedPulls: async () => [] };
  const tm = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [] }, git: {}, register: '', clock, usage: { allowance: { claude: allowance }, jobs: [], snapshots: [] }, timeZone: 'Europe/London', alert: async () => {} });
  return { tm, clock };
}
test('team: a normal agent with a 2 hour old reading gets one probe before the next admission; none when fresh', t => {
  const old = team(t, al(0.5, { ageMin: 120 }));
  assert.deepEqual(old.tm.probesDue(() => true, { pulls: [], issues: [] }), [], 'no work waiting: no probe');
  const due = old.tm.probesDue(() => true, { issues: [{}] });
  assert.deepEqual(due.map(d => [d.agent, d.reason]), [['claude', 'stale']]);
  old.tm.noteProbe('claude', due[0]);
  assert.deepEqual(old.tm.probesDue(() => true, { issues: [{}] }), [], 'one probe, not a second inside the interval');
  assert.deepEqual(team(t, al(0.5, { ageMin: 10 })).tm.probesDue(() => true, { issues: [{}] }), [], 'fresh and above the reserve: no probe');
});

test('a probe result above the exhausted threshold blocks the job that triggered the probe', () => {
  const probed = al(0.997, { ageMin: 0, source: 'probe' });
  const a = assessAgent({ allowance: probed, now: NOW, settings: S });
  assert.equal(a.mode, 'waiting');
  assert.equal(admits(a, 'review').ok, false);
  assert.equal(admits(assessAgent({ allowance: al(0.5), now: NOW, settings: S }), 'review').ok, true);
});

test('5 hour session: a probe reading with the session window used up holds admission the same way', () => {
  const a = assessAgent({ allowance: al(0.5, { extra: [fiveHour(0.998)] }), now: NOW, settings: S });
  assert.equal(a.mode, 'waiting'); assert.match(a.reason, /short window 100%/); assert.equal(a.shortWindow.used, 0.998);
  assert.equal(admits(a, 'implement').ok, false);
});

test('config: reading_max_age_minutes is accepted and range-checked', () => {
  assert.doesNotThrow(() => validateBudgetConfig({ reading_max_age_minutes: 90 }, ['claude']));
  assert.throws(() => validateBudgetConfig({ reading_max_age_minutes: 1 }, ['claude']), /reading_max_age_minutes/);
});

// ---- the budget output (dashboard view and MCP) and the Usage page
test('budget output and MCP brief carry time, age, source and limit kind, and say stale for a stale reading', () => {
  const modes = { claude: assessAgent({ allowance: al(0.5, { ageMin: 180, source: 'probe', extra: [fiveHour(0.2)] }), now: NOW, settings: S }) };
  const view = budgetView({ modes });
  assert.equal(view.claude.reading.stale, true); assert.equal(view.claude.reading.ageMinutes, 180); assert.equal(view.claude.reading.source, 'probe');
  const brief = readingBrief(view.claude.reading);
  assert.equal(brief.stale, true); assert.match(brief.status, /^STALE: last reading 180 minutes ago/); assert.equal(brief.observedAt, new Date(NOW - 180 * MINUTE).toISOString());
  assert.deepEqual(brief.limits.map(l => l.label), ['weekly, all models', '5 hour session']); assert.equal(brief.sessionLimit, 'tracked');
  const fresh = readingBrief(budgetView({ modes: { claude: assessAgent({ allowance: al(0.5, { ageMin: 5 }), now: NOW, settings: S }) } }).claude.reading);
  assert.equal(fresh.stale, false); assert.match(fresh.status, /^current/); assert.equal(fresh.sessionLimit, 'not reported by the provider');
  assert.equal(budgetBrief(view).claude.readingStale, true);
});

test('Usage page fragment: stale reading renders as stale, a fresh one does not; the 5 hour note shows when untracked', () => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const h = { esc, badge: (l, text) => `<b class="${l}">${esc(text)}</b>`, dur: ms => `${Math.floor(ms / 60000)}m` };
  const stale = readingLine(h, { kinds: ['weekly, all models'], windows: [1], observedAt: NOW - 120 * MINUTE, stale: true, maxAgeMinutes: 60, sessionTracked: false }, NOW);
  assert.match(stale, /data-stale="true"/); assert.match(stale, /Stale/); assert.match(stale, /not current/); assert.match(stale, /Limits in this reading: weekly, all models/); assert.match(stale, /5 hour session limit/);
  const ok = readingLine(h, { windows: [1], observedAt: NOW - 5 * MINUTE, stale: false, maxAgeMinutes: 60, sessionTracked: true }, NOW);
  assert.match(ok, /data-stale="false"/); assert.doesNotMatch(ok, /Stale/); assert.match(ok, /5m old/);
});

// ---- the real page: buildView + renderPage over a job record, as the Usage page is served
import { buildView } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';
const id = c => c.repeat(32);
async function usageHtml(t, ageMin) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rfp-')); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = { id: id('a'), provider: 'claude', kind: 'review', issue: 1, status: 'completed', lastEvent: 'completed', createdAt: NOW - 4 * HOUR, updatedAt: NOW - ageMin * MINUTE, allowance: al(0.97, { ageMin }) };
  const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls: [], issues: [], probes: {} };
  const v = await buildView({ config: { ...cfg, agents: { claude: cfg.agents.claude } }, root, jobs: [job], events: [], state: {}, cache, snapshots: [], now: NOW });
  return renderPage(v, { route: { page: 'usage' } });
}
test('the served Usage page shows the stale marker for a 3 hour old reading and the limit kind; not for a fresh one', async t => {
  const old = await usageHtml(t, 180), fresh = await usageHtml(t, 5);
  assert.match(old, /data-stale="true"/); assert.match(old, /Last reading 3h 0m ago/); assert.match(old, /Limits in this reading: weekly, all models\./);
  assert.match(fresh, /data-stale="false"/); assert.doesNotMatch(fresh, /data-stale="true"/);
});
