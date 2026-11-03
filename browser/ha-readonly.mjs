#!/usr/bin/env node
// Home Assistant read-only browser profile (issue #10). Runs INSIDE the pinned Playwright container under the same rules as
// capture.mjs and responsive.mjs: no network, only the declared target socket is reachable, everything else is blocked and recorded.
// On top of that it is READ-ONLY (D-009): non-GET/HEAD requests are refused, WebSocket frames that are not on the read allow-list are
// refused, and a capture-phase guard in the page stops clicks and edits on anything that could change climate or helper state.
// For each page and each profile it saves a screenshot, runs the layout checks and writes <name>.summary.json and <name>.report.md.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, clip, isAllowed, isAllowedSocket, redactUrl, PROFILES, EXIT as BASE_EXIT } from './capture.mjs';
import { layoutCheck } from './layout-check.mjs';
import { parsePngSize, summarise } from './responsive-lib.mjs';
import { PAGE_SETS, HA_PROFILES, PROBE_MODES, MUTATING_SELECTOR, NAVIGATION_SELECTOR, GUARDED_EVENTS, installInteractionGuard, isReadOnlyMethod, wsFrameDecision, haOutcome, renderHaReport } from './ha-readonly-lib.mjs';

export const EXIT = { ...BASE_EXIT, readonly: 16 };

export function parseHaArguments(argv) {
  const o = { pageSet: 'fixture', pages: null, browser: 'chromium', profiles: HA_PROFILES.join(','), probe: 'none', wait: 'load', timeoutMs: 15000, name: 'ha', out: '/out', socketDir: '/targets', playwright: '/cache/package/index.mjs', session: null, forwardWebsocket: false };
  const flags = new Set(['--forward-websocket']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) { o.forwardWebsocket = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    const key = { '--target': 'target', '--page-set': 'pageSet', '--pages': 'pages', '--browser': 'browser', '--profiles': 'profiles', '--probe': 'probe', '--wait': 'wait', '--name': 'name', '--out': 'out', '--socket-dir': 'socketDir', '--playwright': 'playwright', '--timeout-ms': 'timeoutMs', '--session': 'session' }[a];
    if (!key) throw new Error(`unknown argument ${a}`);
    o[key] = key === 'timeoutMs' ? Number(v) : v;
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(o.target || '')) throw new Error('--target must be a declared target name');
  if (!(o.pageSet in PAGE_SETS)) throw new Error(`--page-set must be one of ${Object.keys(PAGE_SETS).join(', ')}`);
  if (!['chromium', 'firefox', 'webkit'].includes(o.browser)) throw new Error('--browser must be chromium, firefox or webkit');
  if (!['load', 'domcontentloaded', 'networkidle'].includes(o.wait)) throw new Error('--wait must be load, domcontentloaded or networkidle');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.name)) throw new Error('--name must be a simple file name');
  if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs < 1000 || o.timeoutMs > 120000) throw new Error('--timeout-ms must be 1000..120000');
  if (!PROBE_MODES.includes(o.probe)) throw new Error(`--probe must be one of ${PROBE_MODES.join(', ')}`);
  if (o.probe !== 'none' && o.pageSet !== 'fixture') throw new Error('--probe clicks is only allowed on the fixture page set: it clicks controls, which must never happen on the live instance');
  o.profileNames = o.profiles.split(',');
  if (!o.profileNames.length || o.profileNames.length > 6 || new Set(o.profileNames).size !== o.profileNames.length || !o.profileNames.every((p) => p in PROFILES)) throw new Error('--profiles must be a comma list of known unique profiles');
  let pages = PAGE_SETS[o.pageSet];
  if (o.pages !== null) {
    // name=/path,name=/path : an explicit list (tests, or a renamed dashboard). Same path rules as the other wrappers.
    pages = o.pages.split(',').map((entry) => { const [name, ...rest] = entry.split('='); return { name, path: rest.join('=') }; });
    if (!pages.length || pages.length > 10 || new Set(pages.map((p) => p.name)).size !== pages.length) throw new Error('--pages must be 1..10 unique name=/path entries');
  }
  for (const p of pages) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.name)) throw new Error('a page name must be a simple lower-case label');
    if (!p.path.startsWith('/') || p.path.startsWith('//') || /[\0\r\n\\]/.test(p.path) || p.path.length > 1024) throw new Error('a page path must be an absolute path on the target');
  }
  o.pageList = pages;
  if (o.session !== null && !/^\/secrets\/[a-z][a-z0-9-]{0,31}$/.test(o.session)) throw new Error('--session must be a /secrets/<name> file (secrets are delivered as mounted files, never arguments)');
  return o;
}

