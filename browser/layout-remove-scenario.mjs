#!/usr/bin/env node
// Issue #1454. Runs INSIDE the pinned Playwright container (same bridge as layout-scenario.mjs). Checks Remove on the fixed Overview
// cards in a real browser: it removes the card when the app bar still shows the Needs you count, otherwise it says why in one line,
// and removing the app bar item while its card is removed is refused the same way. Pages: overview-needs.html (the Overview of
// 14 Nov 2026: Needs you holds 28 items, the breaker card shows no halt) and overview-halt.html (the breaker is halted).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'layout-remove', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => { checks.push({ name: n, ok: !!ok, detail: String(detail) }); };
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const prof = PROFILES[profile];
const newCtx = () => browser.newContext({ ...prof, serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC', hasTouch: false, isMobile: false });
const url = p => `http://127.0.0.1:${port}${p}`;
const SAY = { addBar: 'Add Needs you to the top bar first.', addCard: 'Add the Needs you card back first.' };

async function open(file) {
  const ctx = await newCtx(); await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(url(file), { waitUntil: 'networkidle' });
  return { ctx, page, errors };
}
const shown = (page, id) => page.locator(`#c-${id}`).isVisible();
const pickerRow = (page, title) => page.locator('.lay-hiddens li', { hasText: title });
const openPicker = async page => { await page.locator('.lay-hiddens summary').click(); };
const barEdit = page => page.locator('#barEdit');
const liveText = (page, sel) => page.locator(sel).first().textContent();
const reasonLine = async (page, scope) => (await page.locator(`${scope} .lay-why, ${scope} .bar-why`).allTextContents()).join('|');

async function needsScenario() {
  const { ctx, page, errors } = await open('/overview-needs.html');
  const L = 'needs';
  check(`${L}: the app bar shows the Needs you count (28)`, (await page.locator('.statusbar [data-bar=needs-you]').getAttribute('data-count')) === '28');
  check(`${L}: the Needs you card holds 28 items and is on the page`, (await shown(page, 'needs')) && /\(28\)/.test(await page.locator('#h-needs').textContent()));
  check(`${L}: the card carries no live pin mark`, (await page.locator('#c-needs[data-pin]').count()) === 0);
  await page.locator('[data-lay=edit]').click();
  await openPicker(page);
  // valid: Remove with the count in the bar
  await pickerRow(page, 'Needs you').locator('button').click();
  check(`${L}: Remove takes the Needs you card off`, !(await shown(page, 'needs')));
  check(`${L}: it is listed in the Cards picker with Add`, (await pickerRow(page, 'Needs you').textContent()).includes('not on page') && (await pickerRow(page, 'Needs you').locator('button').textContent()) === 'Add');
  // boundary: undo restores it, redo removes it again
  await page.locator('[data-lay=undo]').click();
  check(`${L}: Undo after the remove restores it`, await shown(page, 'needs'));
  await page.locator('[data-lay=redo]').click();
  check(`${L}: Redo removes it again`, !(await shown(page, 'needs')));
  await page.locator('[data-lay=done]').click();
  await page.reload({ waitUntil: 'networkidle' });
  check(`${L}: after a reload the card is still removed`, !(await shown(page, 'needs')));
  check(`${L}: and the count is still in the app bar`, (await page.locator('.statusbar [data-bar=needs-you]').count()) === 1);
  // invalid: removing the bar count while its card is removed is refused with one line
  await barEdit(page).click();
  await page.locator('[data-bar=needs-you] .bar-ctl button[aria-label^=Remove]').click();
  check(`${L}: removing the top bar count while the card is removed is refused`, (await page.locator('[data-bar=needs-you]:not(.bar-removed)').count()) === 1 && (await reasonLine(page, '[data-bar=needs-you]')) === SAY.addCard, await reasonLine(page, '[data-bar=needs-you]'));
  await page.waitForTimeout(80);
  check(`${L}: and the line is announced through a status region`, (await page.locator('.statusbar [role=status]').allTextContents()).includes(SAY.addCard));
  await barEdit(page).click();
  // boundary: add the card back from the picker; it returns to a free place
  await page.locator('[data-lay=edit]').click();
  await openPicker(page);
  await pickerRow(page, 'Needs you').locator('button').click();
  const back = await page.locator('#c-needs').boundingBox();
  const others = await page.evaluate(() => [...document.querySelectorAll('.cards[data-layout] > .card[data-card]')].filter(c => c.id !== 'c-needs' && c.getBoundingClientRect().width > 0).map(c => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }));
  const hit = others.some(o => back.x + 1 < o.x + o.w && o.x + 1 < back.x + back.width && back.y + 1 < o.y + o.h && o.y + 1 < back.y + back.height);
  check(`${L}: Add from the picker brings the card back to a free place`, (await shown(page, 'needs')) && !hit);
  await page.locator('[data-lay=done]').click();
  // invalid: without the count in the bar Remove leaves the card and says what to do
  await barEdit(page).click();
  await page.locator('[data-bar=needs-you] .bar-ctl button[aria-label^=Remove]').click();
  check(`${L}: with the card on the page the bar count can be removed`, (await page.locator('[data-bar=needs-you].bar-removed').count()) === 1);
  await barEdit(page).click();
  await page.locator('[data-lay=edit]').click();
  await openPicker(page);
  await pickerRow(page, 'Needs you').locator('button').click();
  check(`${L}: without the count in the bar Remove leaves the card`, await shown(page, 'needs'));
  check(`${L}: and shows one line saying what to do`, (await pickerRow(page, 'Needs you').locator('.lay-why').allTextContents()).join('|') === SAY.addBar, await pickerRow(page, 'Needs you').textContent());
  await page.waitForTimeout(80);
  check(`${L}: the line is announced through the layout status region`, (await liveText(page, '.layoutbar .lay-live')) === SAY.addBar);
  await page.locator('#c-needs .lay-hide').click();
  check(`${L}: the Hide control on the card refuses the same way, beside the control`, (await page.locator('#c-needs > .lay-why').allTextContents()).join('|') === SAY.addBar && await shown(page, 'needs'));
  await page.screenshot({ path: path.join(out, `${name}-needs-refused.png`) });
  await page.locator('[data-lay=done]').click();
  check(`${L}: no script error`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

async function haltScenario() {
  const { ctx, page, errors } = await open('/overview-halt.html');
  const L = 'halt';
  check(`${L}: the breaker card is on the page with the live pin mark`, (await shown(page, 'breaker')) && (await page.locator('#c-breaker[data-pin]').count()) === 1);
  await page.locator('[data-lay=edit]').click();
  await openPicker(page);
  await pickerRow(page, 'Work halted').locator('button').click();
  const line = (await pickerRow(page, 'Work halted').locator('.lay-why').allTextContents()).join('|');
  check(`${L}: Remove on a card pinned by a live reason leaves it and shows the reason`, (await shown(page, 'breaker')) && /^Work is halted/.test(line), line);
  await page.locator('#c-breaker .lay-hide').click();
  check(`${L}: the Hide control on the card shows the reason too`, /^Work is halted/.test((await page.locator('#c-breaker > .lay-why').allTextContents()).join('|')));
  await page.locator('[data-lay=done]').click();
  check(`${L}: no script error`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

async function breakerScenario() {
  const { ctx, page } = await open('/overview-needs.html');
  const L = 'breaker';
  check(`${L}: the app bar shows the breaker state`, (await page.locator('.statusbar [data-bar=breaker]').getAttribute('data-halted')) === 'false');
  await page.locator('[data-lay=edit]').click();
  await openPicker(page);
  await pickerRow(page, 'Wasted usage').locator('button').click();
  check(`${L}: with the breaker state in the bar Remove takes the Breaker card off`, !(await shown(page, 'breaker')));
  await page.locator('[data-lay=done]').click();
  await barEdit(page).click();
  await page.locator('[data-bar=breaker] .bar-ctl button[aria-label^=Remove]').click();
  check(`${L}: removing the breaker state while its card is removed is refused`, (await reasonLine(page, '[data-bar=breaker]')) === 'Add the Breaker card back first.', await reasonLine(page, '[data-bar=breaker]'));
  await ctx.close();
}

try {
  await needsScenario(); await haltScenario(); await breakerScenario();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 400)); }
finally { await browser.close(); server.close(); }
const { writeFileSync } = await import('node:fs');
writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks, failed: checks.filter(c => !c.ok) }, null, 1));
process.exit(checks.every(c => c.ok) ? 0 : 1);
