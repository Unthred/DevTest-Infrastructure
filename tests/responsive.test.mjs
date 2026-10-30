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
