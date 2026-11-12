#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Drives the real /inbox page (issue #1219):
// the default view for the width, each of the three views, a sort by Age, a hidden column and a view that survive a reload, an
// expanded Compact list row, and no sideways page scroll. Writes <name>.json and a screenshot to /out.
// Usage: node inbox-views-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'inbox-views', out = arg('out') || '/out';
const phone = PROFILES[profile].viewport.width < 640;
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const open = async () => { await page.goto(`http://127.0.0.1:${port}/inbox`, { waitUntil: 'networkidle' }); };
  const pane = n => page.locator(`[data-iv] [data-pane="${n}"]`);
  const visiblePanes = async () => { const v = []; for (const n of ['cards', 'table', 'compact']) if (await pane(n).isVisible()) v.push(n); return v.join(','); };
  const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const rowTitles = () => page.locator('[data-iv] .iv-table tbody tr td[data-col="title"]').allTextContents();

  await open();
  check('the page is /inbox with an Inbox heading', /Inbox/.test(await page.title()) || (await page.locator('h1').first().textContent()).includes('Inbox'));
  check(`default view for ${phone ? 'a phone is Compact list' : 'desktop is Table'}`, (await visiblePanes()) === (phone ? 'compact' : 'table'), await visiblePanes());
  const text = await page.locator('main').innerText();
  for (const t of ['Rules drift check read only Driftcheck', 'Post-mortem: 3 jobs failed with cause deterministic', 'Tidy the docs index']) check(`the fixture item is on the page: ${t}`, text.includes(t) || (await page.locator(`text=${t}`).count()) > 0);

  for (const [label, key] of [['Cards', 'cards'], ['Table', 'table'], ['Compact list', 'compact']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    check(`the ${label} button shows only the ${key} view`, (await visiblePanes()) === key, await visiblePanes());
    check(`no sideways page scroll in ${label}`, await noSideways());
    if (key !== 'table') check(`${label} does not scroll sideways inside itself`, await pane(key).evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  }
  const counts = {};
  for (const [key, sel] of [['cards', '[data-inbox]'], ['table', 'tbody tr'], ['compact', '.iv-crow']]) counts[key] = await pane(key).locator(sel).count();
  check('the three views hold the same number of items', counts.cards === counts.table && counts.table === counts.compact && counts.cards >= 5, JSON.stringify(counts));

  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('.iv-sort[data-sort="age"]').click();
  const asc = await rowTitles();
  check('Age ascending lists the newest item first', asc[0].includes('Read only drift check') && asc.at(-1).includes('Rules drift check'), asc.join(' | ').slice(0, 300));
  await page.locator('.iv-sort[data-sort="age"]').click();
  const desc = await rowTitles();
  check('a second click on Age reverses the order', desc[0].includes('Rules drift check') && desc.length === asc.length, desc.join(' | ').slice(0, 300));
  check('the sorted column says so for assistive tech', (await page.locator('th[data-col="age"]').getAttribute('aria-sort')) === 'descending');

  await page.locator('summary', { hasText: 'Columns' }).click();
  await page.locator('.iv-colmenu input[data-col="source"]').uncheck();
  check('the Source column is hidden', !(await page.locator('th[data-col="source"]').isVisible()) && !(await page.locator('td[data-col="source"]').first().isVisible()));
  await page.reload({ waitUntil: 'networkidle' });
  check('after a reload the Table view is kept', (await visiblePanes()) === 'table', await visiblePanes());
  check('after a reload the Source column is still hidden', !(await page.locator('th[data-col="source"]').isVisible()));
  check('after a reload the other columns are still shown', await page.locator('th[data-col="result"]').isVisible());
  if (phone) check('at phone width the Table scrolls inside its own container only', await noSideways() && await pane('table').evaluate(el => el.scrollWidth >= el.clientWidth));

  await page.getByRole('button', { name: 'Compact list', exact: true }).click();
  const row = page.locator('.iv-crow', { hasText: 'Post-mortem' });
  check('a Compact list row starts closed with no result text visible', !(await row.locator('.iv-more').isVisible()));
  await row.locator('summary').click();
  check('expanding a row shows its result', (await row.locator('.iv-more').isVisible()) && /posted as issue #321/.test(await row.locator('.iv-more').innerText()));
  const waiting = page.locator('.iv-crow', { hasText: 'Tidy the docs index' });
  await waiting.locator('summary').click();
  check('a waiting row shows its prompt text', /Fix the broken link/.test(await waiting.locator('.iv-more').innerText()));
  await page.reload({ waitUntil: 'networkidle' });
  check('after a reload the Compact list view is kept', (await visiblePanes()) === 'compact', await visiblePanes());
  check('no sideways page scroll in Compact list after the reload', await noSideways());
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500), checks }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
