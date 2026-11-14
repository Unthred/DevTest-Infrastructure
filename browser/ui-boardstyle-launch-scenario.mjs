#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the Launch pad style on the live board screen at
// /api/v1/ui#/board served by the dashboard's own request handler (issue #1319). The host test serves /__fixture/<step> (the model changes and a
// change event is sent) and /__fixture/quiet/<step> (it changes with no event). Checks: Launch pad is offered in the switch and draws one pad per
// lane and one per box and nothing else in the middle; a job that lands with CHANGES is seen above its lane head, then in the middle with a trail,
// then at rest in Changes asked with no trail; two jobs landing in one change show two trails; with reduced motion no ball is seen between two
// places and no trail is drawn.
// Usage: node ui-boardstyle-launch-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-boardstyle-launch', out = arg('out') || '/out';
const checks = [], pageErrors = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail).slice(0, 400) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const options = { ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' };
const step = (ctx, which, quiet = false) => ctx.request.get(url(`/__fixture/${quiet ? 'quiet/' : ''}${which}`));

// A board with the Launch pad style chosen, the model in the state `before`.
async function openLaunch(ctx, before) {
  await step(ctx, before, true);
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto(url('/api/v1/ui#/board'), { waitUntil: 'load' });
  await page.locator('.board-svg').waitFor({ timeout: 10000 });
  await page.locator('.board-switch [data-style-choice="launch"]').waitFor({ timeout: 10000 });
  await page.locator('.board-switch [data-style-choice="launch"]').click();
  await page.waitForTimeout(300);
  return page;
}

// Samples the page on every frame until `ms` have passed: where the circle of each watched ball is, and how many trails are drawn.
const sampler = (page, keys, ms) => page.evaluate(([watched, span]) => new Promise(resolve => {
  const frames = [];
  const begin = performance.now();
  const tick = () => {
    const balls = {};
    for (const key of watched) {
      const r = document.querySelector(`.board-svg [data-ball="${key}"] circle`)?.getBoundingClientRect();
      balls[key] = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }
    frames.push({ balls, trails: document.querySelectorAll('.board-svg .flight-trail').length, animations: document.getAnimations().length });
    if (performance.now() - begin < span) requestAnimationFrame(tick); else resolve(frames);
  };
  tick();
}), [keys, ms]);

const rectOf = (page, selector) => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }, selector);
const within = (p, r) => p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

async function scenery() {
  const ctx = await browser.newContext(options);
  const page = await openLaunch(ctx, 'base');
  const radios = page.locator('.board-switch [role="radio"]');
  check('Launch pad is offered in the switch', (await radios.allTextContents()).includes('Launch pad'));
  check('the board is drawn in the Launch pad style', (await page.evaluate(() => document.querySelector('.board-svg').dataset.style)) === 'launch');
  const lanes = await page.locator('.board-svg .lane').count();
  check('one launch pad per lane and one landing pad per box', (await page.locator('.board-svg .launch-pad').count()) === lanes && lanes === 3
    && (await page.locator('.board-svg .landing-pad').count()) === 9, `${lanes} lanes`);
  const middle = await page.evaluate(() => [...document.querySelector('.board-svg').children].map(node => node.getAttribute('class') ?? node.tagName)
    .filter(cls => !/^(defs|launch-pad|landing-pad|group|hopper|box|ball)\b/.test(cls)));
  check('nothing else is drawn in the middle: no pegs, no tracks, no trail at rest', middle.length === 0, middle.join());
  const padsAbove = await page.evaluate(() => [...document.querySelectorAll('.board-svg .launch-pad')].every(pad => {
    const lane = document.querySelector(`.board-svg [data-lane="${CSS.escape(pad.dataset.launchPad)}"]`).getBoundingClientRect();
    const r = pad.getBoundingClientRect();
    return r.bottom <= lane.top + 1 && Math.abs((r.left + r.right) / 2 - (lane.left + lane.right) / 2) < 2;
  }));
  const padsOnTop = await page.evaluate(() => [...document.querySelectorAll('.board-svg .landing-pad')].every(pad => {
    const box = document.querySelector(`.board-svg [data-box="${CSS.escape(pad.dataset.landingPad)}"] .box-rect`).getBoundingClientRect();
    const r = pad.getBoundingClientRect();
    return Math.abs((r.top + r.bottom) / 2 - box.top) < 3 && Math.abs((r.left + r.right) / 2 - (box.left + box.right) / 2) < 2;
  }));
  check('each launch pad is at the head of its lane and each landing pad on the top edge of its box', padsAbove && padsOnTop);
  await ctx.close();
}

