// Issue #10: Home Assistant read-only browser profile. Pure helpers, the live gate and the wrapper (driven by a FAKE Playwright) are
// proven without Docker; the real-browser behaviour is covered by tests/ha-readonly-smoke.mjs (Tower only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isReadOnlyMethod, wsFrameDecision, installInteractionGuard, MUTATING_SELECTOR, NAVIGATION_SELECTOR, GUARDED_EVENTS, PAGE_SETS, HA_PROFILES, haOutcome, renderHaReport } from '../browser/ha-readonly-lib.mjs';
import { evaluateLiveGate, LIVE_HOST } from '../browser/ha-live-gate.mjs';
import { parseHaArguments, run, loadSession, EXIT } from '../browser/ha-readonly.mjs';

const policyFile = new URL('../broker/policy.example.json', import.meta.url);
const examplePolicy = () => JSON.parse(fs.readFileSync(policyFile, 'utf8'));
const register = (status) => `## D-099 — Dedicated HA test identity\n- Status: ${status}\n- Date: 2026-11-02\n`;
// A policy that satisfies every credential rule, so the only remaining reason can be the network route.
const confirmedPolicy = () => { const p = examplePolicy(); p.productionIdentity = { confirmed: true, decision: 'D-099' }; p.secrets['ha-test-login'].domains = [LIVE_HOST]; return p; };

test('methods: only GET and HEAD are reads', () => {
  for (const m of ['GET', 'get', 'HEAD']) assert.equal(isReadOnlyMethod(m), true, m);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '', undefined]) assert.equal(isReadOnlyMethod(m), false, String(m));
});

test('websocket frames: reads pass, writes and anything unknown are refused, and no payload is returned', () => {
  for (const type of ['auth', 'ping', 'get_states', 'subscribe_events', 'lovelace/config']) assert.deepEqual(wsFrameDecision(JSON.stringify({ id: 1, type })), { allow: true, type }, type);
  for (const type of ['call_service', 'config/entity_registry/update', 'lovelace/config/save', 'input_number/set_value', 'future/unknown']) assert.equal(wsFrameDecision(JSON.stringify({ id: 1, type })).allow, false, type);
  for (const bad of ['not json', '[]', '{}', '{"type":5}', '{"type":"Bad Type!"}', JSON.stringify({ type: 'x'.repeat(100) }), 'null']) assert.equal(wsFrameDecision(bad).allow, false, bad);
  const leaked = wsFrameDecision(JSON.stringify({ type: 'call_service', service_data: { temperature: 30 }, access_token: 'CANARY' }));
  assert.ok(!JSON.stringify(leaked).includes('CANARY') && !JSON.stringify(leaked).includes('30'));
  assert.equal(wsFrameDecision(Buffer.from('{"type":"ping"}')).allow, true);
});

// A tiny stand-in for the browser: nodes with matches(), events with composedPath(). The guard function is the real one.
function guardWorld() {
  const listeners = [];
  globalThis.window = { addEventListener: (type, fn, opt) => listeners.push({ type, fn, opt }) };
  const matcher = (tags) => (selector) => selector.split(',').some((s) => tags.includes(s.trim()));
  const node = (tag, ...extra) => ({ nodeType: 1, tagName: tag.toUpperCase(), matches: matcher([tag, ...extra]) });
  const fire = (type, ...path) => { let stopped = false, prevented = false; const ev = { type, composedPath: () => path, stopImmediatePropagation: () => { stopped = true; }, preventDefault: () => { prevented = true; } };
    for (const l of listeners.filter((x) => x.type === type)) l.fn(ev); return { stopped, prevented }; };
  return { listeners, node, fire, blocked: () => globalThis.window.__haBlockedInteractions };
}
test('interaction guard: state-changing controls (climate, helpers, shadow DOM) are stopped; links and tabs pass', (t) => {
  const w = guardWorld(); t.after(() => { delete globalThis.window; });
  installInteractionGuard({ mutating: 'button,input,select,ha-switch,hui-climate-entity-row,[role=button]', navigation: 'a[href],[role=tab]', events: GUARDED_EVENTS });
  assert.ok(w.listeners.every((l) => l.opt.capture === true) && w.listeners.length === GUARDED_EVENTS.length);
  // positive: a climate row inside shadow DOM (composed path lists the inner button first)
  for (const [type, nodes] of [['click', [w.node('button'), w.node('hui-climate-entity-row')]], ['change', [w.node('select')]], ['input', [w.node('input')]], ['keydown', [w.node('ha-switch')]], ['pointerdown', [w.node('div', '[role=button]')]]]) {
    const r = w.fire(type, ...nodes); assert.deepEqual(r, { stopped: true, prevented: true }, type);
  }
  assert.equal(w.blocked().length, 5);
  assert.ok(w.blocked().every((s) => /^[a-z]+:[a-z-]+$/.test(s)));
  // negative: plain navigation is not blocked and not counted
  assert.deepEqual(w.fire('click', w.node('span'), w.node('a', 'a[href]')), { stopped: false, prevented: false });
  assert.deepEqual(w.fire('click', w.node('button', '[role=tab]')), { stopped: false, prevented: false });
  assert.equal(w.blocked().length, 5);
  // a control nested INSIDE a link is still a control
  assert.equal(w.fire('click', w.node('button'), w.node('a', 'a[href]')).stopped, true);
});

