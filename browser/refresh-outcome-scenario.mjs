#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Issue #1330: presses "Refresh allowance" on the Codex agent's card in a real
// browser and reads the one sentence the Usage page then shows, for each of the four outcomes. The fixture has no server, so the route answers the form post
// with the redirect the real dashboard sends, and the page it lands on is the real Usage page render for that outcome (staged by tests/refresh-outcome-browser.mjs).
// Usage: node refresh-outcome-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'refresh-outcome', out = arg('out') || '/out';
const EXPECT = { new: /^Refresh finished: a new reading was observed at /, 'nothing-newer': /^Refresh found no newer reading: .* taken at /,
  refused: /^Refresh was not run: .* paid overage/, failed: /^Refresh failed: the minimal session did not finish\. The last reading was taken at / };
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
  let outcome = 'new';
  // The browser does not route a redirect's second request, so the redirect points at the staged page of the outcome instead of /usage?probe=<outcome>.
  await ctx.route('**/probe/codex', r => r.fulfill({ status: 303, headers: { location: `/usage-${outcome}.html` }, body: '' }));
  for (outcome of Object.keys(EXPECT)) {
    await page.goto(`http://127.0.0.1:${port}/usage-plain.html`, { waitUntil: 'networkidle' });
    const card = page.locator('section[data-card="u-codex"]');
    check(`${outcome}: no outcome sentence before the button is pressed`, (await page.locator('.probe-outcome').count()) === 0);
    const widthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
    await card.getByRole('button', { name: 'Refresh allowance' }).click();
    await page.waitForSelector('.probe-outcome', { timeout: 5000 });
    const sentence = ((await card.locator('.probe-outcome').innerText()) || '').replace(/\s+/g, ' ').trim();
    check(`${outcome}: the codex card states the outcome in one sentence`, EXPECT[outcome].test(sentence) && (await page.locator('.probe-outcome').count()) === 1, sentence);
    check(`${outcome}: the sentence sits on the codex card, not another agent's`, (await card.locator(`.probe-outcome[data-outcome="${outcome}"]`).count()) === 1);
    check(`${outcome}: the sentence adds no sideways scroll`, (await page.evaluate(() => document.documentElement.scrollWidth)) <= widthBefore);
    await page.screenshot({ path: path.join(out, `${name}-${outcome}.png`) });
  }
  check('no script errors', errors.length === 0, errors.join('; '));
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
