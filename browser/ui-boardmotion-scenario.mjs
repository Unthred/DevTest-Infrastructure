#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives ball travel on the live board screen at /api/v1/ui#/board
// served by the dashboard's own request handler and router (issue #1313). The host test serves /__fixture/<step> (model changes and the change event
// is sent) and /__fixture/quiet/<step> (model changes, no event). It watches the ball on every animation frame and checks: nothing moves on open,
// a launch passes between the hopper and the lane, a land passes through the peg area into Changes asked in 1.5 to 3 s and can be clicked on the
// way, a return rolls back to the hopper and shows one more lap, reduced motion moves nothing, and 13 changes in one event show a count.
// Usage: node ui-boardmotion-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-boardmotion', out = arg('out') || '/out';
const checks = [], pageErrors = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail).slice(0, 400) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;

// In the page: samples the centre of the ball with a key on every animation frame for ms milliseconds, with its laps text.
const watch = ({ key, ms }) => new Promise(resolve => {
  const samples = [], begin = performance.now();
  const frame = () => {
    const node = document.querySelector(`.board-svg [data-ball="${CSS.escape(key)}"]`);
    const box = node?.querySelector('circle').getBoundingClientRect();
    samples.push({ t: performance.now() - begin, x: box ? box.left + box.width / 2 : null, y: box ? box.top + box.height / 2 : null,
      laps: node?.querySelector('.laps')?.textContent ?? null, animating: document.getAnimations().length });
    if (performance.now() - begin < ms) requestAnimationFrame(frame); else resolve(samples);
  };
  requestAnimationFrame(frame);
});
const rectOf = (page, selector) => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }, selector);
const within = (p, r, pad = 0) => p.x !== null && p.x >= r.left - pad && p.x <= r.right + pad && p.y >= r.top - pad && p.y <= r.bottom + pad;
const present = samples => samples.filter(s => s.x !== null);
const moving = samples => present(samples).filter(s => s.animating > 0);

async function openBoard(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto(url('/api/v1/ui#/board'), { waitUntil: 'load' });
  await page.locator('.board-svg').waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  return page;
}

async function openChecks(page) {
  check('on open nothing is moving and no animation exists', await page.evaluate(() => document.getAnimations().length === 0));
  const before = await page.locator('.board-svg [data-ball]').count();
  await page.waitForTimeout(500);
  check('on open the balls are at rest and no timer moves them', await page.evaluate(() => document.getAnimations().length === 0) && (await page.locator('.board-svg [data-ball]').count()) === before);
  await page.evaluate(() => { window.__noNavigation = true; });
}

