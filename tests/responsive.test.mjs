import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePngSize, isRendered, summarise, renderReport, CHECKS } from '../browser/responsive-lib.mjs';
import { parseResponsiveArguments } from '../browser/responsive.mjs';
import { PROFILES, STANDARD_PROFILES } from '../browser/capture.mjs';

const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const result = (name, size, findings = [], pageProblems = 0, shot = true) => ({ name, profile: PROFILES[name], findings, png: shot ? size : null, screenshot: shot ? `${name}.png` : null, pageProblems });
const fail = (check = 'document-overflow') => ({ check, severity: 'fail', element: 'div.x', text: 'hello' });
const warn = () => ({ check: 'truncated', severity: 'warn', element: 'h2', text: '' });

test('PNG headers are parsed and anything else is refused', () => {
  assert.deepEqual(parsePngSize(png(780, 1688)), { width: 780, height: 1688 });
  for (const bad of [null, Buffer.alloc(10), Buffer.alloc(33), Buffer.from('not a png at all, definitely not one ok')]) assert.equal(parsePngSize(bad), null);
});

test('"rendered" needs a real PNG at least viewport x DPR in both directions', () => {
  const p = PROFILES['phone-390'];
  assert.equal(isRendered(p, { width: 780, height: 1688 }), true);
  assert.equal(isRendered(p, { width: 1000, height: 5000 }), true, 'a wider/taller full-page shot is still a render');
  assert.equal(isRendered(p, { width: 779, height: 1688 }), false);
  assert.equal(isRendered(p, { width: 780, height: 1687 }), false);
  assert.equal(isRendered(p, null), false);
});

test('a profile passes only if it rendered and has no failure; warnings do not fail', () => {
  const good = summarise({ target: 'f', path: '/', browser: 'chromium', name: 'n', results: [result('phone-390', parsePngSize(png(780, 1688)), [warn()])] });
  assert.equal(good.ok, true); assert.equal(good.profiles[0].warnings, 1);
  const bad = summarise({ target: 'f', path: '/', browser: 'chromium', name: 'n', results: [result('phone-390', parsePngSize(png(780, 1688)), [fail()]), result('desktop-1280', parsePngSize(png(1280, 800)))] });
  assert.equal(bad.ok, false); assert.deepEqual(bad.failures.map(f => f.profile), ['phone-390']); assert.equal(bad.profiles[1].ok, true);
});

test('no screenshot, a too-small screenshot, page errors or zero profiles can never pass', () => {
  const mk = (r) => summarise({ target: 'f', path: '/', browser: 'chromium', name: 'n', results: r });
  assert.equal(mk([result('phone-390', null, [], 0, false)]).ok, false);
  assert.equal(mk([result('phone-390', { width: 100, height: 100 })]).ok, false);
  assert.equal(mk([result('phone-390', parsePngSize(png(780, 1688)), [], 2)]).ok, false);
  assert.equal(mk([]).ok, false);
});

test('the summary and report never keep a query string or fragment from the requested path', () => {
  const summary = summarise({ target: 'f', path: '/p.html?session=CANARY_VALUE#frag', browser: 'chromium', name: 'n', results: [result('phone-390', parsePngSize(png(780, 1688)))] });
  assert.equal(summary.path, '/p.html');
  assert.ok(!JSON.stringify(summary).includes('CANARY_VALUE') && !renderReport(summary).includes('CANARY_VALUE'));
});

test('the human report names the result, the failures and its own limits', () => {
  const text = renderReport(summarise({ target: 'f', path: '/p.html', browser: 'webkit', name: 'n', results: [result('phone-360', parsePngSize(png(720, 1600)), [fail('target-covered')])] }));
  assert.match(text, /Result: \*\*FAIL\*\*/); assert.match(text, /phone-360: `target-covered`/); assert.match(text, /not that a person has accepted/);
  assert.match(renderReport(summarise({ target: 'f', path: '/', browser: 'chromium', name: 'n', results: [result('desktop-1280', parsePngSize(png(1280, 800)))] })), /Result: \*\*PASS\*\*/);
  for (const k of ['document-overflow', 'clipped', 'target-covered', 'chips-wrapped', 'target-too-small', 'beyond-viewport']) assert.ok(CHECKS[k], k);
});

