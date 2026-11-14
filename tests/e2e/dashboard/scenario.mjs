// Runs inside the pinned Playwright image and checks homeowner-visible dashboard behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed } from '/src/browser/capture.mjs';

const [target, variant] = process.argv.slice(2);
const validTarget = /^[a-z][a-z0-9-]{0,31}$/.test(target || '');
const validVariant = ['valid', 'long', 'empty', 'malformed', 'best', 'best-none', 'best-beaten'].includes(variant);
if (!validTarget || !validVariant) {
  throw new Error('usage: scenario.mjs <target> <valid|empty|malformed>');
}
const checks = [];
const check = async (name, promise) => { await promise; checks.push(name); };
const { server, port } = await bridge(path.join('/targets', `${target}.sock`));
let browser;
try {
  const playwright = await import(pathToFileURL('/cache/package/index.mjs').href);
  browser = await playwright.chromium.launch({
    headless: true,
    args: [
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--disable-dev-shm-usage'
    ]
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-GB', timezoneId: 'UTC' });
  const blocked = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (isAllowed(url, port)) return route.continue();
    blocked.push(url);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  const go = pathname => page.goto(`http://127.0.0.1:${port}${pathname}`, { waitUntil: 'domcontentloaded' });
  await go('/');
  if (variant === 'valid') {
    await check('overview renders fixture figure', page.getByRole('link', { name: '#1148 Dashboard browser test fixture' }).waitFor());
    await check('inbox proposal has approve control', page.locator('#c-now button.inbox-approve[type="submit"]').count().then(count => {
      if (count !== 1) throw new Error(`expected one proposal approve control, got ${count}`);
    }));
    await check('decision action text renders', page.locator('.inbox-text').filter({ hasText: 'reopen 1148' }).waitFor());
    await go('/work/');
    const issue = page.locator('[data-table="issues"] tbody tr').filter({ hasText: 'Dashboard browser test fixture' });
    await check('work page lists fixture item and stage', issue.getByRole('link', { name: '#1148 Dashboard browser test fixture' }).waitFor());
    await check('work page exposes item status', issue.getByText('starts on the next tick').waitFor());
  } else if (variant === 'long') {
    await go('/work/');
    await check('long work list is paginated', page.getByLabel('issues pages').getByText('Page 1 of 3').waitFor());
    const issues = page.locator('[data-table="issues"]');
    await check('long work list has the first fixture item', issues.getByRole('link', { name: '#2000 Long fixture issue 1' }).waitFor());
    await check('long work list links to its next page', page.getByLabel('issues pages').getByRole('link', { name: 'Next' }).waitFor());
  } else if (variant === 'best') {
    const card = id => page.locator(`#hl-${id} .hl-block[data-window="24h"] .hl-best`);
    await check('approval card shows the record line', card('first-pass').filter({ hasText: 'Best 24 hours 84.9% (45 of 53), 6 to 7 Nov' }).waitFor());
    await check('merged card shows the most merged line', card('merge-rate').filter({ hasText: 'Most merged in 24 hours 106, 6 to 7 Nov' }).waitFor());
    await check('the record is not called beaten', page.getByText('Record beaten').count().then(count => {
      if (count !== 0) throw new Error(`expected no beaten wording, got ${count}`);
    }));
  } else if (variant === 'best-none') {
    await check('no record line on either card', page.locator('.hl-best').count().then(count => {
      if (count !== 0) throw new Error(`expected no record line, got ${count}`);
    }));
    await check('the approval card is still there', page.locator('#hl-first-pass').waitFor());
  } else if (variant === 'best-beaten') {
    await check('approval card says the record is beaten', page.locator('#hl-first-pass .hl-block[data-window="24h"] .hl-best').filter({ hasText: 'Record beaten' }).waitFor());
    await check('merged card says the record is beaten', page.locator('#hl-merge-rate .hl-block[data-window="24h"] .hl-best').filter({ hasText: 'Record beaten' }).waitFor());
  } else if (variant === 'empty') {
    await check('empty overview has no-needs state', page.getByText('Nothing needs you').waitFor());
    await check('empty overview has no-plan state', page.getByText('Nothing planned').waitFor());
    await go('/work/');
    await check('empty work has no-issues state', page.getByText('No issues cached').waitFor());
  } else {
    await check('malformed state has a dashboard error', page.getByText('dashboard could not read the supervisor state').waitFor());
  }
  if (blocked.length) throw new Error(`blocked unexpected request: ${blocked[0]}`);
  await context.close();
  fs.writeFileSync(`/out/dashboard-e2e-${variant}.json`, `${JSON.stringify({ ok: true, variant, checks })}\n`);
} catch (error) {
  fs.writeFileSync(`/out/dashboard-e2e-${variant}.json`, `${JSON.stringify({ ok: false, variant, error: error.message })}\n`);
  throw error;
} finally {
  await browser?.close();
  server.close();
}
