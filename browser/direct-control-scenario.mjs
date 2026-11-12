#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the Overseer direct control card
// (issue #1164) in a real browser: the switch, the audit trail with a done and a refused row, an Undo only on the row that can be reversed, the
// switch and Undo buttons sending the right post, controls inside the viewport at a usable tap size, no script errors, no sideways scroll.
// Usage: node direct-control-scenario.mjs --target fixture --profile <name> --page /card.html --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'direct', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const fields = body => Object.fromEntries(new URLSearchParams(body || ''));
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  const card = page.locator('[data-card="s-direct"]').first();
  check('the Overseer direct control card is on the page', (await card.count()) === 1);
  check('the switch shows direct control is on', (await card.locator('[data-switch="on"]').count()) === 1);
  const rows = card.locator('li[data-audit]');
  check('the audit trail lists the done and the refused action', (await rows.count()) === 2 && (await card.locator('li[data-outcome="refused"]').count()) === 1);
  const refusedText = (await card.locator('li[data-outcome="refused"]').textContent()) || '';
  check('the refused row says why, and has no Undo', /not a direct control/.test(refusedText) && (await card.locator('li[data-outcome="refused"] button').count()) === 0, refusedText);
  const done = card.locator('li[data-outcome="done"]');
  const undo = done.locator('button', { hasText: 'Undo' });
  check('the done row shows who, the target, the reason and the before and after state', /overseer/.test((await done.textContent()) || '') && /Reason: not this week/.test((await done.textContent()) || '') && /parked/.test((await done.textContent()) || ''));
  check('the done row has a visible Undo button', await undo.isVisible());
  const box = await undo.boundingBox();
  check('Undo is inside the viewport width and a usable tap size', box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width && box.height >= 24, JSON.stringify(box));
  const undoPost = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/direct'), { timeout: 5000 });
  await undo.click();
  const sent = fields((await undoPost).postData());
  check('clicking Undo posts the undo of that record to /direct', sent.action === 'undo' && /^[a-f0-9]{16}$/.test(sent.id || '') && 'proof' in sent, JSON.stringify(sent));
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  const off = page.locator('[data-card="s-direct"] form button', { hasText: 'Turn direct control off' });
  check('the switch button is visible at a usable tap size', (await off.isVisible()) && (await off.boundingBox()).height >= 24);
  const switchPost = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/direct'), { timeout: 5000 });
  await off.click();
  const flip = fields((await switchPost).postData());
  check('clicking the switch posts the turn-off to /direct', flip.action === 'switch' && flip.value === 'off', JSON.stringify(flip));
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  check('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
