// Accessibility scan (issue #455): the pure report helpers and the argument parser of the in-container wrapper, plus the lock pin.
// The real scan against a broken and a corrected page runs in tests/a11y-smoke.mjs (Tower, real Docker).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AXE_LIMIT, AXE_TAGS, renderReport, summarise } from '../browser/a11y-lib.mjs';
import { parseA11yArguments } from '../browser/a11y.mjs';
import { PROFILES } from '../browser/capture.mjs';

const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const v = (id, impact, n = 1) => ({ id, impact, help: `${id} help`, helpUrl: 'https://example.invalid/x', tags: ['wcag2a'], nodes: ['body[0]>img[1]'], nodeCount: n });
const result = (name, axe) => ({ name, profile: PROFILES[name], axe });
const axe = (violations, incomplete = []) => ({ axeVersion: '4.14.0', violations, incomplete });

test('axe-core is pinned by exact version and sha512 integrity, like playwright-core', () => {
  const pkg = lock.packages['axe-core'];
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/); assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.ok(pkg.resolved_on && pkg.source);
  const tgz = new URL(`../browser/vendor/axe-core-${pkg.version}.tgz`, import.meta.url);
  if (fs.existsSync(tgz)) assert.equal(`sha512-${crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64')}`, pkg.integrity, 'a vendored tarball matches the lock');
});

test('the scan uses the WCAG 2.1 A and AA tags', () => { assert.deepEqual(AXE_TAGS, ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']); });

test('violations fail, incomplete results are reported but do not fail, and the report always says automated checks are not enough', () => {
  const bad = summarise({ target: 'page', path: '/p.html?token=zzz', browser: 'chromium', name: 'a11y', results: [result('phone-390', axe([v('image-alt', 'critical', 2), v('label', 'serious')], [v('color-contrast', 'serious', 4)]))] });
  assert.equal(bad.ok, false); assert.equal(bad.violation_nodes, 3); assert.equal(bad.incomplete_nodes, 4); assert.equal(bad.path, '/p.html', 'no query string in the report');
  assert.deepEqual(bad.profiles[0].violations.map((x) => x.id), ['image-alt', 'label'], 'most severe first');
  const text = renderReport(bad);
  assert.match(text, /VIOLATIONS FOUND/); assert.match(text, /Incomplete: needs a person/); assert.ok(text.includes(AXE_LIMIT)); assert.match(text, /image-alt/);
  const good = summarise({ target: 'page', path: '/p.html', browser: 'chromium', name: 'a11y', results: [result('phone-390', axe([], [v('color-contrast', 'serious')]))] });
  assert.equal(good.ok, true, 'incomplete alone does not fail');
  assert.match(renderReport(good), /NO AUTOMATED VIOLATIONS/); assert.ok(renderReport(good).includes(AXE_LIMIT), 'a pass still carries the limitation');
  assert.doesNotMatch(renderReport(good), /accessible\.\s*$/m);
});

test('a profile that did not load is never a pass, and nothing page-controlled is in the report', () => {
  const none = summarise({ target: 'page', path: '/', browser: 'chromium', name: 'a11y', results: [result('phone-390', null)] });
  assert.equal(none.ok, false); assert.match(renderReport(none), /Not scanned/);
  assert.equal(summarise({ target: 'page', path: '/', browser: 'chromium', name: 'a11y', results: [] }).ok, false, 'no profile at all is not a pass');
  const json = JSON.stringify(summarise({ target: 'page', path: '/', browser: 'chromium', name: 'a11y', results: [result('phone-390', axe([v('image-alt', 'critical')]))] }));
  assert.doesNotMatch(json, /"html"|failureSummary/);
});

test('wrapper arguments: defaults, profile lists, and refusals', () => {
  const ok = parseA11yArguments(['--target', 'page', '--path', '/a11y/fixed.html']);
  assert.deepEqual(ok.profileNames, ['desktop-1440', 'phone-390']); assert.equal(ok.axe, '/cache/axe-core/package/axe.min.js');
  assert.equal(parseA11yArguments(['--target', 'page', '--profiles', 'standard']).profileNames.length, 8);
  for (const bad of [[], ['--target', 'page', '--profiles', 'nope'], ['--target', 'page', '--profiles', 'phone-390,phone-390'], ['--target', 'page', '--path', '//evil'], ['--target', 'page', '--name', '../x'], ['--target', 'page', '--bogus', '1'], ['--target', 'page', '--path']])
    assert.throws(() => parseA11yArguments(bad), Error, JSON.stringify(bad));
});
