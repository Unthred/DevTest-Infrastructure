// Issue #940: one shared card chrome, a roll-up summary, lists that scroll instead of growing the card, two-column reflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';

const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-01T21:30:00Z');
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] } } });
const view = () => buildView({ config: config(), root: '/nonexistent-root', jobs: [], events: [], state: { jobs: {} }, cache: { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, issues: [], pulls: [] }, snapshots: [], now: NOW });
const cardsOf = html => html.split(/<section class="card /).slice(1).map(x => x.slice(0, x.indexOf('</section>')));

test('every Overview card has the roll-up button; KPI tiles share the chrome', async () => {
  const html = renderPage(await view());
  const cards = cardsOf(html);
  assert.ok(cards.length >= 12);
  for (const c of cards) { assert.match(c, /<header>/); assert.match(c, /data-collapse/, c.slice(0, 80)); }
  assert.equal(cards.filter(c => c.startsWith('kpi')).length, 7);
  assert.doesNotMatch(html, /<a class="card kpi"/);
});

test('panel cards carry a roll-up summary line; charts carry none', async () => {
  const html = renderPage(await view());
  const sum = id => new RegExp(`data-card="${id}"[\\s\\S]*?<span class="card-summary" data-summary>([^<]*)</span>`).exec(html)?.[1];
  assert.equal(sum('needs'), 'nothing needs you');
  assert.equal(sum('warnings'), 'no warnings');
  assert.match(sum('next'), /nothing planned|planned/);
  assert.equal(sum('k-active'), '0 / 2');
  const chart = cardsOf(html).find(c => c.includes('data-card="c-jobs"'));
  assert.doesNotMatch(chart, /card-summary/);
});

test('the summary shows only while rolled up; lists scroll inside the card; wide list cards reflow to two columns', () => {
  assert.match(css, /\.card-summary\{display:none/);
  assert.match(css, /\.card\.collapsed>header \.card-summary\{display:block\}/);
  assert.match(css, /\.cards\.free \.dl-scroll\{max-height:none;flex:1 1 0;[^}]*overflow-y:auto\}/);
  assert.match(css, /\.card>\.panel-list\{max-height:[^;]+;overflow-y:auto/);
  assert.match(css, /\.card\{container:card\/inline-size\}/);
  assert.match(css, /@container card \(min-width:46rem\)\{\s*\.dl-scroll\{display:grid;grid-template-columns:repeat\(2,/);
  assert.doesNotMatch(css, /@container card \(max-width[^)]*\)\{[^}]*grid-template-columns:repeat\(2/, 'narrow cards stay single-column');
});
