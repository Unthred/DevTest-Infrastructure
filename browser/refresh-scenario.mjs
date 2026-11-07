#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Issue #930: the dashboard refreshes in
// place. The page is the real Overview with the real dashui scripts; the periodic fetch of the page's own address is answered with changed
// versions of the page (the staged /b.html), so the script's fetch, DOMParser and swap run in real Chromium. A viewer scrolls the page and
// two lists, opens details, searches and types; several refreshes with changed data must leave all of it where it was, and the changed
// values must show. Writes <name>.json (and a screenshot) to /out.
// Usage: node refresh-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'refresh', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => { checks.push({ name: n, ok: !!ok, detail: String(detail) }); };
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  const bHtml = await (await ctx.request.get(url('/b.html'))).text();
  // What the page's own periodic fetch of /a.html receives: 'same' (unchanged), a changed version by value, or a server error.
  const served = { mode: 'same', fetches: 0 };
  await ctx.route('**/*', async r => {
    const req = r.request();
    if (!isAllowed(req.url(), port)) return r.abort('blockedbyclient');
    if (req.resourceType() === 'fetch' && new URL(req.url()).pathname === '/a.html') {
      served.fetches++;
      if (served.mode === 'fail') return r.fulfill({ status: 500, contentType: 'text/plain', body: 'down' });
      if (served.mode === 'same') return r.continue();
      return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bHtml.replaceAll('VALUE-B', served.mode) });
    }
    return r.continue();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  let navigations = 0; page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++; });
  await page.goto(url('/a.html'), { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__same = 'still here'; });
  const startNav = navigations;
  // the Refresh button is at the top of the page; a script click keeps the scroll where the viewer left it (a real click needs it on screen)
  const clickRefresh = () => page.locator('button.refresh-now').evaluate(b => b.click());
  const N = page.locator('[data-dlist="needs"]'), nul = N.locator('> .dl-scroll'), W = page.locator('[data-dlist="watching"]'), wul = W.locator('> .dl-scroll');
  const X = page.locator('#c-c-jobs');

  // ---- the viewer's place
  await N.locator('.dl-q').fill('item 1');
  await nul.evaluate(e => { e.scrollTop = 300; });
  await wul.locator('> li').nth(1).locator('li.wstep details').nth(1).locator('summary').click();
  await X.locator('.x-scroll').evaluate(e => { e.scrollTop = 120; });
  await X.locator('details.x-d summary').click();
  await page.evaluate(() => { const r = document.querySelector('#c-c-jobs .x-q').getBoundingClientRect(); scrollTo(0, Math.max(150, scrollY + r.top - 200)); });   // the typing field is on screen: typing into an off-screen field makes the browser scroll to it
  await X.locator('.x-q').evaluate(e => e.focus({ preventScroll: true })); await page.keyboard.type('ab', { delay: 40 });   // the caret scrolls a field into view, so type once before measuring
  await page.evaluate(() => document.activeElement.blur());
  await sleep(500);
  const mark = async () => ({
    y: await page.evaluate(() => scrollY), list: await nul.evaluate(e => e.scrollTop), q: await N.locator('.dl-q').inputValue(),
    steps: await wul.evaluate(e => [...e.querySelectorAll('details[open]')].map(d => `${d.closest('.dl-scroll > li')?.dataset.key}|${d.closest('[data-step]')?.dataset.step}`)),
    inner: await X.locator('.x-scroll').evaluate(e => e.scrollTop), open: await X.locator('details.x-d').evaluate(d => d.open), typed: await X.locator('.x-q').inputValue()
  });
  const trace = []; const yy = async l => trace.push(`${l}=${await page.evaluate(() => scrollY)}`);
  const before = await mark(); await yy('before');
  check('set-up: the page, the list, a nested scroller are scrolled, a row and a details are open', before.y > 100 && before.list > 50 && before.inner > 50 && before.open && before.steps.length === 1 && before.q === 'item 1', JSON.stringify(before));
  const value = () => X.locator('.x-val').textContent();
  const footer = () => N.locator('[data-dl-foot]').textContent();
  const labelAt = () => page.locator('[data-refresh-at]').textContent();
  check('the indicator shows the last update time', /^Updated \d\d:\d\d:\d\d$/.test(await labelAt()), await labelAt());
  check('the manual refresh control exists and is a labelled button', (await page.locator('button.refresh-now[aria-label="Refresh now"]').count()) === 1);

  // ---- 1. unchanged data: a refresh touches nothing (the very nodes stay)
  await page.evaluate(() => { for (const c of document.querySelectorAll('.card')) c.__node = true; document.querySelector('#c-c-jobs .x-val').__node = true; });
  await clickRefresh(); await sleep(800);
  check('unchanged data swaps no card at all', await page.evaluate(() => document.querySelector('#c-c-jobs .x-val').__node === true));

  // ---- 2. typing holds the update; it applies straight after
  await X.locator('.x-q').evaluate(e => e.focus({ preventScroll: true })); await page.keyboard.type('c', { delay: 40 });
  await yy('typed'); served.mode = 'VALUE-C';
  const f0 = served.fetches; await sleep(4500); await yy('held');   // the 3 s interval fires at least once while the viewer has just typed
  check('the page fetched while the viewer was typing', served.fetches > f0, `${f0} -> ${served.fetches}`);
  check('nothing was updated while the viewer was typing', (await value()) === 'VALUE-A', await value());
  await page.evaluate(() => document.activeElement.blur());   // leave the field (a click on the heading would scroll the page to it)
  await yy('blurred'); await page.waitForFunction(() => document.querySelector('#c-c-jobs .x-val').textContent === 'VALUE-C', null, { timeout: 5000 }).catch(() => {}); await yy('applied');
  check('the update was applied straight after the viewer left the field', (await value()) === 'VALUE-C', await value());

  // ---- 3. nothing moved, closed or cleared; the changed values did update
  const after = await mark();
  check('the page scroll did not move', Math.abs(after.y - before.y) <= 2, `${before.y}/${after.y} ${trace.join(' ')}`);
  check('the scroll inside the list did not move', Math.abs(after.list - before.list) <= 2, `${before.list}/${after.list}`);
  check('the search text stayed', after.q === before.q, after.q);
  check('the open row detail stayed open', JSON.stringify(after.steps) === JSON.stringify(before.steps), JSON.stringify(after.steps));
  check('the scroll inside a plain card stayed', Math.abs(after.inner - before.inner) <= 2, `${before.inner}/${after.inner}`);
  check('the open details in a plain card stayed open', after.open === true);
  check('text typed into a field of a plain card stayed', after.typed === 'abc', after.typed);
  check('the page did not navigate or reload', navigations === startNav && (await page.evaluate(() => window.__same)) === 'still here', `${startNav}/${navigations}`);
  check('the changed numbers did update (the list now has 51 rows)', /51/.test(await footer()), await footer());
  check('the indicator moved on', /^Updated \d\d:\d\d:\d\d$/.test(await labelAt()));

  // ---- 4. a selection holds the update
  await X.locator('.x-val').evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  served.mode = 'VALUE-D'; await sleep(4500);
  check('nothing was updated while text was selected', (await value()) === 'VALUE-C', await value());
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => document.querySelector('#c-c-jobs .x-val').textContent === 'VALUE-D', null, { timeout: 5000 }).catch(() => {});
  check('the update followed when the selection was cleared', (await value()) === 'VALUE-D', await value());

  // ---- 5. the manual refresh is immediate
  served.mode = 'VALUE-E';
  await clickRefresh();
  await page.waitForFunction(() => document.querySelector('#c-c-jobs .x-val').textContent === 'VALUE-E', null, { timeout: 3000 }).catch(() => {});
  check('the manual refresh updated at once', (await value()) === 'VALUE-E', await value());

  // ---- 6. a failing server leaves the page as it was and says so; it recovers
  served.mode = 'fail';
  await clickRefresh(); await sleep(600);
  check('a failed update says so and keeps the last content', /^Update failed/.test(await labelAt()) && (await value()) === 'VALUE-E', `${await labelAt()} / ${await value()}`);
  served.mode = 'VALUE-F';
  await clickRefresh();
  await page.waitForFunction(() => document.querySelector('#c-c-jobs .x-val').textContent === 'VALUE-F', null, { timeout: 3000 }).catch(() => {});
  check('it recovers when the server does', (await value()) === 'VALUE-F' && /^Updated /.test(await labelAt()), `${await labelAt()} / ${await value()}`);

  // ---- 7. after all of that the place is still the viewer's
  const end = await mark();
  check('after several refreshes the page, list, search, open items and typed text are all still in place', Math.abs(end.y - before.y) <= 2 && Math.abs(end.list - before.list) <= 2 && end.q === before.q && JSON.stringify(end.steps) === JSON.stringify(before.steps) && Math.abs(end.inner - before.inner) <= 2 && end.open && end.typed === 'abc', JSON.stringify(end));
  check('still no reload', navigations === startNav && (await page.evaluate(() => window.__same)) === 'still here');
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
  await ctx.close();
} finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
