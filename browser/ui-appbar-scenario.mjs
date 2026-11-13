#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real web shell at /api/v1/ui served by the
// dashboard's own request handler and router: the one-line 48 px bar, the figures, the details panel by click and keyboard, a live update
// from the change stream with no navigation, the kept theme, and that every request stays under /api/v1/. Writes <name>.json to /out.
// The host test serves /__fixture/first-weekly-015, which rewrites the fixture model and appends a model_changed event naming appbar.
// Usage: node ui-appbar-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-appbar', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = [], requested = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  page.on('request', r => { const u = new URL(r.url()); if (u.protocol === 'http:') requested.push(u.pathname); });
  const touch = PROFILES[profile].hasTouch;

  await page.goto(url('/api/v1/ui'), { waitUntil: 'load' });
  await page.locator('.chip.agent').nth(1).waitFor({ timeout: 10000 });
  check('the address ui redirected to the shell page', new URL(page.url()).pathname === '/api/v1/ui/index.html', page.url());
  await page.evaluate(() => { window.__noNavigation = true; });

  const geo = await page.evaluate(() => ({
    barHeight: document.getElementById('appbar').getBoundingClientRect().height,
    barScrollHeight: document.getElementById('appbar').scrollHeight,
    over: document.documentElement.scrollWidth - innerWidth,
    chips: [...document.querySelectorAll('.appbar .chip')].map(c => Math.round(c.getBoundingClientRect().height)),
    centres: [...document.querySelectorAll('#appbar > .chip, #appbar > .st')].map(c => c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2),
  }));
  check('the bar is one line 48 px high', geo.barHeight === 48 && Math.max(...geo.centres) - Math.min(...geo.centres) <= 1, JSON.stringify(geo));
  check('the page does not scroll sideways', geo.over <= 0, JSON.stringify(geo));
  if (touch) check('every control is at least 44 px high on touch', geo.chips.every(h => h >= 44), JSON.stringify(geo.chips));

  const chips = page.locator('.chip.agent');
  check('there is one chip per agent', (await chips.count()) === 2);
  const first = (await chips.nth(0).innerText()).replace(/\s+/g, ' ');
  const second = (await chips.nth(1).innerText()).replace(/\s+/g, ' ');
  check('the first agent shows its name, 14% and 1%, and no age', /^claude 14% · 1%$/.test(first), first);
  check('the second agent shows 31%, a question mark and 9h', /31%/.test(second) && /\?/.test(second) && /9h/.test(second) && !/\d%.*\d%/.test(second), second);
  const label = await chips.nth(1).getAttribute('aria-label');
  check('the accessible name says unknown and stale in words', /5 hour unknown/.test(label) && /reading stale/.test(label), label);
  const marked = await chips.nth(1).locator('.figure.marked').count();
  check('on the stale reading both figures are marked', marked === 2, marked);
  check('the status marks are drawn with a shape class and the system chip has a word', (await page.locator('.chip.system .word').innerText()) === 'stalled' && (await page.locator('.mark.t-fault').count()) >= 2);
  check('the connection mark says Live', (await page.locator('#connection .word').innerText()) === 'Live' || (await page.locator('#connection .word').innerText()) === 'Connecting');
  await page.locator('#connection[data-connection="live"]').waitFor({ timeout: 10000 });
  check('the connection mark reaches Live', (await page.locator('#connection .word').innerText()) === 'Live');

  await chips.nth(1).click();
  const panel = page.locator('#panel');
  const text = (await panel.innerText()).replace(/\s+/g, ' ');
  check('the panel opens with both windows, the unknown reason, the reading age and the roles', await panel.isVisible() && /weekly/i.test(text) && /31% used/.test(text) && /resets Mon 16 Nov, 09:00/.test(text)
    && /5 hour/i.test(text) && /5 hour window has reset; no new reading yet/.test(text) && /Reading is 9h 2m old/.test(text) && /Roles: implementer/.test(text), text);
  const box = await panel.boundingBox();
  check('the panel sits under the bar and inside the page', box.y >= 48 && box.x >= 0 && box.x + box.width <= (await page.evaluate(() => innerWidth)), JSON.stringify(box));
  check('the unknown window has a hatched meter', (await panel.locator('.meter.unknown').count()) === 1);
  await page.screenshot({ path: path.join(out, `${name}-panel.png`) });
  await page.keyboard.press('Escape');
  check('Escape closes the panel', await panel.isHidden());

  await chips.nth(0).focus();
  await page.keyboard.press('Enter');
  check('Enter on a chip opens its panel', (await panel.isVisible()) && /Reading is|Read 6m ago/.test(await panel.innerText()) && /Roles: implementer, reviewer, rebaser/.test(await panel.innerText()), await panel.innerText());
  await page.mouse.click(5, 300);
  check('a click outside closes the panel', await panel.isHidden());

  await ctx.request.get(url('/__fixture/first-weekly-015'));
  await page.locator('.chip.agent').nth(0).filter({ hasText: '15%' }).waitFor({ timeout: 15000 });
  check('the chip reads 15% from the change stream with no navigation', (await page.evaluate(() => window.__noNavigation === true)) && /15%/.test(await chips.nth(0).innerText()));

  await page.locator('[data-theme-switch]').click();
  const chosen = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.reload({ waitUntil: 'load' });
  await page.locator('.chip.agent').nth(1).waitFor({ timeout: 10000 });
  check('the theme choice is kept over a reload', chosen === 'dark' && (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', chosen);
  await page.screenshot({ path: path.join(out, `${name}-dark.png`) });

  const outside = requested.filter(p => !p.startsWith('/api/v1/'));
  check('every request the page made stays under /api/v1/', outside.length === 0, outside.join(', '));
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 600)); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
