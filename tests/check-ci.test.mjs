// Positive and negative tests for tools/ci/check-ci.mjs (issue #12). Each case works on an independent temporary copy (no Git).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCi } from '../tools/ci/check-ci.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'tools', 'ci', 'check-ci.mjs');
const LOCK = 'docker/images.lock.json';

function fixture(mutate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-ci-'));
  fs.cpSync(repo, dir, { recursive: true, filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)) });
  const api = {
    dir,
    read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
    write: (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); },
    lock: (fn) => { const l = JSON.parse(api.read(LOCK)); fn(l); api.write(LOCK, JSON.stringify(l, null, 2)); }
  };
  mutate(api);
  return api;
}
function run(mutate, opts) {
  const api = fixture(mutate);
  try { return checkCi(api.dir, opts); } finally { fs.rmSync(api.dir, { recursive: true, force: true }); }
}
function expect(mutate, check, part, opts) {
  const f = run(mutate, opts);
  assert.ok(f.some((x) => x.check === check && x.message.includes(part)), `expected [${check}] ${part}; got ${JSON.stringify(f)}`);
}
const wf = (body) => `name: x\non: [push]\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n${body}\n`;

test('the repository itself is clean', () => assert.deepEqual(run(), []));

test('shell: a syntax error and a missing shebang are reported', () => {
  expect((a) => a.write('tools/bad.sh', '#!/usr/bin/env bash\nif then fi (\n'), 'shell', 'tools/bad.sh: syntax error');
  expect((a) => a.write('tools/noshebang.sh', 'echo hi\n'), 'shell', 'missing shebang');
  assert.deepEqual(run((a) => a.write('tools/ok.sh', '#!/usr/bin/env bash\nset -e\necho ok\n')), []);
});

test('workflows: permissions, timeouts, pull_request_target, self-hosted, secrets and Docker are refused', () => {
  const ok = wf('      - uses: actions/checkout@v4\n      - run: echo hi');
  assert.deepEqual(run((a) => a.write('.github/workflows/new.yml', ok)), []);
  expect((a) => a.write('.github/workflows/new.yml', ok.replace('permissions:\n  contents: read\n', '')), 'workflows', 'no top-level "permissions:"');
  expect((a) => a.write('.github/workflows/new.yml', ok.replace('contents: read', 'contents: write')), 'workflows', 'write permission');
  expect((a) => a.write('.github/workflows/new.yml', ok.replace('    timeout-minutes: 5\n', '')), 'workflows', 'timeout-minutes');
  expect((a) => a.write('.github/workflows/new.yml', ok.replace('[push]', '[pull_request_target]')), 'workflows', 'pull_request_target');
  expect((a) => a.write('.github/workflows/new.yml', ok.replace('ubuntu-latest', 'self-hosted')), 'workflows', 'self-hosted');
  expect((a) => a.write('.github/workflows/new.yml', ok + '      - run: echo ${{ secrets.' + 'X }}\n'), 'workflows', 'secret referenced');
  expect((a) => a.write('.github/workflows/new.yml', ok + '      - run: docker ' + 'run --rm img\n'), 'workflows', 'Docker in hosted CI');
});

test('workflows: actions must be SHA-pinned or an official actions/* major tag', () => {
  const body = (u) => wf(`      - uses: ${u}`);
  assert.deepEqual(run((a) => a.write('.github/workflows/new.yml', body('third/party@' + 'a'.repeat(40)))), []);
  expect((a) => a.write('.github/workflows/new.yml', body('third/party@v1')), 'workflows', 'not pinned');
  expect((a) => a.write('.github/workflows/new.yml', body('third/party@main')), 'workflows', 'not pinned');
  expect((a) => a.write('.github/workflows/new.yml', body('actions/checkout@main')), 'workflows', 'not pinned');
});

test('image lock: malformed digest, floating tag, foreign registry, duplicate and bad JSON are refused', () => {
  expect((a) => a.lock((l) => { l.images['dotnet-8'].reference = 'mcr.microsoft.com/dotnet/sdk:8.0'; }), 'image-lock', 'sha256 digest');
  expect((a) => a.lock((l) => { l.images['dotnet-8'].reference = l.images['dotnet-8'].reference.slice(0, -1); }), 'image-lock', 'sha256 digest');
  expect((a) => a.lock((l) => { l.images['dotnet-8'].tag = 'mcr.microsoft.com/dotnet/sdk:latest'; }), 'image-lock', 'non-latest');
  expect((a) => a.lock((l) => { l.images['dotnet-8'].tag = 'mcr.microsoft.com/dotnet/sdk'; }), 'image-lock', 'non-latest');
  expect((a) => a.lock((l) => { l.images['dotnet-8'].tag = 'mcr.microsoft.com/dotnet/runtime:8.0'; }), 'image-lock', 'repository differs');
  expect((a) => a.lock((l) => { const h = 'f'.repeat(64); l.images['dotnet-8'].reference = 'docker.io/library/x@sha256:' + h; l.images['dotnet-8'].tag = 'docker.io/library/x:1'; }), 'image-lock', 'allow-listed official registry');
  expect((a) => a.lock((l) => { l.images['dotnet-9'].reference = l.images['dotnet-8'].reference; l.images['dotnet-9'].tag = l.images['dotnet-8'].tag; }), 'image-lock', 'duplicate');
  expect((a) => a.write(LOCK, '{'), 'image-lock', 'not valid JSON');
  expect((a) => a.lock((l) => { delete l.images['dotnet-8'].tag; }), 'image-lock', 'required');
});

test('image lock: Playwright package version must match the image tag; integrity must be SRI', () => {
  expect((a) => a.lock((l) => { l.packages['playwright-core'].version = '1.0.0'; }), 'image-lock', 'does not match');
  expect((a) => a.lock((l) => { l.packages['playwright-core'].integrity = 'nope'; }), 'image-lock', 'sha512 SRI');
  expect((a) => a.lock((l) => { delete l.packages['playwright-core']; }), 'image-lock', 'both be recorded');
});

test('image lock: a digest used in code but absent from the lock is drift', () => {
  expect((a) => a.write('docker/extra.json', JSON.stringify({ image: 'mcr.microsoft.com/dotnet/sdk@sha256:' + 'c'.repeat(64) })), 'image-lock', 'not in docker/images.lock.json');
});

test('image lock: freshness is checked only when asked, and is deterministic with --now', () => {
  assert.deepEqual(run(undefined, { now: new Date('2030-01-01') }), []);
  expect(undefined, 'image-lock', 'update cadence', { maxAgeDays: 45, now: new Date('2026-12-30') });
  assert.deepEqual(run(undefined, { maxAgeDays: 45, now: new Date('2026-11-02') }), []);
  expect(undefined, 'image-lock', 'in the future', { maxAgeDays: 45, now: new Date('2026-01-01') });
});

test('CLI: exit codes 0, 1 and 2', () => {
  assert.equal(spawnSync('node', [script, repo], { encoding: 'utf8' }).status, 0);
  const bad = fixture((a) => a.write(LOCK, '{'));
  try { assert.equal(spawnSync('node', [script, bad.dir], { encoding: 'utf8' }).status, 1); } finally { fs.rmSync(bad.dir, { recursive: true, force: true }); }
  assert.equal(spawnSync('node', [script, '--bogus'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script, '/nonexistent-dir-xyz'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script, repo, '--max-age-days', '0'], { encoding: 'utf8' }).status, 2);
});
