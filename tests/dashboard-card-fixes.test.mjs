// Issue #413: no second next-tick counter on the Next card, a running job's description once, no meaningless estimate range.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';
import { MAX_RANGE_SHARE, meaningfulRange } from '../supervisor/estimate.mjs';

const NOW = Date.parse('2026-11-01T08:00:00Z');
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] } } });
const job = { id: 'a'.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1 };
const make = jobs => buildView({ config: config(), root: '/nonexistent-root', jobs, events: [], state: { jobs: {} }, cache: { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, pulls: [], issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [] }] }, snapshots: [], now: NOW });
const card = (html, id) => { const i = html.indexOf(`data-card="${id}"`); return html.slice(i, html.indexOf('</section>', i)); };
const at = hhmm => Date.parse(`2026-11-01T${hhmm}:00Z`);
const est = (a, b) => ({ kind: 'issue', ref: 30, agent: 'claude', status: 'estimated', finish: { p50: at(a), p90: at(b) }, text: `est. ${a}–${b}`, waits: [], basis: ['b'] });
const withPlan = async e => {
  const v = await make([]);
  v.nextTick = { state: 'scheduled', at: NOW + 240000, lastAt: NOW - 60000 }; v.tz = 'UTC';
  v.panels.next = [{ agent: 'claude', type: 'implement', ref: 30 }];
  v.estimates = { waits: [], items: { 'issue:30': e } };
  return renderPage(v);
};

test('the Next card has no countdown; the app bar keeps its own', async () => {
  const v = await make([]); v.nextTick = { state: 'scheduled', at: NOW + 240000, lastAt: NOW - 60000 };
  const html = renderPage(v);
  assert.doesNotMatch(card(html, 'next'), /data-countdown/);
  assert.doesNotMatch(card(html, 'next'), /Next tick/);
  assert.match(html, /data-countdown="\d+"/);
});

test('no tick scheduled: the app bar message stays and the card adds none', async () => {
  const v = await make([]); v.nextTick = null; v.nextTickAt = null;
  const html = renderPage(v);
  assert.match(html, /<span class="muted">none<\/span>/);
  assert.doesNotMatch(card(html, 'next'), /No tick is scheduled/);
});

test('a running job card contains its description once, linked', async () => {
  const v = await make([job]);
  const name = v.agents[0].jobs[0].name, html = renderPage(v), c = card(html, 'now');
  assert.ok(name.length > 5);
  assert.equal(c.split(name.replace(/&/g, '&amp;')).length - 1, 1);
  assert.match(c, /<a href="\/work\/job\/aaaaaaaa"[^>]*>[^<]*Thirty<\/a>/);
});

test('a range as wide as 08:58-16:10 for the current tick is not shown; a narrow one is shown unchanged', async () => {
  const wide = await withPlan(est('08:58', '16:10'));
  assert.doesNotMatch(card(wide, 'next'), /est\./);
  assert.doesNotMatch(card(wide, 'next'), /unknown/i);
  const narrow = await withPlan(est('10:00', '10:40'));
  assert.match(card(narrow, 'next'), /est\. 10:00–10:40/);
});

test('meaningfulRange: limit is a share of the time from now to the midpoint', () => {
  assert.equal(MAX_RANGE_SHARE, 0.5);
  assert.equal(meaningfulRange(est('10:00', '10:40'), NOW), true);
  assert.equal(meaningfulRange(est('08:58', '16:10'), NOW), false);
  assert.equal(meaningfulRange({ finish: { p50: NOW + 1000, p90: NOW + 1000 } }, NOW), true);
});
