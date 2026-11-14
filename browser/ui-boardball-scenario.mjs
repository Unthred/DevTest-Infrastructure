#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives what a ball and a lane look like on the live board
// screen at /api/v1/ui#/board served by the dashboard's own request handler (issue #1317), in the light and the dark theme.
// The host test serves a made up star icon for claude only, and /__fixture/icons/fail, /__fixture/icons/ok and /__fixture/icons/count.
// Checks (desktop): claude balls are the star in their family colour (pixels measured), codex balls are discs with the letter c, a review and an
// implement ball differ in colour and the legend names both, the model name is drawn along each lane and not at the head, the measured contrast
// of each family colour and of the letter, the accessible names, one icon request per open however many changes arrive, and with the icon route
// failing every ball is a disc with a letter and nothing is broken. Phone: the legend and the models are in the lists.
// Usage: node ui-boardball-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-boardball', out = arg('out') || '/out';
const wide = PROFILES[profile].viewport.width >= 640;
const checks = [], pageErrors = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail).slice(0, 400) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const FAMILIES = ['new', 'fixing', 'review', 'housekeeping'];

async function openBoard(theme) {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC', colorScheme: theme });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto(url('/api/v1/ui#/board'), { waitUntil: 'load' });
  await page.locator(wide ? '.board-svg' : '.board-lists').waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  return { ctx, page };
}
const get = async p => (await fetch(url(p))).text();
const channel = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgb = text => (text.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

// The painted colour of the shape of a ball, the colour of the board, and (for a disc) of the letter.
const ballFacts = (page, key) => page.evaluate(k => {
  const node = document.querySelector(`.board-svg [data-ball="${k}"]`);
  if (!node) return null;
  const fill = node.querySelector('.ball-fill');
  const letter = node.querySelector('.letter');
  const box = (fill ?? node.querySelector('circle')).getBoundingClientRect();
  return { icon: node.querySelector('.ball-fill.icon') !== null, disc: node.querySelector('.ball-fill.disc') !== null, letter: letter?.textContent ?? null,
    fill: getComputedStyle(fill).fill, letterFill: letter ? getComputedStyle(letter).fill : null, label: node.getAttribute('aria-label'), box: { x: box.left, y: box.top, w: box.width, h: box.height },
    hasMask: fill.getAttribute('mask') !== null };
}, key);
// The board background is the surface token of the theme, read from the page so it is the same at every width (the board is not drawn on a phone).
const boardColour = async page => {
  const hex = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface'))).trim();
  return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
};

// The colour of one pixel of the page, read back from a screenshot of a small clip so the mask is measured as drawn.
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } });
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, png.toString('base64'));
}
const near = (a, b, d = 40) => a.every((v, i) => Math.abs(v - b[i]) <= d);

async function iconsOk(theme) {
  await get('/__fixture/icons/ok');
  await get('/__fixture/base');
  const { ctx, page } = await openBoard(theme);
  const legendText = await page.locator('.board-legend').innerText();
  check(`${theme}: the legend names the four families`, ['New work', 'Fixing', 'Review', 'Housekeeping'].every(word => legendText.includes(word)), legendText);
  const swatches = await page.locator('.board-legend .swatch').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  const surface = rgb(await boardColour(page));
  check(`${theme}: each family colour has at least 3 to 1 against the board background`, swatches.length === 4 && swatches.every(c => contrast(rgb(c), surface) >= 3),
    swatches.map(c => contrast(rgb(c), surface).toFixed(2)).join(' '));
  check(`${theme}: the four colours are different`, new Set(swatches).size === 4);
  if (!wide) {
    check(`${theme}: at 390 px the legend is shown above the lists and the lists name the models as text`, (await page.locator('.board-svg').count()) === 0
      && (await page.locator('.board-legend').isVisible()) && (await page.locator('.board-lists').innerText()).includes('Models: sonnet, opus'));
    check(`${theme}: at 390 px a list item carries its family swatch and its agent and model as text`,
      (await page.locator('.board-lists [data-ball="waiting:3"] .swatch.family-review').count()) === 1
      && (await page.locator('.board-lists [data-ball="running:run00001"]').innerText()).includes('claude, sonnet'));
    await ctx.close();
    return;
  }
  const star = await ballFacts(page, 'running:run00001');
  const review = await ballFacts(page, 'waiting:3');
  const codex = await ballFacts(page, 'landed:db849b9f');
  check(`${theme}: a claude ball is an icon masked and filled with the new work colour`, star.icon && !star.disc && star.hasMask && rgb(star.fill).join() === rgb(swatches[0]).join(), JSON.stringify(star));
  const centre = await pixel(page, star.box.x + star.box.w / 2, star.box.y + star.box.h / 2 + 2);
  const corner = await pixel(page, star.box.x + 1.5, star.box.y + 1.5);
  check(`${theme}: the star is painted in its family colour at the middle and leaves its corner empty`, near(centre, rgb(swatches[0])) && near(corner, surface, 60), JSON.stringify({ centre, corner, surface }));
  check(`${theme}: the number stays beside the ball`, (await page.locator('.board-svg [data-ball="running:run00001"] .num').textContent()) === '1312');
  check(`${theme}: a codex ball is a disc with the letter c in its family colour`, codex.disc && !codex.icon && codex.letter === 'c' && rgb(codex.fill).join() === rgb(swatches[0]).join(), JSON.stringify(codex));
  check(`${theme}: the letter has at least 4.5 to 1 against its disc`, contrast(rgb(codex.letterFill), rgb(codex.fill)) >= 4.5, contrast(rgb(codex.letterFill), rgb(codex.fill)).toFixed(2));
  check(`${theme}: a waiting review ball with no agent is a review coloured disc with no letter`, review.disc && review.letter === null && rgb(review.fill).join() === rgb(swatches[2]).join()
    && review.fill !== star.fill, JSON.stringify(review));
  check(`${theme}: the accessible name is job type, number, agent, model`, star.label.includes('implement, issue 1312, claude, sonnet') && codex.label.includes('implement, issue 1166, codex, gpt-5'), `${star.label} | ${codex.label}`);
  const tied = await ballFacts(page, 'waiting:1');
  check(`${theme}: a waiting ball tied to claude uses claude's icon`, tied.icon, JSON.stringify(tied));
  await laneText(page, theme);
  await ctx.close();
}