async function launchChecks(page, ctx) {
  const hopper = await rectOf(page, '.board-svg .hopper .hopper-box');
  const slotBefore = await page.evaluate(() => { const r = document.querySelector('.board-svg [data-ball="waiting:3"] circle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const spare = await page.locator('.board-svg .hopper [data-ball="waiting:1"]').count();
  const watching = page.evaluate(watch, { key: 'running:6ff7be3f', ms: 2500 });
  await ctx.request.get(url('/__fixture/start'));
  const samples = await watching;
  const lane = await rectOf(page, '.board-svg [data-lane="claude/opus"]');
  const seen = present(samples), rest = seen[seen.length - 1];
  const between = moving(samples).filter(s => s.y > lane.bottom - 120 && s.y < hopper.top + 5 && s.y > lane.top);
  check('after the change event the ball is seen at points between the hopper and the lane', between.length >= 5 && moving(samples).some(s => within(s, hopper, 30)),
    `${between.length} between, ${moving(samples).length} moving, first ${JSON.stringify(seen[0])}`);
  check('the launching ball starts at its hopper place and ends at rest inside its lane', Math.abs(seen[0].y - slotBefore.y) < 60 && within(rest, lane) && rest.animating === 0, JSON.stringify([seen[0], rest, slotBefore]));
  check('the launch takes about 0.9 s and the ball then stays put', (() => { const m = moving(samples); const span = m[m.length - 1].t - m[0].t; return span > 500 && span < 1400; })());
  check('the ball has left the hopper: two balls remain, with no reload', spare === 1 && (await page.locator('.board-svg .hopper .ball').count()) === 2 && (await page.evaluate(() => window.__noNavigation === true)));
}

async function landChecks(page, ctx) {
  const pegs = await rectOf(page, '.board-svg .pegs');
  const watching = page.evaluate(watch, { key: 'landed:6ff7be3f', ms: 4500 });
  await page.evaluate(() => { window.__clicked = false; });
  await ctx.request.get(url('/__fixture/land'));
  await page.waitForTimeout(900);
  let opened = false;
  for (let attempt = 0; attempt < 6 && !opened; attempt += 1) {
    const centre = await page.evaluate(() => { const c = document.querySelector('.board-svg [data-ball="landed:6ff7be3f"] circle'); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(centre.x, centre.y);
    opened = (await page.locator('#ball-panel').count()) === 1;
  }
  check('a click on a ball that is moving opens its panel', opened);
  await page.screenshot({ path: path.join(out, `${name}-land.png`) });
  const samples = await watching;
  const box = await rectOf(page, '.board-svg [data-box="changes_asked"] .box-rect');
  const seen = present(samples), rest = seen[seen.length - 1], inPegs = moving(samples).filter(s => within(s, pegs));
  check('after the job lands the ball is seen at points inside the peg area', inPegs.length >= 20, `${inPegs.length} samples inside the pegs`);
  check('the ball ends at rest inside Changes asked', within(rest, box) && rest.animating === 0, JSON.stringify([rest, box]));
  const m = moving(samples), span = m[m.length - 1].t - m[0].t;
  check('the land lasts between 1.5 and 3 seconds', span >= 1400 && span <= 3300, `${Math.round(span)} ms`);
  const drawing = await rectOf(page, '.board-svg');
  check('the ball never leaves the board while it falls', moving(samples).every(s => within(s, drawing)), JSON.stringify(drawing));
  await page.keyboard.press('Escape');
}

async function returnChecks(page, ctx) {
  const hopper = await rectOf(page, '.board-svg .hopper .hopper-box');
  const bottom = (await rectOf(page, '.board-svg [data-box="changes_asked"] .box-rect')).bottom;
  const watching = page.evaluate(watch, { key: 'waiting:3', ms: 3200 });
  await ctx.request.get(url('/__fixture/again'));
  const samples = await watching;
  const seen = present(samples), rest = seen[seen.length - 1], travelling = moving(samples);
  check('after the item is waiting again the ball ends in the hopper', within(rest, hopper) && rest.animating === 0, JSON.stringify([rest, hopper]));
  check('the ball rolled along the bottom to get there', travelling.some(s => s.y > bottom - 40) && travelling.some(s => s.y > bottom - 40 && s.x < travelling[0].x - 100), `bottom ${bottom}`);
  check('it ends showing one more lap', rest.laps === '2↻' && (travelling.some(s => s.laps === '1↻')), JSON.stringify([rest.laps, [...new Set(seen.map(s => s.laps))]]));
}

async function manyChecks(ctx) {
  await ctx.request.get(url('/__fixture/quiet/base'));
  const page = await openBoard(ctx);
  const watching = page.evaluate(watch, { key: 'running:many0000', ms: 1800 });
  await ctx.request.get(url('/__fixture/many'));
  const samples = await watching;
  const seen = present(samples);
  check('with 13 changes in one event nothing travels', seen.length > 0 && seen.every(s => s.animating === 0) && new Set(seen.map(s => `${s.x},${s.y}`)).size === 1, `${new Set(seen.map(s => `${s.x},${s.y}`)).size} places`);
  check('the count line says 13 things changed', /13 things changed/.test(await page.locator('.board-changed').innerText()));
  await page.screenshot({ path: path.join(out, `${name}-many.png`) });
  await page.close();
}

async function reducedChecks(browserContext) {
  await browserContext.request.get(url('/__fixture/quiet/base'));
  const page = await openBoard(browserContext);
  check('the browser reports reduced motion', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  const watching = page.evaluate(watch, { key: 'running:6ff7be3f', ms: 2000 });
  await browserContext.request.get(url('/__fixture/start'));
  const samples = await watching;
  const seen = present(samples);
  check('with reduced motion the ball is never seen between two places', seen.length > 0 && new Set(seen.map(s => `${s.x},${s.y}`)).size === 1 && samples.every(s => s.animating === 0));
  await page.close();
}

try {
  const options = { ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' };
  const ctx = await browser.newContext(options);
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await openBoard(ctx);
  await openChecks(page);
  await launchChecks(page, ctx);
  await landChecks(page, ctx);
  await returnChecks(page, ctx);
  await page.close();
  await manyChecks(ctx);
  await ctx.close();
  const reduced = await browser.newContext({ ...options, reducedMotion: 'reduce' });
  await reduced.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  await reducedChecks(reduced);
  await reduced.close();
  check('no script errors in any page', pageErrors.length === 0, pageErrors.join('; '));
} catch (e) { check('the scenario ran to the end', false, `${String(e.stack || e).slice(0, 600)} page errors: ${pageErrors.join('; ')}`); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
