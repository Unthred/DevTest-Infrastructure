// Wrapper-level tests: capture() drives a FAKE Playwright module, so every exit code and the precedence between them is proven
// without Docker. The real-browser behaviour is covered by tests/browser-smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { capture, EXIT } from '../browser/capture.mjs';

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-capture-'));
  const sockets = path.join(dir, 't'), out = path.join(dir, 'out');
  fs.mkdirSync(sockets); fs.mkdirSync(out);
  const server = net.createServer(c => c.end()).listen(path.join(sockets, 'fixture.sock'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, sockets, out, ready: new Promise(r => server.once('listening', r)) };
}
// scenario: { launchError, requests: [urls the page asks for], console: [...], pageErrors: [...], responses: [{status,url}], gotoError, status }
function fakePlaywright(dir, scenario) {
  const file = path.join(dir, `fake-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(file, `const s = ${JSON.stringify(scenario)};
const handlers = {}; let routeFn;
const page = { on: (e, f) => { handlers[e] = f; },
  async goto(url) {
    if (s.gotoError) throw new Error(s.gotoError);
    for (const u of s.requests || []) await routeFn({ request: () => ({ url: () => u }), continue: () => {}, abort: () => {} });
    for (const m of s.console || []) handlers.console?.({ type: () => 'error', text: () => m });
    for (const m of s.pageErrors || []) handlers.pageerror?.({ message: m });
    for (const r of s.responses || []) handlers.response?.({ status: () => r.status, url: () => r.url });
    return { status: () => s.status ?? 200 };
  },
  async screenshot() { return Buffer.from('PNGDATA'); } };
const context = { route: async (_p, f) => { routeFn = f; }, tracing: { start: async () => {}, stop: async ({ path }) => { (await import('node:fs')).writeFileSync(path, 'zip'); } }, newPage: async () => page, close: async () => {} };
const browser = { version: () => 'fake-1', newContext: async () => context, close: async () => {} };
export const chromium = { launch: async () => { if (s.launchError) throw new Error(s.launchError); return browser; } };
`);
  return file;
}
async function run(t, scenario, extra = {}) {
  const w = world(t); await w.ready;
  const options = { target: 'fixture', path: '/', browser: 'chromium', profile: 'desktop', wait: 'load', timeoutMs: 5000, name: 'p', fullPage: false, trace: false,
    out: w.out, socketDir: w.sockets, playwright: fakePlaywright(w.dir, scenario), ...extra };
  const result = await capture(options);
  return { ...result, out: w.out, files: fs.readdirSync(w.out) };
}

test('a clean page: exit 0, screenshot written, report ok', async t => {
  const r = await run(t, {});
  assert.equal(r.exit, EXIT.ok); assert.equal(r.report.ok, true); assert.deepEqual(r.report.problems, []);
  assert.equal(r.report.screenshot.file, 'p-desktop-chromium.png'); assert.ok(r.files.includes('p-desktop-chromium.png'));
});

test('a broken page is detected at the wrapper level, and the screenshot is still taken as evidence', async t => {
  for (const [name, scenario] of [['console error', { console: ['boom'] }], ['page error', { pageErrors: ['Uncaught'] }], ['HTTP 404 subresource', { responses: [{ status: 404, url: 'http://127.0.0.1:1/x.png?k=1' }] }], ['main document 500', { status: 500 }]]) {
    const r = await run(t, scenario);
    assert.equal(r.exit, EXIT.problems, name); assert.equal(r.report.ok, false, name); assert.ok(r.files.includes('p-desktop-chromium.png'), `${name}: evidence kept`);
  }
  const r = await run(t, { responses: [{ status: 404, url: 'http://127.0.0.1:1/x.png?secret=1' }] });
  assert.ok(!JSON.stringify(r.report).includes('secret=1'), 'query strings never reach the report');
});

test('an undeclared destination wins over page errors and is recorded without its query string', async t => {
  const r = await run(t, { requests: ['http://198.51.100.7/beacon?key=VALUE', 'https://example.invalid/a.js'], console: ['also broken'] });
  assert.equal(r.exit, EXIT.blocked);
  assert.deepEqual(r.report.blockedRequests, ['http://198.51.100.7/beacon', 'https://example.invalid/a.js']);
  assert.ok(!JSON.stringify(r.report).includes('VALUE'));
});

test('timeouts, TLS errors, other navigation failures and launch failures have their own exit codes', async t => {
  const timeout = await run(t, { gotoError: 'page.goto: Timeout 5000ms exceeded.' });
  assert.equal(timeout.exit, EXIT.timeout); assert.equal(timeout.report.screenshot, null);
  assert.equal((await run(t, { gotoError: 'net::ERR_CERT_AUTHORITY_INVALID' })).exit, EXIT.tls);
  assert.equal((await run(t, { gotoError: 'net::ERR_CONNECTION_REFUSED' })).exit, EXIT.problems);
  const launch = await run(t, { launchError: 'no display' });
  assert.equal(launch.exit, EXIT.launch); assert.match(launch.report.problems[0], /launch failed/);
});

test('a missing target socket is a usage error before any browser starts', async t => {
  const w = world(t); await w.ready;
  const r = await capture({ target: 'other', path: '/', browser: 'chromium', profile: 'desktop', wait: 'load', timeoutMs: 5000, name: 'p', out: w.out, socketDir: w.sockets, playwright: '/nonexistent.mjs' });
  assert.equal(r.exit, EXIT.usage);
});

test('a trace is written 0600 and the report says it is NOT redacted', async t => {
  const r = await run(t, {}, { trace: true });
  assert.equal(r.report.trace.redacted, false); assert.match(r.report.trace.contains, /query strings/);
  assert.equal(fs.statSync(path.join(r.out, r.report.trace.file)).mode & 0o777, 0o600);
});

test('a query string or fragment in --path, and URLs inside error text, never reach the report', async t => {
  const r = await run(t, { gotoError: 'page.goto: net::ERR_FAILED at http://127.0.0.1:1234/index.html?session=CANARY_VALUE#frag_CANARY', console: ['load failed https://x.test/a?k=CANARY_VALUE'], pageErrors: ['bad http://127.0.0.1:9/p?k=CANARY_VALUE'] },
    { path: '/index.html?session=CANARY_VALUE#frag_CANARY' });
  const text = JSON.stringify(r.report);
  assert.ok(!text.includes('CANARY'), text);
  assert.equal(r.report.path, '/index.html');
});