test('selectors name the climate and helper controls the issue is about', () => {
  for (const s of ['hui-climate-entity-row', 'ha-climate-control', 'hui-input-number-entity-row', 'hui-input-select-entity-row', 'ha-switch', 'ha-slider', 'button', 'input', 'select']) assert.ok(MUTATING_SELECTOR.split(',').includes(s), s);
  assert.match(NAVIGATION_SELECTOR, /a\[href\]/);
  assert.deepEqual(HA_PROFILES, ['phone-390', 'desktop-1280']);
  assert.deepEqual(PAGE_SETS.live.map((p) => p.name), ['dashboard', 'heating-settings', 'heating-season']);
});

test('live gate: blocked today, with the real reasons', () => {
  const g = evaluateLiveGate({ policy: examplePolicy(), register: register('homeowner-approved') });
  assert.equal(g.status, 'blocked'); assert.equal(g.host, LIVE_HOST);
  assert.ok(g.reasons.some((r) => /dedicated least-privilege devtest- identity/.test(r)));
  assert.ok(g.reasons.some((r) => /OQ-2/.test(r)));
});
test('live gate: a confirmed identity alone is still blocked without an enforced route', () => {
  const g = evaluateLiveGate({ policy: confirmedPolicy(), register: register('homeowner-approved') });
  assert.equal(g.status, 'blocked');
  assert.equal(g.reasons.length, 1); assert.match(g.reasons[0], /OQ-2/);
});
test('live gate: an agent-proposal decision, a foreign domain or an invalid policy never count', () => {
  assert.match(evaluateLiveGate({ policy: confirmedPolicy(), register: register('agent-proposal'), networkRoute: 'available' }).reasons.join(' '), /not a homeowner-approved decision/);
  const foreign = confirmedPolicy(); foreign.secrets['ha-test-login'].domains = ['homeassistant.local'];
  assert.match(evaluateLiveGate({ policy: foreign, register: register('homeowner-approved'), networkRoute: 'available' }).reasons.join(' '), /not scoped to/);
  assert.match(evaluateLiveGate({ policy: { nope: 1 }, register: register('homeowner-approved') }).reasons.join(' '), /policy unusable/);
  assert.match(evaluateLiveGate({ policy: confirmedPolicy(), register: '' , networkRoute: 'available' }).reasons.join(' '), /not a homeowner-approved decision/);
});
test('live gate: ready only when every condition holds (and ready is not a login)', () => {
  const g = evaluateLiveGate({ policy: confirmedPolicy(), register: register('homeowner-approved'), networkRoute: 'available' });
  assert.deepEqual(g, { status: 'ready', host: LIVE_HOST, reasons: [] });
});

test('arguments: defaults and negative cases', () => {
  const o = parseHaArguments(['--target', 'page']);
  assert.equal(o.pageSet, 'fixture'); assert.deepEqual(o.profileNames, HA_PROFILES); assert.equal(o.pageList.length, 3); assert.equal(o.session, null);
  for (const bad of [[], ['--target', 'Bad'], ['--target', 'p', '--page-set', 'prod'], ['--target', 'p', '--pages', 'a=//evil'], ['--target', 'p', '--pages', 'a=/x,a=/y'], ['--target', 'p', '--profiles', 'nope'],
    ['--target', 'p', '--session', '/tmp/x'], ['--target', 'p', '--session', 'relative'], ['--target', 'p', '--bogus', '1'], ['--target', 'p', '--browser', 'ie'], ['--target', 'p', '--probe', 'typing'], ['--target', 'p', '--timeout-ms', '5']])
    assert.throws(() => parseHaArguments(bad), Error, JSON.stringify(bad));
  assert.doesNotThrow(() => parseHaArguments(['--target', 'p', '--session', '/secrets/ha-session', '--page-set', 'live']));
});
test('arguments: clicking is refused on the live page set', () => {
  assert.throws(() => parseHaArguments(['--target', 'p', '--page-set', 'live', '--probe', 'clicks']), /only allowed on the fixture/);
  assert.doesNotThrow(() => parseHaArguments(['--target', 'p', '--probe', 'clicks']));
});

