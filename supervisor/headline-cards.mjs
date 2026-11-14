import { formatCost } from './money.mjs';
import { CARD_IDS, CARD_TITLES, WINDOWS } from './headline.mjs';
import { bestLine } from './dashbest.mjs';
// Issue #1453: the summary cards at the top of the Overview, one period per card. The markup and the wording live here; dashrender.mjs
// only calls headlineCards() and passes in its own page pieces (the card shell, the icon, the escaper), so this module has no import of it.
// Both periods are in the markup and CSS shows the chosen one (data-period on the card); the choice itself is the browser's
// (dashui/headline-period.mjs), so a refresh in place can swap the figures without losing it.

const fin = Number.isFinite;
const DEFAULT_PERIOD = '24h';
const PERIOD_LABEL = { '24h': 'Last 24 hours', '7d': 'Last 7 days' };
const PERIOD_UNIT = { '24h': '24 hours', '7d': '7 days' };
const num = n => (fin(n) ? n.toLocaleString('en-GB') : 'unknown');
const dec1 = n => (fin(n) ? (Math.round(n * 10) / 10).toLocaleString('en-GB') : '–');
const dec2 = n => (fin(n) ? (Math.round(n * 100) / 100).toLocaleString('en-GB') : '–');
const pctText = n => (fin(n) ? `${dec1(n)}%` : 'no data');
const signed = n => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

// The main number and the detail line of each card, from one period's figures (a card's previous period has the same fields).
export const HEADLINE = {
  issues: c => ({ big: `net ${signed(c.net)}`, sub: `${c.opened} opened, ${c.closed} closed` }),
  processed: c => ({ big: pctText(c.value), sub: `${c.processed} closed of ${c.total} in play` }),
  throughput: c => ({ big: fin(c.openedPerHour) ? `${dec1(c.openedPerHour)} PRs opened/h` : 'no data', sub: `${dec1(c.mergedPerHour)} merged/h, ${dec1(c.implementedPerHour)} issues implemented/h (${c.opened} opened, ${c.merged} merged, ${c.implemented} implemented)` }),
  cost: c => ({ big: formatCost(c.value, { unknown: 'unknown' }), sub: `per merged issue, from implement through merge incl. review, fix and rebase rounds; ${c.withKnownCost} of ${c.merged} merged with known cost; usage equivalent, not a cash charge` }),
  'merge-rate': c => ({ big: fin(c.value) ? `${dec1(Math.round(c.value * 100) / 100)}/h` : 'no data', sub: `${c.merged} merged` }),
  'first-pass': c => ({ big: pctText(c.value), sub: c.reviewed ? `${c.approved} of ${c.reviewed} approved first time${c.descriptionOnlyRejected ? `; ${c.descriptionOnlyRejected} more rejected for the description only` : ''}` : 'no first reviews' }),
  rounds: c => ({ big: fin(c.value) ? dec1(c.value) : 'no data', sub: `${c.merged} merged (review, fix and rebase rounds)` }),
  tokens: c => ({ big: fin(c.value) ? num(c.value) : 'unknown', sub: `${c.withKnownTokens} of ${c.merged} merged with known usage; usage equivalent, not a cash charge` }),
  waste: c => ({ big: num(c.value), sub: c.topCause ? `top cause: ${c.topCause.cause} (${num(c.topCause.tokens)})` : 'no wasted jobs' }),
  rejects: c => ({ big: String(c.value), sub: `${c.changes} CHANGES, ${c.blocked} blocked` }),
};

export const trendText = (c, name) => (c.direction === null ? (c.previousNote ? 'no previous period to compare' : `no previous ${name} figure`) : c.direction === 'flat' ? `unchanged from the previous ${name}` : `${c.direction} ${num(Math.abs(c.delta))} from the previous ${name}`);

// Which way is good, per card. Fixed here, never taken from the direction of the move.
const LOWER_IS_BETTER = new Set(['rejects', 'waste', 'rounds', 'tokens', 'cost', 'issues']);
export const isGood = (id, direction) => (direction === 'up' || direction === 'down' ? (direction === 'up') !== LOWER_IS_BETTER.has(id) : null);

