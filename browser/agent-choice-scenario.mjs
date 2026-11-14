#!/usr/bin/env node
// Runs inside the pinned Playwright container. It checks the real dashboard Next card at desktop and phone widths: choice reasons for
// an implement and repair, a review reason, an incomplete candidate, and a planned action with no empty reason line.
// Usage: node agent-choice-scenario.mjs --target fixture --profile <name> --page /card.html --name <stem>
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
const name = arg('name') || 'agent-choice';
const out = arg('out') || '/out';
const checks = [];
const check = (label, ok, detail = '') => checks.push({ label, ok: Boolean(ok), detail: String(detail) });
const { port } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const playwright = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (playwright.default ?? playwright).chromium.launch({
  headless: true,
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'],
});

let failed = true;
try {
  const context = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await context.route('**/*', route => (isAllowed(route.request().url(), port) ? route.continue() : route.abort('blockedbyclient')));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}${arg('page') || '/card.html'}`, { waitUntil: 'networkidle' });

  const card = page.locator('[data-card="next"]').first();
  const implement = card.locator('[data-key="next-beta-implement-1166"]');
  const repair = card.locator('[data-key="next-gamma-fix-7"]');
  const review = card.locator('[data-key="next-reviewer-review-22"]');
  const noChoice = card.locator('[data-key="next-nobody-implement-44"]');
  const implementText = (await implement.innerText()) || '';
  const repairText = (await repair.innerText()) || '';
  const implementFields = [
    'beta chosen by least plan cost',
    'alpha: spare',
    'expected share 4%',
    'recent rate',
    'short room',
    'free slot',
    'beta: spare',
    'expected share 3%',
  ];
  const implementReasonComplete = implementFields.every(text => implementText.includes(text));

  check('the Next card is on the page', (await card.count()) === 1);
  check('the implement choice names both candidates, their figures and the deciding rule',
    implementReasonComplete, implementText);
  check('the configured default share keeps its short history note',
    implementText.includes('history too short (1 of 3 implement jobs seen); configured default share'), implementText);
  check('the repair choice renders and an incomplete candidate says its spare is unknown',
    repairText.includes('gamma chosen by only qualifying candidate') && repairText.includes('missing: spare unknown'), repairText);
  check('a review keeps its existing reason',
    (await review.locator('.sub').innerText()) === "today's review rank and independence rule");
  check('a plan with no choice has no empty reason line', (await noChoice.locator('.sub').count()) === 0);
  const inViewport = await card.evaluate(element => {
    const width = document.documentElement.clientWidth;
    return [element, ...element.querySelectorAll('*')].every(child => child.getBoundingClientRect().right <= width + 1);
  });
  check('nothing in the Next card runs past the viewport', inViewport);
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(checkResult => !checkResult.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const checkResult of checks) {
    console.log(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.label}${checkResult.ok ? '' : ` :: ${checkResult.detail}`}`);
  }
} catch (error) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(error.stack).slice(0, 1500) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
