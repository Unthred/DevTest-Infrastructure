#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real /inbox page served by the dashboard's own
// request handler: the quick filter buttons, a reload keeping the choice, a bare /inbox returning to it, the empty result with Clear filters,
// and at phone width the wrapping, the 44 px tap size and no sideways scroll. Writes <name>.json to /out.
// Usage: node inbox-filter-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'inbox-filter', out = arg('out') || '/out';
const TITLES = { done: 'Rules drift check read only Driftcheck', draft: 'Post-mortem: 3 jobs failed with cause deterministic', waiting: 'Waiting proposal', failed: 'Failed prompt' };
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
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const titles = () => page.locator('.panel-list h3.inbox-title').allTextContents().then(a => a.map(t => t.trim()));
  const nav = action => Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), action()]);
  const chipCount = async id => Number(await page.locator(`[data-chip="${id}"] .qf-n`).textContent());

  await page.goto(url('/inbox'), { waitUntil: 'networkidle' });
  check('the default view is Waiting for approval, showing only the waiting item', JSON.stringify(await titles()) === JSON.stringify([TITLES.waiting]), JSON.stringify(await titles()));
  const states = ['waiting', 'running', 'done', 'failed', 'refused', 'all'];
  const n = {}; for (const s of states) n[s] = await chipCount(`state:${s}`);
  check('the state counts come from the same items and sum to the total', n.all === 4 && states.slice(0, 5).reduce((a, s) => a + n[s], 0) === n.all && n.waiting === 1 && n.done === 2 && n.failed === 1, JSON.stringify(n));

  await nav(() => page.locator('[data-chip="state:failed"]').click());
  check('Failed shows only the failed item', JSON.stringify(await titles()) === JSON.stringify([TITLES.failed]), JSON.stringify(await titles()));
  check('the State dropdown follows the button', (await page.locator('select[name=state]').inputValue()) === 'failed');
  await page.reload({ waitUntil: 'networkidle' });
  check('a reload keeps the choice', JSON.stringify(await titles()) === JSON.stringify([TITLES.failed]));
  await page.goto(url('/inbox'), { waitUntil: 'networkidle' });
  check('coming back to a bare /inbox returns to the saved choice', JSON.stringify(await titles()) === JSON.stringify([TITLES.failed]) && page.url().includes('state=failed'), page.url());

  await nav(() => page.locator('[data-chip="state:waiting"]').click());
  check('Waiting for approval shows only the waiting item', JSON.stringify(await titles()) === JSON.stringify([TITLES.waiting]));
  await nav(() => page.locator('[data-chip="state:done"]').click());
  await nav(() => page.locator('[data-chip="kind:prompt"]').click());
  check('a kind button combines with a state button', JSON.stringify(await titles()) === JSON.stringify([TITLES.done]), JSON.stringify(await titles()));
  await nav(() => page.locator('select[name=kind]').selectOption('issue_draft'));
  check('changing the Kind dropdown moves the buttons and the list', JSON.stringify(await titles()) === JSON.stringify([TITLES.draft]) && (await page.locator('[data-chip="kind:issue_draft"]').getAttribute('aria-current')) === 'true');

  await page.locator('input[name=search]').fill('zzzz'); await nav(() => page.locator('.inbox-search button[type=submit]').click());
  const empty = (await page.locator('.empty').textContent()).replace(/\s+/g, ' ');
  check('an empty result says which filters are on', /Done/.test(empty) && /Issue draft/.test(empty) && /zzzz/.test(empty), empty);
  await page.screenshot({ path: path.join(out, `${name}-empty.png`), fullPage: true });
  await nav(() => page.locator('[data-clear-filters]').click());
  check('Clear filters shows every item again', (await titles()).length === 4 && (await page.locator('[data-chip="state:all"]').getAttribute('aria-current')) === 'true', JSON.stringify(await titles()));
  await page.goto(url('/inbox'), { waitUntil: 'networkidle' });
  check('the cleared choice is the one kept', (await titles()).length === 4);

  const geo = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - innerWidth,
    small: [...document.querySelectorAll('.qf')].filter(c => c.getBoundingClientRect().height < 44).length,
    tops: new Set([...document.querySelectorAll('.qf-row')[0].children].map(c => Math.round(c.getBoundingClientRect().top))).size,
    right: Math.max(...[...document.querySelectorAll('.qf')].map(c => c.getBoundingClientRect().right)) - innerWidth,
  }));
  check('no sideways scroll', geo.over <= 0 && geo.right <= 0, JSON.stringify(geo));
  check('every button is at least 44 px high', geo.small === 0, JSON.stringify(geo));
  if (profile.startsWith('phone')) check('the state buttons wrap onto more than one row', geo.tops > 1, JSON.stringify(geo));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 600)); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
