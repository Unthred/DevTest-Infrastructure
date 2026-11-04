#!/usr/bin/env node
// Accessibility scan (issue #455). Runs INSIDE the pinned Playwright container under the same rules as capture.mjs and responsive.mjs:
// no network, only the declared target socket is reachable, every other request is blocked and recorded. axe-core is not fetched: the
// pinned, integrity-checked copy was restored into the read-only cache (browser/restore-cache.mjs). Rules: WCAG 2.1 A and AA tags.
// Writes <name>.summary.json and <name>.report.md. Violations exit 17; incomplete results are reported but do not fail the run.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, clip, isAllowed, isAllowedSocket, redactUrl, PROFILES, STANDARD_PROFILES, EXIT } from './capture.mjs';
import { AXE_TAGS, runAxeInPage, summarise, renderReport } from './a11y-lib.mjs';

export function parseA11yArguments(argv) {
  const o = { path: '/', browser: 'chromium', profiles: 'desktop-1440,phone-390', wait: 'load', timeoutMs: 15000, name: 'a11y', out: '/out', socketDir: '/targets', playwright: '/cache/package/index.mjs', axe: '/cache/axe-core/package/axe.min.js' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    const key = { '--target': 'target', '--path': 'path', '--browser': 'browser', '--profiles': 'profiles', '--wait': 'wait', '--name': 'name', '--out': 'out', '--socket-dir': 'socketDir', '--playwright': 'playwright', '--axe': 'axe', '--timeout-ms': 'timeoutMs' }[a];
    if (!key) throw new Error(`unknown argument ${a}`);
    o[key] = key === 'timeoutMs' ? Number(v) : v;
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(o.target || '')) throw new Error('--target must be a declared target name');
  if (!o.path.startsWith('/') || o.path.startsWith('//') || /[\0\r\n\\]/.test(o.path) || o.path.length > 1024) throw new Error('--path must be an absolute path on the target');
  if (!['chromium', 'firefox', 'webkit'].includes(o.browser)) throw new Error('--browser must be chromium, firefox or webkit');
  if (!['load', 'domcontentloaded', 'networkidle'].includes(o.wait)) throw new Error('--wait must be load, domcontentloaded or networkidle');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.name)) throw new Error('--name must be a simple file name');
  if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs < 1000 || o.timeoutMs > 120000) throw new Error('--timeout-ms must be 1000..120000');
  o.profileNames = o.profiles === 'standard' ? STANDARD_PROFILES : o.profiles === 'all' ? Object.keys(PROFILES) : o.profiles.split(',');
  if (!o.profileNames.length || o.profileNames.length > 20 || new Set(o.profileNames).size !== o.profileNames.length || !o.profileNames.every((p) => p in PROFILES)) throw new Error('--profiles must be standard, all, or a comma list of known unique profiles');
  return o;
}

export async function scan(o) {
  const results = [], blocked = [];
  let exit = EXIT.ok, problem = null;
  const socketPath = path.join(o.socketDir, `${o.target}.sock`);
  if (!fs.statSync(socketPath, { throwIfNoEntry: false })?.isSocket()) return { summary: null, exit: EXIT.usage, problem: 'target socket is not mounted' };
  let axeSource;
  try { axeSource = fs.readFileSync(o.axe, 'utf8'); } catch { return { summary: null, exit: EXIT.launch, problem: 'axe-core is not in the cache (run browser/restore-cache.mjs)' }; }
  process.env.HOME = process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : '/tmp';
  const { port, server } = await bridge(socketPath);
  let browser;
  try {
    let pw;
    try { pw = await import(pathToFileURL(o.playwright).href); }
    catch (error) { return { summary: null, exit: EXIT.launch, problem: `playwright module could not be loaded (cache not restored?): ${clip(error.message)}` }; }
    const engine = (pw.default ?? pw)[o.browser];
    try { browser = await engine.launch({ headless: true, args: o.browser === 'chromium' ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] : [] }); }
    catch (error) { return { summary: null, exit: EXIT.launch, problem: `browser launch failed: ${clip(error.message)}` }; }
    for (const name of o.profileNames) {
      const profile = PROFILES[name];
      // bypassCSP lets the injected axe source run on a page with a strict Content-Security-Policy; the page still has no network.
      const context = await browser.newContext({ ...profile, ignoreHTTPSErrors: false, serviceWorkers: 'block', acceptDownloads: false, bypassCSP: true, locale: 'en-GB', timezoneId: 'UTC' });
      try {
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (isAllowed(url, port)) return route.continue();
          blocked.push(redactUrl(url)); return route.abort('blockedbyclient');
        });
        await context.routeWebSocket(/.*/, (ws) => {
          const url = ws.url();
          if (isAllowedSocket(url, port)) return ws.connectToServer();
          blocked.push(redactUrl(url)); return ws.close({ code: 1008, reason: 'blocked' });
        });
        const page = await context.newPage();
        const entry = { name, profile, axe: null };
        try { await page.goto(`http://127.0.0.1:${port}${o.path}`, { waitUntil: o.wait, timeout: o.timeoutMs }); }
        catch (error) { exit = /Timeout/i.test(error.message) ? EXIT.timeout : /ERR_CERT|SSL|TLS/i.test(error.message) ? EXIT.tls : EXIT.problems; problem = clip(error.message); results.push(entry); continue; }
        await page.evaluate(axeSource);
        entry.axe = await page.evaluate(runAxeInPage, AXE_TAGS);
        results.push(entry);
      } finally { await context.close().catch(() => {}); }
    }
  } finally { await browser?.close().catch(() => {}); server.close(); }
  const summary = summarise({ target: o.target, path: o.path, browser: o.browser, name: o.name, results });
  summary.blockedRequests = blocked;
  if (blocked.length) exit = EXIT.blocked;
  else if (exit === EXIT.ok && !summary.ok) exit = EXIT.a11y;
  summary.ok = summary.ok && exit === EXIT.ok;
  return { summary, exit, problem };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let options;
  try { options = parseA11yArguments(process.argv.slice(2)); } catch (error) { process.stderr.write(`a11y: ${error.message}\n`); process.exit(EXIT.usage); }
  let result;
  try { result = await scan(options); } catch (error) { result = { summary: null, exit: EXIT.problems, problem: `scan failed: ${clip(error.message)}` }; }
  const summary = result.summary ?? { schema_version: 1, ok: false, problems: [result.problem] };
  fs.writeFileSync(path.join(options.out, `${options.name}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (result.summary) fs.writeFileSync(path.join(options.out, `${options.name}.report.md`), renderReport(result.summary), { mode: 0o600 });
  process.exit(result.exit);
}