// ---- wrapper against a fake Playwright ----
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-ha-'));
  const sockets = path.join(dir, 't'), out = path.join(dir, 'out');
  fs.mkdirSync(sockets); fs.mkdirSync(out);
  const server = net.createServer((c) => c.end()).listen(path.join(sockets, 'page.sock'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, sockets, out, ready: new Promise((r) => server.once('listening', r)) };
}
// scenario: { requests: [{url, method}], frames: [{url, body}], findings: [], interactions: [], png: bool }
function fakePlaywright(dir, scenario) {
  const file = path.join(dir, `fake-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(file, `const s = ${JSON.stringify(scenario)};
import fs from 'node:fs';
const log = globalThis.__haLog = { contexts: [], aborted: [], continued: 0, sent: [], closed: [], initScripts: 0 };
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
let routeFn, wsFn, opts;
const page = { on() {},
  async goto() {
    for (const r of s.requests || []) await routeFn({ request: () => ({ url: () => r.url, method: () => r.method }), continue: () => { log.continued++; }, abort: (why) => { log.aborted.push(r.method + ' ' + r.url); } });
    for (const f of s.frames || []) { const handlers = {}; const upstream = { send: (b) => log.sent.push(b), onMessage: () => {} };
      const ws = { url: () => f.url, connectToServer: () => { log.connected = true; return upstream; }, close: () => { log.closed.push(f.url); }, send() {}, onMessage: (h) => { handlers.m = h; } };
      await wsFn(ws); for (const b of f.bodies || []) handlers.m?.(b); }
    return { status: () => 200 }; },
  // probe scenario: s.controls clickable controls; s.counters is the sequence read after the controls ({blocked, mutated}); s.pageInitiated blocked before the probe
  reads: 0,
  locator() { return { count: async () => s.controls || 0, nth: () => ({ click: async () => {}, press: async () => {} }) }; },
  async evaluate(fn) {
    const t = String(fn);
    if (t.includes('Array.isArray')) { const seq = s.counters || []; const v = seq[Math.min(this.reads++, seq.length - 1)]; return { sameDocument: true, ...(v ?? { blocked: 0, mutated: 0 }) }; }
    if (t.includes(').length')) return s.pageInitiated || 0;
    return t.includes('__haBlockedInteractions') ? (s.interactions || []) : (s.findings || []); },
  async screenshot() { return s.noPng ? Buffer.from('x') : png(opts.viewport.width * opts.deviceScaleFactor, opts.viewport.height * opts.deviceScaleFactor); } };
const context = { route: async (_p, f) => { routeFn = f; }, routeWebSocket: async (_p, f) => { wsFn = f; }, addInitScript: async () => { log.initScripts++; }, newPage: async () => page, close: async () => {} };
export const chromium = { launch: async () => ({ newContext: async (o) => { opts = o; log.contexts.push(o); return context; }, close: async () => {} }) };
`);
  return file;
}
async function go(t, scenario, extra = []) {
  const w = world(t); await w.ready;
  const o = parseHaArguments(['--target', 'page', '--out', w.out, '--socket-dir', w.sockets, '--playwright', fakePlaywright(w.dir, scenario), ...extra]);
  const result = await run(o);
  return { ...result, files: fs.readdirSync(w.out), w, log: globalThis.__haLog };
}
const ok = (p) => `http://127.0.0.1:${p}`;

test('wrapper: a clean read-only run passes with 3 pages x 2 profiles and a screenshot each', async (t) => {
  const r = await go(t, {});
  assert.equal(r.exit, EXIT.ok); assert.equal(r.summary.ok, true); assert.equal(r.summary.authenticated, false);
  assert.equal(r.summary.pages.length, 3); assert.ok(r.summary.pages.every((p) => p.profiles.length === 2 && p.profiles.every((x) => x.rendered)));
  assert.equal(r.log.contexts.length, 6);
  assert.equal(r.log.initScripts, 6, 'the interaction guard is installed in every context');
  assert.deepEqual(r.log.contexts.map((c) => c.viewport.width).slice(0, 2), [390, 1280]);
  assert.match(r.summary.scope, /no login, no state change/);
});

test('wrapper: layout overflow and clipping are failures (exit 15) and are reported per page and profile', async (t) => {
  const r = await go(t, { findings: [{ check: 'document-overflow', severity: 'fail', element: 'body[0]' }, { check: 'clipped', severity: 'fail', element: 'div[1]', text: 'CANARY' }] });
  assert.equal(r.exit, EXIT.layout); assert.equal(r.summary.ok, false);
  assert.ok(r.summary.pages.every((p) => p.failures.length === 4));
  assert.ok(!JSON.stringify(r.summary).includes('CANARY') && !renderHaReport(r.summary).includes('CANARY'));
  assert.match(renderHaReport(r.summary), /Result: \*\*FAIL\*\*.*|document-overflow/s);
});

test('wrapper: a profile that did not render is not a pass', async (t) => {
  const r = await go(t, { noPng: true });
  assert.equal(r.exit, EXIT.layout); assert.equal(r.summary.ok, false);
});

test('wrapper: a write request is aborted and fails the run with its own exit code (16)', async (t) => {
  const w = world(t); await w.ready;
  // port is unknown until run(); the fake reads it from the first request instead, so build requests after the bridge exists
  const scenarioFile = fakePlaywright(w.dir, { requests: [] });
  const text = fs.readFileSync(scenarioFile, 'utf8').replace('for (const r of s.requests || [])', 'for (const r of (s.requests || []).concat(globalThis.__haExtra || []).map((x) => ({ ...x, url: x.url.replace("PORT", String(globalThis.__haPort)) })))');
  fs.writeFileSync(scenarioFile, text);
  globalThis.__haExtra = [{ url: 'http://127.0.0.1:PORT/api/services/climate/set_temperature?token=CANARY', method: 'POST' }, { url: 'http://127.0.0.1:PORT/x', method: 'GET' }];
  // discover the port by wrapping net.createServer listen is overkill: the bridge picks any port, so read it from the first context's route call
  const net2 = await import('node:net'); const orig = net2.default.Server.prototype.listen;
  net2.default.Server.prototype.listen = function (...a) { const r = orig.apply(this, a); this.once('listening', () => { if (this.address()?.address === '127.0.0.1') globalThis.__haPort = this.address().port; }); return r; };
  t.after(() => { net2.default.Server.prototype.listen = orig; delete globalThis.__haExtra; delete globalThis.__haPort; });
  const o = parseHaArguments(['--target', 'page', '--out', w.out, '--socket-dir', w.sockets, '--playwright', scenarioFile, '--profiles', 'desktop-1280', '--pages', 'dashboard=/d']);
  const r = await run(o);
  assert.equal(r.exit, EXIT.readonly); assert.equal(r.summary.ok, false);
  assert.equal(r.summary.readOnly.blockedWrites.length, 1);
  assert.match(r.summary.readOnly.blockedWrites[0], /^POST http:\/\/127\.0\.0\.1:\d+\/api\/services\/climate\/set_temperature$/);
  assert.ok(!JSON.stringify(r.summary).includes('CANARY'), 'query strings never reach the report');
  assert.equal(globalThis.__haLog.continued, 1, 'the GET went through');
  assert.deepEqual(globalThis.__haLog.aborted.length, 1);
});

test('wrapper: a call_service frame is refused while get_states is relayed (only with --forward-websocket)', async (t) => {
  const bodies = [JSON.stringify({ id: 1, type: 'get_states' }), JSON.stringify({ id: 2, type: 'call_service', service_data: { token: 'CANARY' } }), 'garbage'];
  const w = world(t); await w.ready;
  const scenarioFile = fakePlaywright(w.dir, { frames: [{ url: 'PORTWS', bodies }] });
  fs.writeFileSync(scenarioFile, fs.readFileSync(scenarioFile, 'utf8').replace('url: () => f.url', 'url: () => f.url.replace("PORTWS", "ws://127.0.0.1:" + globalThis.__haPort + "/api/websocket")'));
  const net2 = await import('node:net'); const orig = net2.default.Server.prototype.listen;
  net2.default.Server.prototype.listen = function (...a) { const r = orig.apply(this, a); this.once('listening', () => { if (this.address()?.address === '127.0.0.1') globalThis.__haPort = this.address().port; }); return r; };
  t.after(() => { net2.default.Server.prototype.listen = orig; delete globalThis.__haPort; });
  const base = ['--target', 'page', '--out', w.out, '--socket-dir', w.sockets, '--playwright', scenarioFile, '--profiles', 'desktop-1280', '--pages', 'dashboard=/d'];
  const r = await run(parseHaArguments([...base, '--forward-websocket']));
  assert.equal(r.exit, EXIT.readonly);
  assert.deepEqual(r.summary.readOnly.blockedFrames.map((f) => f.split(' ')[0]), ['call_service', 'non-json']);
  assert.deepEqual(globalThis.__haLog.sent, [bodies[0]], 'only the read frame reached the upstream');
  assert.ok(!JSON.stringify(r.summary).includes('CANARY'));
  assert.equal(globalThis.__haLog.connected, true);
  globalThis.__haLog.connected = undefined;
  const mock = await run(parseHaArguments(base));
  assert.equal(globalThis.__haLog.connected, undefined, 'without --forward-websocket nothing is connected');
  assert.equal(mock.exit, EXIT.readonly);
});

test('wrapper: a socket or request to an undeclared host is blocked (12) and outranks the read-only code', async (t) => {
  const r = await go(t, { requests: [{ url: 'https://home.yeradonkey.com/api/states?x=CANARY', method: 'POST' }] });
  assert.equal(r.exit, EXIT.blocked);
  assert.deepEqual([...new Set(r.summary.blockedRequests)], ['https://home.yeradonkey.com/api/states']);
  assert.equal(r.summary.readOnly.blockedWrites.length, 0, 'an undeclared destination is not also counted as a write');
});

test('wrapper: interactions the guard blocked without a probe mean the page acted on its own (16)', async (t) => {
  const r = await go(t, { interactions: ['click:button'] });
  assert.equal(r.exit, EXIT.readonly); assert.ok(r.summary.unexpectedInteractions > 0);
});

test('wrapper: click probe counts per control, fails on a navigation or a page-initiated interaction, passes a clean probe', async (t) => {
  const args = ['--probe', 'clicks', '--profiles', 'desktop-1280', '--pages', 'd=/d'];
  const clean = await go(t, { controls: 2, counters: [{ blocked: 0, mutated: 0 }, { blocked: 2, mutated: 0 }, { blocked: 4, mutated: 0 }] }, args);
  assert.equal(clean.exit, EXIT.ok); assert.equal(clean.summary.probe.attempted, 2); assert.equal(clean.summary.probe.blocked, 4); assert.equal(clean.summary.probe.navigated, 0);
  const bypass = await go(t, { controls: 2, counters: [{ blocked: 0, mutated: 0 }, { blocked: 2, mutated: 1 }, { blocked: 4, mutated: 1 }] }, args);
  assert.equal(bypass.exit, EXIT.readonly); assert.equal(bypass.summary.probe.mutated, 1);
  // the second control navigated: counters reset, so the mutation counted before it must still fail the run, via navigated
  const nav = await go(t, { controls: 3, counters: [{ blocked: 0, mutated: 0 }, { blocked: 2, mutated: 1 }, { blocked: -1, mutated: 0 }] }, args);
  assert.equal(nav.exit, EXIT.readonly); assert.equal(nav.summary.probe.navigated, 1); assert.equal(nav.summary.probe.mutated, 1); assert.equal(nav.summary.probe.attempted, 2);
  const navOnly = await go(t, { controls: 1, counters: [{ blocked: 0, mutated: 0 }, { blocked: 0, mutated: 0 }, { blocked: -1, mutated: 0 }] }, args);
  assert.equal(navOnly.summary.probe.navigated, 0, 'a single control that does not navigate is fine');
  const navFirst = await go(t, { controls: 1, counters: [{ blocked: 0, mutated: 0 }, { blocked: -1, mutated: 0 }] }, args);
  assert.equal(navFirst.exit, EXIT.readonly); assert.equal(navFirst.summary.probe.navigated, 1);
  // the first control navigated and the guard re-created its counters at 0 on the new document: only the document marker shows it
  const navReset = await go(t, { controls: 2, counters: [{ blocked: 0, mutated: 0 }, { blocked: 0, mutated: 0, sameDocument: false }] }, args);
  assert.equal(navReset.exit, EXIT.readonly); assert.equal(navReset.summary.probe.navigated, 1); assert.equal(navReset.summary.probe.attempted, 1);
  // the page clicked something by itself before the probe: detected even though the probe is on
  const own = await go(t, { controls: 1, pageInitiated: 1, counters: [{ blocked: 1, mutated: 0 }, { blocked: 3, mutated: 0 }] }, args);
  assert.equal(own.exit, EXIT.readonly); assert.equal(own.summary.unexpectedInteractions, 1);
});

test('wrapper: a stored session is passed to the browser context and never reported', async (t) => {
  const w = world(t); await w.ready;
  const sessionFile = path.join(w.dir, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ cookies: [{ name: 'ha', value: 'CANARY-COOKIE', domain: LIVE_HOST, path: '/' }], origins: [] }));
  assert.equal(loadSession(sessionFile).cookies.length, 1);
  // the argument parser only accepts /secrets/<name>, so the wrapper is given the parsed options directly for this test
  const o = parseHaArguments(['--target', 'page', '--out', w.out, '--socket-dir', w.sockets, '--playwright', fakePlaywright(w.dir, {}), '--profiles', 'desktop-1280', '--pages', 'dashboard=/d']);
  o.session = sessionFile;
  const r = await run(o);
  assert.equal(r.exit, EXIT.ok); assert.equal(r.summary.authenticated, true);
  assert.equal(globalThis.__haLog.contexts[0].storageState.cookies[0].name, 'ha');
  const everything = JSON.stringify(r.summary) + renderHaReport(r.summary) + fs.readdirSync(w.out).join();
  assert.ok(!everything.includes('CANARY-COOKIE'));
});
test('session files: missing or malformed ones are refused before any browser starts', async (t) => {
  const w = world(t); await w.ready;
  for (const content of [null, 'not json', '[]', '{"cookies":5}', '{"cookies":[],"origins":5}']) {
    const f = path.join(w.dir, `s-${Math.random()}.json`); if (content !== null) fs.writeFileSync(f, content);
    assert.throws(() => loadSession(f), /session file/);
    const o = parseHaArguments(['--target', 'page', '--out', w.out, '--socket-dir', w.sockets, '--playwright', path.join(w.dir, 'never.mjs')]); o.session = f;
    const r = await run(o);
    assert.equal(r.exit, EXIT.usage); assert.match(r.problem, /session file/);
  }
});

