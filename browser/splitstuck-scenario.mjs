#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Issue #1240: the split card of a stuck pull request.
// The page is the real Overview holding the real data of PR 1139 with a proposed split. Only the network edge is answered by this script: POST /decision
// and the page's own periodic fetch (/a.html, answered with /b.html, the split filed, once Approve split was pressed).
// Checks: the card shows the parking reason and the draft items, has both buttons, Approve split sends one POST and the card changes without a page
// reload, Reject split sends its POST and files nothing (the page keeps the parked PR). Writes <name>.json and a screenshot to /out.
// Usage: node splitstuck-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'splitstuck', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  const url = p => `http://127.0.0.1:${port}${p}`;
  const bHtml = await (await ctx.request.get(url('/b.html'))).text();
  const served = { page: 'a', posts: [], reply: json(200, { ok: true, outcome: 'done', message: 'Recorded. Foreman applies it on the next pass.' }) };
  await ctx.route('**/*', async r => {
    const req = r.request(), p = new URL(req.url()).pathname;
    if (!isAllowed(req.url(), port)) return r.abort('blockedbyclient');
    if (req.method() === 'POST' && p === '/decision') { served.posts.push(req.postData() || ''); return r.fulfill(served.reply); }
    if (req.resourceType() === 'fetch' && p === '/a.html' && served.page === 'b') return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bHtml });
    return r.continue();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  let navigations = 0; page.on('load', () => { navigations++; });
  await page.goto(url('/a.html'), { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__same = 'still here'; });
  const startNav = navigations;
  const openList = async () => { if (!(await page.evaluate(() => document.getElementById('approvals')?.open))) await page.locator('#approvals > summary').evaluate(s => s.click()); };
  await openList();
  const card = page.locator('#dec-split-stuck-1139 .decision-card[data-decision="split-stuck"]');
  const text = async () => (await card.textContent()) || '';
  check('the split card is on the page', (await card.count()) === 1);
  check('the card shows the parking reason', /Parked: 4 fix rounds/.test(await text()), (await text()).slice(0, 200));
  check('the card shows the three drafted items', /Capacity team/.test(await text()) && /Issue assignment/.test(await text()) && /Inbox agent and pass speed/.test(await text()));
  const approve = card.locator('button.decision-control', { hasText: 'Approve split' }), reject = card.locator('button.decision-control', { hasText: 'Reject split' });
  check('both buttons are visible', (await approve.isVisible()) && (await reject.isVisible()));
  for (const [label, b] of [['Approve split', approve], ['Reject split', reject]]) {
    const box = await b.boundingBox();
    check(`${label} is inside the viewport width and a usable tap size`, box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width && box.height >= 24, JSON.stringify(box));
  }
  check('the card does not overflow sideways (the AI status panel above it is not this item\'s)', await card.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth && [...el.querySelectorAll('*')].every(e => e.getBoundingClientRect().right <= r.right + 1); }));

  // Reject first: one POST, the answer is shown on the card, the card is still there and the PR is still shown as parked.
  await reject.evaluate(b => b.scrollIntoView({ block: 'center' }));
  await reject.click();
  await page.waitForFunction(() => /^Done:/.test(document.querySelector('#dec-split-stuck-1139 .decision-status')?.textContent || ''), null, { timeout: 4000 }).catch(() => {});
  check('Reject sends one POST for reject_split and files nothing on the page', served.posts.length === 1 && /control=reject_split/.test(served.posts[0]) && /card=split-stuck-1139/.test(served.posts[0]), served.posts.join('|'));
  check('Reject: the card says done in place and the PR stays parked', /Done:/.test(await text()) && (await page.content()).includes('parked'));

  // Approve: one POST, in place; the next refresh shows the filed items.
  await page.reload({ waitUntil: 'networkidle' });
  await openList();
  await page.evaluate(() => { window.__same = 'still here'; });
  const nav2 = navigations;
  served.posts.length = 0;
  await approve.evaluate(b => b.scrollIntoView({ block: 'center' }));
  await approve.click();
  await page.waitForFunction(() => /^Done:/.test(document.querySelector('#dec-split-stuck-1139 .decision-status')?.textContent || ''), null, { timeout: 4000 }).catch(() => {});
  check('Approve sends one POST for approve_split', served.posts.length === 1 && /control=approve_split/.test(served.posts[0]) && /card=split-stuck-1139/.test(served.posts[0]), served.posts.join('|'));
  check('Approve: no page reload', navigations === nav2 && (await page.evaluate(() => window.__same)) === 'still here', `${nav2}/${navigations}`);
  served.page = 'b';
  await page.locator('button.refresh-now').evaluate(b => b.click());
  await page.waitForFunction(() => !document.getElementById('dec-split-stuck-1139'), null, { timeout: 4000 }).catch(() => {});
  check('after the refresh the approved card has left the list of what needs a decision', (await page.locator('#dec-split-stuck-1139').count()) === 0);
  check('the refresh did not reload the page', navigations === nav2 && (await page.evaluate(() => window.__same)) === 'still here');
  // The PR page shows the parking reason and the items, before the approval (drafted) and after it (filed with their numbers).
  await page.goto(url('/pr-proposed.html'), { waitUntil: 'networkidle' });
  const proposedText = (await page.locator('body').textContent()) || '';
  check('the PR page shows the parking reason and the drafted items', /Parked/.test(proposedText) && /4 fix rounds/.test(proposedText) && /Capacity team/.test(proposedText) && /Inbox agent and pass speed/.test(proposedText));
  await page.goto(url('/pr.html'), { waitUntil: 'networkidle' });
  const prText = (await page.locator('body').textContent()) || '';
  check('the PR page shows the new items with their issue numbers', /#2000/.test(prText) && /#2001/.test(prText) && /#2002/.test(prText) && /filed/.test(prText), prText.slice(0, 300));
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await ctx.close();
} catch (e) { checks.push({ name: 'the scenario ran to the end', ok: false, detail: String(e.stack).slice(0, 1500) }); } finally { await browser.close(); server.close(); }
failed = checks.some(c => !c.ok);
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, ok: !failed, checks }, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
process.exit(failed ? 1 : 0);
