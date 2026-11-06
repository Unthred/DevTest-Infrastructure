// Issue #552: a page left open must not stay unstyled. style-guard.js re-requests the stylesheet when it fails, without a reload.
// The sandbox DOM is small, but every stylesheet request is a real HTTP request to the real dashboard handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { handler } from '../supervisor/dashserver.mjs';
import { STYLE_GUARD, STYLE_GUARD_HASH } from '../supervisor/dashrender.mjs';

const guardSrc = STYLE_GUARD;
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1] } } };

// A dashboard server that can be stopped and started again on the same port, like an install restarting it.
async function restartable(t, { fail503 = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash552-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  let port = 0, server = null, left503 = fail503;
  const start = async () => {
    server = http.createServer();
    await new Promise(r => server.listen(port, '127.0.0.1', r)); port = server.address().port;
    const h = handler({ root, config, host: '127.0.0.1', port, now: () => Date.now() });
    server.on('request', (req, res) => { if (left503 > 0 && req.url.startsWith('/static/style.css')) { left503 -= 1; res.writeHead(503); return res.end('busy'); } h(req, res); });
  };
  const stop = () => new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  await start(); t.after(() => server?.listening && server.close());
  return { start, stop, get port() { return port; } };
}

// Fake page: the stylesheet counts as applied only after a link was fetched successfully (HTTP 200 text/css) from the live server.
function page(srv, { styled = false, src = guardSrc } = {}) {
  const timers = [], delays = [], links = [], listeners = {}, docListeners = {};
  let applied = styled, reloads = 0;
  const mkLink = href => { const l = { rel: 'stylesheet', href, ls: {}, parentNode: null, addEventListener(e, f) { this.ls[e] = f; } }; return l; };
  const head = { appendChild(l) { l.parentNode = head; links.push(l); fetchSheet(l); }, removeChild(l) { l.parentNode = null; const i = links.indexOf(l); if (i >= 0) links.splice(i, 1); } };
  const first = mkLink('/static/style.css'); first.parentNode = head; links.push(first);
  const fetchSheet = l => new Promise(resolve => {
    http.get({ host: '127.0.0.1', port: srv.port, path: l.href, headers: { host: `127.0.0.1:${srv.port}` } }, res => { res.resume(); res.on('end', () => { if (res.statusCode === 200 && /css/.test(res.headers['content-type'])) { applied = true; l.ls.load?.(); } else l.ls.error?.(); resolve(); }); })
      .on('error', () => { l.ls.error?.(); resolve(); });
  });
  const sandbox = {
    Math, Error, document: { querySelector: s => (/stylesheet/.test(s) ? links.find(l => l.href.startsWith('/static/style.css')) || null : null), createElement: () => mkLink(''), head, documentElement: {}, visibilityState: 'visible',
      addEventListener: (e, f) => { docListeners[e] = f; } },
    window: { addEventListener: (e, f) => { listeners[e] = f; } }, getComputedStyle: () => ({ getPropertyValue: n => (applied && n === '--nav-h' ? '52px' : '') }),
    setTimeout: (f, ms) => { timers.push(f); delays.push(ms); return timers.length; }, clearTimeout: n => { timers[n - 1] = null; }, location: { reload: () => { reloads += 1; } }
  };
  vm.runInNewContext(src, sandbox);
  const settle = () => new Promise(r => setTimeout(r, 60));
  return { links, delays, listeners, docListeners, first, get styled() { return applied; }, get reloads() { return reloads; }, get pending() { return timers.filter(Boolean).length; },
    async fire() { const f = timers.find(Boolean); timers[timers.indexOf(f)] = null; f(); await settle(); }, settle, fetchSheet };
}

// GET a path from the live server: status, headers and body.
const get = (srv, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.port, path: p, headers: { host: `127.0.0.1:${srv.port}` } }, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', reject));

test('the page carries the guard inline, the CSP allows exactly that script by hash, every icon is sized, and the skip link stays out of view', async t => {
  const srv = await restartable(t);
  const res = await get(srv, '/');
  const inline = res.body.match(/<script>([^<]*)<\/script>/);
  assert.ok(inline, 'the guard is an inline script in the page itself, not a request that can fail with the stylesheet');
  assert.equal(inline[1], guardSrc);
  assert.match(res.headers['content-security-policy'], new RegExp(`script-src 'self' ${STYLE_GUARD_HASH.replace(/[+/=]/g, '.')};`));
  assert.equal(STYLE_GUARD_HASH, `'sha256-${createHash('sha256').update(inline[1]).digest('base64')}'`, 'the hash is of the exact text in the page');
  assert.doesNotMatch(res.body, /style-guard\.js/);
  assert.ok(res.body.indexOf('rel="stylesheet"') < res.body.indexOf('<script>'), 'the guard runs after the stylesheet link exists');
  assert.match(res.body, /<style>\.skip:not\(:focus\)\{position:absolute;left:-9999px\}<\/style><link rel="stylesheet"/, 'inline rule comes before the stylesheet so the stylesheet still wins');
  const icons = res.body.match(/<svg class="icon [^>]*>/g) || [];
  assert.ok(icons.length > 0);
  for (const i of icons) assert.match(i, /width="18" height="18"/, i);
});

test('a tab opened before a restart recovers: the guard came with the page, the server is stopped, then returns', async t => {
  const srv = await restartable(t);
  const html = (await get(srv, '/')).body;               // the tab loads the page while the server is up
  const src = html.match(/<script>([^<]*)<\/script>/)[1];
  await srv.stop();                                      // install restart: style.css, app.js and any script file now fail
  await assert.rejects(get(srv, '/static/style.css'));
  await assert.rejects(get(srv, '/static/app.js'));
  const p = page(srv, { src });                          // the only script that still runs is the one inside the page
  p.first.ls.error();
  await p.fire(); assert.equal(p.styled, false);
  await srv.start();
  await p.fire();
  assert.equal(p.styled, true); assert.equal(p.reloads, 0);
});

test('stylesheet request fails (server down at a restart), then succeeds: the page is styled without a reload', async t => {
  const srv = await restartable(t);
  await srv.stop();
  const p = page(srv);
  p.first.ls.error();                                   // the browser reports the failed stylesheet
  assert.equal(p.pending, 1); assert.equal(p.delays[0], 1000);
  await p.fire();                                       // retry while the server is still down: fails, backs off
  assert.equal(p.styled, false); assert.equal(p.pending, 1); assert.equal(p.delays[1], 2000);
  assert.equal(p.links.length, 1, 'the failed retry link is removed');
  await srv.start();                                    // the install finished
  await p.fire();
  assert.equal(p.styled, true);
  assert.equal(p.pending, 0, 'nothing is scheduled once styled');
  assert.equal(p.links.length, 1); assert.match(p.links[0].href, /^\/static\/style\.css\?r=2$/, 'the failed first link is replaced by the working one');
  assert.equal(p.reloads, 0);
});

test('a busy server answering 503 twice, then 200: two backed-off retries, then recovered', async t => {
  const srv = await restartable(t, { fail503: 3 });     // the first request and two retries fail
  const p = page(srv);
  await p.fetchSheet(p.first);                          // initial request: 503 -> error event
  assert.equal(p.pending, 1);
  await p.fire(); await p.fire();
  assert.deepEqual(p.delays, [1000, 2000, 4000]);
  assert.equal(p.styled, false);
  await p.fire();
  assert.equal(p.styled, true); assert.equal(p.pending, 0); assert.equal(p.reloads, 0);
});

test('backoff is capped at 30 s and never reloads the page', async t => {
  const srv = await restartable(t); await srv.stop();
  const p = page(srv); p.first.ls.error();
  for (let i = 0; i < 8; i++) await p.fire();
  assert.deepEqual(p.delays.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.ok(p.delays.every(d => d <= 30000));
  assert.equal(p.reloads, 0); assert.equal(p.links.length, 1, 'failed retries do not pile up links');
});

test('negative: a page whose stylesheet loaded schedules nothing, on load, pageshow or becoming visible', async t => {
  const srv = await restartable(t);
  const p = page(srv, { styled: true });
  p.listeners.load(); p.listeners.pageshow(); p.docListeners.visibilitychange();
  assert.equal(p.pending, 0); assert.equal(p.links.length, 1);
});

test('a tab returning to view while unstyled retries at once-ish (delay restarts), and a missed error event is caught on load', async t => {
  const srv = await restartable(t); await srv.stop();
  const p = page(srv);
  p.listeners.load();                                   // the error event was missed, the load check finds no styles
  assert.equal(p.pending, 1);
  await p.fire(); await p.fire();
  assert.equal(p.delays.at(-1), 4000);
  p.docListeners.visibilitychange();                    // back in view: start again from the shortest delay, one timer only
  assert.equal(p.pending, 1); assert.equal(p.delays.at(-1), 1000);
});

test('the guard source contains no reload or navigation call (no loop, no flicker; compatible with #431)', () => {
  assert.doesNotMatch(guardSrc, /location\s*[.=]|\.reload\s*\(|history\./);
});