async function landing() {
  const ctx = await browser.newContext(options);
  const page = await openLaunch(ctx, 'base');
  await step(ctx, 'start');
  await page.waitForTimeout(1500);
  const lane = await rectOf(page, '.board-svg [data-lane="claude/opus"]');
  const hopper = await rectOf(page, '.board-svg .hopper-box');
  const box = await rectOf(page, '.board-svg [data-box="changes_asked"] .box-rect');
  const watching = sampler(page, ['landed:6ff7be3f'], 4200);
  await step(ctx, 'land');
  const frames = await watching;
  const spots = frames.map(frame => ({ ball: frame.balls['landed:6ff7be3f'], trails: frame.trails }));
  const aboveHead = spots.some(spot => spot.ball && spot.ball.x >= lane.left && spot.ball.x <= lane.right && spot.ball.y < lane.top + 40);
  const inSky = spots.filter(spot => spot.ball && spot.ball.x > lane.right + 10 && spot.ball.y > lane.top && spot.ball.y < hopper.top);
  check('the ball is seen above the head of its lane', aboveHead);
  check('then in the middle area with a trail', inSky.length > 5 && inSky.every(spot => spot.trails === 1), `${inSky.length} frames, trails ${[...new Set(inSky.map(spot => spot.trails))]}`);
  const last = spots.at(-1);
  check('then at rest in Changes asked with no trail', within(last.ball, box) && last.trails === 0 && frames.at(-1).animations === 0, JSON.stringify(last));
  const edge = await page.evaluate(() => document.querySelector('.board-svg .flight-trail')?.getAttribute('stroke-dasharray') ?? null);
  check('no trail is left in the drawing after the landing', edge === null && (await page.locator('.board-svg .flight-trail').count()) === 0);
  await ctx.close();
}

async function twoAtOnce() {
  const ctx = await browser.newContext(options);
  const page = await openLaunch(ctx, 'start');
  const watching = sampler(page, [], 3500);
  await step(ctx, 'land2');
  const frames = await watching;
  check('two jobs landing in one change show two trails at once', Math.max(...frames.map(frame => frame.trails)) === 2, `most ${Math.max(...frames.map(frame => frame.trails))}`);
  check('and no trail is left at the end', frames.at(-1).trails === 0);
  await ctx.close();
}

async function reducedMotion() {
  const ctx = await browser.newContext({ ...options, reducedMotion: 'reduce' });
  const page = await openLaunch(ctx, 'start');
  check('with reduced motion the pads are drawn', (await page.locator('.board-svg .launch-pad').count()) === 3 && (await page.locator('.board-svg .landing-pad').count()) === 9);
  const watching = sampler(page, ['landed:6ff7be3f'], 3000);
  await step(ctx, 'land');
  const frames = await watching;
  const places = new Set(frames.map(frame => frame.balls['landed:6ff7be3f']).filter(Boolean).map(p => `${Math.round(p.x)},${Math.round(p.y)}`));
  check('no ball is seen between two places', places.size === 1, [...places].join(' | '));
  check('no trail is drawn and nothing animates', frames.every(frame => frame.trails === 0 && frame.animations === 0));
  await ctx.close();
}

try {
  await scenery();
  await landing();
  await twoAtOnce();
  await reducedMotion();
  check('no script errors in any page', pageErrors.length === 0, pageErrors.join('; '));
} catch (e) { check('the scenario ran to the end', false, `${String(e.stack || e).slice(0, 600)} page errors: ${pageErrors.join('; ')}`); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