test('wrapper: an undeclared target socket and a missing Playwright cache are distinct faults', async (t) => {
  const w = world(t); await w.ready;
  const missing = parseHaArguments(['--target', 'other', '--out', w.out, '--socket-dir', w.sockets]);
  assert.equal((await run(missing)).exit, EXIT.usage);
  const nocache = parseHaArguments(['--target', 'page', '--out', w.out, '--socket-dir', w.sockets, '--playwright', path.join(w.dir, 'missing', 'index.mjs')]);
  assert.equal((await run(nocache)).exit, EXIT.launch);
});

test('outcome: layout, write attempts, unexpected interactions and a guard bypass each fail on their own', () => {
  const pages = [{ ok: true }];
  const base = { pages, blockedWrites: [], blockedFrames: [], blockedInteractions: [], probe: null };
  assert.equal(haOutcome(base).ok, true);
  assert.equal(haOutcome({ ...base, pages: [{ ok: false }] }).ok, false);
  assert.equal(haOutcome({ ...base, blockedWrites: ['POST x'] }).ok, false);
  assert.equal(haOutcome({ ...base, blockedFrames: ['call_service x'] }).ok, false);
  assert.equal(haOutcome({ ...base, blockedInteractions: ['click:button'] }).ok, false);
  const probing = { mode: 'clicks', attempted: 3, blocked: 3, mutated: 0 };
  assert.equal(haOutcome({ ...base, blockedInteractions: ['click:button'], probe: probing }).ok, true, 'blocks are expected while probing');
  assert.equal(haOutcome({ ...base, probe: { ...probing, mutated: 1 } }).ok, false, 'a handler that ran despite the guard is a bypass');
  assert.equal(haOutcome({ ...base, probe: { ...probing, navigated: 1 } }).probeBypassed, 1, 'a navigation during the probe fails it');
  const own = haOutcome({ ...base, blockedInteractions: ['click:button'], probe: { ...probing, pageInitiated: 1 } });
  assert.equal(own.ok, false, 'a page-initiated interaction fails even while probing');
  assert.equal(own.unexpectedInteractions, 1);
});
