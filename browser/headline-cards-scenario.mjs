#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Issue #1453: the summary cards on the real Overview, served by the
// dashboard's own request handler over a state holding the real example (First review approval 41.2%, Rejects 84). Reads the cards, clicks the real
// period control, then checks the page after the click, after a refresh in place and after a reload (drawn with the saved choice before the first
// paint), and that nothing is clipped or scrolls sideways. Writes <name>.json (and a screenshot) to /out.
// Usage: node headline-cards-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'headline-cards', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const squash = s => String(s).replace(/\s+/g, ' ').trim();
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  // Records what the card's period was when the document was parsed and at the first frame: a flash would show 24h there.
  await ctx.addInitScript(() => {
    window.__period = {};
    const note = k => { const c = document.querySelector('#c-hl-first-pass'); if (c) window.__period[k] = c.dataset.period || null; };
    document.addEventListener('DOMContentLoaded', () => { note('parsed'); requestAnimationFrame(() => note('frame')); });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  let navigations = 0; page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++; });
  const card = id => page.locator(`#c-hl-${id}`);
  const shown = id => card(id).locator('.hl-block:visible');
  const read = async id => squash(await shown(id).innerText());
  const tone = id => shown(id).locator('.hl-badge').getAttribute('data-tone');

  await page.goto(url('/'), { waitUntil: 'networkidle' });
  const first = await read('first-pass');
  check('first review approval shows one period, Last 24 hours', await shown('first-pass').count() === 1 && /Last 24 hours/.test(first), first);
  check('first review approval shows 41.2% and Previous 34.1%', /41\.2%/.test(first) && /Previous 34\.1%/.test(first), first);
  check('first review approval has an up arrow and a green badge reading +7.1 pp and +20.8%', await shown('first-pass').locator('.hl-arrow[data-dir="up"]').count() === 1 && await tone('first-pass') === 'good' && /\+7\.1 pp \+20\.8%/.test(first), first);
  const colourOf = (loc, v) => loc.evaluate((e, name) => { const t = document.createElement('i'); t.style.color = `var(${name})`; document.body.append(t); const want = getComputedStyle(t).color; t.remove(); return getComputedStyle(e).color === want; }, v);
  check('the badge and arrow are really the existing green', await colourOf(shown('first-pass').locator('.hl-badge'), '--ok') && await colourOf(shown('first-pass').locator('.hl-arrow'), '--ok'));
  check('the detail and the best so far line are kept', /28 of 68 approved first time; 7 more rejected for the description only/.test(first) && /Best 24 hours 84\.9% \(45 of 53\), 6 to 7 Nov/.test(first), first);
  check('the main number still links to its items page', await shown('first-pass').locator('a.hl-v').getAttribute('href') === '/headline/first-pass?window=24h');
  const rejects = await read('rejects');
  check('rejects shows 84, a down arrow, a green badge reading -8 and -8.7%, Previous 92', /\b84\b/.test(rejects) && await shown('rejects').locator('.hl-arrow[data-dir="down"]').count() === 1 && await tone('rejects') === 'good' && /-8 -8\.7%/.test(rejects) && /Previous 92/.test(rejects), rejects);

  // ---- the period control
  const before = await read('first-pass');
  await card('first-pass').locator('[data-hl-period="7d"]').click();
  const after = await read('first-pass');
  check('clicking 7d shows the Last 7 days block only, with other figures', await shown('first-pass').count() === 1 && /Last 7 days/.test(after) && after !== before, after);
  check('the control marks the chosen period', await card('first-pass').locator('[data-hl-period="7d"]').getAttribute('aria-pressed') === 'true' && await card('first-pass').locator('[data-hl-period="24h"]').getAttribute('aria-pressed') === 'false');
  check('another card stays on Last 24 hours', /Last 24 hours/.test(await read('rejects')));
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('dash.period.overview.')).map(([, v]) => JSON.parse(v)));
  check('the choice is saved per card', saved.length === 1 && saved[0]['hl-first-pass'] === '7d' && !('hl-rejects' in saved[0]), JSON.stringify(saved));

  const navBefore = navigations;
  await page.locator('button.refresh-now').evaluate(b => b.click());
  await page.waitForTimeout(1500);
  check('a refresh in place keeps the chosen period and does not reload', navigations === navBefore && /Last 7 days/.test(await read('first-pass')) && await card('first-pass').locator('[data-hl-period="7d"]').getAttribute('aria-pressed') === 'true', await read('first-pass'));

  await page.reload({ waitUntil: 'networkidle' });
  const early = await page.evaluate(() => window.__period);
  check('after a reload the page is drawn with the saved period, before the first frame', early.parsed === '7d' && early.frame === '7d', JSON.stringify(early));
  check('after a reload the 7 days figures show', /Last 7 days/.test(await read('first-pass')) && /Last 24 hours/.test(await read('rejects')));

  await card('first-pass').locator('[data-hl-period="24h"]').click();
  check('switching back to 24 hours shows the first figures and forgets the saved choice', await read('first-pass') === before && await page.evaluate(() => Object.keys(localStorage).every(k => !k.startsWith('dash.period.'))));

  // ---- a card is as tall as its content and its text wraps
  const geo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card.headline')];
    return {
      over: document.documentElement.scrollWidth - innerWidth,
      clipped: cards.filter(c => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map(c => c.dataset.card),
      badgeClipped: [...document.querySelectorAll('.hl-block:not([style*="none"]) .hl-badge')].filter(b => b.offsetParent && b.scrollWidth > b.clientWidth + 1).length,
      // empty space under the content, past the card's own padding: none when the card is only as tall as what it holds
      tall: cards.filter(c => c.getBoundingClientRect().bottom - Math.max(...[...c.children].map(k => k.getBoundingClientRect().bottom)) > 40).map(c => c.dataset.card),
    };
  });
  check('no sideways scroll, no clipped card or badge, no card taller than its content needs', geo.over <= 0 && geo.clipped.length === 0 && geo.badgeClipped === 0 && geo.tall.length === 0, JSON.stringify(geo));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 600)); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
