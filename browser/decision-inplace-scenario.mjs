#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Issue #1185: a decision card's control is sent
// in the background. The page is the real Overview with the real dashui scripts and 14 fix limit cards. Only the network edge is answered by this
// script: POST /decision (done, failed or cleared) and the page's own periodic fetch (/a.html, answered with /b.html once a card has gone).
// The checks: scroll, the open "Waiting for approval" list, its fragment and focus survive a press and the refreshes; the card says working, then
// done, failed or already cleared; no navigation; no script errors. Writes <name>.json and a screenshot to /out.
// Usage: node decision-inplace-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'decision-inplace', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const REPLIES = {
  done: json(200, { ok: true, outcome: 'done', message: 'Park recorded. Foreman applies it on the next pass.' }),
  failed: json(409, { ok: false, outcome: 'failed', reason: 'The same change is already waiting for the next tick.' }),
  cleared: json(409, { ok: false, outcome: 'cleared', reason: 'That card has already cleared. Nothing was changed.' }),
};
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  const url = p => `http://127.0.0.1:${port}${p}`;
  const bHtml = await (await ctx.request.get(url('/b.html'))).text();
  const served = { post: 'done', page: 'a', posts: [], fetches: 0 };
  await ctx.route('**/*', async r => {
    const req = r.request(), p = new URL(req.url()).pathname;
    if (!isAllowed(req.url(), port)) return r.abort('blockedbyclient');
    if (req.method() === 'POST' && p === '/decision') { served.posts.push(req.postData() || ''); return r.fulfill(REPLIES[served.post]); }
    if (req.resourceType() === 'fetch' && p === '/a.html') { served.fetches++; return served.page === 'a' ? r.continue() : r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bHtml }); }
    return r.continue();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  let navigations = 0; page.on('load', () => { navigations++; });   // a load is a reload; the address fragment changing in place is not
  await page.goto(url('/a.html'), { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__same = 'still here'; });
  const startNav = navigations;
  const row = n => page.locator(`#dec-fixlimit-${n}`), press = n => row(n).locator('button.decision-control').first();
  const status = n => row(n).locator('.decision-status');
  const state = () => page.evaluate(() => ({ y: scrollY, open: document.getElementById('approvals')?.open, hash: location.hash }));

  // ---- open the list the way the homeowner did, then go far down it
  await page.locator('#approvals > summary').click();
  await page.waitForFunction(() => location.hash === '#approvals', null, { timeout: 2000 }).catch(() => {});
  check('opening the list puts it in the address', (await state()).open === true && (await state()).hash === '#approvals', JSON.stringify(await state()));
  await press(12).evaluate(b => b.scrollIntoView({ block: 'center' }));
  await sleep(300);
  const before = await state();
  check('set-up: the page is scrolled well down with the list open', before.y > 300 && before.open, JSON.stringify(before));

  // ---- 1. Park on a card far down: working, then done; nothing moves; focus goes to the next card
  served.post = 'done';
  await press(12).focus();
  await press(12).press('Enter');
  await page.waitForFunction(() => /^Done:/.test(document.querySelector('#dec-fixlimit-12 .decision-status')?.textContent || ''), null, { timeout: 4000 }).catch(() => {});
  const doneText = await status(12).textContent();
  const afterPress = await state();
  check('the press was sent in the background (one POST with the card and control)', served.posts.length === 1 && /card=fixlimit-12/.test(served.posts[0]) && /control=park/.test(served.posts[0]), served.posts.join('|'));
  check('the card says done, with the message, in place', /^Done: Park recorded/.test(doneText) && (await status(12).isVisible()), doneText);
  check('the page did not navigate or reload', navigations === startNav && (await page.evaluate(() => window.__same)) === 'still here', `${startNav}/${navigations}`);
  check('scroll offset is the same after the press', Math.abs(afterPress.y - before.y) <= 2, `${before.y}/${afterPress.y}`);
  check('the list is still open and the address still names it', afterPress.open === true && afterPress.hash === '#approvals', JSON.stringify(afterPress));
  const focusIn = await page.evaluate(() => document.activeElement?.closest('li')?.id || '');
  check('focus moved to the next card in the list', /^dec-fixlimit-\d+$/.test(focusIn) && focusIn !== 'dec-fixlimit-12', focusIn);
  check('the pressed control cannot be pressed twice', await press(12).isDisabled());

  // ---- 2. the server's next page no longer lists the card: the refresh in place removes it and keeps the place
  served.page = 'b';
  await page.locator('button.refresh-now').evaluate(b => b.click());
  await page.waitForFunction(() => !document.getElementById('dec-fixlimit-12'), null, { timeout: 4000 }).catch(() => {});
  const afterRefresh = await state();
  check('the card left the list', (await row(12).count()) === 0 && (await row(11).count()) === 1);
  check('scroll, open list and address are the same after the refresh', Math.abs(afterRefresh.y - before.y) <= 2 && afterRefresh.open === true && afterRefresh.hash === '#approvals', JSON.stringify(afterRefresh));
  check('still no reload', navigations === startNav && (await page.evaluate(() => window.__same)) === 'still here');

  // ---- 3. a failed action shows its reason on that card and can be tried again
  served.post = 'failed';
  await press(5).click();
  await page.waitForFunction(() => /^Not done:/.test(document.querySelector('#dec-fixlimit-5 .decision-status')?.textContent || ''), null, { timeout: 4000 }).catch(() => {});
  check('a failed action shows its reason on the card', /^Not done: The same change is already waiting/.test(await status(5).textContent()), await status(5).textContent());
  check('the control is available again after a failure', await press(5).isEnabled() && (await press(5).textContent()) === 'Park');
  check('the card is still in the list after a failure', (await row(5).count()) === 1);

  // ---- 4. a card that has already cleared says so and nothing else changes
  served.post = 'cleared';
  await press(6).click();
  await page.waitForFunction(() => /^Already cleared:/.test(document.querySelector('#dec-fixlimit-6 .decision-status')?.textContent || ''), null, { timeout: 4000 }).catch(() => {});
  check('an already cleared card says so on the card', /^Already cleared: That card has already cleared/.test(await status(6).textContent()), await status(6).textContent());

  // ---- 5. the periodic refresh (3 s here) keeps the scroll, the open list and the address
  const y0 = (await state()).y; served.page = 'b'; const f0 = served.fetches;
  await sleep(4500);
  const end = await state();
  check('the periodic refresh ran', served.fetches > f0, `${f0} -> ${served.fetches}`);
  check('the periodic refresh kept scroll, the open list and the address', Math.abs(end.y - y0) <= 2 && end.open === true && end.hash === '#approvals', `${y0} ${JSON.stringify(end)}`);

  // ---- 6. a reload or a shared link returns to the same view
  await page.reload({ waitUntil: 'networkidle' });
  check('a reload with the address returns to the open list', await page.evaluate(() => document.getElementById('approvals').open), page.url());
  await page.goto(url('/a.html#dec-fixlimit-3'), { waitUntil: 'networkidle' });
  check('a link to a card inside the list opens the list', await page.evaluate(() => document.getElementById('approvals').open && document.getElementById('dec-fixlimit-3').getBoundingClientRect().height > 0));

  // ---- 7. the phone and laptop layouts keep the control usable; no script errors
  const box = await press(3).boundingBox();
  check('the control is inside the viewport width and a usable tap size', box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width && box.height >= 24, JSON.stringify(box));
  check('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await ctx.close();
} finally { await browser.close(); server.close(); }
failed = checks.some(c => !c.ok);
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, ok: !failed, checks }, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
process.exit(failed ? 1 : 0);
