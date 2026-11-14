#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Drives the real /inbox page (issue #1219):
// the default view for the width, each of the three views, a sort by Age, a hidden column and a view that survive a reload, an
// expanded Compact list row, and no sideways page scroll. Writes <name>.json and a screenshot to /out.
// Usage: node inbox-views-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'inbox-views', out = arg('out') || '/out';
const phone = PROFILES[profile].viewport.width < 640;
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  await ctx.route('**/*', r => (isAllowed(r.request().url(), port) ? r.continue() : r.abort('blockedbyclient')));
  // The app bar's agent item (.ai-stale, issue #1221) makes every dashboard page 15 px too wide at 390, on main as well. That is not this
  // page, so the fixture leaves that one item out and the sideways-scroll checks below measure the Inbox itself.
  await ctx.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '.agent-item{display:none!important}';
    document.head.append(style);
  }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  const open = async () => { await page.goto(`http://127.0.0.1:${port}/inbox?state=all`, { waitUntil: 'networkidle' }); };
  const pane = n => page.locator(`[data-iv] [data-pane="${n}"]`);
  const visiblePanes = async () => { const v = []; for (const n of ['cards', 'table', 'compact']) if (await pane(n).isVisible()) v.push(n); return v.join(','); };
  const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const rowTitles = () => page.locator('[data-iv] .iv-table tbody tr td[data-col="title"]').allTextContents();

  await open();
  check('the page is /inbox with an Inbox heading', /Inbox/.test(await page.title()) || (await page.locator('h1').first().textContent()).includes('Inbox'));
  check(`default view for ${phone ? 'a phone is Compact list' : 'desktop is Table'}`, (await visiblePanes()) === (phone ? 'compact' : 'table'), await visiblePanes());
  const text = await page.locator('main').innerText();
  for (const t of ['Rules drift check read only Driftcheck', 'Post-mortem: 3 jobs failed with cause deterministic', 'Tidy the docs index']) check(`the fixture item is on the page: ${t}`, text.includes(t) || (await page.locator(`text=${t}`).count()) > 0);

  for (const [label, key] of [['Cards', 'cards'], ['Table', 'table'], ['Compact list', 'compact']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    check(`the ${label} button shows only the ${key} view`, (await visiblePanes()) === key, await visiblePanes());
    check(`no sideways page scroll in ${label}`, await noSideways());
    if (key !== 'table') check(`${label} does not scroll sideways inside itself`, await pane(key).evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  }
  const counts = {};
  for (const [key, sel] of [['cards', '[data-inbox]'], ['table', 'tbody tr'], ['compact', '.iv-crow']]) counts[key] = await pane(key).locator(sel).count();
  check('the three views hold the same number of items', counts.cards === counts.table && counts.table === counts.compact && counts.cards >= 5, JSON.stringify(counts));

  // Issue #1416: the title takes the room, the chips lead, a decided item says so, and the phone stacks each row.
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const ciwatch = page.locator('.iv-table tbody tr', { hasText: 'Ciwatch' });
  const lines = await ciwatch.locator('td[data-col="title"] .iv-title').evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  const widths = await ciwatch.locator('td:visible').evaluateAll(tds => tds.map(td => [td.dataset.col, td.getBoundingClientRect().width]));
  const titleW = Object.fromEntries(widths).title;
  if (!phone) {
    check('the Ciwatch title takes at most two lines at 1280', lines <= 2, lines);
    check('the title cell is wider than every other cell', widths.every(([k, w]) => k === 'title' || w < titleW), JSON.stringify(widths));
    check('the Kind and State chips come before the title', (await ciwatch.locator('td').evaluateAll(tds => tds.map(t => t.dataset.col).slice(0, 3).join())) === 'kind,state,title');
  } else {
    const box = el => el.evaluate(n => n.getBoundingClientRect().top);
    check('at 390 the chips, then the title, stack in the row', (await box(ciwatch.locator('td[data-col="kind"]'))) < (await box(ciwatch.locator('td[data-col="title"]'))));
  }
  check('Kind and State show a chip with their word', /Issue draft/.test(await ciwatch.locator('td[data-col="kind"] .badge').innerText()) && /waiting/.test(await ciwatch.locator('td[data-col="state"] .badge').innerText()));
  const decidedRow = page.locator('.iv-table tbody tr', { hasText: 'Splitdecided' });
  check('an item already decided shows the decision and its time', /Approved \d\d:\d\d, waiting for the next pass/.test(await decidedRow.innerText()), await decidedRow.innerText());
  check('a row not yet decided still shows its controls', (await ciwatch.locator('.iv-acts form').count()) === 2);
  check('the Result column is shown while a row has a result', await page.locator('th[data-col="result"]').isVisible());
  await page.locator('.iv-sort[data-sort="age"]').click();
  const asc = await rowTitles();
  check('Age ascending lists the newest item first', asc[0].includes('Read only drift check') && asc.at(-1).includes('Rules drift check'), asc.join(' | ').slice(0, 300));
  await page.locator('.iv-sort[data-sort="age"]').click();
  const desc = await rowTitles();
  check('a second click on Age reverses the order', desc[0].includes('Rules drift check') && desc.length === asc.length, desc.join(' | ').slice(0, 300));
  check('the sorted column says so for assistive tech', (await page.locator('th[data-col="age"]').getAttribute('aria-sort')) === 'descending');

  await page.locator('summary', { hasText: 'Columns' }).click();
  await page.locator('.iv-colmenu input[data-col="source"]').uncheck();
  check('the Source column is hidden', !(await page.locator('th[data-col="source"]').isVisible()) && !(await page.locator('td[data-col="source"]').first().isVisible()));
  await page.reload({ waitUntil: 'networkidle' });
  check('after a reload the Table view is kept', (await visiblePanes()) === 'table', await visiblePanes());
  check('after a reload the Source column is still hidden', !(await page.locator('th[data-col="source"]').isVisible()));
  check('after a reload the other columns are still shown', await page.locator('th[data-col="result"]').isVisible());
  if (phone) check('at phone width the Table scrolls inside its own container only', await noSideways() && await pane('table').evaluate(el => el.scrollWidth >= el.clientWidth));

  await page.getByRole('button', { name: 'Compact list', exact: true }).click();
  const row = page.locator('.iv-crow', { hasText: 'Post-mortem' });
  check('a Compact list row starts closed with no result text visible', !(await row.locator('.iv-more').isVisible()));
  await row.locator('summary').click();
  check('expanding a row shows its result', (await row.locator('.iv-more').isVisible()) && /posted as issue #321/.test(await row.locator('.iv-more').innerText()));
  const waiting = page.locator('.iv-crow', { hasText: 'Tidy the docs index' });
  await waiting.locator('summary').click();
  check('a waiting row shows its prompt text', /Fix the broken link/.test(await waiting.locator('.iv-more').innerText()));
  await page.reload({ waitUntil: 'networkidle' });
  check('after a reload the Compact list view is kept', (await visiblePanes()) === 'compact', await visiblePanes());
  check('no sideways page scroll in Compact list after the reload', await noSideways());
  // Issue #1466: the Running button lists the three running jobs, newest start first, and the line above the buttons counts them.
  await page.locator('a[data-chip="state:running"]').click();
  await page.waitForLoadState('networkidle');
  // The fixture also holds one approved prompt with no job (Splitdecided), which the Running view keeps next to the three jobs.
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const shown = await page.locator('.iv-table tbody tr').count();
  const chipCount = Number((await page.locator('a[data-chip="state:running"] .qf-n').innerText()).trim());
  check('the Running button count equals the rows its view shows (three jobs and the approved item)', chipCount === shown && shown === 4, shown);
  const runningLine = page.locator('.inbox-running-line a');
  const lineOk = (await runningLine.innerText()) === '3 jobs running now' && (await runningLine.getAttribute('href')) === '/inbox?state=running';
  check('the line above the buttons reads 3 jobs running now and links to the Running view', lineOk);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const jobRows = page.locator('.iv-table tbody tr[data-job]');
  const order = await jobRows.evaluateAll(rs => rs.map(r => r.dataset.job[0]).join(''));
  check('Running shows one table row per job, newest first (review, implement, fix)', order === 'abc', order);
  const chipsOk = await jobRows.evaluateAll(rs => rs.every(r => /Job/.test(r.querySelector('td[data-col=kind]').innerText)
    && /running/.test(r.querySelector('td[data-col=state]').innerText)));
  check('each job row has the Job kind chip and the running chip', chipsOk);
  const facts = await jobRows.evaluateAll(rs => rs.map(r => r.querySelector('.iv-jobfacts').innerText));
  check('the review row reads agent, model, role and job kind', /claude · opus · reviewer · review/.test(facts[0]), facts[0]);
  check('the implement row carries its Inbox card reference', /C\d+, issue #1449/.test(await jobRows.nth(1).locator('td[data-col=title]').innerText()));
  check('the fix row reads attempt 1 and over 3 hours elapsed', /attempt 1 · elapsed 3 h/.test(facts[2]), facts[2]);
  const watch = await jobRows.nth(0).locator('a.iv-watch').getAttribute('href');
  check('Watch live leads to the job page', watch === `/jobs/${'a'.repeat(32)}`, watch);
  for (const [label, sel, n] of [['Compact list', '.iv-crow[data-job]', 3], ['Cards', 'li.inbox-job', 3]]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    check(`the ${label} view draws the three job rows`, (await page.locator(sel).count()) === n);
    const factsShown = await page.locator(`${sel} .iv-jobfacts:visible`).count();
    const watchShown = await page.locator(`${sel} a.iv-watch:visible`).count();
    check(`the ${label} view shows the facts and Watch live`, factsShown === 3 && watchShown === 3);
  }
  await page.goto(`http://127.0.0.1:${port}/inbox?state=done`, { waitUntil: 'networkidle' });
  check('job rows appear only under Running', (await page.locator('[data-job]').count()) === 0);
  check('the line is shown whatever filter is on', (await page.locator('.inbox-running-line').innerText()) === '3 jobs running now');
  check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  failed = checks.some(c => !c.ok);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, checks }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
} catch (e) { fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, error: String(e.stack).slice(0, 1500), checks }, null, 2)); throw e; } finally { await browser.close(); }
process.exit(failed ? 1 : 0);
