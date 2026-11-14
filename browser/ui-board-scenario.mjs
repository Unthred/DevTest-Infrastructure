#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real live board screen at /api/v1/ui#/board served by
// the dashboard's own request handler and router (issue #1312): the link without the board address, three lanes in two agent groups with
// allowance bars, the dimmed codex lane, a waiting item that starts running after the change event with no reload, the side panel with the exact
// title and cost in pounds, the Needs you list with its Inbox links, the phone lists, and a failing request with Retry and the stale mark.
// The host test serves /__fixture/start, /__fixture/fail and /__fixture/recover. Usage: node ui-board-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'ui-board', out = arg('out') || '/out';
const phone = profile.startsWith('phone');
const checks = [], pageErrors = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const texts = async locator => (await locator.evaluateAll(nodes => nodes.map(n => n.textContent))).map(t => t.replace(/\s+/g, ' ').trim());

async function desktopChecks(page, ctx) {
  await page.locator('.board-svg').waitFor({ timeout: 10000 });
  check('three lanes are drawn in two agent groups', (await page.locator('.board-svg .lane').count()) === 3 && (await page.locator('.board-svg .agent-name').count()) === 2,
    await texts(page.locator('.board-svg .agent-name')));
  const labels = await texts(page.locator('.board-svg .lane-label'));
  check('each lane is labelled with its model', labels.join(',') === 'sonnet,opus,gpt-5', labels);
  const allowance = await texts(page.locator('.board-svg .allow'));
  check('each group shows the weekly and short windows with the reset time, an unknown one says unknown',
    allowance.length === 4 && /Weekly: 86% left/.test(allowance[0]) && /5 hour: 99% left/.test(allowance[1]) && /Weekly: 69% left/.test(allowance[2]) && /5 hour: unknown$/.test(allowance[3])
    && (await texts(page.locator('.board-svg .reset'))).includes('resets Thu 19 Nov, 04:00'), allowance);
  check('an unknown window is drawn hatched with no fill, not empty or full', (await page.locator('.board-svg .bar.unknown .fill').count()) === 0 && (await page.locator('.board-svg .bar.unknown').count()) === 1);
  check('the reading age is shown for each group', (await texts(page.locator('.board-svg .reading'))).length === 2);
  const outGroup = page.locator('.board-svg .group.out');
  check('the codex group is dimmed and says out until its time and reason', (await outGroup.count()) === 1 && (await texts(outGroup.locator('.out-label'))).join(' ') === 'Out until Thu 12 Nov, 14:09 usage limit', await texts(page.locator('.out-label')));
  check('the claude group is not dimmed', (await page.locator('.board-svg .group:not(.out)').count()) === 1);
  const hopper = page.locator('.board-svg .hopper .ball');
  check('the hopper holds three waiting balls', (await hopper.count()) === 3);
  check('the held ball is greyed and carries its hold reason', (await page.locator('.board-svg .hopper .ball.held').count()) === 1
    && /out of allowance until 14:09/.test(await page.locator('.board-svg .hopper .ball.held').getAttribute('aria-label')));
  await page.locator('.board-svg .hopper .ball.held').focus();
  check('focus on the held ball shows its hold reason', await page.locator('.board-svg .hopper .ball.held .tip').isVisible());
  check('a ball tied to an agent carries a colour mark', (await page.locator('.board-svg .hopper .tied').count()) === 2);
  check('nine boxes are drawn with their counts', (await page.locator('.board-svg .box').count()) === 9 && /Needs you/.test((await texts(page.locator('.board-svg .box-needs_you')))[0]));
  check('the running ball sits in the claude sonnet lane', await page.evaluate(() => {
    const ball = document.querySelector('.board-svg [data-ball="running:run00001"] circle'), lane = document.querySelector('.board-svg [data-lane="claude/sonnet"]');
    const b = ball.getBoundingClientRect(), l = lane.getBoundingClientRect();
    return b.left >= l.left && b.right <= l.right && b.top > l.top && b.bottom < l.bottom;
  }));
  await page.screenshot({ path: path.join(out, `${name}-first.png`) });

  await page.evaluate(() => { window.__noNavigation = true; });
  await ctx.request.get(url('/__fixture/start'));
  await page.locator('.board-svg [data-ball="running:run00002"]').waitFor({ timeout: 15000 });
  check('after the change event the waiting item runs in its lane and is gone from the hopper, with no reload',
    (await hopper.count()) === 2 && (await page.evaluate(() => window.__noNavigation === true))
    && (await page.locator('.board-svg .hopper [data-ball="waiting:3"]').count()) === 0
    && await page.evaluate(() => {
      const ball = document.querySelector('.board-svg [data-ball="running:run00002"] circle').getBoundingClientRect();
      const lane = document.querySelector('.board-svg [data-lane="claude/opus"]').getBoundingClientRect();
      return ball.left >= lane.left && ball.right <= lane.right;
    }));
  check('a running job with no estimate is marked', (await page.locator('.board-svg .ball.no-estimate').count()) === 1
    && /no estimate/i.test(await page.locator('.board-svg [data-ball="running:run00002"]').getAttribute('aria-label')));

  await page.locator('.board-svg [data-ball="landed:6ff7be3f"]').click();
  const panel = page.locator('#ball-panel');
  const panelText = (await panel.innerText()).replace(/\s+/g, ' ');
  check('clicking a ball opens the panel with the exact title, agent, model, box, laps and the cost in pounds',
    /Review of pull request 1244/.test(panelText) && /claude/.test(panelText) && /opus/.test(panelText) && /Changes asked/.test(panelText) && /Laps 1/.test(panelText) && /£1\.25/.test(panelText), panelText);
  await page.screenshot({ path: path.join(out, `${name}-panel.png`) });
  await page.keyboard.press('Escape');
  check('Escape closes the panel', (await panel.count()) === 0);
  await page.locator('.board-svg [data-ball="landed:aaaa1307"]').focus();
  check('focus is on the ball before Enter', await page.evaluate(() => document.activeElement?.dataset?.ball === 'landed:aaaa1307'), await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.dataset?.ball}`));
  await page.keyboard.press('Enter');
  check('Enter on a ball opens its panel', /Outcomes read model/.test(await panel.innerText()) && /£0\.30/.test(await panel.innerText()));
  await page.keyboard.press('Escape');

  await page.locator('.board-svg [data-box="needs_you"] .box-rect').click({ position: { x: 10, y: 10 } });
  const picked = page.locator('.picked-box [data-box-list="needs_you"]');
  const links = await picked.locator('a.inbox-link').evaluateAll(anchors => anchors.map(a => a.getAttribute('href')));
  check('clicking Needs you lists its items with links to the Inbox page', links.length === 2 && links.includes('/inbox?state=all&search=1166') && links.includes('/inbox?state=all&search=1306'), links);
  check('the list opened by a box is visible', await picked.isVisible());
  await page.screenshot({ path: path.join(out, `${name}-needs-you.png`) });
}

async function phoneChecks(page) {
  await page.locator('.board-lists').waitFor({ timeout: 10000 });
  check('at 390 px the board is not drawn', (await page.locator('.board-svg').count()) === 0);
  check('the agent list is visible with allowance and out until', await page.locator('.board-lists .agent-item.out').isVisible() && /Out until Thu 12 Nov, 14:09: usage limit/.test(await page.locator('.board-lists .agent-item.out').innerText()));
  check('the waiting, running and box lists are visible', await page.locator('.board-lists [data-ball="waiting:1"]').isVisible() && await page.locator('.board-lists [data-ball="running:run00001"]').isVisible()
    && (await page.locator('.board-lists .box-section').count()) === 9);
  check('the Needs you rows link to the Inbox', (await page.locator('.board-lists [data-box-list="needs_you"] a.inbox-link').count()) === 2);
  check('the page does not scroll sideways', (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await page.locator('.board-lists [data-ball="landed:6ff7be3f"]').click();
  check('tapping a list item opens the panel', /£1\.25/.test(await page.locator('#ball-panel').innerText()));
  await page.screenshot({ path: path.join(out, `${name}-lists.png`) });
  await page.keyboard.press('Escape');
}

async function failureChecks(page, ctx) {
  await ctx.request.get(url('/__fixture/fail'));
  await page.locator('.board-error').waitFor({ timeout: 15000 });
  const error = (await page.locator('.board-error').innerText()).replace(/\s+/g, ' ');
  check('a failing request shows the error with Retry and keeps the last board marked stale', /could not be loaded/.test(error) && /503/.test(error) && /Stale/.test(error)
    && (await page.locator('.board-error button[data-retry]').count()) === 1 && (await page.locator('.board-screen.stale').count()) === 1
    && (await page.locator('.board-lists [data-ball="running:run00001"]').count()) === 1, error);
  await page.screenshot({ path: path.join(out, `${name}-stale.png`) });
  await page.locator('.board-error button[data-retry]').click();
  await page.locator('.board-error').waitFor({ state: 'visible', timeout: 5000 });
  check('Retry while the failure lasts shows the error again', (await page.locator('.board-error').count()) === 1);
  await ctx.request.get(url('/__fixture/recover'));
  await page.locator('.board-error button[data-retry]').click();
  await page.locator('.board-error').waitFor({ state: 'detached', timeout: 10000 });
  check('Retry after the failure ends clears the error and the stale mark', (await page.locator('.board-screen.stale').count()) === 0);
}

try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = pageErrors, requested = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  page.on('request', r => { const u = new URL(r.url()); if (u.protocol === 'http:') requested.push(u.pathname); });

  await page.goto(url('/api/v1/ui'), { waitUntil: 'load' });
  await page.locator('#main a[href="#/board"]').waitFor({ timeout: 10000 });
  check('without the board address the main area holds one link to it and no board', (await page.locator('#main a').count()) === 1 && (await page.locator('.board-svg').count()) === 0);
  check('the app bar is drawn', (await page.locator('#appbar .chip').count()) > 0);
  const barBefore = await page.locator('#appbar').boundingBox();
  await page.locator('#main a[href="#/board"]').click();
  await page.locator('.board-screen').waitFor({ timeout: 10000 });
  const barAfter = await page.locator('#appbar').boundingBox();
  check('the app bar is unchanged on the board screen', barBefore.height === 48 && barAfter.height === 48 && barBefore.width === barAfter.width);
  if (phone) await phoneChecks(page); else await desktopChecks(page, ctx);
  check('the lists exist at every width', (await page.locator('.board-lists').count()) === 1 && (await page.locator('.board-lists .box-section').count()) === 9);
  await failureChecks(page, ctx);
  const outside = requested.filter(p => !p.startsWith('/api/v1/'));
  check('every request the page made stays under /api/v1/', outside.length === 0, outside.join(', '));
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, `${String(e.stack || e).slice(0, 600)} page errors: ${pageErrors.join('; ')}`); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