test('the standard set is the issue\'s width ladder and arguments are validated', () => {
  assert.deepEqual(STANDARD_PROFILES.map(p => PROFILES[p].viewport.width), [360, 390, 430, 768, 1024, 1280, 1440, 1920]);
  assert.deepEqual(parseResponsiveArguments(['--target', 'fixture']).profileNames, STANDARD_PROFILES);
  assert.deepEqual(parseResponsiveArguments(['--target', 'f', '--profiles', 'phone-360,desktop-1280']).profileNames, ['phone-360', 'desktop-1280']);
  assert.ok(parseResponsiveArguments(['--target', 'f', '--profiles', 'all']).profileNames.length === Object.keys(PROFILES).length);
  for (const bad of [[], ['--target', 'f', '--profiles', 'nope'], ['--target', 'f', '--profiles', 'phone-360,phone-360'], ['--target', 'f', '--profiles', ''], ['--target', 'F'], ['--target', 'f', '--path', '//x'],
    ['--target', 'f', '--browser', 'ie'], ['--target', 'f', '--name', '../x'], ['--target', 'f', '--timeout-ms', '1'], ['--target', 'f', '--x', '1'], ['--target', 'f', '--path']])
    assert.throws(() => parseResponsiveArguments(bad), Error, JSON.stringify(bad));
});

// ---- WebSocket handshakes are not seen by context.route(): the audit must refuse and record them like capture.mjs does
test('responsive audit refuses an undeclared WebSocket, records it without its query string and exits blocked', async t => {
  const { default: fsm } = await import('node:fs'), { default: osm } = await import('node:os'), { default: pathm } = await import('node:path'), { default: netm } = await import('node:net');
  const { audit } = await import('../browser/responsive.mjs');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'resp-ws-'));
  const sockets = pathm.join(dir, 's'), out = pathm.join(dir, 'o'); fsm.mkdirSync(sockets); fsm.mkdirSync(out);
  const server = netm.createServer(c => c.end()).listen(pathm.join(sockets, 'fixture.sock'));
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.close(); fsm.rmSync(dir, { recursive: true, force: true }); });
  const fake = pathm.join(dir, 'fake.mjs');
  fsm.writeFileSync(fake, `let wsFn;
globalThis.__ws = [];
const page = { on() {}, async goto() { for (const u of ['ws://127.0.0.1:43210/undeclared?token=VALUE', 'wss://example.invalid/live']) await wsFn({ url: () => u, connectToServer: () => globalThis.__ws.push('connect ' + u), close: () => globalThis.__ws.push('close ' + u) }); return { status: () => 200 }; },
  async evaluate() { return []; }, async screenshot() { return Buffer.from('PNGDATA'); } };
const context = { route: async () => {}, routeWebSocket: async (_p, f) => { wsFn = f; }, newPage: async () => page, close: async () => {} };
export const chromium = { launch: async () => ({ newContext: async () => context, close: async () => {} }) };
`);
  const o = parseResponsiveArguments(['--target', 'fixture', '--profiles', 'phone', '--out', out, '--socket-dir', sockets, '--playwright', fake]);
  const r = await audit(o);
  assert.equal(r.exit, 12);
  assert.deepEqual(r.summary.blockedRequests, ['ws://127.0.0.1:43210/undeclared', 'wss://example.invalid/live']);
  assert.ok(!JSON.stringify(r.summary).includes('VALUE'));
});

