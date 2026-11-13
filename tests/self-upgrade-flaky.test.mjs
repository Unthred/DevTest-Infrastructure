// Issue #1322: realDeps turns the installer's stdout "flaky tests:" block (exit 0) into a flaky result with the test names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realDeps } from '../supervisor/upgrade.mjs';

const FROM = 'a'.repeat(40), TO = 'b'.repeat(40);

test('issue #1322: realDeps reads the installer\'s "flaky tests:" stdout on exit 0 and returns it with ok: true', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-fl-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'versions', FROM), { recursive: true }); fs.symlinkSync(`versions/${FROM}`, path.join(dir, 'current'));
  const mk = out => realDeps({ root: dir, config: { repo_path: dir }, gh: {}, listActive: async () => [], verdictFor: () => null, run: (cmd, args) => {
    if (cmd === 'git' && args.includes('show')) return { status: 0, stdout: '#!/bin/bash\n', stderr: '' };
    if (cmd === 'git') return { status: 0, stdout: 'https://example.invalid/r.git\n', stderr: '' };
    return { status: 0, stdout: out, stderr: '' }; } });
  const r = await mk('flaky tests: alpha works; beta works\n--- excerpt ---\nnot ok 2 - alpha works\n').preChecks(TO);
  assert.equal(r.ok, true); assert.deepEqual(r.flaky.tests, ['alpha works', 'beta works']); assert.match(r.flaky.excerpt, /not ok 2/);
  assert.deepEqual(await mk('').preChecks(TO), { ok: true });
});
