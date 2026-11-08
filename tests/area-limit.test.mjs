// Issue #1054: open PRs per area limit, the overlap rule on real PR files and the area fallback, visible reasons.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig, applyLocalOverride } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { areaOfPath, areaFromLabels, primaryArea, areaLimitOf, AREA_LIMIT_DEFAULT, holdText } from '../supervisor/areas.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';
const config = (limits = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 1 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2, ...limits },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5, 6, 7] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const pr = (n, branch, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: H(n % 9 + 1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, body = '', labels = []) => ({ number: n, title: `Issue ${n} title here`, state: 'OPEN', body, labels });

function world(t, { limits, pulls = [], issues, files = {}, active = [] }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'area-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, listIssues: async () => issues, listMergedPulls: async () => [], listPullFiles: async n => files[n] || [] };
  const jobs = { listActive: async () => active, get: async () => null };
  const team = new Team({ config: config(limits), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1000 } });
  return team;
}
// three open Foreman PRs of other issues, all changing supervisor/ files
const three = () => [1, 2, 3].map(i => pr(1000 + i, `codex/issue-${200 + i}-x`));
const sup = { 1001: ['supervisor/a.mjs'], 1002: ['supervisor/b.mjs', 'tests/b.test.mjs'], 1003: ['supervisor/c.mjs'] };
const implementing = acts => acts.filter(a => a.type === 'implement').map(a => a.issue);

test('pure helpers: area of a path, label, majority, defaults', () => {
  assert.equal(areaOfPath('supervisor/team.mjs'), 'supervisor');
  assert.equal(areaOfPath('./docs/x.md'), 'docs');
  assert.equal(areaOfPath('README.md'), '(root)');
  assert.equal(areaFromLabels(['bug', 'area:Dashboard']), 'dashboard');
  assert.equal(areaFromLabels([{ name: 'area/docs' }]), 'docs');
  assert.equal(areaFromLabels(['areas:x', 'area:']), null);
  assert.equal(primaryArea(['tests/a', 'tests/b', 'docs/c']), 'tests');
  assert.equal(primaryArea(['b/x', 'a/y']), 'a');
  assert.equal(primaryArea([]), null);
  assert.equal(areaLimitOf({}), AREA_LIMIT_DEFAULT);
  assert.equal(AREA_LIMIT_DEFAULT, 3);
  assert.equal(holdText('supervisor', ['PR 1038', 'PR 1040', 'PR 1043']), 'held: 3 open PRs in supervisor (PR 1038, PR 1040, PR 1043)');
});

test('config: default applies with no setting, validated, overridable in team.local.json, shipped in team.json', () => {
  assert.equal(areaLimitOf(validateTeamConfig(config()).limits), 3);
  assert.equal(validateTeamConfig(config({ max_open_prs_per_area: 5 })).limits.max_open_prs_per_area, 5);
  for (const bad of [0, -1, 1.5, '3', 101, null]) assert.throws(() => validateTeamConfig(config({ max_open_prs_per_area: bad })), /max_open_prs_per_area/, String(bad));
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.equal(shipped.limits.max_open_prs_per_area, 3);
  assert.equal(applyLocalOverride(shipped, { limits: { max_open_prs_per_area: 2 } }).limits.max_open_prs_per_area, 2);
});

