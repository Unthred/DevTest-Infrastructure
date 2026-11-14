#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real About box of the web shell at /api/v1/ui, served
// by the dashboard's own request handler over the real about model (see tests/ui-about-browser.mjs for the data): nothing loaded before the click,
// the open part, the closed parts, the technical numbers only after opening, text with angle brackets, the failed fetch and Try again, focus
// return, and the phone fit. The browser clock is fixed to the dashboard's "now", 14 Nov 2026 12:00 UTC. Writes <name>.json to /out.
// Usage: node ui-about-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-about', out = arg('out') || '/out';
const SENTENCE = 'The agent choice starts a job whenever a candidate actually has room left for it.';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail).slice(0, 400) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const flat = text => text.replace(/\s+/g, ' ');
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.clock.setFixedTime(new Date(Date.UTC(2026, 10, 14, 12, 0, 0)));
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = [], requested = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  page.on('request', r => { const u = new URL(r.url()); if (u.protocol === 'http:') requested.push(u.pathname); });
  const dialog = page.locator('dialog.about'), button = page.locator('[data-about]');
  const text = async () => flat(await dialog.innerText());
  const partOf = title => dialog.locator('details.about-part', { has: page.locator('summary', { hasText: title }) }).last();

  await page.goto(url('/api/v1/ui'), { waitUntil: 'load' });
  await button.waitFor({ timeout: 10000 });
  check('an About button is the last item of the app bar', (await page.evaluate(() => document.getElementById('appbar').lastElementChild.hasAttribute('data-about'))));
  check('the box is closed and nothing was fetched from the about model before the click', (await dialog.isHidden()) && !requested.includes('/api/v1/about'), requested.join(','));
  await page.waitForTimeout(500);

  await button.click();
  await partOf('What is new in this version').waitFor({ timeout: 10000 });
  check('a click on About opens the box and fetches the model', (await dialog.isVisible()) && requested.includes('/api/v1/about'));
  let box = await text();
  check('the top shows the name, the short version and when it was installed in words', /Foreman/.test(box) && /f748e46/.test(box) && /Installed today at 09:18/.test(box), box);
  check('one status line is shown', (await dialog.locator('.about-status').count()) === 1 && /Up to date|waiting to install|paused|not known/.test(await dialog.locator('.about-status').innerText()));

  const isOpen = async title => partOf(title).evaluate(node => node.open);
  check('What is new in this version is open, Earlier and Technical details are closed', (await isOpen('What is new in this version')) && !(await isOpen('Earlier')) && !(await isOpen('Technical details')));
  const fresh = partOf('What is new in this version');
  const headings = await fresh.locator('h4').allInnerTexts();
  check('the install with changes in two groups shows exactly two headings', JSON.stringify(headings.map(h => h.toLowerCase())) === JSON.stringify(['fixed', 'screens']), headings.join(','));
  const fixedItems = await fresh.locator('h4:text-is("Fixed") + ul li').allInnerTexts();
  check('the plain sentence is under Fixed', fixedItems.length === 1 && fixedItems[0] === SENTENCE, fixedItems.join('|'));
  const open = flat(await fresh.innerText());
  check('the code word and the pull request number are not shown in the open part', !/Roomgate/.test(open) && !/1425|1424/.test(open) && !/Roomgate|1425/.test(await text()), open);
  const literal = await fresh.locator('.about-changes li').allInnerTexts();
  check('text with angle brackets is shown as text', literal.some(t => t.includes('<b>bold</b>')) && (await fresh.locator('.about-changes b').count()) === 0, literal.join('|'));
  check('no link leaves the box', (await dialog.locator('a').count()) === 0);

  check('Earlier is closed, so its days are not shown', !/Yesterday/.test(await text()));
  await partOf('Earlier').locator('summary').first().click();
  box = await text();
  check('Earlier holds one part per day with its count, closed at first', /Yesterday \(2 changes\)/.test(box) && /Thu 12 Nov \(1 change\)/.test(box) && !/1 changes/.test(box)
    && !(await isOpen('Yesterday')) && !(await isOpen('Thu 12 Nov')), box);
  await partOf('Yesterday').locator('summary').first().click();
  box = await text();
  check('opening a day shows its changes under group headings', /The menu opens faster/.test(box) && /improved/i.test(box) && /The old settings files are gone/.test(box) && /tidying/i.test(box), box);
  const daySummaries = await partOf('Earlier').locator('details > summary').allTextContents();
  const dayTexts = await partOf('Earlier').locator('details').allTextContents();
  check('the current install is not repeated in Earlier: exactly two day parts, none for Today, none holding its sentence',
    daySummaries.length === 2 && !daySummaries.some(t => /Today/.test(t)) && !dayTexts.some(t => t.includes(SENTENCE)), daySummaries.join('|'));

  check('the technical numbers are not shown while Technical details is closed', !/1425/.test(box) && !/Pull request/.test(box));
  await partOf('Technical details').locator('summary').first().click();
  box = await text();
  check('opening Technical details shows the full commit, the commit of main, the MCP version and the processes', /f748e468cf21be20e62d99b5c3a5d9c28b36f084/.test(box) && /Commit of main/.test(box) && /MCP server version/.test(box) && /processes/i.test(box), box);
  check('opening Technical details shows the pull request and issue numbers as text only', /Pull request 1425, issue 1424/.test(box) && /Pull request 1426, issue 1427/.test(box) && (await dialog.locator('a').count()) === 0, box);
  await page.screenshot({ path: path.join(out, `${name}-open.png`) });

  const geo = await page.evaluate(() => {
    const d = document.querySelector('dialog.about'), c = d.querySelector('.about-content');
    return { dialogWidth: Math.round(d.getBoundingClientRect().width), dialogHeight: Math.round(d.getBoundingClientRect().height), over: d.scrollWidth - d.clientWidth,
      overflowY: getComputedStyle(c).overflowY, scrolls: c.scrollHeight > c.clientHeight, inner: [innerWidth, innerHeight] };
  });
  check('the box does not scroll sideways and its content scrolls', geo.over <= 0 && geo.overflowY === 'auto', JSON.stringify(geo));
  if (profile.startsWith('phone')) {
    check('at phone width the box fills the screen', geo.dialogWidth === geo.inner[0] && geo.dialogHeight === geo.inner[1], JSON.stringify(geo));
    check('with every part open the content has more to scroll than fits', geo.scrolls, JSON.stringify(geo));
  }

  await page.keyboard.press('Escape');
  check('Escape closes the box and focus returns to the About button', (await dialog.isHidden()) && (await page.evaluate(() => document.activeElement?.hasAttribute('data-about'))));
  await button.click();
  await partOf('What is new in this version').waitFor();
  await page.locator('.about-close').click();
  check('Close closes the box and focus returns to the About button', (await dialog.isHidden()) && (await page.evaluate(() => document.activeElement?.hasAttribute('data-about'))));
  await button.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'visible' });
  await partOf('What is new in this version').waitFor();
  const summary = partOf('Earlier').locator('summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  check('a part opens from the keyboard', await isOpen('Earlier'));
  await page.keyboard.press('Escape');

  await ctx.request.get(url('/__fixture/about-fail-on'));
  await button.click();
  await dialog.locator('[data-about-retry]').waitFor({ timeout: 10000 });
  box = await text();
  check('a failed fetch shows one line and Try again, and no list', /could not be loaded/.test(box) && (await dialog.locator('details').count()) === 0 && !/Nothing new is recorded/.test(box), box);
  await ctx.request.get(url('/__fixture/about-fail-off'));
  await dialog.locator('[data-about-retry]').click();
  await partOf('What is new in this version').waitFor({ timeout: 10000 });
  check('after Try again succeeds the content is shown', (await text()).includes(SENTENCE) && (await dialog.locator('[data-about-retry]').count()) === 0);
  await page.keyboard.press('Escape');

  await page.goto(url('/api/v1/ui/index.html?empty=1'), { waitUntil: 'load' });
  await button.waitFor({ timeout: 10000 });
  await button.click();
  await partOf('What is new in this version').waitFor({ timeout: 10000 });
  check('with no installs the first part says Nothing new is recorded yet', /Nothing new is recorded yet/.test(await partOf('What is new in this version').innerText()));

  const outside = requested.filter(p => !p.startsWith('/api/v1/') && !p.startsWith('/__fixture/'));
  check('every request the page made stays under /api/v1/', outside.length === 0, outside.join(', '));
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 600)); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
