#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Checks the app bar agent items (issues #1178, #1221) in a real browser against the real Usage page render: one item per agent with name, state dot, role, weekly and 5 hour %, the bar on one row at 1280, the tooltip, the detail opened by a tap, no sideways scroll, a saved layout restored and a saved layout with the two old items migrated. Writes <name>.json and a screenshot to /out.
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
  const items = page.locator('.statusbar .agent-item');
  const desktop = profile.startsWith('desktop');
  const lineOf = async agent => ((await page.locator(`.statusbar [data-bar="agent-${agent}"] summary`).innerText()) || '').replace(/\s+/g, ' ').trim();
  check('one item per agent, and none of the two old items', (await items.count()) === 2 && (await page.locator('.statusbar .allowance-item, .statusbar [data-bar="agents"]').count()) === 0, await items.count());
  check('claude reads: name, W 14%, 5h 1%', (await lineOf('claude')) === 'claude W 14% 5h 1%', await lineOf('claude'));
  check('codex reads: name, role, W 31%, 5h unknown (never 0%)', (await lineOf('codex')) === (desktop ? 'codex Implementer W 31% 5h unknown ◷' : 'codex W 31% 5h unknown ◷'), await lineOf('codex'));
  check('claude has an idle dot and codex a paused dot', (await page.locator('[data-bar="agent-claude"] .ai-dot[data-state="idle"]').count()) === 1 && (await page.locator('[data-bar="agent-codex"] .ai-dot[data-state="paused"]').count()) === 1);
  const tip = (await page.locator('[data-bar="agent-claude"] summary').getAttribute('title')) || '';
  check('the tooltip holds the reset times and the reading age', /resets 2026-11-19 04:00 UTC/.test(tip) && /resets 2026-11-13 00:40 UTC/.test(tip) && /Read 14m ago/.test(tip), tip);
  check('the bar does not print reset times, wording or age', !/resets|Read |ago|OK|High/.test(await page.locator('.statusbar summary').allInnerTexts().then(t => t.join(' '))));
  const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check('the page does not scroll sideways', await noScroll());
  const rows = await page.evaluate(() => { const bar = document.querySelector('.statusbar'); const mids = [...bar.children].filter(e => e.getBoundingClientRect().height > 0 && !e.classList.contains('bar-picker')).map(e => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }); return { height: Math.round(bar.getBoundingClientRect().height), spread: Math.max(...mids) - Math.min(...mids) }; });
  if (desktop) check('the whole bar is one row', rows.spread <= 16 && rows.height < 70, JSON.stringify(rows));
  else check('the phone bar wraps to at most one extra row of items', (await page.evaluate(() => new Set([...document.querySelectorAll('.statusbar .agent-item')].map(e => Math.round(e.getBoundingClientRect().top))).size)) <= 2, JSON.stringify(rows));
  const claude = page.locator('.statusbar [data-bar="agent-claude"]');
  check('the detail is closed until the item is focused or tapped', !(await claude.locator('.ai-detail').isVisible()));
  if (desktop) { await claude.locator('summary').focus(); await page.keyboard.press('Enter'); } else await claude.locator('summary').tap();
  check('opening the item shows the detail with the reset times and the OK wording', await claude.locator('.ai-detail').isVisible() && /OK, resets/.test(await claude.locator('.ai-detail').innerText()) && (await claude.locator('.ai-detail time').count()) === 2);
  check('the open detail causes no sideways scroll', await noScroll());
  // The periodic refresh swaps the status-bar figures; an open detail (and its focus) must survive it (a fresher reading age is served).
  const pagePath = arg('page') || '/card.html';
  await page.route(`**${pagePath}`, async r => { const res = await r.fetch(); await r.fulfill({ response: res, body: (await res.text()).replace('Read 14m ago', 'Read 15m ago') }); });
  await page.locator('.refresh-now').click();
  await page.waitForFunction(() => /Read 15m ago/.test(document.querySelector('[data-bar="agent-claude"] summary')?.title || ''), null, { timeout: 5000 });
  check('an open detail stays open after the page refreshes the figures', await claude.locator('details').evaluate(d => d.open) && await claude.locator('.ai-detail').isVisible());
  await page.unroute(`**${pagePath}`);
  await page.screenshot({ path: path.join(out, `${name}-detail.png`) });
  await Promise.all([page.waitForURL('**/usage'), claude.locator('.ai-detail a', { hasText: 'Usage page' }).click()]);
  check('the item links to the Usage page', /\/usage$/.test(page.url()), page.url());
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });
  const codex = page.locator('.statusbar [data-bar="agent-codex"]');
  if (desktop) {
    await page.click('#barEdit');
    await codex.locator('.bar-ctl button', { hasText: '✕' }).click();
    check('a removed item leaves the bar', !(await codex.isVisible()));
    await page.reload({ waitUntil: 'networkidle' });
    check('the removal is saved and restored for this viewer', !(await page.locator('.statusbar [data-bar="agent-codex"]').isVisible()));
    await page.click('#barEdit');
    await page.locator('.bar-picker summary').click();
    await page.locator('.bar-picker li', { hasText: 'Agent: codex' }).locator('button').click();
    check('a restored item is back', await page.locator('.statusbar [data-bar="agent-codex"]').isVisible());
    await page.click('#barEdit');
  }
  await page.evaluate(() => localStorage.setItem('dash.appbar', JSON.stringify({ v: 1, order: ['allowance-codex', 'agents'], removed: ['allowance-claude'] })));
  await page.reload({ waitUntil: 'networkidle' });
  const shown = async a => page.locator(`.statusbar [data-bar="agent-${a}"]`).isVisible();
  if (desktop) check('a saved layout holding the old items is migrated: codex kept, claude still removed', (await shown('codex')) && !(await shown('claude')));
  else check('a saved layout holding the old items leaves the phone bar with its items', (await shown('codex')) && (await shown('claude')));
  check('the migrated bar is not blank', (await page.locator('.statusbar .agent-item:visible').count()) >= 1);
  await page.evaluate(() => localStorage.removeItem('dash.appbar'));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.reload({ waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500) }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
