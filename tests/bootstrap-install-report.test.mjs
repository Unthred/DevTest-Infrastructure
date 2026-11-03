// Issue #412: tools/bootstrap-install.sh names the failing test(s) and keeps a bounded excerpt. Real script, real git, a throw-away
// repository made with `git init` (never a linked worktree).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../tools/bootstrap-install.sh');
function fixture(t, testSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootfix-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(path.join(repo, 'tools'), { recursive: true }); fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tools/validate-project.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(repo, 'tests/fix.test.mjs'), testSource);
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

test('issue #412: team status shows the failing test names, the excerpt and "failed twice" for a latched install', async () => {
  const { renderStatus } = await import('../supervisor/teamstatus.mjs');
  const s = { repository: 'o/r', generatedAt: 0, timeZone: 'UTC', notes: [], agents: [], slots: [], hold: null, installed: 'abc1234',
    install: { result: 'blocked', sha: 'def5678', at: null, nextAttemptAt: null, reason: 'tests failed: the broken one', tests: ['the broken one', 'second failure'], excerpt: 'not ok 1 - the broken one\nerror: boom', retried: true },
    next: { plan: [], waiting: [] }, estimates: { items: [], waits: [] }, problems: [], pulls: [], mergedToday: [], allowance: [], schedule: { intervalMinutes: 5, lastTickAt: null } };
  const out = renderStatus(s);
  assert.match(out, /failing tests: the broken one; second failure \(failed twice, each in a fresh copy\)/);
  assert.match(out, /\| not ok 1 - the broken one/); assert.match(out, /\| error: boom/);
});
