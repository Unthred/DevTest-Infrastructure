#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container (no network; one declared target, like capture.mjs). Issue #1306: the closed-noreason Needs you item
// has a text box and a Record reason button. The page is the real Overview with the real dashui scripts and the real item for issue 895. Only the
// network edge is answered by this script: POST /api/v1/commands/work_item.close_reason and the page's own refresh (/a.html, answered with /b.html,
// the page without the item, once a reason is recorded). The checks: the item lists issue 895; a reason under 10 characters shows the refusal in place
// and sends nothing; a valid reason sends the command for issue 895 with the access proof and the item goes without a reload; a refusal of the
// server is shown on the item. Writes <name>.json and a screenshot to /out.
// Usage: node closed-reason-scenario.mjs --target fixture --profile <name> --name <stem>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, isAllowed, PROFILES } from './capture.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const target = arg('target') || 'fixture', profile = arg('profile') || 'desktop-1280', name = arg('name') || 'closed-reason', out = arg('out') || '/out';
const checks = [];
const check = (n, ok, detail = '') => checks.push({ name: n, ok: !!ok, detail: String(detail) });
const { port, server } = await bridge(path.join('/targets', `${target}.sock`));
process.env.HOME = '/tmp';
const pw = await import(pathToFileURL('/cache/package/index.mjs').href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] });
const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const APPLIED = json(200, { ok: true, command: 'work_item.close_reason', outcome: 'applied', audit_id: 'abcdef12', refusal_code: null, refusal_text: null,
  result: { target: { kind: 'issue', key: '895', label: 'Issues 895', title: null, source: null, project: null, url: null },
    condition: { state: 'recorded', attention: 'none', reason_code: null, reason_text: null, since: null } }, undo: null, cursor: 'e-1' });
const REFUSED = json(409, { ok: false, command: 'work_item.close_reason', outcome: 'refused', audit_id: 'abcdef13', refusal_code: 'github_failed',
  refusal_text: 'Issue 895 could not be read from GitHub. Nothing was changed.', result: null, undo: null, cursor: 'e-2' });
const REASON = 'Dropped in the V2 sweep; the outcome board is now issue 1300';
let failed = true;
try {
  const ctx = await browser.newContext({ ...PROFILES[profile], serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
  const url = p => `http://127.0.0.1:${port}${p}`;
  const bHtml = await (await ctx.request.get(url('/b.html'))).text();
  const served = { reply: REFUSED, page: 'a', posts: [] };
  await ctx.route('**/*', async r => {
    const req = r.request(), p = new URL(req.url()).pathname;
    if (!isAllowed(req.url(), port)) return r.abort('blockedbyclient');
    if (req.method() === 'POST' && p === '/api/v1/commands/work_item.close_reason') {
      served.posts.push({ body: JSON.parse(req.postData() || '{}'), proof: req.headers()['x-foreman-proof'] || '' });
      return r.fulfill(served.reply);
    }
    if (req.resourceType() === 'fetch' && p === '/a.html' && served.page === 'b') return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bHtml });
    return r.continue();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  let navigations = 0; page.on('load', () => { navigations++; });
  await page.goto(url('/a.html'), { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__same = 'still here'; });
  const startNav = navigations;
  const item = page.locator('#att-closed-noreason'), status = item.locator('.close-reason-status'), box = item.locator('textarea[name=reason]'), button = item.locator('.close-reason-button');
  const statusText = async () => (await status.textContent()) || '';

  check('the item is shown and lists issue 895 with its exact title', (await item.count()) === 1 && /#895 Explain everything: every skip, refusal and failure records a plain-English reason/.test(await item.innerText()), await item.innerText());
  check('the item has a text box and a Record reason button', (await box.count()) === 1 && (await button.textContent()) === 'Record reason');

  // The item alone is measured: the rest of this fixture page is wider than a phone for reasons that have nothing to do with the item.
  const inside = await item.evaluate(el => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll('*')].every(c => c.getBoundingClientRect().right <= r.right + 1) && r.right <= innerWidth; });
  check('everything inside the item stays inside the item and the screen', inside);

  // ---- 1. a reason under 10 characters: the refusal shows on the item, nothing is sent
  await box.fill('too short');
  await button.click();
  await page.waitForFunction(() => /at least 10 characters/.test(document.querySelector('#att-closed-noreason .close-reason-status')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
  check('a reason under 10 characters shows the refusal text in place', /^The reason needs at least 10 characters\. Nothing was changed\.$/.test(await statusText()), await statusText());
  check('nothing was sent for the short reason', served.posts.length === 0);
  check('the item is still there', (await item.count()) === 1);

  // ---- 2. a refusal of the server is shown in place and the button comes back
  await box.fill(REASON);
  await button.click();
  await page.waitForFunction(() => /could not be read/.test(document.querySelector('#att-closed-noreason .close-reason-status')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
  check('the refusal of the server is shown in place', /^Issue 895 could not be read from GitHub/.test(await statusText()), await statusText());
  check('the button can be pressed again after a refusal', await button.isEnabled());

  // ---- 3. a valid reason: the command is sent for issue 895, then the item goes without a reload
  served.reply = APPLIED; served.page = 'b';
  await button.click();
  await page.waitForFunction(() => !document.getElementById('att-closed-noreason'), null, { timeout: 5000 }).catch(() => {});
  const sent = served.posts.at(-1);
  check('the command was sent with the issue number, the reason and the access proof', sent && sent.body.input.issues === '895' && sent.body.reason === REASON && /^[A-Za-z0-9_-]{8,64}$/.test(sent.body.idempotency_key) && sent.proof.length > 8, JSON.stringify(sent));
  check('the item is gone on the next draw', (await item.count()) === 0);
  check('the page did not reload', navigations === startNav && (await page.evaluate(() => window.__same)) === 'still here', `${startNav}/${navigations}`);
    check('no script errors', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, `${name}.png`) });

  // ---- 4. layout of the item itself on this screen: the text box and the button stay inside the viewport
  await page.goto(url('/a.html'), { waitUntil: 'networkidle' });
  const b = await box.boundingBox(), k = await button.boundingBox(), width = PROFILES[profile].viewport.width;
  check('the text box and the button are inside the viewport with a usable tap size', b && k && b.x >= 0 && b.x + b.width <= width && k.x >= 0 && k.x + k.width <= width && k.height >= 24, JSON.stringify({ b, k, width }));
  await ctx.close();
} finally { await browser.close(); server.close(); }
failed = checks.some(c => !c.ok);
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ profile, ok: !failed, checks }, null, 2));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` :: ${c.detail}`}`);
process.exit(failed ? 1 : 0);
