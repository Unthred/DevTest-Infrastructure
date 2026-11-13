// Issue #412: tools/bootstrap-install.sh names the failing test(s) and keeps a bounded excerpt. Real script, real git, a throw-away
// repository made with `git init` (never a linked worktree).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../tools/bootstrap-install.sh');
function fixture(t, testSource, extraTests = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootfix-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(path.join(repo, 'tools'), { recursive: true }); fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tools/validate-project.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(repo, 'tests/fix.test.mjs'), testSource);
  for (const [name, source] of Object.entries(extraTests)) fs.writeFileSync(path.join(repo, 'tests', name), source);
  const git = (...a) => { const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture');
  return { repo, sha: git('rev-parse', 'HEAD') };
}
const check = f => spawnSync('bash', [script, 'check', f.repo, f.sha], { encoding: 'utf8', timeout: 60000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && !k.startsWith('LC_') && k !== 'LANG')), LC_ALL: 'C' } });

test('issue #412: a failing test is named in the installer output, with a bounded excerpt', t => {
  const secret = ['gh', 'p_'].join('') + 'b'.repeat(30);
  const f = fixture(t, `import test from 'node:test';
test('suite', async t => { await t.test('fine', () => {}); await t.test('the broken one', () => { throw new Error('boom ${secret}'); }); });
test('second failure', () => { throw new Error('again'); });
test('passes', () => {});
`);
  const r = check(f);
  assert.equal(r.status, 11);
  const lines = r.stderr.split('\n');
  assert.equal(lines[0], 'tests failed: the broken one; second failure');
  assert.equal(lines[1], '--- excerpt ---');
  assert.match(r.stderr, /not ok \d+ - the broken one/); assert.match(r.stderr, /error: .*boom/);
  assert.ok(!/not ok \d+ - suite/.test(r.stderr), 'the parent suite is not reported');
  assert.ok(r.stderr.length <= 3100);
});

test('issue #412: at most five names are listed and the rest are counted', t => {
  const f = fixture(t, `import test from 'node:test';\n${[1, 2, 3, 4, 5, 6, 7].map(n => `test('t${n}', () => { throw new Error('x'); });`).join('\n')}\n`);
  assert.equal(check(f).stderr.split('\n')[0], 'tests failed: t1; t2; t3; t4; t5; and 2 more');
});

test('issue #412: passing tests exit 0 and print nothing', t => {
  const r = check(fixture(t, `import test from 'node:test';\ntest('ok', () => {});\n`));
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
});

// ---- issue #1322: each failed file is repeated alone, in sequence, in the same copy, before the verdict.
// A run counter lives outside the repository (the copy must stay clean), one line per run of a file.
function counterIn(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bootcount-')), 'runs'); t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return { file, runs: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []) };
}
const count = (c, label) => `import cntfs from 'node:fs'; cntfs.appendFileSync(${JSON.stringify(c.file)}, ${JSON.stringify(label)} + '\\n');\n`;

test('issue #1322: a test that fails only while another file runs beside it passes alone: the install continues and the flaky name is reported', t => {
  // Modelled on the 13 Nov 2026 heartbeat test (263 ms gap against a 180 ms limit): a timing test that fails only under load.
  const c = counterIn(t); const busy = path.join(path.dirname(c.file), 'busy');
  const f = fixture(t, `import test from 'node:test';\nimport fs from 'node:fs';\n${count(c, 'victim')}
test('heartbeat gap stays small', async () => { await new Promise(r => setTimeout(r, 700)); if (fs.existsSync(${JSON.stringify(busy)})) throw new Error('gap 263 ms over 180 ms'); });
`, { 'load.test.mjs': `import test from 'node:test';\nimport fs from 'node:fs';
test('the neighbour that loads the host', async () => { fs.writeFileSync(${JSON.stringify(busy)}, ''); await new Promise(r => setTimeout(r, 2000)); fs.rmSync(${JSON.stringify(busy)}); });
` });
  const r = check(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.split('\n')[0], 'flaky tests: heartbeat gap stays small');
  assert.match(r.stdout, /--- excerpt ---/); assert.match(r.stdout, /263 ms/);
  assert.deepEqual(c.runs(), ['victim', 'victim']);   // the whole run, then once alone
});

