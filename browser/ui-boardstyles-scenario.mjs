#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the board style switch on the live board screen at
// /api/v1/ui#/board served by the dashboard's own request handler (issue #1315). The host test serves /__fixture/styles/on and /off (whether a
// second style file, Marble run, is served) and /__fixture/start (a launch). Checks: with only peg served there is no switch and one console
// line per missing style; with a second style served the switch shows two radios, choosing the second redraws the middle and keeps every ball
// where it was with no animation, the choice survives a reload, the arrow keys move the choice, a travel in progress ends at its destination
// when the switch is used, a blocked store does not stop the switch, and at 390 px there is no switch.
// Usage: node ui-boardstyles-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-boardstyles', out = arg('out') || '/out';
const wide = PROFILES[profile].viewport.width >= 640;
const checks = [], pageErrors = [], lines = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail).slice(0, 400) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const options = { ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' };

async function newContext(initScript) {
  const ctx = await browser.newContext(options);
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  if (initScript) await ctx.addInitScript(initScript);
  return ctx;
}
async function openBoard(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
  page.on('console', m => { if (m.text().startsWith('Board style')) lines.push(m.text()); });
  await page.goto(url('/api/v1/ui#/board'), { waitUntil: 'load' });
  await page.locator(wide ? '.board-svg' : '.board-lists').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  return page;
}
const styles = on => fetch(url(`/__fixture/styles/${on ? 'on' : 'off'}`));
// Where every ball of the drawing is, by key.
const places = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.board-svg [data-ball]')].map(node => {
  const r = node.querySelector('circle').getBoundingClientRect();
  return [node.dataset.ball, `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`];
})));
const drawnStyle = page => page.evaluate(() => document.querySelector('.board-svg')?.dataset.style ?? null);

async function pegOnly() {
  await styles(false);
  const ctx = await newContext();
  const page = await openBoard(ctx);
  check('with only peg served there is no switch', (await page.locator('.board-switch').count()) === 0);
  check('the console says once for each style that did not load, and no script error', lines.length === 2 && lines.some(l => l.includes('marble')) && lines.some(l => l.includes('launch')) && pageErrors.length === 0, lines.join(' | '));
  if (wide) {
    check('the peg board is drawn', (await drawnStyle(page)) === 'peg' && (await page.locator('.board-svg .pegs').count()) === 1 && (await page.locator('#peg .peg-dot').count()) === 2);
    check('the common parts are drawn: hopper, lanes, nine boxes, balls', (await page.locator('.board-svg .hopper').count()) === 1 && (await page.locator('.board-svg .lane').count()) === 3
      && (await page.locator('.board-svg .box').count()) === 9 && (await page.locator('.board-svg [data-ball]').count()) > 5);
  }
  await ctx.close();
}

async function twoStyles() {
  await styles(true);
  const ctx = await newContext();
  const page = await openBoard(ctx);
  if (!wide) {
    check('at 390 px there is no switch though two styles loaded', (await page.locator('.board-switch').count()) === 0 && (await page.locator('.board-svg').count()) === 0);
    await ctx.close();
    return;
  }
  const radios = page.locator('.board-switch [role="radio"]');
  check('with a second style served the switch is a labelled radio group with two choices', (await page.locator('.board-switch[role="radiogroup"][aria-label]').count()) === 1 && (await radios.count()) === 2
    && (await radios.allTextContents()).join() === 'Peg board,Marble run');
  check('peg is chosen when nothing was saved', (await radios.nth(0).getAttribute('aria-checked')) === 'true' && (await radios.nth(1).getAttribute('aria-checked')) === 'false'
    && (await radios.nth(1).getAttribute('tabindex')) === '-1');
  const before = await places(page);
  const stale = await page.evaluate(() => { window.__noNavigation = true; return document.querySelector('.board-svg .pegs') !== null; });
  await radios.nth(1).click();
  check('choosing the second style redraws the middle at once', (await drawnStyle(page)) === 'marble' && (await page.locator('.board-svg .marble-track').count()) === 1
    && (await page.locator('.board-svg .pegs').count()) === 0 && stale);
  check('every ball is where it was and nothing animates', JSON.stringify(await places(page)) === JSON.stringify(before) && (await page.evaluate(() => document.getAnimations().length)) === 0);
  check('the chosen radio is marked and the page was not reloaded', (await radios.nth(1).getAttribute('aria-checked')) === 'true' && (await page.evaluate(() => window.__noNavigation === true)));
  await page.reload({ waitUntil: 'load' });
  await page.locator('.board-svg').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  check('after a reload the second style is still chosen', (await drawnStyle(page)) === 'marble' && (await radios.nth(1).getAttribute('aria-checked')) === 'true');
  await radios.nth(1).focus();
  await page.keyboard.press('ArrowLeft');
  check('the left arrow moves the choice to peg and keeps the focus on the switch', (await drawnStyle(page)) === 'peg'
    && (await page.evaluate(() => document.activeElement?.dataset.styleChoice)) === 'peg');
  await page.keyboard.press('ArrowRight');
  check('the right arrow moves it back, and the arrows wrap round', (await drawnStyle(page)) === 'marble');
  await page.keyboard.press('ArrowRight');
  check('after the last style the arrow goes to the first', (await drawnStyle(page)) === 'peg');
  await page.keyboard.press('Tab');
  check('the switch is one tab stop', (await page.evaluate(() => document.activeElement?.closest('.board-switch') === null)));
  await travelEnds(ctx, page);
  await ctx.close();
}

// A launch is under way when the switch is used: no travel plays because of the switch and the ball is at its destination.
async function travelEnds(ctx, page) {
  await page.locator('.board-switch [data-style-choice="peg"]').click();
  await ctx.request.get(url('/__fixture/start'));
  await page.waitForFunction(() => document.getAnimations().length > 0, null, { timeout: 5000 });
  await page.locator('.board-switch [data-style-choice="marble"]').click();
  check('using the switch during a travel ends it: no animation is left', (await page.evaluate(() => document.getAnimations().length)) === 0);
  const lane = await page.evaluate(() => { const r = document.querySelector('.board-svg [data-lane="claude/opus"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  const spot = await page.evaluate(() => { const r = document.querySelector('.board-svg [data-ball="running:6ff7be3f"] circle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  check('the ball is drawn at its destination inside its lane', spot.x >= lane.left && spot.x <= lane.right && spot.y >= lane.top && spot.y <= lane.bottom, JSON.stringify([spot, lane]));
}

async function blockedStore() {
  await styles(true);
  const ctx = await newContext(() => {
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
  });
  const page = await openBoard(ctx);
  await page.locator('.board-switch [data-style-choice="marble"]').click();
  check('when the store is blocked the switch still works for the visit', (await drawnStyle(page)) === 'marble');
  await page.reload({ waitUntil: 'load' });
  await page.locator('.board-svg').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  check('and the next visit shows peg, with no script error', (await drawnStyle(page)) === 'peg' && pageErrors.length === 0, pageErrors.join('; '));
  await ctx.close();
}

try {
  await pegOnly();
  await twoStyles();
  if (wide) await blockedStore();
  check('no script errors in any page', pageErrors.length === 0, pageErrors.join('; '));
} catch (e) { check('the scenario ran to the end', false, `${String(e.stack || e).slice(0, 600)} page errors: ${pageErrors.join('; ')}`); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
