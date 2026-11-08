import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shortMkdtemp } from './_short-tmp.mjs';
import { targetSocketPath } from '../docker/runner.mjs';

// Regression: the pre-install check sets TMPDIR to a long per-job folder (issue #1007); socket paths built from it overflowed 107 bytes.
const withTmpdir = (value, fn) => { const old = process.env.TMPDIR; process.env.TMPDIR = value; try { return fn(); } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; } };

test('a long TMPDIR still gives a root whose target socket path fits a Unix socket', () => {
  const long = '/mnt/cache/ai-supervisor/tmp/job-fc55cdac2b06b81e846d170b697d323d/install-4312c5c-123456-1794113670746';
  withTmpdir(long, () => {
    const dir = shortMkdtemp('dtc-');
    try { assert.ok(Buffer.byteLength(targetSocketPath(`${dir}/s`, 'a'.repeat(16), 'fixture')) <= 107); assert.ok(!dir.startsWith(long)); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test('a short TMPDIR is used as it is', () => {
  const dir = fs.mkdtempSync('/tmp/dts-');
  try { withTmpdir(dir, () => { const d = shortMkdtemp('x-'); try { assert.ok(d.startsWith(dir)); } finally { fs.rmSync(d, { recursive: true, force: true }); } }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