test('issue #1322: a test that fails alone too is refused with exit 11 naming only the tests that failed alone', t => {
  const c = counterIn(t);
  const f = fixture(t, `import test from 'node:test';\n${count(c, 'broken')}test('always fails', () => { throw new Error('real'); });\n`,
    { 'other.test.mjs': `import test from 'node:test';\ntest('passes', () => {});\n` });
  const r = check(f);
  assert.equal(r.status, 11);
  assert.equal(r.stderr.split('\n')[0], 'tests failed: always fails');
  assert.match(r.stderr, /error: .*real/);
  assert.deepEqual(c.runs(), ['broken', 'broken']);
});

test('issue #1322: only the tests that still fail alone are named when one failed file passes and another does not', t => {
  const c = counterIn(t); const busy = path.join(path.dirname(c.file), 'busy');
  const f = fixture(t, `import test from 'node:test';\ntest('real failure', () => { throw new Error('real'); });\n`, {
    'flaky.test.mjs': `import test from 'node:test';\nimport fs from 'node:fs';
test('load sensitive', async () => { await new Promise(r => setTimeout(r, 700)); if (fs.existsSync(${JSON.stringify(busy)})) throw new Error('slow'); });\n`,
    'load.test.mjs': `import test from 'node:test';\nimport fs from 'node:fs';
test('neighbour', async () => { fs.writeFileSync(${JSON.stringify(busy)}, ''); await new Promise(r => setTimeout(r, 2000)); fs.rmSync(${JSON.stringify(busy)}); });\n` });
  const r = check(f);
  assert.equal(r.status, 11);
  assert.equal(r.stderr.split('\n')[0], 'tests failed: real failure');
  assert.ok(!r.stderr.includes('load sensitive'));
});

test('issue #1322: more than 10 failed files are refused at once, with no repeat', t => {
  const c = counterIn(t);
  const extra = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => [`f${n}.test.mjs`, `import test from 'node:test';\n${count(c, `f${n}`)}test('fail ${n}', () => { throw new Error('x'); });\n`]));
  const f = fixture(t, `import test from 'node:test';\n${count(c, 'f0')}test('fail 0', () => { throw new Error('x'); });\n`, extra);
  const r = check(f);
  assert.equal(r.status, 11);
  assert.match(r.stderr, /^tests failed: /);
  assert.equal(c.runs().length, 11);   // each of the 11 files ran once: nothing was repeated
});

test('issue #1322: exactly 10 failed files are still repeated', t => {
  const c = counterIn(t);
  const extra = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [`f${n}.test.mjs`, `import test from 'node:test';\n${count(c, `f${n}`)}test('fail ${n}', () => { throw new Error('x'); });\n`]));
  const f = fixture(t, `import test from 'node:test';\n${count(c, 'f0')}test('fail 0', () => { throw new Error('x'); });\n`, extra);
  assert.equal(check(f).status, 11);
  assert.equal(c.runs().length, 20);   // 10 in the full run, 10 alone
});

test('issue #1322: with no failure the suite runs once only and the installer prints nothing', t => {
  const c = counterIn(t);
  const r = check(fixture(t, `import test from 'node:test';\n${count(c, 'once')}test('ok', () => {});\n`));
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  assert.deepEqual(c.runs(), ['once']);
});

test('issue #412: team status shows the failing test names, the excerpt and "failed twice" for a latched install', async () => {
  const { renderStatus } = await import('../supervisor/teamstatus.mjs');
  const s = { repository: 'o/r', generatedAt: 0, timeZone: 'UTC', notes: [], agents: [], slots: [], hold: null, installed: 'abc1234',
    install: { result: 'blocked', sha: 'def5678', at: null, nextAttemptAt: null, reason: 'tests failed: the broken one', tests: ['the broken one', 'second failure'], excerpt: 'not ok 1 - the broken one\nerror: boom', retried: true },
    next: { plan: [], waiting: [] }, estimates: { items: [], waits: [] }, problems: [], pulls: [], mergedToday: [], allowance: [], schedule: { intervalMinutes: 5, lastTickAt: null } };
  const out = renderStatus(s);
  assert.match(out, /failing tests: the broken one; second failure \(failed twice, each in a fresh copy\)/);
  assert.match(out, /\| not ok 1 - the broken one/); assert.match(out, /\| error: boom/);
});
