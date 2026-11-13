#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real Work page (/work?view=jobs) served by the
// dashboard's own request handler over the real records of PR #1180: filter to blocked, group by cause, read the totals, open the side panel
// of job 60b46719 and see the other jobs on PR #1180, hide and resize a column, save a view and find it restored, download the CSV, and at
// phone width check the wrapping, the 44 px tap size and no sideways scroll. Writes <name>.json to /out.
// Usage: node jobs-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'jobs', out = arg('out') || '/out';
const REBASE = '60b46719', REVIEW = '91896f66';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC', acceptDownloads: true });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const rowIds = () => page.locator('tr[data-job]').evaluateAll(rs => rs.map(r => r.dataset.job));
  const nav = action => Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), action()]);
  // A real tap (phone) or click (desktop) at the middle of the element: the row opens its panel from any cell. The locator click is not used here
  // because its hit test mis-reports a neighbour as covering the target in the stacked phone layout, where nothing overlaps (a mouse press and a touch tap at the same point work).
  const tap = async loc => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
    if (profile.startsWith('phone')) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
  };
  const total = async n => (await page.locator(`[data-total="${n}"]`).textContent()).replace(/\s+/g, ' ').trim();

  await page.goto(url('/work'), { waitUntil: 'networkidle' });
  check('the Work page opens on the Queue view, which says Queue', /Queue/.test(await page.locator('main').textContent()));
  await nav(() => page.locator('[data-work-view="jobs"]').click());
  check('the Jobs button opens the Jobs view with one row per job', (await rowIds()).length === 4, JSON.stringify(await rowIds()));
  const heads = await page.locator('th[data-col]').evaluateAll(hs => hs.map(h => h.textContent.trim()));
  check('all fifteen columns are there', heads.length === 15 && heads[0] === 'Id' && heads.at(-1) === 'Wasted tokens', heads.join('|'));
  check('an unknown cost shows unknown', (await page.locator('tr[data-job] td.c-costGbp').allTextContents()).includes('unknown'));

  await nav(() => page.locator('[data-chip="status:blocked"]').click());
  check('filtering to blocked leaves job 60b46719', JSON.stringify(await rowIds()) === JSON.stringify([REBASE]), JSON.stringify(await rowIds()));
  await nav(() => page.locator('[data-group="cause"]').click());
  check('grouping by cause shows the deterministic group', /^deterministic/.test((await page.locator('tr.grp').first().getAttribute('data-group-row')) || ''));
  check('the totals row shows the filtered set', (await total('Jobs')).endsWith('1') && /3,427,984/.test(await total('Wasted tokens')) && /£1\.21/.test(await total('Cost')) && /100%/.test(await total('Share wasted')),
    JSON.stringify([await total('Jobs'), await total('Tokens'), await total('Cost'), await total('Wasted tokens'), await total('Share wasted')]));

  await nav(() => tap(page.locator(`tr[data-job="${REBASE}"] td.c-kind`)));
  const panel = page.locator(`[data-job-panel="${REBASE}"]`);
  check('clicking the row opens the side panel of 60b46719', await panel.count() === 1);
  const same = await panel.locator('[data-same-ref]').evaluateAll(l => l.map(x => x.dataset.sameRef));
  check('the panel lists the other jobs on PR #1180 in order', JSON.stringify(same) === JSON.stringify([REBASE, REVIEW]), JSON.stringify(same));
  check('the panel shows the postcondition that was not met', /Not met/.test(await panel.locator('[data-job-postcondition]').textContent()) && /no new head was pushed/.test(await panel.textContent()));

  // Columns: hide Model, resize Cause with the keyboard, and both survive a reload.
  await page.locator('.jobs-cols summary').click();
  await tap(page.locator('[data-col-toggle="model"]'));
  check('hiding Model hides its header and cells', !(await page.locator('th.c-model').isVisible()) && !(await page.locator('td.c-model').first().isVisible()));
  const grip = page.locator('[data-grip="cause"]');
  await grip.focus();
  const before = await page.locator('th.c-cause').evaluate(e => e.getBoundingClientRect().width);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const after = await page.locator('th.c-cause').evaluate(e => e.getBoundingClientRect().width);
  check('the arrow keys resize the Cause column', after > before + 20 || profile.startsWith('phone'), `${before} -> ${after}`);
  await page.reload({ waitUntil: 'networkidle' });
  check('the hidden column stays hidden after a reload', !(await page.locator('th.c-model').isVisible()));
  await page.locator('.jobs-cols summary').click();
  await tap(page.locator('[data-col-toggle="model"]'));

  // Saved view: save the blocked, by cause view, leave, come back to the bare Jobs address and find it again.
  await page.locator('[data-jobs-views] input[name=name]').fill('Blocked by cause');
  await page.locator('[data-jobs-views] button[type=submit]').click();
  check('saving a view says so', /Saved view/.test(await page.locator('[data-jobs-status]').textContent()));
  await page.goto(url('/work'), { waitUntil: 'networkidle' });
  await page.goto(url('/work?view=jobs&reset=1'), { waitUntil: 'networkidle' });
  check('Clear filters starts from the whole table', (await rowIds()).length === 4, JSON.stringify(await rowIds()));
  await page.goto(url('/work?view=jobs'), { waitUntil: 'networkidle' });
  check('opening Jobs again restores the saved view', JSON.stringify(await rowIds()) === JSON.stringify([REBASE]) && page.url().includes('status=blocked') && page.url().includes('group=cause'), page.url());
  check('the saved view is in the list', (await page.locator('[data-jobs-views] select option').allTextContents()).includes('Blocked by cause'));

  // The page refreshes cards in place. A new running job changes the Jobs card, so the tools bar is rebuilt: it must stay usable.
  await page.evaluate(() => fetch('/__bump'));
  await page.locator('button.refresh-now').evaluate(b => b.click());
  const swapped = await page.waitForSelector('[data-chip="status:running"]', { timeout: 5000 }).then(() => true, () => false);
  check('the refresh in place swapped the Jobs card (the new running job has a filter button)', swapped);
  check('the tools bar is still shown after the refresh in place', await page.locator('[data-jobs-tools]').isVisible() && await page.locator('[data-jobs-csv]').isVisible());
  await page.locator('[data-jobs-views] input[name=name]').fill('After refresh');
  await page.locator('[data-jobs-views] button[type=submit]').click();
  check('saving a view after the refresh saves it and stays on the Jobs view', /Saved view/.test(await page.locator('[data-jobs-status]').textContent()) && page.url().includes('view=jobs')
    && (await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('dash.jobs.views') || '{}')))).includes('After refresh'), page.url());
  check('the saved views list holds the new view after the refresh', (await page.locator('[data-jobs-views] select option').allTextContents()).includes('After refresh'));

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-jobs-csv]').click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8').trimEnd().split('\r\n');
  check('the CSV download is the current table', download.suggestedFilename() === 'jobs.csv' && csv.length === 2 && csv[1].startsWith('60b46719') && /,1\.21,2,3427984$/.test(csv[1]), csv.join(' | '));

  const geo = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - innerWidth,
    small: [...document.querySelectorAll('.qf')].filter(c => c.getBoundingClientRect().height < 44).length,
    right: Math.max(...[...document.querySelectorAll('.qf')].map(c => c.getBoundingClientRect().right)) - innerWidth,
  }));
  check('no sideways scroll', geo.over <= 0 && geo.right <= 0, JSON.stringify(geo));
  check('every filter button is at least 44 px high', geo.small === 0, JSON.stringify(geo));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 600)); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
