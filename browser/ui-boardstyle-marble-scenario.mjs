#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the Marble run board style on the live board screen at
// /api/v1/ui#/board served by the dashboard's own request handler and router (issue #1318). The host test serves /__fixture/<step>: base, start,
// and land-<box> (the review job of pull request 1244 lands in that box). The scenario watches the ball and every gate on each animation frame.
// Checks: the switch offers Marble run and choosing it draws the tracks, the sorting rail and one gate above each of the nine boxes; a land in
// Changes asked is seen on a track, then on the sorting rail, then at rest in the box, with its gate seen open and then closed and every other
// gate always closed; a land in the first box and one in the last box both arrive; with reduced motion no ball is seen between two places and all
// gates are closed.
// Usage: node ui-boardstyle-marble-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-boardstyle-marble', out = arg('out') || '/out';
const checks = [], pageErrors = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail).slice(0, 400) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const BOXES = ['merged', 'passed', 'to_review', 'changes_asked', 'done', 'out_of_allowance', 'failed', 'stopped', 'needs_you'];

// In the page: every animation frame for ms milliseconds, the centre of the ball with a key and the opacity of the open posts of every gate.
const watch = ({ key, ms }) => new Promise(resolve => {
  const samples = [], begin = performance.now();
  const frame = () => {
    const node = document.querySelector(`.board-svg [data-ball="${CSS.escape(key)}"]`);
    const box = node?.querySelector('circle').getBoundingClientRect();
    const gates = Object.fromEntries([...document.querySelectorAll('.board-svg [data-gate]')].map(gate => [gate.dataset.gate, Number(getComputedStyle(gate.querySelector('.gate-open')).opacity)]));
    samples.push({ t: performance.now() - begin, x: box ? box.left + box.width / 2 : null, y: box ? box.top + box.height / 2 : null, gates, animating: document.getAnimations().length });
    if (performance.now() - begin < ms) requestAnimationFrame(frame); else resolve(samples);
  };
  requestAnimationFrame(frame);
});
const rectOf = (page, selector, index = 0) => page.evaluate(([sel, at]) => { const r = document.querySelectorAll(sel)[at].getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }, [selector, index]);
const within = (p, r, pad = 0) => p.x !== null && p.x >= r.left - pad && p.x <= r.right + pad && p.y >= r.top - pad && p.y <= r.bottom + pad;
const present = samples => samples.filter(s => s.x !== null);
const moving = samples => present(samples).filter(s => s.animating > 0);

async function openBoard(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto(url('/api/v1/ui#/board'), { waitUntil: 'load' });
  await page.locator('.board-svg').waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await page.locator('.board-switch [data-style-choice="marble"]').click();
  return page;
}

async function sceneryChecks(page) {
  const radios = page.locator('.board-switch [role="radio"]');
  check('Marble run is offered in the switch', (await radios.allTextContents()).includes('Marble run'));
  check('choosing it draws the tracks, the sorting rail and no pegs', (await page.evaluate(() => document.querySelector('.board-svg')?.dataset.style)) === 'marble'
    && (await page.locator('.board-svg .marble-track').count()) === 3 && (await page.locator('.board-svg .marble-rail').count()) >= 9 && (await page.locator('.board-svg .pegs').count()) === 0);
  const gates = await page.evaluate(() => [...document.querySelectorAll('.board-svg [data-gate]')].map(gate => ({ id: gate.dataset.gate, box: (() => { const r = gate.querySelector('.gate-closed').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom }; })(),
    shape: document.querySelector(`.board-svg [data-box="${gate.dataset.gate}"] .box-rect`).getBoundingClientRect().toJSON() })));
  check('one gate above each of the nine boxes', gates.length === 9 && gates.every((gate, index) => gate.id === BOXES[index] && gate.box.x > gate.shape.left && gate.box.x < gate.shape.right && gate.box.y <= gate.shape.top),
    JSON.stringify(gates.map(gate => gate.id)));
  check('every gate is drawn closed', (await page.evaluate(() => [...document.querySelectorAll('.board-svg .gate-open')].every(node => getComputedStyle(node).opacity === '0'
    && getComputedStyle(node.parentNode.querySelector('.gate-closed')).opacity !== '0'))));
}