// Reads a Playwright storage state delivered by the broker. Only the parsed object is passed on; nothing from it is ever reported.
export function loadSession(file) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('the session file is missing or not valid JSON'); }
  if (!state || typeof state !== 'object' || !Array.isArray(state.cookies) || (state.origins !== undefined && !Array.isArray(state.origins))) throw new Error('the session file is not a Playwright storage state');
  return state;
}

export async function run(o) {
  const blocked = [], blockedWrites = [], blockedFrames = [], interactions = [];
  const pageResults = [];
  const probe = { mode: o.probe, attempted: 0, blocked: 0, mutated: 0, navigated: 0, pageInitiated: 0 };
  let exit = EXIT.ok, problem = null;
  const socketPath = path.join(o.socketDir, `${o.target}.sock`);
  if (!fs.statSync(socketPath, { throwIfNoEntry: false })?.isSocket()) return { summary: null, exit: EXIT.usage, problem: 'target socket is not mounted' };
  let storageState;
  if (o.session) { try { storageState = loadSession(o.session); } catch (error) { return { summary: null, exit: EXIT.usage, problem: error.message }; } }
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
    for (const page of o.pageList) {
      const results = [];
      for (const name of o.profileNames) {
        const profile = PROFILES[name];
        const context = await browser.newContext({ ...profile, ...(storageState ? { storageState } : {}), ignoreHTTPSErrors: false, serviceWorkers: 'block', acceptDownloads: false, locale: 'en-GB', timezoneId: 'UTC' });
        let pageProblems = 0;
        try {
          await context.route('**/*', (route) => {
            const request = route.request();
            const url = request.url();
            if (!isAllowed(url, port)) { blocked.push(redactUrl(url)); return route.abort('blockedbyclient'); }
            if (!isReadOnlyMethod(request.method())) { blockedWrites.push(`${String(request.method()).toUpperCase().slice(0, 10)} ${redactUrl(url)}`); return route.abort('blockedbyclient'); }
            return route.continue();
          });
          await context.routeWebSocket(/.*/, (ws) => {
            const url = ws.url();
            if (!isAllowedSocket(url, port)) { blocked.push(redactUrl(url)); return ws.close({ code: 1008, reason: 'blocked' }); }
            // Without connectToServer() the socket is a mock that never reaches the target; with --forward-websocket frames are
            // relayed, and the allow-list decides each client frame. The frame body is never recorded, only its type label.
            const upstream = o.forwardWebsocket ? ws.connectToServer() : null;
            ws.onMessage((frame) => {
              const d = wsFrameDecision(frame);
              if (!d.allow) { blockedFrames.push(`${d.type} ${redactUrl(url)}`); return; }
              upstream?.send(frame);
            });
            upstream?.onMessage((frame) => ws.send(frame));
          });
          await context.addInitScript(installInteractionGuard, { mutating: MUTATING_SELECTOR, navigation: NAVIGATION_SELECTOR, events: GUARDED_EVENTS });
          const tab = await context.newPage();
          tab.on('console', (m) => { if (m.type() === 'error') pageProblems++; });
          tab.on('pageerror', () => { pageProblems++; });
          tab.on('response', (r) => { if (r.status() >= 400) pageProblems++; });
          const entry = { name, profile, findings: [], png: null, screenshot: null, pageProblems: 0 };
          try { await tab.goto(`http://127.0.0.1:${port}${page.path}`, { waitUntil: o.wait, timeout: o.timeoutMs }); }
          catch (error) { exit = /Timeout/i.test(error.message) ? EXIT.timeout : /ERR_CERT|SSL|TLS/i.test(error.message) ? EXIT.tls : EXIT.problems; problem = clip(error.message); results.push(entry); continue; }
          if (o.probe === 'clicks') {
            // Interactions the guard already blocked before the probe's first click came from the page itself.
            probe.pageInitiated += await tab.evaluate(() => (window.__haBlockedInteractions ?? []).length).catch(() => 0);
            await clickProbe(tab, probe, o.timeoutMs);
          }
          entry.findings = (await tab.evaluate(layoutCheck, { touch: profile.hasTouch })).map(({ text, ...f }) => f);
          const file = `${o.name}-${page.name}-${name}-${o.browser}.png`;
          const buffer = await tab.screenshot({ fullPage: true, type: 'png', timeout: o.timeoutMs });
          fs.writeFileSync(path.join(o.out, file), buffer, { mode: 0o600 });
          entry.png = parsePngSize(buffer); entry.screenshot = file; entry.pageProblems = pageProblems;
          interactions.push(...(await tab.evaluate(() => window.__haBlockedInteractions ?? []).catch(() => [])));
          results.push(entry);
        } finally { await context.close().catch(() => {}); }
      }
      pageResults.push({ page: page.name, path: page.path.replace(/[?#].*$/s, ''), ...summarise({ target: o.target, path: page.path, browser: o.browser, name: page.name, results }) });
    }
  } finally { await browser?.close().catch(() => {}); server.close(); }
  const outcome = haOutcome({ pages: pageResults, blockedWrites, blockedFrames, blockedInteractions: interactions, probe });
  const summary = { schema_version: 1, kind: 'ha-readonly', pageSet: o.pageSet, target: o.target, browser: o.browser, name: o.name,
    scope: 'read-only navigation and screenshots with layout heuristics measured in a real browser; no pixel comparison, no login, no state change. A pass is not visual acceptance.',
    authenticated: !!storageState, pages: pageResults,
    readOnly: { blockedWrites, blockedFrames, blockedInteractions: interactions }, probe: o.probe === 'none' ? null : probe,
    blockedRequests: blocked, ...outcome };
  // Precedence: undeclared destination, then an attempted write, then layout, then page errors.
  if (blocked.length) exit = EXIT.blocked;
  else if (exit === EXIT.ok) {
    if (outcome.readonlyViolations || outcome.unexpectedInteractions || outcome.probeBypassed) exit = EXIT.readonly;
    else if (pageResults.some((p) => p.failures.length || p.profiles.some((x) => !x.rendered))) exit = EXIT.layout;
    else if (pageResults.some((p) => p.profiles.some((x) => x.pageProblems))) exit = EXIT.problems;
  }
  summary.ok = summary.ok && exit === EXIT.ok;
  return { summary, exit, problem };
}

// Clicks every control the fixture marks as state-changing (and presses Space on it). The in-page guard must stop each one; the
// fixture counts any handler that still ran in window.__mutations. The counters are read after every control, because a control
// that navigates resets them: a counter that is gone (or a page that cannot be read) is a navigation during the probe, which is
// reported as a failure (probe.navigated) instead of silently losing earlier counts.
async function clickProbe(tab, probe, timeoutMs) {
  const controls = tab.locator('[data-mutates]');
  const count = Math.min(await controls.count(), 50);
  const read = () => tab.evaluate(() => ({ blocked: Array.isArray(window.__haBlockedInteractions) ? window.__haBlockedInteractions.length : -1, mutated: window.__mutations ?? 0 })).catch(() => ({ blocked: -1, mutated: 0 }));
  let last = await read();
  for (let i = 0; i < count; i++) {
    const c = controls.nth(i);
    probe.attempted++;
    try { await c.click({ timeout: Math.min(timeoutMs, 3000) }); await c.press('Space', { timeout: 1000 }); } catch { /* an unclickable control cannot have changed anything */ }
    const now = await read();
    if (now.blocked < 0 || now.blocked < last.blocked) { probe.navigated++; return; }
    probe.blocked += now.blocked - last.blocked;
    probe.mutated += now.mutated - last.mutated;
    last = now;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let options;
  try { options = parseHaArguments(process.argv.slice(2)); } catch (error) { process.stderr.write(`ha-readonly: ${error.message}\n`); process.exit(EXIT.usage); }
  let result;
  try { result = await run(options); } catch (error) { result = { summary: null, exit: EXIT.problems, problem: `run failed: ${clip(error.message)}` }; }
  const summary = result.summary ?? { schema_version: 1, kind: 'ha-readonly', ok: false, problems: [result.problem] };
  fs.writeFileSync(path.join(options.out, `${options.name}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (result.summary) fs.writeFileSync(path.join(options.out, `${options.name}.report.md`), renderHaReport(result.summary), { mode: 0o600 });
  process.exit(result.exit);
}
