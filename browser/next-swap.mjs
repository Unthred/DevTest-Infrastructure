#!/usr/bin/env node
// Real-browser check of the app bar's Next swap (issue #564). Runs INSIDE the pinned Playwright container under the same rules as
// capture.mjs: no network, only the declared target socket is reachable. The dashboard page script (supervisor/dashui/app.js) runs
// unchanged; GET /api/next is answered from a fragment file served by the same target, so DOMParser, querySelector('[data-tick-state],
// .muted'), importNode and replaceWith run against Chromium's real DOM instead of the fakes in tests/dashboard-next-tick.test.mjs.
// Usage: next-swap.mjs --target NAME --page /index.html --case NAME=/fragments/x.html[=expected] ...  Writes <name>.summary.json.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, clip, isAllowed, redactUrl, EXIT } from './capture.mjs';

// Expected outcomes, checked in the page after the swap: `none` has no [data-tick-state] and shows the muted "none"; `running` has
// the running element; `scheduled` has the countdown element.
export const EXPECT = {
  none: () => !document.querySelector('.statusbar [data-tick-state]') && document.querySelector('.statusbar .stat .muted')?.textContent === 'none',
  running: () => document.querySelector('.statusbar [data-tick-state="running"][data-running]') !== null,
  scheduled: () => document.querySelector('.statusbar [data-tick-state="scheduled"] [data-countdown]') !== null,
};
export function parseArguments(argv) {
  const o = { target: null, page: '/', cases: [], name: 'next-swap', out: '/out', socketDir: '/targets', playwright: '/cache/package/index.mjs', timeoutMs: 15000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    if (a === '--case') { const [name, fragment, expect] = v.split('='); if (!name || !fragment?.startsWith('/') || !(expect in EXPECT)) throw new Error('--case must be NAME=/fragment/path=none|running|scheduled'); o.cases.push({ name, fragment, expect }); continue; }
    const key = { '--target': 'target', '--page': 'page', '--name': 'name', '--out': 'out', '--socket-dir': 'socketDir', '--playwright': 'playwright', '--timeout-ms': 'timeoutMs' }[a];
    if (!key) throw new Error(`unknown argument ${a}`);
    o[key] = key === 'timeoutMs' ? Number(v) : v;
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(o.target || '')) throw new Error('--target must be a declared target name');
  if (!o.page.startsWith('/') || o.page.startsWith('//') || /[\0\r\n\\]/.test(o.page)) throw new Error('--page must be an absolute path on the target');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.name)) throw new Error('--name must be a simple file name');
  if (!o.cases.length) throw new Error('at least one --case is needed');
  return o;
}

export async function run(o) {
  const socketPath = path.join(o.socketDir, `${o.target}.sock`);
  if (!fs.statSync(socketPath, { throwIfNoEntry: false })?.isSocket()) return { summary: null, exit: EXIT.usage, problem: 'target socket is not mounted' };
  process.env.HOME = process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : '/tmp';
  const { port, server } = await bridge(socketPath);
  const blocked = [], cases = [];
  let browser, exit = EXIT.ok;
  try {
    let pw;
    try { pw = await import(pathToFileURL(o.playwright).href); } catch (error) { return { summary: null, exit: EXIT.launch, problem: `playwright could not be loaded: ${clip(error.message)}` }; }
    try { browser = await (pw.default ?? pw).chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] }); }
    catch (error) { return { summary: null, exit: EXIT.launch, problem: `browser launch failed: ${clip(error.message)}` }; }
    for (const c of o.cases) {
      const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC' });
      const errors = [], asked = [];
      try {
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url());
          if (isAllowed(url.href, port) && url.pathname === '/api/next') { asked.push(url.pathname); return route.continue({ url: `http://127.0.0.1:${port}${c.fragment}` }); }
          if (isAllowed(url.href, port)) return route.continue();
          blocked.push(redactUrl(url.href)); return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(clip(e.message)));
        await page.goto(`http://127.0.0.1:${port}${o.page}`, { waitUntil: 'load', timeout: o.timeoutMs });
        let swapped = true;
        try { await page.waitForFunction(EXPECT[c.expect], null, { timeout: o.timeoutMs }); } catch { swapped = false; }
        // a swapped-in element must be live DOM: the clock keeps working on it (running/scheduled) and the old element is gone
        const state = await page.evaluate(() => ({ states: [...document.querySelectorAll('.statusbar [data-tick-state]')].map((e) => e.dataset.tickState), muted: document.querySelector('.statusbar .stat .muted')?.textContent ?? null }));
        cases.push({ name: c.name, expect: c.expect, ok: swapped && errors.length === 0 && asked.length >= 1, swapped, requests: asked.length, pageErrors: errors, state });
      } finally { await context.close().catch(() => {}); }
    }
  } finally { await browser?.close().catch(() => {}); server.close(); }
  const summary = { schema_version: 1, ok: cases.every((c) => c.ok) && !blocked.length, cases, blockedRequests: blocked };
  if (blocked.length) exit = EXIT.blocked; else if (!summary.ok) exit = EXIT.problems;
  return { summary, exit };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) { process.stderr.write(`next-swap: ${error.message}\n`); process.exit(EXIT.usage); }
  let result;
  try { result = await run(options); } catch (error) { result = { summary: null, exit: EXIT.problems, problem: `run failed: ${clip(error.message)}` }; }
  fs.writeFileSync(path.join(options.out, `${options.name}.summary.json`), `${JSON.stringify(result.summary ?? { schema_version: 1, ok: false, problems: [result.problem] }, null, 2)}\n`, { mode: 0o600 });
  process.exit(result.exit);
}
