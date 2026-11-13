#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks one decision card (a fix limit
// card, issue #1156) in a real browser: it shows a non-empty Why, the clear condition, the later-slice note and a visible, unclipped
// control, with no script errors and no overflow. Writes <name>.json and a screenshot to /out.
// Usage: node decision-card-scenario.mjs --target fixture --profile <name> --page /card.html --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'decision', out = arg('out') || '/out';
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
  const card = page.locator('#att-fixlimit-7 .decision-card[data-decision="fixlimit"]');
  check('the fix limit decision card is on the page', (await card.count()) === 1);
  const why = (await card.locator('.decision-reason').textContent()) || '';
  check('Why is not empty and says the PR is still rejected', /^Why: .*still rejected after 2 fix rounds/.test(why), why);
  check('the clear condition is shown in plain words', /Clears when a new head is reviewed PASS; no more fix jobs start\./.test((await card.locator('.decision-clears').textContent()) || ''));
  check('the card names the slice that will provide the missing option', /slice 2/.test((await card.locator('.decision-later').textContent()) || ''));
  const button = card.locator('button.decision-control').first();
  check('a routine control is visible', await button.isVisible(), await button.textContent());
  check('the old dead-end text is gone', !/it has no button here/.test(await page.content()));
  const box = await button.boundingBox();
  check('the control is inside the viewport width and a usable tap size', box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width && box.height >= 24, JSON.stringify(box));
  check('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