// The amount of the change, in the unit of the card's own figure; percentage cards move in percentage points.
function amountText(id, c) {
  const size = Math.abs(c.delta);
  const sign = c.delta > 0 ? '+' : c.delta < 0 ? '-' : '';
  if (c.unit === '%') return `${sign}${dec1(size)} pp`;
  if (c.unit === 'USD equivalent') return `${sign}${formatCost(size)}`;
  if (c.unit === 'per hour') return `${sign}${dec2(size)}`;
  if (c.unit === 'rounds') return `${sign}${dec1(size)}`;
  return `${sign}${num(size)}`;
}
// The change as a share of the previous value; null when that value is zero.
function percentText(c) {
  if (!fin(c.previousValue) || c.previousValue === 0) return null;
  const share = Math.round(c.delta / Math.abs(c.previousValue) * 1000) / 10;
  return `${share > 0 ? '+' : share < 0 ? '-' : ''}${dec1(Math.abs(share))}%`;
}

const arrowName = direction => (direction === 'up' ? 'up' : direction === 'down' ? 'down' : 'sort');
const toneOf = (id, direction) => { const good = isGood(id, direction); return good === null ? 'neutral' : good ? 'good' : 'bad'; };
const BADGE_CLASS = { good: ' sev-ok', bad: ' sev-action', neutral: '', none: '' };

function badge(id, c, esc) {
  if (c.direction === null) return '<span class="badge hl-badge" data-tone="none">no earlier figure</span>';
  const tone = toneOf(id, c.direction);
  const share = percentText(c);
  const body = c.direction === 'flat' ? '<span class="hl-amt">no change</span>' : `<span class="hl-amt">${esc(amountText(id, c))}</span>${share ? ` <span class="hl-pct">${esc(share)}</span>` : ''}`;
  return `<span class="badge hl-badge${BADGE_CLASS[tone]}" data-tone="${tone}">${body}</span>`;
}

function periodBlock(id, name, view, deps) {
  const { esc, icon } = deps;
  const c = view.headline.windows[name].cards[id];
  const t = HEADLINE[id](c);
  const hasData = fin(c.value) && (id !== 'throughput' || fin(c.openedPerHour));
  const tone = hasData ? toneOf(id, c.direction) : 'none';
  const arrow = hasData ? `<span class="hl-arrow" data-tone="${tone}" data-dir="${esc(c.direction || '')}">${icon(arrowName(c.direction))}</span>` : '';
  const previous = hasData && fin(c.previousValue) && c.previous ? `<div class="hl-prev sub">Previous <b>${esc(HEADLINE[id](c.previous).big)}</b></div>` : '';
  const best = name === DEFAULT_PERIOD ? bestLine(id, view.best, view.tz) : '';
  return `<div class="hl-block" data-window="${esc(name)}"><span class="hl-chip">${esc(PERIOD_LABEL[name])}</span>
    <div class="hl-main"><a class="hl-v" href="${esc(`/headline/${id}?window=${name}`)}">${esc(t.big)}</a>${arrow}</div>
    ${hasData ? badge(id, c, esc) : ''}${previous}<hr class="hl-rule"><div class="sub hl-detail">${esc(t.sub)}</div>${best}</div>`;
}

const periodControl = (title, esc) => `<span class="hl-pick" role="group" aria-label="Period for ${esc(title)}">${Object.keys(WINDOWS).map(name => `<button type="button" class="tbtn hl-pickbtn" data-hl-period="${esc(name)}" aria-pressed="${name === DEFAULT_PERIOD}" title="${esc(PERIOD_LABEL[name])}">${esc(name)}</button>`).join('')}</span>`;

// deps: { card, icon, esc } from the page renderer.
export function headlineCards(view, deps) {
  const h = view.headline;
  if (!h) return '';
  const { card, esc } = deps;
  return CARD_IDS.map(id => {
    const blocks = Object.keys(WINDOWS).map(name => periodBlock(id, name, view, deps)).join('');
    const extra = id === 'issues' ? `<p class="sub">${h.openNow} open now</p>` : '';
    return card({ id: `hl-${id}`, title: CARD_TITLES[id], span: 3, href: `/headline/${id}`, tools: periodControl(CARD_TITLES[id], esc), cls: 'panel headline', type: 'panel', body: blocks + extra });
  }).join('');
}
export { PERIOD_UNIT };
