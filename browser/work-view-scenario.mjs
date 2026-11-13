#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target). Drives the real /work page served by the dashboard's own
// request handler over the 21-item queue fixture: switches to Table, sorts by Rank, filters to held, groups by hold reason, opens the side
// panel for #1169 and reads its hold reason, saves a view and reloads to see it restored, downloads the CSV, switches to Board.
// Writes <name>.json and screenshots to /out. Usage: node work-view-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'work-view', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail).slice(0, 1500) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
let page = null;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC', acceptDownloads: true });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const rowRefs = () => page.locator('.wv-row [data-cell=ref]').allTextContents().then(a => a.map(t => t.trim()));
  // Scrolls the control to the middle of its frame, then presses it with the mouse; the panel opening is what the checks assert.
  const press = async locator => { await locator.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'nearest' })); await locator.click({ force: true }); };
  const states = () => page.locator('.wv-row [data-cell=state]').allTextContents().then(a => a.map(t => t.trim()));

  await page.goto(url('/work'), { waitUntil: 'networkidle' });
  check('the Work page opens on the queue cards, with the Queue heading and the three switch buttons',
    (await page.locator('[data-card="wq-claude"]').isVisible()) && (await page.locator('.vs-btn').count()) === 3 && /Queue/.test(await page.locator('[data-card="wq-claude"] h2').textContent()));
  check('the table is not shown yet', !(await page.locator('.wv-table').count()));

  await page.locator('.vs-btn[data-view=table]').click();
  await page.locator('.wv-table').waitFor();
  check('Table shows a row for every open item and every item finished today', (await rowRefs()).length === 23, (await rowRefs()).length);
  check('the queue cards are hidden while the table shows', !(await page.locator('[data-card="wq-claude"]').isVisible()));

  const asc = await rowRefs();
  check('the table opens sorted by Rank, #1153 first and #1169 seventeenth', asc[0] === '#1153' && asc.indexOf('#1169') === 16, asc.slice(0, 18).join(' '));
  check('the Rank header says it is sorted ascending', (await page.locator('th[data-col=rank]').getAttribute('aria-sort')) === 'ascending');
  await page.locator('[data-sort=rank]').click();
  check('pressing Rank reverses the order, PR 1180 first', (await rowRefs())[0] === 'PR 1180' && (await page.locator('th[data-col=rank]').getAttribute('aria-sort')) === 'descending', (await rowRefs())[0]);
  await page.locator('[data-sort=title]').click();
  check('sorting by another column sorts that column ascending', (await page.locator('th[data-col=title]').getAttribute('aria-sort')) === 'ascending' && (await rowRefs())[0] === '#1169');
  await page.locator('[data-sort=rank]').click();
  check('and Rank again sorts ascending, back to the queue order', (await rowRefs())[0] === '#1153');

  await page.locator('[data-facet=state][data-value=held]').click();
  const heldStates = await states();
  const heldRefs = await rowRefs();
  check('filtering to Held shows only held items, with #1169 and PR 1180', heldStates.length > 2 && heldStates.every(s => s === 'Held') && heldRefs.includes('#1169') && heldRefs.includes('PR 1180'), heldRefs.join(' '));
  check('the button shows a count that matches the rows', Number(await page.locator('[data-facet=state][data-value=held] .qf-n').textContent()) === heldStates.length);

  await page.locator('[data-wv-group]').selectOption('holdReason');
  const groups = await page.locator('.wv-group th').allTextContents();
  check('grouping by hold reason makes one group per reason', groups.some(g => /waiting for #1157 still open/.test(g)) && groups.some(g => /stopped after 3 attempts/.test(g)), groups.join(' | '));

  await press(page.locator('[data-open="issue:1169"]'));
  const panel = page.locator('.wv-side');
  await panel.waitFor({ state: 'visible' });
  const panelText = (await panel.textContent()).replace(/\s+/g, ' ');
  check('the side panel for #1169 shows its hold reason and when it began', /waiting for #1157 still open/.test(panelText) && /Began: (?!not recorded)/.test(panelText), panelText.slice(0, 300));
  check('the side panel shows the dependency chain and the GitHub link', /#1157/.test(panelText) && (await panel.locator('a[href$="/issues/1169"]').count()) === 1);
  await page.screenshot({ path: path.join(out, `${name}-panel.png`), fullPage: false });
  await page.locator('[data-wv-close]').click();
  check('Close hides the panel', !(await panel.isVisible()));

  await page.locator('[data-wv-name]').fill('Held by reason');
  await page.locator('[data-wv-save]').click();
  check('the view is saved under its name', (await page.locator('[data-wv-saved] option').allTextContents()).includes('Held by reason'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.wv-table').waitFor();
  const back = await rowRefs();
  check('after a reload the table, filter and grouping are restored', (await page.locator('[data-facet=state][data-value=held]').getAttribute('aria-pressed')) === 'true'
    && (await page.locator('[data-wv-group]').inputValue()) === 'holdReason' && back.length === heldRefs.length, back.length);
  check('after a reload the saved view is still listed', (await page.locator('[data-wv-saved] option').allTextContents()).includes('Held by reason'));
  await page.locator('[data-wv-clear]').click();
  await page.locator('[data-wv-group]').selectOption('');
  check('clearing shows every item again', (await rowRefs()).length === 23);
  await page.locator('[data-wv-saved]').selectOption('Held by reason');
  check('choosing the saved view brings the filter and grouping back', (await rowRefs()).length === heldRefs.length && (await page.locator('[data-wv-group]').inputValue()) === 'holdReason');

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-wv-csv]').click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  check('the CSV download is the current table: header, held rows only, #1169 with its hold reason', download.suggestedFilename() === 'work-queue.csv'
    && csv.startsWith('Ref,Title,Kind,Agent,Role,State,Rank,Waits on,Hold reason') && /#1169,Table view of the queue,Issue,claude,implementer,Held,17,#1157,waiting for #1157 still open/.test(csv)
    && csv.trimEnd().split('\r\n').length === heldRefs.length + 1, csv.split('\r\n').slice(0, 3).join(' / '));

  await page.locator('.vs-btn[data-view=board]').click();
  await page.locator('.wv-board').waitFor();
  const cols = await page.locator('.wv-col-board h3').allTextContents();
  check('Board has the six columns', JSON.stringify(cols.map(c => c.replace(/\s*\d+$/, ''))) === JSON.stringify(['Held', 'Planned', 'Running', 'In review', 'Waiting for you', 'Merged today']), cols.join('|'));
  const card = (await page.locator('[data-board=held] .wv-card', { hasText: '#1169' }).textContent()).replace(/\s+/g, ' ');
  check('the card for #1169 shows ref, title, agent and hold reason', /#1169/.test(card) && /Table view of the queue/.test(card) && /claude/.test(card) && /waiting for #1157 still open/.test(card), card);
  await page.locator('.wv-card', { hasText: '#1169' }).click();
  check('clicking a card opens the same side panel', /Dependency chain/.test(await page.locator('.wv-side').textContent()));
  await page.locator('[data-wv-close]').click();
  await page.screenshot({ path: path.join(out, `${name}-board.png`), fullPage: true });

  await page.locator('.vs-btn[data-view=cards]').click();
  check('Queue cards brings the cards back', await page.locator('[data-card="wq-claude"]').isVisible());
  await page.locator('.vs-btn[data-view=table]').click();
  const geo = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, small: [...document.querySelectorAll('.vs-btn,.wv-chip')].filter(c => c.getBoundingClientRect().height < 44).length }));
  check('the page has no sideways scroll (the table scrolls inside its frame)', geo.over <= 0, JSON.stringify(geo));
  check('every switch and filter button is at least 44 px high', geo.small === 0, JSON.stringify(geo));
  await page.screenshot({ path: path.join(out, `${name}-table.png`), fullPage: false });

  // Issue #930 guarantee for the new card: a refresh in place that swaps the card keeps the viewer's place.
  await page.locator('.wv-scroll').evaluate(e => { e.scrollLeft = 300; e.scrollTop = 40; });
  const before = await page.locator('.wv-scroll').evaluate(e => ({ left: e.scrollLeft, top: e.scrollTop }));
  const swaps = await page.evaluate(() => { window.__swaps = 0; document.addEventListener('card-rebuilt', () => { window.__swaps++; }); });
  await page.waitForTimeout(1100);   // the page's generated-at stamp changes between fetches, so the card is swapped
  await page.locator('.refresh-now').click();
  await page.waitForFunction(() => window.__swaps > 0, null, { timeout: 8000 }).catch(() => {});
  const after = await page.locator('.wv-scroll').evaluate(e => ({ left: e.scrollLeft, top: e.scrollTop }));
  check('a refresh in place that swaps the card keeps the table drawn and its scroll place',
    swaps === undefined && (await page.evaluate(() => window.__swaps)) > 0 && (await page.locator('.wv-table').count()) === 1
    && after.left === before.left && after.top === before.top && before.left > 0, JSON.stringify({ before, after }));
  check('no script errors', errors.length === 0, errors.join('; '));
  await ctx.close();
} catch (e) { check('the scenario ran to the end', false, String(e.stack || e).slice(0, 1500)); await page?.screenshot({ path: path.join(out, `${name}-failure.png`) }).catch(() => {}); } finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
