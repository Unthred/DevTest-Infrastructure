#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real /inbox page and the real decision post
// (issue #1262): Approve from a Table row, the outcome in the Compact list, Reject from a Compact row without expanding it, and a refusal
// for an item decided in another tab a moment before. Writes <name>.json and a screenshot to /out.
// Usage: node inbox-row-actions-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'inbox-row-actions', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const COOLDOWN_MS = 1200;   // the route allows one decision a second
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  // Same fixture rule as inbox-views-scenario.mjs: the app bar's agent item (issue #1221) is left out so the sideways-scroll check measures the Inbox.
  await ctx.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '.agent-item{display:none!important}';
    document.head.append(style);
  }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  let navigations = 0;
  page.on('framenavigated', f => { if (f === page.mainFrame()) navigations += 1; });
  await page.goto(`http://127.0.0.1:${port}/inbox?state=all`, { waitUntil: 'networkidle' });
  const loaded = navigations;
  const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const view = label => page.getByRole('button', { name: label, exact: true }).click();
  const tRow = title => page.locator('.iv-table tbody tr', { hasText: title });
  const cRow = title => page.locator('.iv-crow', { hasText: title });
  const cardOf = title => page.locator('[data-pane="cards"] .inbox-item', { hasText: title });
  const CHIP = '[data-chip="state:waiting"] .qf-n';   // the waiting count on the /inbox page
  const waitingCount = async () => Number((await page.locator(CHIP).first().textContent()).replace(/\D/g, ''));
  const tableOrder = () => page.locator('.iv-table tbody tr').evaluateAll(trs => trs.map(tr => tr.querySelector('[data-col="title"]').textContent.trim().slice(0, 12)).join('|'));
  const sortState = () => page.locator('.iv-table th[aria-sort]').evaluateAll(ths => ths.map(t => `${t.textContent.trim()}:${t.getAttribute('aria-sort')}`).join());
  const DRAFT = 'Draftchain', DONE = 'Driftcheck', TIDY = 'Tidy the docs index', RACE = 'Raceitem';

  await view('Table');
  check('the Table has Actions as its last column', (await page.locator('.iv-table thead th').last().textContent()).trim() === 'Actions');
  check('Actions is not in the Columns menu', (await page.locator('.iv-colmenu input[data-col="actions"]').count()) === 0);
  check('the Draftchain row has Approve and Reject', (await tRow(DRAFT).locator('button').allTextContents()).join() === 'Approve,Reject');
  check('the Driftcheck row has no buttons', (await tRow(DONE).locator('button').count()) === 0);
  check('no sideways page scroll in the Table', await noSideways());
  const heights = await tRow(DRAFT).locator('button').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height));
  if (PROFILES[profile].viewport.width < 640) check('the buttons are at least 44 px high at phone width', heights.every(h => h >= 44), heights.join());

  // The post and the refresh that follows it are slowed, so the in-flight state and the outcome can be seen before the page re-reads the server.
  let slow = false;
  await page.route('**/*', async r => {
    const req = r.request();
    if (slow && req.method() === 'POST') await new Promise(res => setTimeout(res, 900));
    if (slow && req.method() === 'GET') await new Promise(res => setTimeout(res, 2500));
    await r.continue();
  });
  const outcomeOf = (pane, title) => (pane === 'table' ? tRow(title) : pane === 'compact' ? cRow(title) : cardOf(title)).locator('.inbox-outcome');
  // Presses one button in a row and checks the in-flight state; the outcome is checked by the caller.
  const press = async (row, label) => {
    slow = true;
    const buttons = row.locator('.iv-acts button');
    await row.locator('.iv-acts button', { hasText: label }).click();
    check(`pressing ${label} disables both buttons at once`, (await buttons.evaluateAll(bs => bs.every(b => b.disabled))));
    check(`the pressed ${label} button is labelled`, (await row.locator(`.iv-acts button.inbox-${label.toLowerCase()}`).textContent()).includes(label === 'Approve' ? 'Approved' : 'Rejected'));
  };

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await tRow(DRAFT).locator('button').first().scrollIntoViewIfNeeded();   // so Playwright's own scroll before the click is not read as the page moving
  await page.locator('.iv-sort[data-sort="title"]').click();
  const orderBefore = await tableOrder(), sortBefore = await sortState(), searchBefore = await page.evaluate(() => location.search);
  check('the Title sort is on before the press', /Title:ascending/.test(sortBefore), sortBefore);
  await tRow(DRAFT).locator('button').first().scrollIntoViewIfNeeded();   // the sort moved the row, so bring it back before the position is read (issue #1416: rows are taller on a phone)
  const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));
  const waitingBefore = await waitingCount();
  check('three items are waiting before the first press', waitingBefore === 3, waitingBefore);
  await press(tRow(DRAFT), 'Approve');
  await outcomeOf('table', DRAFT).waitFor({ timeout: 8000 });
  check('the press was recorded, not refused', await tRow(DRAFT).locator('.inbox-err').isHidden());
  check('Approve did not navigate', navigations === loaded, `${navigations} vs ${loaded}`);
  { const now = await page.evaluate(() => [Math.round(window.scrollY), document.documentElement.scrollHeight, innerHeight]); check('the scroll position stayed', Math.abs(now[0] - scrollBefore) <= 2, `${scrollBefore} -> ${now}`); }
  check('the Table is still the view shown', await page.locator('[data-pane="table"]').isVisible());
  check('the table row shows its outcome and no buttons', /Approved/.test(await outcomeOf('table', DRAFT).textContent()) && (await tRow(DRAFT).locator('button').count()) === 0);
  check('the Compact list row shows the same outcome and no buttons', /Approved/.test(await outcomeOf('compact', DRAFT).textContent()) && (await cRow(DRAFT).locator('button').count()) === 0);
  check('the Cards view shows the outcome too', /Approved/.test(await outcomeOf('cards', DRAFT).textContent()));
  check('the waiting count is one lower at once', (await waitingCount()) === waitingBefore - 1, `${waitingBefore} -> ${await waitingCount()}`);
  slow = false;
  await tRow(DRAFT).locator('td[data-col="state"]', { hasText: 'approved' }).waitFor({ timeout: 12000 });
  check('after the page re-reads the server the row says approved and has no buttons', (await tRow(DRAFT).locator('button').count()) === 0);
  { const now = await page.evaluate(() => [Math.round(window.scrollY), document.documentElement.scrollHeight]); check('the refresh kept the scroll position', Math.abs(now[0] - scrollBefore) <= 2, `${scrollBefore} -> ${now}`); }
  { const order = await tableOrder(), sortNow = await sortState(); check('the sort order stayed after the page re-read', order === orderBefore && sortNow === sortBefore, `${orderBefore} -> ${order}; ${sortBefore} -> ${sortNow}`); }
  check('the filters and search in the address stayed', (await page.evaluate(() => location.search)) === searchBefore);
  check('the waiting count is two after the re-read', (await waitingCount()) === 2, await waitingCount());

  await view('Compact list');
  check('the Compact list row says approved and has no buttons', (await cRow(DRAFT).getAttribute('data-state')) === 'approved' && (await cRow(DRAFT).locator('button').count()) === 0);
  check('a Compact row for a done item has no buttons', (await cRow(DONE).locator('button').count()) === 0);
  check('no sideways page scroll in Compact list', await noSideways());

  await page.waitForTimeout(COOLDOWN_MS);
  const tidy = cRow(TIDY);
  check('the Tidy row has its buttons visible without expanding', (await tidy.locator('.iv-acts button').first().isVisible()) && !(await tidy.locator('.iv-more').isVisible()));
  const compactHeights = await tidy.locator('.iv-acts button').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height));
  if (PROFILES[profile].viewport.width < 640) check('compact buttons are at least 44 px high at phone width', compactHeights.every(h => h >= 44), compactHeights.join());
  await press(tidy, 'Reject');
  await outcomeOf('compact', TIDY).waitFor({ timeout: 8000 });
  check('Reject from the Compact list posted without a reload', navigations === loaded && /Rejected/.test(await outcomeOf('compact', TIDY).textContent()));
  check('the Table row shows the rejection for the same item', /Rejected/.test(await outcomeOf('table', TIDY).textContent()));
  slow = false;
  await page.locator('.iv-crow[data-state="rejected"]', { hasText: TIDY }).waitFor({ timeout: 12000 });
  await view('Table');

  // Invalid case: the item was decided in another tab a moment before, so the server refuses this click and the row keeps its reason.
  const other = await ctx.newPage();
  await other.goto(`http://127.0.0.1:${port}/inbox?state=all`, { waitUntil: 'networkidle' });
  await other.getByRole('button', { name: 'Table', exact: true }).click();
  await page.waitForTimeout(COOLDOWN_MS);
  slow = true;   // the first tab's own re-read is held back, so its row still shows the buttons when the other tab has decided
  const decidedElsewhere = other.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/inbox'));
  await other.locator('.iv-table tbody tr', { hasText: RACE }).locator('button', { hasText: 'Approve' }).click();
  check('the other tab decided the item first', (await (await decidedElsewhere).json()).ok === true);
  await page.waitForTimeout(COOLDOWN_MS);
  await tRow(RACE).locator('button', { hasText: 'Reject' }).click();
  await tRow(RACE).locator('.inbox-err').waitFor({ timeout: 8000 });
  const reason = await tRow(RACE).locator('.inbox-err').textContent();
  check('a refusal shows its reason on the row', /Not recorded|already/i.test(reason), reason);
  check('after the refusal both buttons are not left pressed', await tRow(RACE).locator('button.inbox-reject').textContent().then(x => x.includes('Reject') && !x.includes('Rejected')));
  check('the refused row shows no outcome of its own', await tRow(RACE).locator('.inbox-outcome').isHidden());
  check('no sideways page scroll after a refusal', await noSideways());
  // Boundary: every waiting item is decided now (Draftchain, Tidy here, Raceitem in the other tab), so the re-read leaves none waiting.
  slow = false;
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent.trim() === '0', CHIP, { timeout: 12000 }).catch(() => {});
  check('the waiting count reaches zero when the last waiting item is decided', (await waitingCount()) === 0, await waitingCount());
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500), checks }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
