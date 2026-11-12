#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the Limit resets card (issue #1162) in a
// real browser: both fake resets are listed with their advice, the figures and the expiry warning, the Mark used, Edit and Delete controls and the add
// form are visible and inside the viewport, with no script errors and no sideways scroll. Writes <name>.json and a screenshot to /out.
// Usage: node resets-card-scenario.mjs --target fixture --profile <name> --page /card.html --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture';
const profile = arg('profile') || 'desktop-1280';
const name = arg('name') || 'resets';
const out = arg('out') || '/out';
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
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  const card = page.locator('#c-limit-resets');
  check('the Limit resets card is on the page', (await card.count()) === 1);
  const fable = card.locator('tr[data-reset="aaaa0001"]');
  const plain = card.locator('tr[data-reset="aaaa0002"]');
  check('the Fable reset says it does not help Foreman and is flagged to use before it expires', /Use before expiry/.test((await fable.textContent()) || '') && /does not help Foreman/.test((await fable.textContent()) || ''));
  check('the Fable reset shows an expiry warning with the days left', /\b[45] days left/.test((await fable.textContent()) || ''), await fable.textContent());
  check('the normal reset gets a hold with its figures', /Hold/.test((await plain.textContent()) || '') && (await plain.locator('dl.reset-figures dt').count()) === 4);
  for (const [label, locator] of [['Mark used', fable.getByRole('button', { name: 'Mark used' })], ['Delete', fable.getByRole('button', { name: 'Delete' })]]) {
    check(`${label} is visible and inside the viewport`, await locator.isVisible());
    const box = await locator.boundingBox();
    check(`${label} has a usable tap size inside the width`, box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width && box.height >= 24, JSON.stringify(box));
  }
  await fable.locator('summary', { hasText: 'Edit' }).click();
  check('Edit opens a form with the reset filled in', (await fable.locator('form.reset-form input[name="scope"]').inputValue()) === 'fable');
  await card.locator('summary', { hasText: 'Add a reset' }).click();
  check('the add form is usable', await card.locator('details.reset-add button[type="submit"]').isVisible());
  check('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2));
  throw e;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