test('with 3 open PRs in supervisor a fourth implement in that area does not start; the reason names the PRs', async t => {
  const issues = [issue(5, 'Change supervisor/team.mjs'), issue(6, 'Update docs/guide.md')];
  const team = world(t, { pulls: three(), issues, files: sup });
  const acts = await team.plan();
  assert.deepEqual(implementing(acts), [6], JSON.stringify(acts));   // docs is under the limit; supervisor is not
  assert.match(team.held.claude.implement, /issue #5 held: 3 open PRs in supervisor \(PR 1001, PR 1002, PR 1003\)/);
});

test('the fourth starts once one of the three merges or closes', async t => {
  const issues = [issue(5, 'Change supervisor/team.mjs')];
  const team = world(t, { pulls: three().slice(0, 2), issues, files: sup });
  assert.deepEqual(implementing(await team.plan()), [5]);
});

test('the limit is configurable: 4 lets a fourth start, 2 stops a third', async t => {
  const issues = [issue(5, 'Change supervisor/team.mjs')];
  assert.deepEqual(implementing(await world(t, { limits: { max_open_prs_per_area: 4 }, pulls: three(), issues, files: sup }).plan()), [5]);
  assert.deepEqual(implementing(await world(t, { limits: { max_open_prs_per_area: 2 }, pulls: three().slice(0, 2), issues, files: sup }).plan()), []);
});

test('an area label overrides the path guess, for the issue and for a PR', async t => {
  const issues = [issue(5, 'Change supervisor/team.mjs', ['area:ui']), issue(6, 'x', []), ...[1, 2, 3].map(i => issue(200 + i, '', ['area:ui']))];
  const team = world(t, { pulls: three(), issues, files: sup });
  assert.deepEqual(implementing(await team.plan()), [6]);   // 5 is labelled ui, which holds 3 labelled PRs; 6 names no area, so it is not limited
  assert.match(team.held.claude.implement, /issue #5 held: 3 open PRs in ui/);
});

test('an issue with no determinable area is not limited', async t => {
  const team = world(t, { pulls: three(), issues: [issue(5, 'no paths at all')], files: sup });
  assert.deepEqual(implementing(await team.plan()), [5]);
});

test('a running implement job without a PR counts toward its area', async t => {
  const pulls = three().slice(0, 2);
  const issues = [issue(5, 'Change supervisor/x.mjs'), issue(6, 'Change supervisor/y.mjs'), ...[1, 2].map(i => issue(200 + i))];
  const t2 = world(t, { pulls, issues, files: sup, active: [{ id: 'run1', provider: 'claude', status: 'running' }] });
  t2.s.jobs.run1 = { kind: 'implement', issue: 6, agent: 'claude', key: '6', branch: 'claude/issue-6-y' };
  const acts = await t2.plan();
  assert.deepEqual(implementing(acts), []);
  assert.ok(acts.some(a => a.type === 'review'));   // the free slot goes to finishing work
  assert.match(t2.held.claude.implement, /3 open PRs in supervisor \(PR 1001, PR 1002, issue #6\)/);
});

test('two implement jobs in the same plan stay within the limit', async t => {
  const issues = [issue(5, 'Change supervisor/a.mjs'), issue(6, 'Change supervisor/b.mjs'), issue(7, 'Change supervisor/c.mjs')];
  const team = world(t, { pulls: three().slice(0, 1), issues, files: sup });
  // limit 3: one PR open; implementer slots 2 -> two start, but files differ so the area limit is what counts (1 + 2 = 3)
  assert.equal(implementing(await team.plan()).length, 2);
  const team2 = world(t, { pulls: three().slice(0, 2), issues, files: sup });
  assert.equal(implementing(await team2.plan()).length, 1);   // 2 open + 1 planned = 3, the second is held
});

test('overlap: a fix on an open PR uses its real changed files against another running job', async t => {
  // PR 1001 (issue 201) really changes supervisor/shared.mjs though its issue names nothing; issue 5 names that file.
  const pulls = [pr(1001, 'claude/issue-201-x', { mergeable: 'CONFLICTING' })];
  const issues = [issue(5, 'Change supervisor/shared.mjs'), issue(201, 'no paths')];
  const t1 = world(t, { pulls, issues, files: { 1001: ['supervisor/shared.mjs'] }, active: [{ id: 'r5', provider: 'claude', status: 'running' }] });
  t1.s.jobs.r5 = { kind: 'implement', issue: 5, agent: 'claude', key: '5', branch: 'claude/issue-5-a' };
  const acts = await t1.plan();
  assert.equal(acts.some(a => a.type === 'rebase'), false, JSON.stringify(acts));
  assert.match(t1.held.claude.rebase, /issue #201 waits: it is expected to edit supervisor\/shared\.mjs, which the running or planned job for issue #5 also edits/);
  // negative: same PR, but its real files do not overlap
  const t2 = world(t, { pulls, issues, files: { 1001: ['docs/other.md'] }, active: [{ id: 'r5', provider: 'claude', status: 'running' }] });
  t2.s.jobs.r5 = { kind: 'implement', issue: 5, agent: 'claude', key: '5', branch: 'claude/issue-5-a' };
  assert.equal((await t2.plan()).some(a => a.type === 'rebase'), true);
});

test('overlap: with no files named the area is the claim', async t => {
  const issues = [issue(5, '', ['area:supervisor']), issue(6, '', ['area:supervisor']), issue(7, '', ['area:docs'])];
  const team = world(t, { issues });
  const acts = await team.plan();
  assert.deepEqual(implementing(acts).sort(), [5, 7]);
  assert.match(team.held.claude.implement, /issue #6 waits: it is expected to edit supervisor\/, which the running or planned job for issue #5 also edits/);
});

test('prefer finishing: a full area sends the free implementer slot to review work', async t => {
  const pulls = [...three(), pr(900, 'codex/issue-300-y')];
  const issues = [issue(5, 'Change supervisor/team.mjs'), issue(300)];
  const acts = await world(t, { pulls, issues, files: { ...sup, 900: ['docs/z.md'] } }).plan();
  assert.equal(implementing(acts).length, 0);
  assert.ok(acts.some(a => a.type === 'review' && a.pr === 900), JSON.stringify(acts));
});

test('the dashboard shows open PRs per area and the limit', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'areav-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.chmodSync(dir, 0o700);
  const v = await buildView({ config: config(), root: dir, jobs: [], events: [], state: {}, register: REGISTER,
    cache: { tick: { at: 1, status: 'ok', error: null, lastOkAt: 1 }, pulls: three(), issues: [201, 202, 203].map(n => issue(n, `Change supervisor/f${n}.mjs`)) }, snapshots: [], now: 1_800_000_000_000 });
  assert.equal(v.areas.limit, 3);
  assert.deepEqual(v.areas.areas.map(a => [a.area, a.open, a.full]), [['supervisor', 3, true]]);
  assert.match(renderPage(v), /Open PRs per area[\s\S]*3 of 3/);
});

test('foreman_headline carries open PRs per area; absent view data gives null', async () => {
  const { createTools } = await import('../foreman-mcp/tools.mjs');
  const areas = { limit: 3, areas: [{ area: 'supervisor', open: 3, full: true, refs: ['PR 1001'] }] };
  const mk = view => createTools({ source: { get: async () => ({ view, ageMs: 0, stale: false }) }, readHost: () => ({}), now: () => 1_800_000_000_000 });
  const headline = { windows: { '24h': { cards: {} }, '7d': { cards: {} } } };
  const withAreas = JSON.parse((await mk({ headline, areas }).call('foreman_headline', {})).text);
  assert.deepEqual(withAreas.openPrsPerArea, areas);
  const without = JSON.parse((await mk({ headline }).call('foreman_headline', {})).text);
  assert.equal(without.openPrsPerArea, null);
});

// ---- fix round for the review of PR 1077 ----
import { compactIssues } from '../supervisor/dashdata.mjs';
import { codeAreas, rebaseReport } from '../supervisor/areas.mjs';

test('the dashboard plans from compacted issues (no body) and still shows the hold', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'areac-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.chmodSync(dir, 0o700);
  const raw = [...[201, 202, 203].map(n => issue(n, `Change supervisor/f${n}.mjs`)), issue(5, 'Change supervisor/team.mjs')];
  const cached = compactIssues(raw);
  assert.equal(cached.every(i => i.body === undefined), true);
  const v = await buildView({ config: config(), root: dir, jobs: [], events: [], state: {}, register: REGISTER,
    cache: { tick: { at: 1, status: 'ok', error: null, lastOkAt: 1 }, pulls: three(), issues: cached }, snapshots: [], now: 1_800_000_000_000 });
  assert.equal(JSON.stringify(v.plan).includes('"issue":5'), false, JSON.stringify(v.plan));
  assert.match(JSON.stringify(v), /issue #5 held: 3 open PRs in supervisor/);
});

test('bare file names choose no area and are matched by name for overlap', async t => {
  const issues = [issue(5, 'Refactor supervisor/team.mjs (team.mjs) and record it in AGENTS.md')];
  const team = world(t, { pulls: three(), issues, files: sup });
  assert.deepEqual(team.areasOfIssue(issues[0]), ['supervisor']);
  assert.deepEqual(implementing(await team.plan()), []);
  assert.deepEqual(world(t, { issues: [issue(6, 'edit team.mjs only')] }).areasOfIssue(issue(6, 'edit team.mjs only')), []);
  // a running implement for an issue naming only team.mjs blocks a rebase of a PR that really changes supervisor/team.mjs
  const pulls = [pr(1001, 'claude/issue-201-x', { mergeable: 'CONFLICTING' })];
  const t1 = world(t, { pulls, issues: [issue(5, 'edit team.mjs only'), issue(201, 'no paths')], files: { 1001: ['supervisor/team.mjs'] }, active: [{ id: 'r5', provider: 'claude', status: 'running' }] });
  t1.s.jobs.r5 = { kind: 'implement', issue: 5, agent: 'claude', key: '5', branch: 'claude/issue-5-a' };
  assert.equal((await t1.plan()).some(a => a.type === 'rebase'), false);
  assert.match(t1.held.claude.rebase, /waits/);
});

test('a PR counts in every code area it changes; tests/ and root files do not outvote the code', async t => {
  assert.deepEqual(codeAreas(['supervisor/a.mjs', 'tests/a.test.mjs', 'tests/b.test.mjs']), ['supervisor']);
  assert.deepEqual(codeAreas(['supervisor/a.mjs', 'docs/x.md']), ['docs', 'supervisor']);
  assert.deepEqual(codeAreas(['tests/a.test.mjs']), ['tests']);
  const files = { 1001: ['supervisor/a.mjs', 'tests/1.test.mjs', 'tests/2.test.mjs'], 1002: ['supervisor/b.mjs', 'tests/1.test.mjs', 'tests/2.test.mjs'], 1003: ['supervisor/c.mjs', 'tests/1.test.mjs', 'tests/2.test.mjs'] };
  const team = world(t, { pulls: three(), issues: [issue(5, 'Change supervisor/team.mjs')], files });
  assert.deepEqual(implementing(await team.plan()), []);
  assert.match(team.held.claude.implement, /held: 3 open PRs in supervisor/);
});

test('the week report: absent before day 7, then rebase jobs per merged PR against the baseline', () => {
  const day = 86400000, t0 = Date.parse('2026-11-08T00:00:00Z');
  const state = { mergeLog: [{ pr: 1, mergedAt: t0 + day }, { pr: 2, mergedAt: t0 + 2 * day }], jobs: { a: { kind: 'rebase', at: t0 + day }, b: { kind: 'rebase', at: t0 + day }, c: { kind: 'review', at: t0 + day }, d: { kind: 'rebase', at: t0 - day } } };
  assert.equal(rebaseReport(state, t0 + 6 * day), null);
  const r = rebaseReport(state, t0 + 7 * day);
  assert.equal(r.rebases, 2); assert.equal(r.merged, 2); assert.equal(r.perPullRequest, 1);
  assert.match(r.text, /baseline was 37 blocked rebase jobs/);
});
