#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like lists-scenario.mjs). Checks the Inbox page of issue #884 in a real
// browser: one compact row per proposal, search on the title, the 8-character id, the kind and the why (and not on the body), the "Nothing matches" case,
// duplicates flagged, the full text expanding on click, bulk Approve/Reject (the post is answered by a stand-in, so the page's own script is what is
// tested), strong-confirm rows with no tick box, the Needs you summary line, and on a phone: no horizontal scrolling and the buttons reachable.
// Usage: node inbox-scenario.mjs --target fixture --profile <name> --name <stem>. Writes <name>.json and a screenshot to /out.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';
import { layoutCheck } from './layout-check.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'inbox', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const url = p => `http://127.0.0.1:${port}${p}`;
const A1 = 'a1'.repeat(16), B2 = 'b2'.repeat(16), D4 = 'd4'.repeat(16), E5 = 'e5'.repeat(16), STRONG = '17'.repeat(16);
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  const posts = [];
  // The stand-in for POST /inbox: the first selected id is refused, the others recorded. Everything else on this origin is the static fixture.
  await ctx.route('**/*', async r => {
    const req = r.request();
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/inbox' && isAllowed(req.url(), port)) {
      const body = new URLSearchParams(req.postData() || ''); posts.push({ decision: body.get('decision'), ids: body.getAll('id'), bulk: body.get('bulk'), proof: body.get('proof') });
      const ids = body.getAll('id');
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results: ids.map((id, i) => (i === 0 && ids.length > 1 ? { id, ok: false, reason: 'the item is already approved' } : { id, ok: true, state: 'approved', decidedAt: Date.now(), undoUntil: Date.now() + 30000 })) }) });
    }
    return isAllowed(req.url(), port) ? r.continue() : r.abort('blockedbyclient');
  });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(url('/inbox.html'), { waitUntil: 'networkidle' });
  const L = page.locator('[data-dlist="inbox"]'), rows = L.locator('> .dl-scroll > li'), visible = () => L.locator('> .dl-scroll > li:visible').count();
  const findings = await page.evaluate(layoutCheck, { touch: PROFILES[profile].hasTouch });
  check('no overflow or covered link (layout check)', findings.filter(f => f.severity === 'fail').length === 0, findings.filter(f => f.severity === 'fail').slice(0, 5).map(f => `${f.check}@${f.element}`).join('; '));
  check('no horizontal scrolling on the page', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  check('no script errors', errors.length === 0, errors.join('; '));
  const wide = await page.evaluate(() => { const ul = document.querySelector('[data-dlist="inbox"] > .dl-scroll'), lim = ul.getBoundingClientRect().right + 1; return [...ul.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > lim && e.getBoundingClientRect().width > 0).slice(0, 4).map(e => `${e.tagName}.${e.className}`); });
  check('nothing inside a row is wider than the list', wide.length === 0, wide.join('; '));
  check('seven rows, one per proposal', (await rows.count()) === 7);
  const row1 = rows.filter({ has: page.locator(`[data-inbox="${A1}"]`) });
  const t1 = await row1.textContent();
  check('a row shows title, kind, short id, submitted time and why', /Project board update: one GraphQL rate limit/.test(t1) && /issue draft/.test(t1) && t1.includes('a1a1a1a1') && /Submitted/.test(t1) && /ago/.test(t1) && /Why: The board query hits the limit/.test(t1), t1.replace(/\s+/g, ' ').slice(0, 300));
  check('every row has Approve and Reject on it', (await L.locator('.dl-scroll .inbox-approve').count()) === 7 && (await L.locator('.dl-scroll .inbox-reject').count()) === 7);
  // the buttons are reachable: inside the viewport width, not covered
  const reach = await page.evaluate(() => [...document.querySelectorAll('.inbox-row .acts button')].every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.width >= 40 && r.height >= 30; }));
  check('Approve and Reject are inside the screen width and a usable size', reach);
  // search on each field
  const q = L.locator('.dl-q'), foot = L.locator('[data-dl-foot]');
  const search = async (text, want, label) => { await q.fill(text); const n = await visible(); check(`search ${label}: "${text.slice(0, 40)}" shows ${want}`, n === want, `${n}`); };
  check('the search box is there with seven rows', await q.isVisible());
  await search('graphql rate', 1, 'by part of the title');
  check('the shown row is the right one', (await L.locator('> .dl-scroll > li:visible').first().getAttribute('data-key')) === `inbox-${A1}`);
  await search('Project board update: one GraphQL rate limit', 1, 'by the whole title');
  await search('b2b2b2b2', 1, 'by the 8-character id');
  await search(E5, 1, 'by the full id');
  await search('prompt job', 3, 'by kind (prompt job)');
  await search('issue draft', 2, 'by kind (issue draft)');
  await search('stuck', 1, 'by the why');
  await search('dead code', 1, 'by the why (another)');
  await search('zebra', 0, 'by a word only in a body (not searched)');
  check('no match says so in words', /Nothing matches/.test(await L.locator('.dl-none').textContent()) && (await L.locator('.dl-none').isVisible()));
  await search('duplicate', 2, 'by the duplicate flag');
  await search('TIDY   the', 2, 'ignoring case and spacing');
  check('the footer counts N of M', /^2 of 7 proposals/.test(await foot.textContent()), await foot.textContent());
  await L.locator('.dl-clear').click();
  check('clearing the search restores every row', (await visible()) === 7);
  // duplicates
  const dup = page.locator(`[data-inbox="${D4}"] .inbox-dup`), dupOld = page.locator(`[data-inbox="${B2}"] .inbox-dup`);
  check('the newer of two same-titled proposals is marked newer', /this is the newer one/.test(await dup.textContent()) && /a newer one exists/.test(await dupOld.textContent()));
  check('a proposal with a unique title has no duplicate flag', (await page.locator(`[data-inbox="${E5}"] .inbox-dup`).count()) === 0);
  // expand
  const more = page.locator(`[data-inbox="${A1}"] details.inbox-more`);
  check('the full text is closed to start with', !(await more.evaluate(d => d.open)));
  await more.locator('summary').click();
  check('clicking opens the full text, Markdown rendered for an issue draft, with the hash under it', (await more.locator('.md strong').count()) === 1 && (await more.locator('.md li').count()) === 2 && /Content hash/.test(await more.textContent()));
  // bulk
  const approveAll = page.locator('form.inbox-bulk button[value=approve]'), rejectAll = page.locator('form.inbox-bulk button[value=reject]');
  check('bulk buttons are off with nothing ticked', (await approveAll.isDisabled()) && (await rejectAll.isDisabled()));
  check('the strong-confirm row has no tick box and says why', (await page.locator(`[data-inbox="${STRONG}"] input.inbox-check`).count()) === 0 && /own confirmation/.test(await page.locator(`[data-inbox="${STRONG}"]`).textContent()));
  await page.locator('input.inbox-checkall').check();
  check('Select all shown ticks every row that has a tick box (six, not the strong one)', (await page.locator('input.inbox-check:checked').count()) === 6 && /Approve selected \(6\)/.test(await approveAll.textContent()));
  await q.fill('docs'); await page.waitForTimeout(100);
  check('searching unticks the rows it hides and keeps the shown ones', (await page.locator('input.inbox-check:checked').count()) === 2 && (await page.locator('li:not([hidden]) input.inbox-check:checked').count()) === 2 && /Approve selected \(2\)/.test(await approveAll.textContent()), await approveAll.textContent());
  await page.locator('input.inbox-checkall').uncheck(); await page.locator('input.inbox-checkall').check();
  check('Select all shown ticks only the two shown rows', (await page.locator('input.inbox-check:checked').count()) === 2);
  await approveAll.click();
  await page.waitForFunction(() => /refused/.test(document.querySelector('.inbox-bulk-msg')?.textContent || ''));
  check('the bulk post carried the proof, the ids of the two shown rows only, and the decision', posts.length === 1 && posts[0].decision === 'approve' && posts[0].bulk === '1' && posts[0].proof === 'fixture-proof' && posts[0].ids.length === 2 && posts[0].ids.includes(B2) && posts[0].ids.includes(D4), JSON.stringify(posts));
  const msg = await page.locator('.inbox-bulk-msg').textContent();
  check('the bar reports what was recorded and what was refused, with the reason', /Approved 1\./.test(msg) && /1 refused: the item is already approved/.test(msg), msg);
  check('the recorded row left the list; the refused row stays and says why', (await page.locator('[data-dlist="inbox"] > .dl-scroll > li').count()) === 6 && /Not recorded: the item is already approved/.test(await page.locator('.inbox-err:visible').first().textContent()));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  // the Overview: one summary line in Needs you and no proposal body there
  await page.goto(url('/overview.html'), { waitUntil: 'networkidle' });
  const needs = await page.locator('[data-dlist="needs"]').textContent();
  check('Needs you has the one summary line with a link to the Inbox', /7 overseer proposals waiting/.test(needs) && (await page.locator('[data-dlist="needs"] a[href="/inbox"]').count()) === 1 && !/Do the work called/.test(needs));
  check('the Overview shows the Inbox as its own card', (await page.locator('#c-inbox').count()) === 1);
  await ctx.close();
} finally { await browser.close(); server.close(); }
const result = { profile, ok: checks.every(c => c.ok), checks };
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 10);
