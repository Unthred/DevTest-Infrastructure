#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Issue #1453: the summary cards on the real Overview, served by the
// dashboard's own request handler over a state holding the real example (First review approval 41.2%, Rejects 84). Reads the cards, clicks the real
// period control, then checks the page after the click, after a refresh in place and after a reload (drawn with the saved choice before the first
// paint), and that nothing is clipped or scrolls sideways. Writes <name>.json (and a screenshot) to /out.
// Issue #1468: at a desktop width it then enters the real layout editor over the saved free layout of the eight summary cards and measures that every card
// fills its grid place, that dragging the real resize handle and the real card moves and sizes it, and that the sizes survive a reload.
// Usage: node headline-cards-scenario.mjs --target fixture --profile <name> --name <stem> [--width <px>]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'headline-cards', out = arg('out') || '/out', width = Number(arg('width')) || null;
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const squash = s => String(s).replace(/\s+/g, ' ').trim();
try {
  const prof = width ? { ...PROFILES[profile], viewport: { ...PROFILES[profile].viewport, width } } : PROFILES[profile];
  const ctx = await browser.newContext({ ...prof, serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  // Records what the card's period was when the document was parsed and at the first frame: a flash would show 24h there.
  await ctx.addInitScript(() => {
    window.__period = {};
    const note = k => { const c = document.querySelector('#c-hl-first-pass'); if (c) window.__period[k] = c.dataset.period || null; };
    document.addEventListener('DOMContentLoaded', () => { note('parsed'); requestAnimationFrame(() => note('frame')); });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  let navigations = 0; page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++; });
  const card = id => page.locator(`#c-hl-${id}`);
  const shown = id => card(id).locator('.hl-block:visible');
  const read = async id => squash(await shown(id).innerText());
  const tone = id => shown(id).locator('.hl-badge').getAttribute('data-tone');

  await page.goto(url('/'), { waitUntil: 'networkidle' });
  const first = await read('first-pass');
  check('first review approval shows one period, Last 24 hours', await shown('first-pass').count() === 1 && /Last 24 hours/.test(first), first);
  check('first review approval shows 41.2% and Previous 34.1%', /41\.2%/.test(first) && /Previous 34\.1%/.test(first), first);
  check('first review approval has an up arrow and a green badge reading +7.1 pp and +20.8%', await shown('first-pass').locator('.hl-arrow[data-dir="up"]').count() === 1 && await tone('first-pass') === 'good' && /\+7\.1 pp \+20\.8%/.test(first), first);
  const colourOf = (loc, v) => loc.evaluate((e, name) => { const t = document.createElement('i'); t.style.color = `var(${name})`; document.body.append(t); const want = getComputedStyle(t).color; t.remove(); return getComputedStyle(e).color === want; }, v);
  check('the badge and arrow are really the existing green', await colourOf(shown('first-pass').locator('.hl-badge'), '--ok') && await colourOf(shown('first-pass').locator('.hl-arrow'), '--ok'));
  check('the detail and the best so far line are kept', /28 of 68 approved first time; 7 more rejected for the description only/.test(first) && /Best 24 hours 84\.9% \(45 of 53\), 6 to 7 Nov/.test(first), first);
  check('the main number still links to its items page', await shown('first-pass').locator('a.hl-v').getAttribute('href') === '/headline/first-pass?window=24h');
  const rejects = await read('rejects');
  check('rejects shows 84, a down arrow, a green badge reading -8 and -8.7%, Previous 92', /\b84\b/.test(rejects) && await shown('rejects').locator('.hl-arrow[data-dir="down"]').count() === 1 && await tone('rejects') === 'good' && /-8 -8\.7%/.test(rejects) && /Previous 92/.test(rejects), rejects);

  // ---- the period control
  const before = await read('first-pass');
  await card('first-pass').locator('[data-hl-period="7d"]').click();
  const after = await read('first-pass');
  check('clicking 7d shows the Last 7 days block only, with other figures', await shown('first-pass').count() === 1 && /Last 7 days/.test(after) && after !== before, after);
  check('the control marks the chosen period', await card('first-pass').locator('[data-hl-period="7d"]').getAttribute('aria-pressed') === 'true' && await card('first-pass').locator('[data-hl-period="24h"]').getAttribute('aria-pressed') === 'false');
  check('another card stays on Last 24 hours', /Last 24 hours/.test(await read('rejects')));
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('dash.period.overview.')).map(([, v]) => JSON.parse(v)));
  check('the choice is saved per card', saved.length === 1 && saved[0]['hl-first-pass'] === '7d' && !('hl-rejects' in saved[0]), JSON.stringify(saved));

  const navBefore = navigations;
  await page.locator('button.refresh-now').evaluate(b => b.click());
  await page.waitForTimeout(1500);
  check('a refresh in place keeps the chosen period and does not reload', navigations === navBefore && /Last 7 days/.test(await read('first-pass')) && await card('first-pass').locator('[data-hl-period="7d"]').getAttribute('aria-pressed') === 'true', await read('first-pass'));

  await page.reload({ waitUntil: 'networkidle' });
  const early = await page.evaluate(() => window.__period);
  check('after a reload the page is drawn with the saved period, before the first frame', early.parsed === '7d' && early.frame === '7d', JSON.stringify(early));
  check('after a reload the 7 days figures show', /Last 7 days/.test(await read('first-pass')) && /Last 24 hours/.test(await read('rejects')));

  await card('first-pass').locator('[data-hl-period="24h"]').click();
  check('switching back to 24 hours shows the first figures and forgets the saved choice', await read('first-pass') === before && await page.evaluate(() => Object.keys(localStorage).every(k => !k.startsWith('dash.period.'))));

  // ---- a card is as tall as its content and its text wraps
  const geo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card.headline')];
    return {
      over: document.documentElement.scrollWidth - innerWidth,
      clipped: cards.filter(c => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map(c => c.dataset.card),
      badgeClipped: [...document.querySelectorAll('.hl-block:not([style*="none"]) .hl-badge')].filter(b => b.offsetParent && b.scrollWidth > b.clientWidth + 1).length,
      // empty space under the content, past the card's own padding: none when the card is only as tall as what it holds
      tall: cards.filter(c => c.getBoundingClientRect().bottom - Math.max(...[...c.children].map(k => k.getBoundingClientRect().bottom)) > 40).map(c => c.dataset.card),
    };
  });
  check('no sideways scroll, no clipped card or badge, no card taller than its content needs', geo.over <= 0 && geo.clipped.length === 0 && geo.badgeClipped === 0 && geo.tall.length === 0, JSON.stringify(geo));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
  // ---- issue #1468: in the free layout every summary card fills its grid place (desktop widths only)
  if (page.viewportSize().width >= 1100) {
    await page.setViewportSize({ width: page.viewportSize().width, height: 1500 });
    const IDS = ['first-pass', 'rejects', 'merge-rate', 'processed', 'issues', 'waste', 'rounds', 'tokens'];
    const key = 'dash.layout.overview.desktop', ROWS = 10;
    const layout = pos => ({ v: 2, pos, hidden: [], collapsed: [] });
    const eight = Object.fromEntries(IDS.map((id, i) => [`hl-${id}`, { x: (i % 4) * 6, y: i < 4 ? 0 : ROWS, w: 6, h: ROWS }]));
    const put = async pos => { await page.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, JSON.stringify(v)); }, [key, layout(pos)]); await page.reload({ waitUntil: 'networkidle' }); };
    // Each card's rendered box next to the box of its grid place worked out from the saved numbers (24 columns, 12 px rows, 12 px gaps).
    const boxes = () => page.evaluate(() => {
      const g = document.querySelector('.cards[data-layout]'), gr = g.getBoundingClientRect(), colPitch = (gr.width + 12) / 24, out = {};
      for (const c of g.querySelectorAll(':scope > .card[data-card]')) {
        const s = getComputedStyle(c), n = v => Number(c.style.getPropertyValue(v)), r = c.getBoundingClientRect();
        out[c.dataset.card] = { x: r.left - gr.left, y: r.top - gr.top, w: r.width, h: r.height, special: /measuring|collapsed|expanded|lay-hidden/.test(c.className) || s.display === 'none',
          px: n('--cx') * colPitch, py: n('--cy') * 24, pw: n('--cw') * colPitch - 12, ph: n('--ch') * 24 - 12, ov: s.overflowY };
      }
      return out;
    });
    const off = b => Math.max(Math.abs(b.x - b.px), Math.abs(b.y - b.py), Math.abs(b.w - b.pw), Math.abs(b.h - b.ph));
    const fill = (b, ids) => ids.filter(id => off(b[`hl-${id}`]) > 1.5);
    await put(eight);
    let b = await boxes();
    check('free layout: every summary card is exactly as large as its place', fill(b, IDS).length === 0, JSON.stringify(fill(b, IDS).map(id => [id, b[`hl-${id}`]])));
    const hs = IDS.slice(0, 4).map(id => b[`hl-${id}`].h);
    check('free layout: the four cards of a row have the same rendered height', Math.max(...hs) - Math.min(...hs) < 1.5, hs.join(','));
    const everyCard = Object.entries(b).filter(([, v]) => !v.special && v.pw > 0 && v.ph > 0 && v.px === v.px).filter(([, v]) => off(v) > 1.5).map(([id]) => id);
    check('free layout: every card on the Overview fills its grid place', everyCard.length === 0, everyCard.join(','));

    await page.locator('.layoutbar [data-lay=edit]').click();
    const pitchY = 24, still = async ids => { const n = await boxes(); return ids.filter(id => ['x', 'y', 'w', 'h'].some(k => Math.abs(n[`hl-${id}`][k] - b[`hl-${id}`][k]) > 1.5)); };
    // resize: the real corner handle of Rejects, two rows taller
    await card('rejects').scrollIntoViewIfNeeded();
    let bb = await card('rejects').boundingBox();
    await page.mouse.move(bb.x + bb.width - 6, bb.y + bb.height - 6); await page.mouse.down(); await page.mouse.move(bb.x + bb.width - 6, bb.y + bb.height - 6 + 2 * pitchY, { steps: 8 }); await page.mouse.up();
    let n = await boxes();
    const grew = n['hl-rejects'].h - b['hl-rejects'].h;
    check('resize: dragging the corner of Rejects two rows taller grows its rendered height by two rows and their gaps', Math.abs(grew - 2 * pitchY) < 1.5, `grew ${grew}`);
    check('resize: the card still fills its place', off(n['hl-rejects']) < 1.5, JSON.stringify(n['hl-rejects']));
    const savedRows = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).pos['hl-rejects'].h, key);
    check('resize: the saved layout holds the new row count', savedRows === ROWS + 2, savedRows);
    await page.locator('.layoutbar [data-lay=done]').click();
    await page.reload({ waitUntil: 'networkidle' });
    n = await boxes();
    check('resize: after a reload Rejects is still that tall and fills its place', Math.abs(n['hl-rejects'].h - b['hl-rejects'].h - 2 * pitchY) < 1.5 && off(n['hl-rejects']) < 1.5, n['hl-rejects'].h);

    // shrinking: a place shorter than the content scrolls and never cuts the text off
    await put({ ...eight, 'hl-waste': { x: 6, y: ROWS, w: 6, h: 4 } });
    b = await boxes();
    const w = await card('waste').evaluate(c => ({ over: c.scrollHeight > c.clientHeight + 1, top: c.getBoundingClientRect().top, first: c.firstElementChild.getBoundingClientRect().top, scroll: getComputedStyle(c).overflowY }));
    check('short place: Wasted tokens is as tall as its place, scrolls and starts at its top', off(b['hl-waste']) < 1.5 && w.over && w.scroll === 'auto' && w.first >= w.top - 1, JSON.stringify(w));
    await card('waste').evaluate(c => { c.scrollTop = c.scrollHeight; });
    check('short place: the last line can be scrolled into view', await card('waste').evaluate(c => c.scrollTop + c.clientHeight >= c.scrollHeight - 1));
    // a place taller than the content centres it
    await put({ ...eight, 'hl-rejects': { x: 6, y: 0, w: 6, h: 30 } });
    const mid = await card('rejects').evaluate(c => { const r = c.getBoundingClientRect(), k = [...c.children].filter(e => e.offsetParent); const top = Math.min(...k.map(e => e.getBoundingClientRect().top)), bot = Math.max(...k.map(e => e.getBoundingClientRect().bottom)); return { above: top - r.top, below: r.bottom - bot }; });
    check('tall place: the content of Rejects is centred in the card', Math.abs(mid.above - mid.below) < 4 && mid.above > 20, JSON.stringify(mid));

    // moving: the real card, by its body, to under Wasted tokens
    await put(eight); b = await boxes();
    await page.locator('.layoutbar [data-lay=edit]').click();
    await card('rejects').scrollIntoViewIfNeeded();
    bb = await card('rejects').boundingBox();
    const sx = bb.x + bb.width / 2, sy = bb.y + bb.height / 2;
    await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 3, sy + 3);
    await page.mouse.move(sx, sy + 2 * ROWS * pitchY + 6, { steps: 10 }); await page.mouse.up();
    n = await boxes();
    const wasted = b['hl-waste'], moved = n['hl-rejects'];
    check('move: Rejects is exactly in the place under Wasted tokens', Math.abs(moved.x - wasted.x) < 1.5 && off(moved) < 1.5 && moved.y > wasted.y + wasted.h, JSON.stringify(moved));
    check('move: the other six cards keep their own places and sizes', (await still(IDS.filter(i => i !== 'rejects'))).length === 0, (await still(IDS.filter(i => i !== 'rejects'))).join(','));
    await page.locator('.layoutbar [data-lay=done]').click();

    // a saved zero row place falls back to the size the other cards fall back to
    await put({ ...eight, 'hl-rejects': { x: 6, y: 0, w: 6, h: 0 }, 'hl-waste': { x: 6, y: ROWS, w: 6, h: 0 } });
    n = await boxes();
    check('zero rows: a summary card with no rows draws at the fallback size, like another card', n['hl-rejects'].h > 40 && Math.abs(n['hl-rejects'].h - n['hl-waste'].h) < 1.5, `${n['hl-rejects'].h}`);
    // Regression guard for all card types: the layout the editor itself saves for every card of the Overview, then each card against its place.
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.layoutbar [data-lay=edit]').click();
    await page.locator('.layoutbar [data-lay=tidy]').click();
    await page.locator('.layoutbar [data-lay=done]').click();
    await page.reload({ waitUntil: 'networkidle' });
    n = await boxes();
    const placed = Object.entries(n).filter(([, v]) => !v.special && v.pw > 0 && v.ph > 0);
    check('every card of the Overview is placed in the free layout', placed.length >= 10 && placed.length === Object.keys(n).length, `${placed.length} of ${Object.keys(n).length}`);
    check('every card on the Overview fills its grid place (any card type)', placed.filter(([, v]) => off(v) > 1.5).length === 0, placed.filter(([, v]) => off(v) > 1.5).map(([id]) => id).join(','));
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
  }
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 600)); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
