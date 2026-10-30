#!/usr/bin/env node
// Runs INSIDE the pinned Playwright container, which has no network. The only reachable page is a declared target: a host-side
// Unix socket mounted at /targets/<name>.sock, bridged to a loopback port that the browser may use. Every other request is
// refused and recorded, whatever the page asks for. Writes <name>.png and <name>.report.json (and optionally a trace) to /out.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT = { ok: 0, usage: 2, problems: 10, timeout: 11, blocked: 12, tls: 13, launch: 14 };
export const PROFILES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }
};
const BROWSERS = ['chromium', 'firefox', 'webkit'];
const WAITS = ['load', 'domcontentloaded', 'networkidle'];
const safeName = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseArguments(argv) {
  const o = { path: '/', browser: 'chromium', profile: 'desktop', wait: 'load', timeoutMs: 15000, name: 'page', fullPage: false, trace: false, out: '/out', socketDir: '/targets', playwright: '/cache/package/index.mjs' };
  const flags = new Set(['--full-page', '--trace']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) { o[a === '--full-page' ? 'fullPage' : 'trace'] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    if (a === '--target') o.target = v; else if (a === '--path') o.path = v; else if (a === '--browser') o.browser = v;
    else if (a === '--profile') o.profile = v; else if (a === '--wait') o.wait = v; else if (a === '--name') o.name = v;
    else if (a === '--timeout-ms') o.timeoutMs = Number(v); else if (a === '--out') o.out = v;
    else if (a === '--socket-dir') o.socketDir = v; else if (a === '--playwright') o.playwright = v;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(o.target || '')) throw new Error('--target must be a declared target name');
  if (!o.path.startsWith('/') || o.path.startsWith('//') || /[\0\r\n\\]/.test(o.path) || o.path.length > 1024) throw new Error('--path must be an absolute path on the target');
  if (!BROWSERS.includes(o.browser)) throw new Error(`--browser must be one of ${BROWSERS.join(', ')}`);
  if (!(o.profile in PROFILES)) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`);
  if (!WAITS.includes(o.wait)) throw new Error(`--wait must be one of ${WAITS.join(', ')}`);
  if (!safeName.test(o.name)) throw new Error('--name must be a simple file name');
  if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs < 1000 || o.timeoutMs > 120000) throw new Error('--timeout-ms must be 1000..120000');
  return o;
}

// Query strings and fragments can carry tokens, so reports keep only origin-less path information.
export const redactUrl = (raw) => { try { const u = new URL(raw); return u.protocol === 'data:' ? 'data:' : `${u.protocol}//${u.host}${u.pathname}`; } catch { return 'invalid-url'; } };
// Free text (console, page and navigation errors) can embed full URLs, so every URL in it is reduced the same way as a URL field.
const redactText = (s) => String(s).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi, (u) => redactUrl(u));
const redactPath = (p) => String(p).replace(/[?#].*$/s, '');
const clip = (s) => redactText(String(s).replace(/\s+/g, ' ')).slice(0, 500);

// A request is allowed only to the bridged target (and inline data/blob/about URLs, which are not network).
export function isAllowed(raw, port) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (['data:', 'blob:', 'about:'].includes(u.protocol)) return true;
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === port;
}

// WebSocket handshakes are not seen by context.route(), so they are routed separately. Only a ws:// socket to the bridged origin is allowed.
export function isAllowedSocket(raw, port) {
  let u; try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'ws:' && u.hostname === '127.0.0.1' && Number(u.port) === port;
}

function bridge(socketPath) {
  const server = net.createServer((client) => {
    const upstream = net.connect(socketPath);
    client.pipe(upstream); upstream.pipe(client);
    const stop = () => { client.destroy(); upstream.destroy(); };
    client.on('error', stop); upstream.on('error', stop); client.on('close', stop); upstream.on('close', stop);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); });
}