// Starts the review job, then lands it in the box, and watches the ball and the gates.
async function landInto(page, ctx, box) {
  await ctx.request.get(url('/__fixture/quiet/base'));
  await ctx.request.get(url('/__fixture/start'));
  await page.waitForTimeout(1500);
  const watching = page.evaluate(watch, { key: 'landed:6ff7be3f', ms: 4500 });
  await ctx.request.get(url(`/__fixture/land-${box}`));
  return { samples: await watching, rect: await rectOf(page, `.board-svg [data-box="${box}"] .box-rect`) };
}

async function landChecks(page, ctx) {
  const tracks = await Promise.all([0, 1, 2].map(index => rectOf(page, '.board-svg .marble-track', index)));
  const rail = await rectOf(page, '.board-svg .marble-rail', 0);
  const { samples, rect } = await landInto(page, ctx, 'changes_asked');
  const seen = present(samples), rest = seen[seen.length - 1], travelling = moving(samples);
  const onTrack = travelling.filter(s => tracks.some(t => s.x >= t.left && s.x <= t.right && s.y >= t.top - 40 && s.y <= t.bottom));
  const onRail = travelling.filter(s => Math.abs(s.y - (rail.top - 14)) < 6 && s.x > rail.left);
  check('the ball is seen on a track', onTrack.length >= 20, `${onTrack.length} samples`);
  check('then on the sorting rail', onRail.length >= 5 && onTrack[0].t < onRail[0].t, `${onRail.length} samples`);
  check('then at rest in Changes asked', within(rest, rect) && rest.animating === 0, JSON.stringify([rest, rect]));
  const opens = samples.map(s => s.gates.changes_asked > 0.5);
  const firstOpen = opens.indexOf(true), lastOpen = opens.lastIndexOf(true);
  check('the Changes asked gate is seen open, after the ball reached the rail, and then closed again', firstOpen > 0 && lastOpen < opens.length - 1 && opens.slice(firstOpen, lastOpen + 1).every(Boolean)
    && samples[firstOpen].t >= onRail[0].t - 100 && samples[lastOpen].t < rest.t + 1, `open from sample ${firstOpen} to ${lastOpen} of ${opens.length}`);
  check('every other gate stays closed all the time', samples.every(s => Object.entries(s.gates).every(([id, opacity]) => id === 'changes_asked' || opacity === 0)));
  const span = travelling[travelling.length - 1].t - travelling[0].t;
  check('the land lasts between 1.5 and 3 seconds', span >= 1400 && span <= 3300, `${Math.round(span)} ms`);
  await page.screenshot({ path: path.join(out, `${name}-land.png`) });
}

async function endChecks(page, ctx) {
  for (const box of ['merged', 'needs_you']) {
    const { samples, rect } = await landInto(page, ctx, box);
    const seen = present(samples), rest = seen[seen.length - 1];
    check(`a ball landing in ${box} arrives and its gate opens and shuts`, within(rest, rect) && rest.animating === 0 && samples.some(s => s.gates[box] > 0.5) && samples[samples.length - 1].gates[box] === 0,
      JSON.stringify([rest, rect]));
  }
}

async function reducedChecks(ctx) {
  await ctx.request.get(url('/__fixture/quiet/base'));
  const page = await openBoard(ctx);
  check('the browser reports reduced motion', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  check('the scenery is drawn', (await page.locator('.board-svg .marble-track').count()) === 3 && (await page.locator('.board-svg [data-gate]').count()) === 9);
  await ctx.request.get(url('/__fixture/start'));
  await page.waitForTimeout(500);
  const watching = page.evaluate(watch, { key: 'landed:6ff7be3f', ms: 2500 });
  await ctx.request.get(url('/__fixture/land-changes_asked'));
  const samples = await watching;
  const seen = present(samples);
  check('with reduced motion no ball is seen between two places', seen.length > 0 && new Set(seen.map(s => `${s.x},${s.y}`)).size === 1 && samples.every(s => s.animating === 0));
  check('and all gates are closed', samples.every(s => Object.values(s.gates).every(opacity => opacity === 0)));
  await page.close();
}

try {
  const options = { ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' };
  const ctx = await browser.newContext(options);
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await openBoard(ctx);
  await sceneryChecks(page);
  await landChecks(page, ctx);
  await endChecks(page, ctx);
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