// ---- review round on PR #29: page text must not reach artifacts; a blocked destination outranks a navigation failure
async function auditWithFake(t, pageSource) {
  const { default: fsm } = await import('node:fs'), { default: osm } = await import('node:os'), { default: pathm } = await import('node:path'), { default: netm } = await import('node:net');
  const { audit } = await import('../browser/responsive.mjs');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'resp-rv-'));
  const sockets = pathm.join(dir, 's'), out = pathm.join(dir, 'o'); fsm.mkdirSync(sockets); fsm.mkdirSync(out);
  const server = netm.createServer(c => c.end()).listen(pathm.join(sockets, 'fixture.sock'));
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.close(); fsm.rmSync(dir, { recursive: true, force: true }); });
  const fake = pathm.join(dir, 'fake.mjs');
  fsm.writeFileSync(fake, `let wsFn;
const page = { on() {}, ${pageSource}, async screenshot() { return Buffer.from('PNGDATA'); } };
const context = { route: async () => {}, routeWebSocket: async (_p, f) => { wsFn = f; }, newPage: async () => page, close: async () => {} };
export const chromium = { launch: async () => ({ newContext: async () => context, close: async () => {} }) };
`);
  const o = parseResponsiveArguments(['--target', 'fixture', '--profiles', 'phone', '--out', out, '--socket-dir', sockets, '--playwright', fake]);
  const r = await audit(o);
  const files = fsm.readdirSync(out).map(f => fsm.readFileSync(pathm.join(out, f)).toString('latin1')).join('\n');
  return { r, files };
}

test('a navigation timeout together with an undeclared request still exits blocked (12)', async t => {
  const { r } = await auditWithFake(t, `async goto() { await wsFn({ url: () => 'wss://example.invalid/x', connectToServer() {}, close() {} }); throw new Error('Timeout 5000ms exceeded'); }, async evaluate() { return []; }`);
  assert.equal(r.exit, 12);
  assert.deepEqual(r.summary.blockedRequests, ['wss://example.invalid/x']);
});

test('page text, input values and aria-labels never reach the layout JSON, summary or report', async t => {
  const { r, files } = await auditWithFake(t, `async goto() { return { status: () => 200 }; }, async evaluate() { return [{ check: 'clipped', severity: 'fail', element: 'div.x', text: 'CANARY_SECRET', width: 5 }]; }`);
  assert.equal(r.exit, 15);
  assert.equal(r.summary.failures[0].check, 'clipped');
  assert.ok(!JSON.stringify(r.summary).includes('CANARY_SECRET') && !renderReport(r.summary).includes('CANARY_SECRET') && !files.includes('CANARY_SECRET'));
});

test('layoutCheck itself never reads page text, values or aria-labels', async () => {
  const { layoutCheck } = await import('../browser/layout-check.mjs');
  assert.ok(!/innerText|textContent|\.value\b|aria-label/.test(layoutCheck.toString()));
});

test('layoutCheck labels elements structurally: page-controlled ids, classes and tag names never reach a finding', async () => {
  const { layoutCheck } = await import('../browser/layout-check.mjs');
  const canary = 'CANARY-pw-9Q2x';
  const mk = (tagName, extra = {}) => ({ nodeType: 1, tagName, children: [], parentElement: null, id: canary, className: `${canary} other`, hasAttribute: () => false, scrollWidth: 0, clientWidth: 0, getBoundingClientRect: () => ({ width: 1, height: 1, left: 0, right: 1, top: 0, bottom: 1 }), ...extra });
  const body = mk('BODY'), main = mk('MAIN', { parentElement: body }), widget = mk('X-' + canary.toUpperCase(), { parentElement: main });
  body.children = [main]; main.children = [mk('DIV', { parentElement: main }), widget];
  widget.getBoundingClientRect = () => ({ width: 50, height: 20, left: 90, right: 140, top: 0, bottom: 20 });
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, scrollTo: globalThis.scrollTo, innerHeight: globalThis.innerHeight };
  globalThis.scrollTo = () => {}; globalThis.innerHeight = 600;
  globalThis.document = { documentElement: { clientWidth: 100, scrollWidth: 100 }, body: { ...body, querySelectorAll: () => [widget] }, querySelectorAll: () => [], elementFromPoint: () => null };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1', overflowX: 'visible', position: 'static' });
  try {
    const findings = layoutCheck({ touch: false });
    assert.ok(findings.length >= 1);
    for (const f of findings) assert.match(f.element, /^[a-z0-9>\[\]]+$/);
    assert.equal(findings[0].element, 'body>main[0]>other[1]');
    assert.ok(!JSON.stringify(findings).toUpperCase().includes(canary.toUpperCase()));
  } finally { Object.assign(globalThis, saved); if (saved.document === undefined) delete globalThis.document; if (saved.scrollTo === undefined) delete globalThis.scrollTo; }
});
