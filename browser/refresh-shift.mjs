// Issue #431: measures what a periodic dashboard refresh does to the page, INSIDE the pinned Chromium container (Tower only).
// Usage: node /src/browser/refresh-shift.mjs --target fixture --path /overview.html
// It saves a card layout and expands a card, scrolls, waits for one refresh and reports: whether the document survived (a full
// reload loses a marker set on window), the largest movement of any card, whether the expanded card and the scroll position are kept,
// and whether the saved order was already applied at the first animation frame. Exit 0 = pass, 1 = fail, 2 = usage/launch.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed } from './capture.mjs';

export const MAX_SHIFT_PX = 2;   // a card may move by at most this many CSS pixels across a refresh

// Pure: judge the before/after measurements. Every failure names what broke.
export function judgeRefresh({ before, after, firstFrameOrder, savedOrder, limit = MAX_SHIFT_PX }) {
  const problems = [];
  if (!after.markerKept) problems.push('the document was reloaded (a full reload discards and redraws the page)');
  const shift = Math.max(0, ...before.cards.map(b => { const a = after.cards.find(c => c.id === b.id); return a ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)) : Infinity; }));
  if (shift > limit) problems.push(`a card moved or resized by ${shift}px (limit ${limit}px)`);
  if (after.cards.length !== before.cards.length) problems.push('a card appeared or vanished');
  if (!after.expandedKept) problems.push('the expanded card was collapsed by the refresh');
  if (Math.abs(after.scrollY - before.scrollY) > 1) problems.push(`the scroll position moved from ${before.scrollY} to ${after.scrollY}`);
  if (JSON.stringify(firstFrameOrder) !== JSON.stringify(savedOrder)) problems.push('the saved card order was not applied by the first animation frame');
  return { ok: problems.length === 0, shift, problems };
}

async function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const target = get('--target'), pagePath = get('--path') || '/';
  const sock = path.join('/targets', `${target}.sock`);
  if (!target || !fs.statSync(sock, { throwIfNoEntry: false })?.isSocket()) { console.error('refresh-shift: target socket not mounted'); return 2; }
  process.env.HOME = process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : '/tmp';
  const { port, server } = await bridge(sock);
  let browser;
  try {
    const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 600 }, serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'Europe/London' });
    await context.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
    const page = await context.newPage();
    const url = `http://127.0.0.1:${port}${pagePath}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    // Save a layout that reverses the grid order, then reload normally: it must be in place at the first animation frame.
    const ids = await page.$$eval('.cards[data-layout] > .card[data-card]', cs => cs.map(c => c.dataset.card));
    const page_ = await page.$eval('.cards[data-layout]', g => g.dataset.layout);
    const savedOrder = [...ids].reverse();
    await page.evaluate(([p, order]) => { for (const bp of ['desktop', 'tablet', 'phone']) localStorage.setItem(`dash.layout.${p}.${bp}`, JSON.stringify({ order })); }, [page_, savedOrder]);
    await page.addInitScript(() => { requestAnimationFrame(() => { window.__firstFrame = [...document.querySelectorAll('.cards[data-layout] > .card[data-card]')].map(c => c.dataset.card); }); });
    await page.goto(url, { waitUntil: 'networkidle' });
    const firstFrameOrder = await page.evaluate(() => window.__firstFrame || null);
    // Expand a card, scroll, mark the document, then wait for the page's own refresh (the fixture sets refresh-seconds=1).
    const measure = () => page.evaluate(() => ({
      markerKept: window.__marker === 431, scrollY: Math.round(scrollY),
      expandedKept: !!document.querySelector('.card.expanded'),
      cards: [...document.querySelectorAll('.card[data-card]')].map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.card, x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; }),
    }));
    await page.evaluate(() => { document.querySelector('[data-expand]')?.click(); window.scrollTo(0, 120); window.__marker = 431; });
    await page.waitForTimeout(300);
    const before = await measure();
    await page.waitForTimeout(2500);   // at least two refresh periods
    const after = await measure();
    const verdict = judgeRefresh({ before, after: { ...after, expandedKept: before.expandedKept ? after.expandedKept : true }, firstFrameOrder, savedOrder });
    console.log(JSON.stringify({ ...verdict, firstFrameOrder, savedOrder }));
    return verdict.ok ? 0 : 1;
  } catch (e) { console.error('refresh-shift: ' + String(e.message).slice(0, 300)); return 2; }
  finally { await browser?.close().catch(() => {}); server.close(); }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await main(process.argv.slice(2)));
