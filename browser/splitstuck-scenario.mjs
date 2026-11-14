#!/usr/bin/env node
// The pinned-browser scenario for a parked pull request split (issue #1343).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = key => {
  const index = process.argv.indexOf(`--${key}`);
  return index > 0 ? process.argv[index + 1] : null;
};
const target = arg('target') || 'fixture';
const profile = arg('profile') || 'desktop-1280';
const name = arg('name') || 'splitstuck';
const out = arg('out') || '/out';
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
const pageUrl = (port, pathname) => `http://127.0.0.1:${port}${pathname}`;
const bodyText = async locator => (await locator.textContent()) || '';
const splitDone = () => /^Done:/.test(document.querySelector('#dec-split-stuck-1139 .decision-status')?.textContent || '');

const waitForSplitResult = page => page.waitForFunction(splitDone, null, { timeout: 4000 }).catch(() => {});

async function openApprovals(page) {
  if (!(await page.evaluate(() => document.getElementById('approvals')?.open))) {
    await page.locator('#approvals > summary').evaluate(summary => summary.click());
  }
}

async function checkCard(page, card) {
  const text = await bodyText(card);
  const approve = card.locator('button.decision-control', { hasText: 'Approve split' });
  const reject = card.locator('button.decision-control', { hasText: 'Reject split' });
  check('the split card is on the page', (await card.count()) === 1);
  check('the card shows the parking reason', /Parked: 4 fix rounds/.test(text), text.slice(0, 200));
  check('the card shows the three drafted items', /Capacity team/.test(text) && /Issue assignment/.test(text) && /Inbox agent and pass speed/.test(text));
  check('both buttons are visible', (await approve.isVisible()) && (await reject.isVisible()));
  for (const [label, button] of [['Approve split', approve], ['Reject split', reject]]) {
    const box = await button.boundingBox();
    const fits = box && box.x >= 0 && box.x + box.width <= PROFILES[profile].viewport.width && box.height >= 24;
    check(`${label} is inside the viewport width and a usable tap size`, fits, JSON.stringify(box));
  }
  const fitsCard = await card.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= document.documentElement.clientWidth
      && [...element.querySelectorAll('*')].every(child => child.getBoundingClientRect().right <= rect.right + 1);
  });
  check('the card does not overflow sideways', fitsCard);
  return { approve, reject };
}

async function rejectSplit(page, card, reject, served) {
  await reject.evaluate(button => button.scrollIntoView({ block: 'center' }));
  await reject.click();
  await waitForSplitResult(page);
  check('Reject sends one POST for reject_split and files nothing on the page', served.posts.length === 1
    && /control=reject_split/.test(served.posts[0]) && /card=split-stuck-1139/.test(served.posts[0]), served.posts.join('|'));
  check('Reject leaves the pull request parked in place', /Done:/.test(await bodyText(card)) && (await page.content()).includes('parked'));
}

async function approveSplit(page, approve, served, navigations) {
  await approve.evaluate(button => button.scrollIntoView({ block: 'center' }));
  await approve.click();
  await waitForSplitResult(page);
  check('Approve sends one POST for approve_split', served.posts.length === 1
    && /control=approve_split/.test(served.posts[0]) && /card=split-stuck-1139/.test(served.posts[0]), served.posts.join('|'));
  check('Approve files the split without a page reload', navigations.count === navigations.before
    && (await page.evaluate(() => window.__splitStuck)) === 'still here', `${navigations.before}/${navigations.count}`);
  served.page = 'filed';
  await page.locator('button.refresh-now').evaluate(button => button.click());
  await page.waitForFunction(() => !document.getElementById('dec-split-stuck-1139'), null, { timeout: 4000 }).catch(() => {});
  check('the refreshed decision list has no proposed split card', (await page.locator('#dec-split-stuck-1139').count()) === 0);
  check('the refresh did not reload the page', navigations.count === navigations.before
    && (await page.evaluate(() => window.__splitStuck)) === 'still here');
}

async function checkPullRequestPages(page, url) {
  await page.goto(url('/pr-proposed.html'), { waitUntil: 'networkidle' });
  const proposed = await bodyText(page.locator('body'));
  check('the pull request page shows the parking reason and draft before approval', /Parked/.test(proposed)
    && /4 fix rounds/.test(proposed) && /Capacity team/.test(proposed) && /Inbox agent and pass speed/.test(proposed));
  await page.goto(url('/pr.html'), { waitUntil: 'networkidle' });
  const filed = await bodyText(page.locator('body'));
  check('the pull request page links each filed item after approval', /#2000/.test(filed)
    && /#2001/.test(filed) && /#2002/.test(filed) && /filed/.test(filed), filed.slice(0, 300));
}

const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/work';
const playwright = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (playwright.default ?? playwright).chromium.launch({
  headless: true,
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'],
});
let failed = true;
try {
  const context = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  const url = pathname => pageUrl(port, pathname);
  const filedHtml = await (await context.request.get(url('/b.html'))).text();
  const served = { page: 'proposed', posts: [] };
  await context.route('**/*', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!isAllowed(request.url(), port)) return route.abort('blockedbyclient');
    if (request.method() === 'POST' && pathname === '/decision') {
      served.posts.push(request.postData() || '');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (request.resourceType() === 'fetch' && pathname === '/a.html' && served.page === 'filed') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: filedHtml });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  const navigations = { count: 0, before: 0 };
  page.on('pageerror', error => errors.push(String(error.message).slice(0, 200)));
  page.on('load', () => { navigations.count++; });
  await page.goto(url('/a.html'), { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__splitStuck = 'still here'; });
  await openApprovals(page);
  let card = page.locator('#dec-split-stuck-1139 .decision-card[data-decision="split-stuck"]');
  let controls = await checkCard(page, card);
  await rejectSplit(page, card, controls.reject, served);

  await page.reload({ waitUntil: 'networkidle' });
  await openApprovals(page);
  await page.evaluate(() => { window.__splitStuck = 'still here'; });
  navigations.before = navigations.count;
  served.posts.length = 0;
  card = page.locator('#dec-split-stuck-1139 .decision-card[data-decision="split-stuck"]');
  controls = await checkCard(page, card);
  await approveSplit(page, controls.approve, served, navigations);
  await checkPullRequestPages(page, url);
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await context.close();
} catch (error) {
  checks.push({ name: 'the scenario ran to the end', ok: false, detail: String(error.stack).slice(0, 1500) });
} finally {
  await browser.close();
  server.close();
}
failed = checks.some(checkResult => !checkResult.ok);
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, ok: !failed, checks }, null, 2));
for (const checkResult of checks) console.log(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.name}${checkResult.ok ? '' : ` :: ${checkResult.detail}`}`);
process.exit(failed ? 1 : 0);
