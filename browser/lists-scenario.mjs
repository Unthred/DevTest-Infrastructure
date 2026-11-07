#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the shared Overview lists in a
// real browser: the page height stays bounded, nothing overflows or covers a link, search and sort work, and search text, sort and the
// scroll position inside a list survive a reload (the dashboard's refresh today). Also the no-script case. Writes <name>.json to /out.
// Usage: node lists-scenario.mjs --target fixture --profile <name> --many /many.html --few /few.html --empty /empty.html --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, redactUrl, PROFILES } from './capture.mjs';
import { layoutCheck } from './layout-check.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'lists', out = arg('out') || '/out';
const pages = { many: arg('many') || '/many.html', few: arg('few') || '/few.html', empty: arg('empty') || '/empty.html' };
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const newCtx = (js = true) => browser.newContext({ ...PROFILES[profile], javaScriptEnabled: js, serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
const guard = async ctx => ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
const url = p => `http://127.0.0.1:${port}${p}`;
const heights = {};
try {
  const ctx = await newCtx(); await guard(ctx);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const height = () => page.evaluate(() => document.documentElement.scrollHeight);
  for (const k of ['empty', 'few', 'many']) {
    await page.goto(url(pages[k]), { waitUntil: 'networkidle' });
    heights[k] = await height();
    const findings = await page.evaluate(layoutCheck, { touch: PROFILES[profile].hasTouch });
    const fails = findings.filter(f => f.severity === 'fail').map(({ text, ...f }) => `${f.check}@${f.element}`);
    check(`${k}: no overflow or covered link (layout check)`, fails.length === 0, fails.slice(0, 5).join('; '));
    if (k === 'many') await page.screenshot({ path: path.join(out, `${name}-many.png`), fullPage: true });
  }
  if (arg('heights-only')) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, heights, headless: true }, null, 2)); await ctx.close(); process.exit(0); }
  check('page height with 50 Needs you rows is bounded near the height with 5 (within 1.6x)', heights.many <= heights.few * 1.6 + 200, JSON.stringify(heights));
  check('no script errors', errors.length === 0, errors.join('; '));

  await page.goto(url(pages.many), { waitUntil: 'networkidle' });
  const L = page.locator('[data-dlist="needs"]'), ul = L.locator('> .dl-scroll');
  const box = await ul.evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight, rows: e.children.length, ox: getComputedStyle(e).overflowY }));
  check('Needs you has 50 rows inside a scrolling box shorter than its content', box.rows === 50 && box.scroll > box.client && box.client <= 0.6 * 900 + 400 && box.ox === 'auto', JSON.stringify(box));
  check('the footer counts the rows', (await L.locator('[data-dl-foot]').textContent()) === '50 items · 50 action');
  // search
  await L.locator('.dl-q').fill('item 105');
  check('search filters to the matching row and shows N of M', (await L.locator('[data-dl-foot]').textContent()) === '1 of 50 items · 1 action' && (await ul.locator('> li:visible').count()) === 1);
  await L.locator('.dl-q').fill('zzzz');
  check('no match shows a plain message', /Nothing matches/.test(await L.locator('.dl-none').textContent()) && (await L.locator('.dl-none').isVisible()));
  await L.locator('.dl-clear').click();
  check('clear restores every row', (await ul.locator('> li:visible').count()) === 50 && (await L.locator('.dl-q').inputValue()) === '');
  // sort
  await L.locator('.dl-key').selectOption('number');
  const firstAsc = await ul.locator('> li').first().getAttribute('data-num');
  await L.locator('.dl-dir').click();
  const firstDesc = await ul.locator('> li').first().getAttribute('data-num');
  check('sort by number, both directions', firstAsc === '100' && firstDesc === '149', `${firstAsc}/${firstDesc}`);
  check('the direction is stated in words', /Highest first/.test(await L.locator('.dl-dir').textContent()));
  // state across a reload (the refresh)
  await L.locator('.dl-q').fill('plan');
  await ul.evaluate(e => { e.scrollTop = 400; });
  await page.waitForTimeout(400);
  const before = { h: await height(), top: await ul.evaluate(e => e.scrollTop), first: await ul.locator('> li').first().getAttribute('data-num') };
  await page.reload({ waitUntil: 'networkidle' });
  const after = { h: await height(), q: await L.locator('.dl-q').inputValue(), key: await L.locator('.dl-key').inputValue(), top: await ul.evaluate(e => e.scrollTop), first: await ul.locator('> li').first().getAttribute('data-num') };
  check('refresh keeps the search text', after.q === 'plan', after.q); check('refresh keeps the sort', after.key === 'number' && after.first === before.first, `${after.key} ${after.first}/${before.first}`);
  check('refresh keeps the scroll position inside the list', before.top > 0 && Math.abs(after.top - before.top) <= 2, `${before.top}/${after.top}`);
  check('refresh does not change the page height', Math.abs(after.h - before.h) <= 2, `${before.h}/${after.h}`);
  // page scrolling is not trapped: the wheel over a list at its end moves the page (scroll chaining stays on)
  check('page scrolling is not trapped (overscroll chains to the page)', (await ul.evaluate(e => getComputedStyle(e).overscrollBehaviorY)) === 'auto');
  // a card the viewer resized taller gives its list more room (the saved layout sets --h on the card)
  const c0 = await ul.evaluate(e => e.clientHeight);
  await page.locator('#c-needs').evaluate(c => { c.style.setProperty('--h', '1100px'); c.style.alignSelf = 'start'; });
  const c1 = await ul.evaluate(e => e.clientHeight);
  check('a card resized taller gives its list more room', c1 > c0 + 100, `${c0} -> ${c1}`);
  // watched-steps reload (the #793 repro): each watched row holds nested li.wstep steps with their own details. Opening one step must come
  // back as exactly that step after a reload, using the browser's real closest('.dl-scroll > li') matching (not a stub).
  const W = page.locator('[data-dlist="watching"]'), wul = W.locator('> .dl-scroll');
  const steps = await wul.evaluate(e => [...e.querySelectorAll(':scope > li')].map(li => li.querySelectorAll('li.wstep details').length));
  check('the watched list has rows with nested step details', steps.length >= 2 && steps.every(n => n >= 2), JSON.stringify(steps));
  const openState = () => wul.evaluate(e => [...e.querySelectorAll('details[open]')].map(d => `${d.closest('.dl-scroll > li')?.dataset.key}|${d.closest('[data-step]')?.dataset.step}`));
  const target1 = wul.locator('> li').nth(1).locator('li.wstep details').nth(1);
  await target1.locator('summary').click();
  const want = await openState();
  check('exactly one step is open before the reload, keyed by row and step', want.length === 1 && /^watch-.+\|.+$/.test(want[0]), JSON.stringify(want));
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  const got = await openState();
  check('the watched step reopens after a reload, and only that step', JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(want)} -> ${JSON.stringify(got)}`);
  await ctx.close();

  const plain = await newCtx(false); await guard(plain);
  const p2 = await plain.newPage(); await p2.goto(url(pages.many), { waitUntil: 'load' });
  const nb = await p2.locator('[data-dlist="needs"] > .dl-scroll').evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight, rows: e.children.length }));
  check('without script the list still shows all rows and scrolls inside its own box', nb.rows === 50 && nb.scroll > nb.client, JSON.stringify(nb));
  check('without script the dead controls are hidden', !(await p2.locator('[data-dlist="needs"] .dl-bar').isVisible()));
  heights.noScript = await p2.evaluate(() => document.documentElement.scrollHeight);
  await plain.close();
} finally { await browser.close(); server.close(); }
const result = { profile, heights, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