// The model name is drawn along each lane, rotated, not at the head, and clear of the one running ball.
async function laneText(page, theme) {
  const rows = await page.evaluate(() => [...document.querySelectorAll('.board-svg .lane-model')].map(text => {
    const t = text.getBoundingClientRect();
    const lane = text.closest('.group').querySelectorAll('.lane');
    const laneBox = [...lane].map(node => node.getBoundingClientRect()).find(box => t.left >= box.left - 1 && t.right <= box.right + 1);
    const balls = [...document.querySelectorAll('.board-svg [data-ball^="running:"] circle')].map(c => c.getBoundingClientRect())
      .filter(b => laneBox && b.left >= laneBox.left && b.right <= laneBox.right);
    const overlaps = balls.some(b => !(b.bottom < t.top || b.top > t.bottom));
    return { text: text.textContent, opacity: getComputedStyle(text).opacity, tall: t.height > t.width, inLane: Boolean(laneBox), half: text.dataset.laneText,
      belowHead: laneBox ? t.top > laneBox.top + 8 : false, balls: balls.length, overlaps };
  }));
  check(`${theme}: the model name is drawn along each of the three lanes, faint and upright along the lane`, rows.length === 3 && rows.every(r => r.tall && r.inLane && Number(r.opacity) < 1)
    && rows.map(r => r.text).join() === 'sonnet,opus,gpt-5', JSON.stringify(rows));
  check(`${theme}: the text is not at the lane head and never covers a ball`, rows.every(r => r.belowHead && !r.overlaps), JSON.stringify(rows));
  check(`${theme}: the old label under the lane is gone`, (await page.locator('.board-svg .lane-label').count()) === 0);
  const headed = rows.filter(r => r.balls === 1);
  check(`${theme}: with one ball in the foot half the text moves to the other half`, headed.length === 1 && headed[0].half === 'head', JSON.stringify(rows));
}

async function iconsOncePerOpen() {
  await get('/__fixture/icons/ok');
  await get('/__fixture/base');
  const { ctx, page } = await openBoard('light');
  await get('/__fixture/start');
  await page.waitForTimeout(600);
  await get('/__fixture/base');
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: PROFILES[profile].viewport.width - 60, height: 800 });
  await page.waitForTimeout(400);
  check('the icon is requested once for the open however many changes and resizes follow', (await get('/__fixture/icons/count')) === '1', await get('/__fixture/icons/count'));
  await ctx.close();
  const again = await openBoard('light');
  check('opening the screen again asks again, once more', (await get('/__fixture/icons/count')) === '2', await get('/__fixture/icons/count'));
  await again.ctx.close();
}

async function iconsFail(theme) {
  await get('/__fixture/icons/fail');
  await get('/__fixture/base');
  const { ctx, page } = await openBoard(theme);
  const keys = await page.evaluate(() => [...document.querySelectorAll('.board-svg [data-ball]')].map(node => node.dataset.ball));
  const facts = [];
  for (const key of keys) facts.push([key, await ballFacts(page, key)]);
  const lettered = facts.filter(([key]) => key !== 'waiting:3');
  check(`${theme}: with the icon route failing every ball is a disc`, facts.length > 5 && facts.every(([, f]) => f.disc && !f.icon), JSON.stringify(facts.map(([k, f]) => [k, f.disc, f.icon])));
  check(`${theme}: each ball with an agent carries its letter, and the waiting ball with none carries none`, lettered.every(([, f]) => f.letter === 'c') && facts.find(([key]) => key === 'waiting:3')[1].letter === null);
  check(`${theme}: nothing is broken: no image, no mask, no script error`, (await page.locator('.board-svg image, .board-svg mask').count()) === 0 && pageErrors.length === 0, pageErrors.join('; '));
  await ctx.close();
  await get('/__fixture/icons/ok');
}

try {
  for (const theme of ['light', 'dark']) await iconsOk(theme);
  if (wide) {
    await iconsOncePerOpen();
    for (const theme of ['light', 'dark']) await iconsFail(theme);
  }
  check('no script errors in any page', pageErrors.length === 0, pageErrors.join('; '));
} catch (e) { check('the scenario ran to the end', false, `${String(e.stack || e).slice(0, 600)} page errors: ${pageErrors.join('; ')}`); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
