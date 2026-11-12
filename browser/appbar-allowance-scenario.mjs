#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the app bar allowance items (issue #1178) in a real browser: each agent shows weekly and 5 hour figures with a text marker, the link opens the
// Usage page, an item can be removed and restored (desktop), and the narrow layout still shows both figures. Writes <name>.json and a screenshot to /out.
// Usage: node appbar-allowance-scenario.mjs --target fixture --profile <name> --page /card.html --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'appbar-allowance', out = arg('out') || '/out';
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
  // The static fixture has no routes: /usage is answered by the fixture page itself (a Usage page render), so the link can be followed.
  await ctx.route('**/usage', r => r.continue({ url: r.request().url().replace(/\/usage$/, '/card.html') }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  const items = page.locator('.statusbar .allowance-item');
  check('one item per agent', (await items.count()) === 2, await items.count());
  for (const agent of ['claude', 'codex']) {
    const it = page.locator(`.statusbar [data-bar="allowance-${agent}"]`);
    for (const w of ['weekly', 'short']) check(`${agent} shows its ${w} figure`, await it.locator(`[data-window="${w}"]`).isVisible());
  }
  const codex = page.locator('.statusbar [data-bar="allowance-codex"]');
  check('codex weekly 15% and short 99% with a text marker', /15%/.test((await codex.locator('[data-window="weekly"]').textContent()) || '') && /99%[\s\S]*High/.test((await codex.locator('[data-window="short"]').textContent()) || ''));
  check('an expired window reads unknown, not its old figure', /unknown: .*window has reset/.test((await page.locator('.statusbar [data-bar="allowance-claude"] [data-window="short"]').textContent()) || ''));
  check('a stale reading is marked', (await codex.locator('[data-stale="true"]').count()) === 1);
  const bar = await page.locator('.statusbar').boundingBox();
  const box = await codex.boundingBox();
  check('the item sits inside the viewport width', box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width + 1, JSON.stringify(box));
  check('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), JSON.stringify(bar));
  if (profile.startsWith('desktop')) {
    await page.click('#barEdit');
    await codex.locator('.bar-ctl button', { hasText: '✕' }).click();
    check('a removed item leaves the bar', !(await codex.isVisible()));
    await page.reload({ waitUntil: 'networkidle' });
    check('the removal is saved for this viewer', !(await page.locator('.statusbar [data-bar="allowance-codex"]').isVisible()));
    await page.click('#barEdit');
    await page.locator('.bar-picker summary').click();
    await page.locator('.bar-picker li', { hasText: 'Allowance: codex' }).locator('button').click();
    check('a restored item is back', await page.locator('.statusbar [data-bar="allowance-codex"]').isVisible());
    await page.click('#barEdit');
  }
  await Promise.all([page.waitForURL('**/usage'), page.locator('.statusbar [data-bar="allowance-claude"] a.al-link').click()]);
  check('the link opens the Usage page', /\/usage$/.test(page.url()), page.url());
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