export async function capture(o) {
  const report = { schema_version: 1, ok: false, target: o.target, path: redactPath(o.path), browser: o.browser, profile: o.profile, wait: o.wait, fullPage: o.fullPage,
    navigation: { status: null, durationMs: null }, screenshot: null, consoleErrors: [], pageErrors: [], httpErrors: [], failedRequests: [], blockedRequests: [], problems: [] };
  let exit = EXIT.ok;
  const socketPath = path.join(o.socketDir, `${o.target}.sock`);
  if (!fs.statSync(socketPath, { throwIfNoEntry: false })?.isSocket()) { report.problems.push('target socket is not mounted'); return { report, exit: EXIT.usage }; }
  process.env.HOME = process.env.HOME && process.env.HOME !== '/' ? process.env.HOME : '/tmp';
  const { port, server } = await bridge(socketPath);
  let browser, context;
  try {
    const pw = await import(pathToFileURL(o.playwright).href);
    const engine = (pw.default ?? pw)[o.browser];
    const args = o.browser === 'chromium' ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-dev-shm-usage'] : [];
    try { browser = await engine.launch({ headless: true, args }); report.browserVersion = browser.version(); }
    catch (error) { report.problems.push(`browser launch failed: ${clip(error.message)}`); return { report, exit: EXIT.launch }; }
    context = await browser.newContext({ ...PROFILES[o.profile], ignoreHTTPSErrors: false, serviceWorkers: 'block', acceptDownloads: false, locale: 'en-GB', timezoneId: 'UTC' });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (isAllowed(url, port)) return route.continue();
      report.blockedRequests.push(redactUrl(url));
      return route.abort('blockedbyclient');
    });
    // Intercepted without connectToServer() the socket is a mock: a refused one never reaches the network.
    await context.routeWebSocket(/.*/, (ws) => {
      const url = ws.url();
      if (isAllowedSocket(url, port)) return ws.connectToServer();
      report.blockedRequests.push(redactUrl(url));
      return ws.close({ code: 1008, reason: 'blocked' });
    });
    if (o.trace) await context.tracing.start({ screenshots: false, snapshots: true });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(clip(m.text())); });
    page.on('pageerror', (e) => report.pageErrors.push(clip(e.message)));
    page.on('response', (r) => { if (r.status() >= 400) report.httpErrors.push({ status: r.status(), url: redactUrl(r.url()) }); });
    page.on('requestfailed', (r) => { const url = redactUrl(r.url()); if (!report.blockedRequests.includes(url)) report.failedRequests.push({ url, error: clip(r.failure()?.errorText || '') }); });
    const started = Date.now();
    try {
      const response = await page.goto(`http://127.0.0.1:${port}${o.path}`, { waitUntil: o.wait, timeout: o.timeoutMs });
      report.navigation = { status: response ? response.status() : null, durationMs: Date.now() - started };
    } catch (error) {
      report.navigation.durationMs = Date.now() - started;
      const message = clip(error.message);
      if (/ERR_CERT|SSL|TLS/i.test(message)) { report.problems.push(`TLS error: ${message}`); exit = EXIT.tls; }
      else if (/Timeout/i.test(message)) { report.problems.push(`navigation timed out after ${o.timeoutMs} ms`); exit = EXIT.timeout; }
      else { report.problems.push(`navigation failed: ${message}`); exit = EXIT.problems; }
    }
    if (exit === EXIT.ok || exit === EXIT.problems) {
      const file = `${o.name}-${o.profile}-${o.browser}.png`;
      const buffer = await page.screenshot({ fullPage: o.fullPage, type: 'png', timeout: o.timeoutMs });
      fs.writeFileSync(path.join(o.out, file), buffer, { mode: 0o600 });
      report.screenshot = { file, bytes: buffer.length };
    }
    if (o.trace) { const file = `${o.name}-${o.profile}-${o.browser}.trace.zip`; const traceFile = path.join(o.out, file); await context.tracing.stop({ path: traceFile }); fs.chmodSync(traceFile, 0o600);
      // Unlike the report, a Playwright trace keeps full URLs (query strings included) and DOM snapshots. Say so, never imply redaction.
      report.trace = { file, redacted: false, contains: 'full request URLs with query strings and DOM snapshots' }; }
  } finally {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {}); server.close();
  }
  if (report.blockedRequests.length) { report.problems.push(`${report.blockedRequests.length} request(s) to undeclared destinations were blocked`); exit = EXIT.blocked; }
  else if (exit === EXIT.ok && (report.consoleErrors.length || report.pageErrors.length || report.httpErrors.length || report.failedRequests.length || (report.navigation.status ?? 200) >= 400)) {
    report.problems.push('the page reported errors'); exit = EXIT.problems;
  }
  report.ok = exit === EXIT.ok;
  return { report, exit };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) { process.stderr.write(`capture: ${error.message}\n`); process.exit(EXIT.usage); }
  let result;
  try { result = await capture(options); }
  catch (error) { result = { report: { schema_version: 1, ok: false, problems: [`capture failed: ${clip(error.message)}`] }, exit: EXIT.problems }; }
  fs.writeFileSync(path.join(options.out, `${options.name}-${options.profile}-${options.browser}.report.json`), `${JSON.stringify(result.report, null, 2)}\n`, { mode: 0o600 });
  process.exit(result.exit);
}
