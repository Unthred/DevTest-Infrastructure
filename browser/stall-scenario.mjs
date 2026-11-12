#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Checks the Stalled card and its marks (issue #1222) in a real browser on the
// real rendered Overview page: the card lists the stalls, the retry capped item sits under Waiting for you, the app bar marks link to the card, and the card
// and marks are gone on the page rendered with a running job for each agent. Writes <name>.json and screenshots to /out.
// Usage: node stall-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'stall', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port } = await bridge(path.join('/targets', `${target}.sock`));
const base = `http://127.0.0.1:${port}`;
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  // The static fixture has no routes: the link target "/" is answered by the stalled page itself.
  await ctx.route(url => new URL(url).pathname === '/', r => r.continue({ url: `${base}/card.html` }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`${base}/card.html`, { waitUntil: 'networkidle' });
  const card = page.locator('#c-stalled');
  check('the Stalled card is shown', await card.isVisible());
  const text = (await card.textContent()) || '';
  check('claude is listed with fix PR #1180 and its recorded reason', /claude/.test(text) && /fix PR #1180[\s\S]*Fix the foo[\s\S]*slot full/.test(text), text.slice(0, 300));
  check('fix PR #1175 is listed with No reason recorded', /fix PR #1175[\s\S]*Fix the bar[\s\S]*No reason recorded/.test(text));
  check('codex job db849b9f is listed past its resume time with its last error', /codex/.test(text) && /db849b9f/.test(text) && /lease file unreadable/.test(text));
  const waiting = card.locator('[data-stall-waiting]');
  check('the retry capped rebase of #1180 is under Waiting for you', (await waiting.count()) === 1 && /rebase PR #1180/.test((await waiting.textContent()) || ''));
  check('the retry capped item is not listed among the stalls', !/rebase PR #1180/.test(text.slice(0, text.indexOf('Waiting for you'))));
  const first = await page.evaluate(() => document.querySelector('.cards[data-layout="overview"] > .card')?.id);
  check('the card is the first card on Overview', first === 'c-stalled', first);
  for (const agent of ['claude', 'codex']) check(`${agent} has a stalled mark in the app bar`, await page.locator(`.statusbar [data-stall-mark="${agent}"]`).isVisible());
  check('the Needs you pill carries the red marker', await page.locator('.statusbar [data-pill-stall]').isVisible());
  check('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.screenshot({ path: path.join(out, `${name}-stalled.png`) });
  await page.goto(`${base}/card.html?x=1`, { waitUntil: 'networkidle' });
  await page.locator('.statusbar [data-stall-mark="claude"]').click();
  await page.waitForLoadState('networkidle');
  check('the agent mark links to the card', new URL(page.url()).hash === '#c-stalled', page.url());
  await page.screenshot({ path: path.join(out, `${name}-followed.png`) });
  const seen = await page.locator('#c-stalled').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  check('the card is on screen after following it', seen, await page.evaluate(() => `${document.querySelectorAll('[id=c-stalled]').length} cards, url ${location.href}, title ${document.title}`));
  await page.goto(`${base}/gone.html`, { waitUntil: 'networkidle' });
  check('the card is gone when each agent has a running job', (await page.locator('#c-stalled').count()) === 0);
  check('the agent marks and the pill marker are gone too', (await page.locator('[data-stall-mark], [data-pill-stall]').count()) === 0);
  await page.screenshot({ path: path.join(out, `${name}-running.png`) });
  check('no script errors', errors.length === 0, errors.join('; '));
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
