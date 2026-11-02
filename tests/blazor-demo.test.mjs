import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDemoArgs, runDemo } from '../tools/blazor-demo.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = 'a'.repeat(64);
let n = 0;
const okResult = (cmd, extra = {}) => { n += 1; return { run_id: `r${n}`, status: 'passed', workspace: `/ev/${n}`, cleanup: 'complete', artifacts: cmd === 'build' || cmd === 'test' ? [] : Array.from({ length: cmd === 'responsive' ? 8 : 1 }, (_, i) => ({ kind: 'screenshot', path: `artifacts/s${i}.png`, sha256: sha, bytes: 5000 })), ...extra }; };
function fake({ testOverride = null, failBuild = false, passTests = false, broken = 1, netRefused = true, shotCode = 0 } = {}) {
  return (args) => {
    const key = args[1];
    if (key === 'build') return failBuild ? { code: 1, result: { status: 'failed', workspace: '/ev/b', cleanup: 'complete' } } : { code: 0, result: okResult('build') };
    if (key === 'test' && testOverride) return testOverride;
    if (key === 'test') return passTests ? { code: 0, result: okResult('test') } : { code: 1, result: { status: 'failed', message: 'restore failed', data: { summary: { tests: null } }, workspace: '/ev/t', cleanup: 'complete' } };
    if (key === 'responsive') return { code: 0, result: okResult('responsive') };
    if (args[2] === 'http://127.0.0.1:5000/' || args.includes('http://127.0.0.1:5000/')) return netRefused ? { code: 4, result: { status: 'refused' } } : { code: 0, result: okResult('screenshot') };
    if (args.some((a) => a.endsWith('broken.html'))) return broken ? { code: 1, result: { status: 'failed' } } : { code: 0, result: okResult('screenshot') };
    return shotCode ? { code: shotCode, result: { status: 'error' } } : { code: 0, result: okResult('screenshot') };
  };
}
const opts = { projectRoot: repo, sdk: '8', requireTests: false, dockerCheck: true };
const state = () => ({ containers: 0, loops: 3 });
const exists = () => true;

test('fixture site exists and shows the counter', () => {
  const html = fs.readFileSync(path.join(repo, 'tests/fixtures/blazor-demo/wwwroot/index.html'), 'utf8');
  assert.match(html, /id="inc"/);
});
test('argument parsing: defaults, values and refusals', () => {
  assert.equal(parseDemoArgs([]).sdk, '8');
  assert.equal(parseDemoArgs(['--sdk', '10', '--require-tests']).requireTests, true);
  assert.throws(() => parseDemoArgs(['--sdk', '7']), /8, 9 or 10/);
  assert.throws(() => parseDemoArgs(['--sdk']), /needs a value/);
  assert.throws(() => parseDemoArgs(['--bogus']), /unknown argument/);
});
test('positive: all steps pass, tests recorded as blocked not passed', () => {
  const out = runDemo(opts, { run: fake(), state, exists });
  assert.equal(out.ok, true);
  const t = out.steps.find((s) => s.name.startsWith('dotnet test'));
  assert.equal(t.result, 'blocked');
  assert.ok(out.artifacts.length >= 10);
});
test('--require-tests makes blocked tests a failure; passing tests satisfy it', () => {
  assert.equal(runDemo({ ...opts, requireTests: true }, { run: fake(), state, exists }).ok, false);
  assert.equal(runDemo({ ...opts, requireTests: true }, { run: fake({ passTests: true }), state, exists }).ok, true);
});
test('negative: build failure fails the demo', () => {
  assert.equal(runDemo(opts, { run: fake({ failBuild: true }), state, exists }).ok, false);
});
test('negative: a broken page that unexpectedly passes fails the demo', () => {
  assert.equal(runDemo(opts, { run: fake({ broken: 0 }), state, exists }).ok, false);
});
test('negative: a network URL that is not refused fails the demo', () => {
  assert.equal(runDemo(opts, { run: fake({ netRefused: false }), state, exists }).ok, false);
});
test('negative: screenshot failure, missing artifact file and leftover container are detected', () => {
  assert.equal(runDemo(opts, { run: fake({ shotCode: 6 }), state, exists }).ok, false);
  assert.equal(runDemo(opts, { run: fake(), state, exists: () => false }).ok, false);
  let calls = 0;
  const leaking = () => ({ containers: calls++ === 0 ? 0 : 1, loops: 3 });
  assert.equal(runDemo(opts, { run: fake(), state: leaking, exists }).ok, false);
});
test('no project paths are embedded in the tool or the reuse guide', () => {
  for (const f of ['tools/blazor-demo.mjs', 'docs/blazor-demo.md']) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.doesNotMatch(text, /Surveyor\/|BuildMonitor\/|\/mnt\/user\/projects\/(Surveyor|BuildMonitor)/i, f);
  }
});
test('negative: only the offline-restore case is blocked; real failures and faults fail the demo', () => {
  const ws = { workspace: '/ev/t', cleanup: 'complete' };
  const cases = {
    'real test failures': { code: 1, result: { status: 'failed', data: { summary: { tests: { total: 3, passed: 0 } } }, ...ws } },
    'infrastructure refusal (4)': { code: 4, result: { status: 'refused', ...ws } },
    'environment fault (3)': { code: 3, result: { status: 'error', ...ws } },
    'cleanup fault (7)': { code: 7, result: { status: 'failed', data: { summary: { tests: null } }, workspace: '/ev/t', cleanup: 'incomplete' } },
    'blocked shape but cleanup incomplete': { code: 1, result: { status: 'failed', data: { summary: { tests: null } }, workspace: '/ev/t', cleanup: 'incomplete' } },
    'no result at all': { code: 1, result: null }
  };
  for (const [name, testOverride] of Object.entries(cases)) {
    const out = runDemo(opts, { run: fake({ testOverride }), state, exists });
    assert.equal(out.ok, false, name);
    assert.equal(out.steps.find((x) => x.name.startsWith('dotnet test')).result, 'failed', name);
  }
});
