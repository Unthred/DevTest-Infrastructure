// Issue #213: one card per running job, counts of jobs and of available agents, cards agree with the role-slot lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';

const NOW = Date.parse('2026-11-01T21:30:00Z');
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const job = (id, over = {}) => ({ id: id.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, ...over });
const view = (jobs, state = { jobs: {} }) => buildView({ config: config(), root: '/nonexistent-root', jobs, events: [], state, cache: { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, pulls: [], issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [] }] }, snapshots: [], now: NOW });
const cards = html => (html.match(/data-job-card="/g) || []).length;
const kpi = (html, id) => new RegExp(`data-card="${id}"[^>]*><div class="v">([^<]*)</div>`).exec(html)?.[1];

test('two jobs on one agent give two cards, jobs 2 / 2 and one agent available', async () => {
  const jobs = [job('a'), job('b', { kind: 'review', issue: 31, branch: 'claude/issue-31-y', createdAt: NOW - 60000 })];
  const state = { jobs: { ['a'.repeat(32)]: { kind: 'implement', agent: 'claude', model: 'sonnet', issue: 30 }, ['b'.repeat(32)]: { kind: 'review', agent: 'claude', model: 'opus', pr: 198 } } };
  const v = await view(jobs, state), html = renderPage(v);
  assert.equal(v.agents[0].jobs.length, 2);
  assert.deepEqual(v.agents[0].jobs.map(j => j.role).sort(), ['implementer', 'reviewer']);
  assert.equal(cards(html), 2);
  assert.match(html, /Implementer/); assert.match(html, /Reviewer/); assert.match(html, /sonnet/); assert.match(html, /opus/);
  assert.equal(kpi(html, 'k-active'), '2 / 2'); assert.equal(kpi(html, 'k-avail'), '1 / 2');
  // the cards agree with the role-slot lines
  for (const slot of v.slots) assert.equal(slot.held.length, v.agents.flatMap(a => a.jobs).filter(j => j.role === slot.role).length);
});

test('one job on each of two agents: two cards, 2 / 2 jobs, no agent available', async () => {
  const jobs = [job('a'), job('c', { provider: 'codex', issue: 2, branch: 'codex/issue-2-z' })];
  const v = await view(jobs), html = renderPage(v);
  assert.equal(cards(html), 2); assert.equal(kpi(html, 'k-active'), '2 / 2'); assert.equal(kpi(html, 'k-avail'), '0 / 2');
});

test('no jobs: no job cards, an idle card per agent, 0 / 2 and both agents available', async () => {
  const v = await view([]), html = renderPage(v);
  assert.equal(cards(html), 0); assert.equal(kpi(html, 'k-active'), '0 / 2'); assert.equal(kpi(html, 'k-avail'), '2 / 2');
  assert.equal((html.match(/Idle: /g) || []).length >= 2, true);
  assert.deepEqual(v.agents.map(a => a.jobs), [[], []]);
});

test('a paused job gets a card but does not count as running', async () => {
  const v = await view([job('a', { status: 'paused_limit', lastEvent: 'usage_limit' })]), html = renderPage(v);
  assert.equal(cards(html), 1); assert.equal(kpi(html, 'k-active'), '0 / 2');
});
