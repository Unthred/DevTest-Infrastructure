#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the Limit resets card
// (issue #1159) in a real browser: both recorded resets show with their Helps Foreman now line and expiry colour, the record form
// is reachable, controls sit inside the viewport, no script errors and no sideways scroll. Writes <name>.json and a screenshot to /out.
// Usage: node limit-resets-scenario.mjs --target fixture --profile <name> --page /card.html --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'resets', out = arg('out') || '/out';
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
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  const card = page.locator('[data-card="u-resets"], #u-resets').first();
  check('the Limit resets card is on the page', (await card.count()) === 1);
  const rows = card.locator('li[data-reset]');
  check('both recorded resets are listed under the claude section', (await rows.count()) === 2 && (await card.locator('section[data-agent="claude"]').count()) === 1);
  check('an empty agent shows no section', (await card.locator('section[data-agent="codex"]').count()) === 0);
  check('the reset 5 days from expiry is amber', (await card.locator('li[data-expiry="amber"]').count()) === 1);
  check('each reset has a Helps Foreman now line', (await card.locator('.helps').count()) === 2 && /^Helps Foreman now: /.test((await card.locator('.helps').first().textContent()) || ''));
  const fable = (await card.locator('li[data-expiry="amber"] .helps').textContent()) || '';
  check('the Fable reset says why it does not help', /covers fable only/.test(fable), fable);
  const summary = card.locator('details > summary', { hasText: 'Record a reset' });
  check('the Record a reset control is visible', await summary.isVisible());
  await summary.click();
  const add = card.locator('form button', { hasText: 'Add' });
  check('the Add form opens and its button is visible', await add.isVisible());
  const box = await add.boundingBox();
  check('the button is inside the viewport width and a usable tap size', box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width && box.height >= 24, JSON.stringify(box));
  check('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
