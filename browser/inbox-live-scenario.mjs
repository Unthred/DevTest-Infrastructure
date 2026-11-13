#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real /inbox page (issue #1287): a card that
// arrives, or is decided elsewhere, shows or leaves in place within 10 seconds, in the Cards and the Table view, without a page load; a typed
// search is kept; the stream is opened once on the Inbox page and never on a page with neither the count badge nor the Inbox card; the
// Overview badge still follows the stream. The host side (tests/inbox-live-browser.mjs) changes the Inbox folder when this script calls
// /__test/add and /__test/decide, and reports the stream requests it saw at /__test/streams?path=<page>.
// Usage: node inbox-live-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'inbox-live', out = arg('out') || '/out';
const NEW_TITLE = 'A command can record an already approved Inbox action that the next tick runs Actionbridge';
const FIRST_TITLE = 'Waiting proposal one';
const WITHIN_MS = 10000;
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const control = async p => (await ctx.request.get(url(p))).json();
  const streams = async () => (await control('/__test/streams')).count;
  const pane = view => page.locator(`[data-iv] [data-pane="${view}"]`);
  const shown = (view, title) => pane(view).getByText(title, { exact: false }).first();
  const visibleWithin = async (view, title) => { try { await shown(view, title).waitFor({ state: 'visible', timeout: WITHIN_MS }); return true; } catch { return false; } };
  const goneWithin = async (view, title) => { try { await shown(view, title).waitFor({ state: 'hidden', timeout: WITHIN_MS }); return true; } catch { return false; } };

  for (const view of ['cards', 'table']) {
    await control('/__test/reset');
    const label = view === 'cards' ? 'Cards' : 'Table';
    await page.goto(url('/inbox'), { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.evaluate(() => { window.__loaded = 'first-load'; });
    check(`${label}: the page opens with its one waiting card`, await shown(view, FIRST_TITLE).isVisible());
    check(`${label}: the page opened exactly one stream`, (await streams()) === 1, await streams());

    await control('/__test/add');
    check(`${label}: the new card is on the page within 10 seconds`, await visibleWithin(view, NEW_TITLE));
    check(`${label}: no page load happened (the window marker is still there)`, (await page.evaluate(() => window.__loaded)) === 'first-load');
    check(`${label}: the address is unchanged`, page.url() === url('/inbox'), page.url());

    await control('/__test/decide');
    check(`${label}: a card decided elsewhere leaves within 10 seconds`, await goneWithin(view, FIRST_TITLE));
    check(`${label}: still no page load after the decision`, (await page.evaluate(() => window.__loaded)) === 'first-load');
    check(`${label}: still one stream`, (await streams()) === 1, await streams());
  }

  // Boundary: text typed more than 8 seconds ago does not hold the page back, and is kept.
  await control('/__test/reset');
  await page.goto(url('/inbox'), { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__loaded = 'boundary-load'; });
  await page.locator('input[name=search]').fill('typed words');
  await page.locator('h1, body').first().click({ position: { x: 1, y: 1 } });
  await page.evaluate(() => document.activeElement?.blur?.());
  await sleep(9000);
  await control('/__test/add');
  check('after a search typed over 8 seconds earlier, the new card still arrives', await visibleWithin('cards', NEW_TITLE) || await visibleWithin('table', NEW_TITLE));
  check('the typed search is kept', (await page.locator('input[name=search]').inputValue()) === 'typed words');
  check('the boundary run did not load the page again', (await page.evaluate(() => window.__loaded)) === 'boundary-load');

  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  await page.close();   // an Inbox tab left open would reconnect to the stream and be counted in the passes below

  // Invalid: neither the badge nor the Inbox card on the page, so no stream.
  await control('/__test/reset');
  const other = await ctx.newPage();
  await other.goto(url('/work'), { waitUntil: 'networkidle' });
  await sleep(1500);
  const hasMarkers = await other.evaluate(() => !!document.querySelector('[data-approvals-count], [data-layout="inbox"]'));
  check('the comparison page has neither the badge nor the Inbox card', !hasMarkers);
  check('a page with neither opens no stream', (await streams()) === 0, await streams());
  await other.close();

  // Regression: the Overview badge follows the stream.
  await control('/__test/reset');
  const overview = await ctx.newPage();
  // The Overview loads its script once per page load (it loads twice in this fixture); each load must open one stream, no more.
  const seen = []; overview.on('request', r => { seen.push(new URL(r.url()).pathname); });
  await overview.goto(url('/'), { waitUntil: 'networkidle' });
  const badge = () => overview.locator('[data-approvals-count]').first().textContent().then(t => Number(t.trim()));
  const before = await badge();
  const loads = seen.filter(u => u === '/static/app.js').length;
  check('the Overview opens one stream for each page load', loads >= 1 && (await streams()) === loads, `${await streams()} streams, ${loads} loads`);
  await control('/__test/add');
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) { await sleep(500); after = await badge(); }
  check('the Overview count badge goes up from the stream', after === before + 1, `${before} -> ${after}`);
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 600)); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
