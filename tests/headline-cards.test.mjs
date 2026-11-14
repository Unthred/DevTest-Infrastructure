// Issue #1453: the summary cards show one period, a coloured badge with the change and the previous value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headlineStats } from '../supervisor/headline.mjs';
import { isGood } from '../supervisor/headline-cards.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { sanitizePeriods, withPeriod } from '../supervisor/dashui/headline-period.mjs';
import { overviewView } from './helpers/lists-fixture.mjs';

const H = 3600000;
const NOW = Date.parse('2026-11-14T12:18:00Z');
const at = hours => NOW - hours * H;
const verdict = (v, t) => ({ verdict: v, at: t, reviewer: 'codex' });

// First review approval: 68 first reviews in the last 24 hours, 28 approved first time (41.2 percent), 7 more first rejected only for the
// description (an archived CHANGES, then a description round, then PASS); 44 the 24 hours before, 15 approved (34.1 percent).
function fixture() {
  const prs = [];
  const timeline = [];
  const jobs = [];
  const add = (n, hoursAgo, v) => prs.push({ number: n, title: `pr ${n}`, status: 'open', mergedAt: null, verdicts: [{ verdict: v, at: at(hoursAgo), reviewer: 'codex', head: 'abc1234' }], fixRounds: 0, rebaseRounds: 0 });
  for (let i = 0; i < 68; i += 1) add(1000 + i, 2 + (i % 20), i < 28 ? 'PASS' : 'CHANGES');
  for (let i = 28; i < 35; i += 1) {
    const pr = prs[i];
    pr.verdicts = [{ verdict: 'PASS', at: at(1), reviewer: 'codex', head: 'abc1234' }];
    timeline.push({ id: `verdict:${pr.number}`, at: at(2 + (i % 20)), kind: 'verdict', pr: pr.number, head: 'abc1234', verdict: 'CHANGES', reviewer: 'codex' });
    jobs.push({ id: String(i % 10).repeat(32), status: 'completed', kind: 'review', postcondition: { kind: 'description_edited', pr: pr.number, baseHead: 'abc1234def5678' } });
  }
  for (let i = 0; i < 44; i += 1) add(2000 + i, 26 + (i % 20), i < 15 ? 'PASS' : 'CHANGES');
  return { prs, jobs, timeline };
}
const page = async (headline, best = null) => {
  const view = await overviewView();
  view.headline = headline;
  view.best = best;
  return renderRoute(view, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
};
const cardOf = (html, id) => { const i = html.indexOf(`data-card="hl-${id}"`); return html.slice(i, html.indexOf('</section>', i)); };
const blockOf = (card, name) => { const i = card.indexOf(`data-window="${name}"`); return card.slice(i, card.indexOf('</div></div>', i) + 12); };
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// A headline whose cards come from stats with a hand-set value and previous value for one card and window.
function withCard(id, win, patch) {
  const h = headlineStats({ now: NOW });
  const c = h.windows[win].cards[id];
  const next = { ...c, ...patch };
  if (patch.value !== undefined) next.previous = { ...c.previous };
  if (patch.previousValue !== undefined) next.previous = { ...next.previous, value: patch.previousValue };
  if (patch.previousValue !== undefined || patch.value !== undefined) {
    next.delta = Number.isFinite(next.value) && Number.isFinite(next.previousValue) ? Math.round((next.value - next.previousValue) * 1000) / 1000 : null;
    next.direction = next.delta === null ? null : next.delta > 0 ? 'up' : next.delta < 0 ? 'down' : 'flat';
  }
  h.windows[win].cards[id] = next;
  return h;
}

test('valid: first review approval shows 41.2%, an up arrow, a green +7.1 pp and +20.8% badge, Previous 34.1%, the detail and the best line', async () => {
  const { prs, jobs, timeline } = fixture();
  const headline = headlineStats({ prs, jobs, timeline, now: NOW });
  const best = { records: { approval: { rate: 84.9, approved: 45, reviewed: 53, start: '2026-11-06T09:00:00Z', end: '2026-11-07T09:00:00Z' } }, distance: { approval: 0 } };
  const html = await page(headline, best);
  const block = blockOf(cardOf(html, 'first-pass'), '24h');
  assert.match(block, /class="hl-v"[^>]*>41\.2%</);
  assert.match(block, /data-dir="up"/);
  assert.match(block, /class="badge hl-badge sev-ok" data-tone="good"/);
  assert.match(text(block), /\+7\.1 pp \+20\.8%/);
  assert.match(text(block), /Previous 34\.1%/);
  assert.match(text(block), /28 of 68 approved first time; 7 more rejected for the description only/);
  assert.match(text(block), /Best 24 hours 84\.9% \(45 of 53\), 6 to 7 Nov/);
  assert.match(block, /href="\/headline\/first-pass\?window=24h"/);
  assert.match(cardOf(html, 'first-pass'), /data-hl-period="24h" aria-pressed="true"/);
});

test('valid: rejects 84 against a previous 92 shows a down arrow and a green -8 and -8.7% badge', async () => {
  const html = await page(withCard('rejects', '24h', { value: 84, previousValue: 92, changes: 84, blocked: 0 }));
  const block = blockOf(cardOf(html, 'rejects'), '24h');
  assert.match(block, /data-dir="down"/);
  assert.match(block, /data-tone="good"/);
  assert.match(text(block), /-8 -8\.7%/);
  assert.match(text(block), /Previous 92/);
});

test('colour comes from the fixed table, not the direction', () => {
  for (const id of ['first-pass', 'processed', 'merge-rate', 'throughput']) { assert.equal(isGood(id, 'up'), true); assert.equal(isGood(id, 'down'), false); }
  for (const id of ['rejects', 'waste', 'rounds', 'tokens', 'issues', 'cost']) { assert.equal(isGood(id, 'up'), false); assert.equal(isGood(id, 'down'), true); }
  assert.equal(isGood('rejects', 'flat'), null);
  assert.equal(isGood('rejects', null), null);
});

test('boundary: a lower first review approval is a red badge with a down arrow; more rejects is red', async () => {
  const worse = blockOf(cardOf(await page(withCard('first-pass', '24h', { value: 30, previousValue: 40 })), 'first-pass'), '24h');
  assert.match(worse, /data-tone="bad"/);
  assert.match(worse, /sev-action/);
  assert.match(text(worse), /-10 pp -25%/);
  const more = blockOf(cardOf(await page(withCard('rejects', '24h', { value: 100, previousValue: 92 })), 'rejects'), '24h');
  assert.match(more, /data-tone="bad"/);
  assert.match(text(more), /\+8 \+8\.7%/);
});

test('boundary: an unchanged value shows a neutral badge', async () => {
  const block = blockOf(cardOf(await page(withCard('rejects', '24h', { value: 5, previousValue: 5 })), 'rejects'), '24h');
  assert.match(block, /class="badge hl-badge" data-tone="neutral"/);
  assert.match(text(block), /no change/);
  assert.doesNotMatch(block, /sev-ok|sev-action/);
});

test('boundary: a previous value of zero shows the amount and no percentage', async () => {
  const block = blockOf(cardOf(await page(withCard('rejects', '24h', { value: 3, previousValue: 0 })), 'rejects'), '24h');
  assert.match(text(block), /\+3/);
  assert.doesNotMatch(block, /hl-pct/);
  assert.match(text(block), /Previous 0/);
});

test('boundary: the 7 days period of wasted usage has no previous period and says no earlier figure, with no colour', async () => {
  const headline = headlineStats({ now: NOW });
  const block = blockOf(cardOf(await page(headline), 'waste'), '7d');
  assert.match(block, /data-tone="none"/);
  assert.match(text(block), /no earlier figure/);
  assert.doesNotMatch(block, /sev-ok|sev-action/);
  assert.doesNotMatch(block, /Previous/);
});

test('boundary: the cost badge is in pounds and the throughput badge is per hour', async () => {
  const cost = blockOf(cardOf(await page(withCard('cost', '24h', { value: 4, previousValue: 5 })), 'cost'), '24h');
  assert.match(text(cost), /-£\d/);
  assert.match(text(cost), /-20%/);
  const rate = blockOf(cardOf(await page(withCard('merge-rate', '24h', { value: 1.5, previousValue: 1 })), 'merge-rate'), '24h');
  assert.match(text(rate), /\+0\.5 \+50%/);
});

test('invalid: a card with no data shows its no data wording and no badge, arrow or previous line', async () => {
  const block = blockOf(cardOf(await page(headlineStats({ now: NOW })), 'first-pass'), '24h');
  assert.match(text(block), /no data/);
  assert.match(text(block), /no first reviews/);
  assert.doesNotMatch(block, /hl-badge|hl-arrow|Previous/);
});

test('invalid: text from the data containing angle brackets is shown as text', async () => {
  const headline = withCard('waste', '24h', { value: 10, previousValue: 5, topCause: { cause: '<script>alert(1)</script>', tokens: 10 } });
  const html = await page(headline);
  const block = blockOf(cardOf(html, 'waste'), '24h');
  assert.doesNotMatch(block, /<script>alert/);
  assert.match(block, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('one period per card: both blocks are drawn, the control offers both, 24 hours is the default and the old two-block rows are gone', async () => {
  const html = await page(headlineStats({ now: NOW }));
  const card = cardOf(html, 'rounds');
  assert.match(card, /data-window="24h"/);
  assert.match(card, /data-window="7d"/);
  assert.match(card, /data-hl-period="24h" aria-pressed="true"/);
  assert.match(card, /data-hl-period="7d" aria-pressed="false"/);
  assert.match(card, /Last 24 hours/);
  assert.match(card, /Last 7 days/);
  assert.doesNotMatch(html, /hl-row/);
  const css = readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.headline\[data-period="7d"\] \.hl-block\[data-window="24h"\]\{display:none\}/);
});

test('the saved period: sanitised, written without the default', () => {
  assert.deepEqual(sanitizePeriods({ 'hl-rounds': '7d', 'hl-tokens': 'bad', gone: '7d' }, ['hl-rounds', 'hl-tokens']), { 'hl-rounds': '7d' });
  assert.deepEqual(sanitizePeriods(null, ['hl-rounds']), {});
  assert.deepEqual(sanitizePeriods(['7d'], ['0']), {});
  assert.deepEqual(withPeriod({ 'hl-tokens': '7d' }, 'hl-rounds', '7d'), { 'hl-tokens': '7d', 'hl-rounds': '7d' });
  assert.deepEqual(withPeriod({ 'hl-rounds': '7d' }, 'hl-rounds', '24h'), {});
  assert.deepEqual(withPeriod(null, 'hl-rounds', '24h'), {});
});

test('the early layout script applies a saved period before the first paint, and only a known one', () => {
  const early = readFileSync(new URL('../supervisor/dashui/layout-early.js', import.meta.url), 'utf8');
  assert.match(early, /'dash\.period\.'/);
  assert.match(early, /setAttribute\('data-period', saved\[id\]\)/);
  assert.match(early, /saved\[id\] === '24h' \|\| saved\[id\] === '7d'/);
});
