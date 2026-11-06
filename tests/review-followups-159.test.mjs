// Issue #159: redaction rules, resizeRect guards, the dotnet filter, local-date Codex scan, early-window projection.
// Secret-shaped fixtures are assembled at run time so no scanner sees a literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../supervisor/redact.mjs';
import { scrub } from '../supervisor/suphealth.mjs';
import { resizeRect } from '../supervisor/dashui/grid.mjs';
import { buildCommand, DotnetCommandError } from '../dotnet/commands.mjs';
import { assessAgent, HOUR } from '../supervisor/budget.mjs';
import { codexAllowanceProbe } from '../supervisor/allowance.mjs';

const j = (...p) => p.join('');
const body = 'Zq8xLm2Vn4Rt7Yp1';

test('redact removes key=value, quoted JSON, userinfo URLs, JWTs, AWS ids and vault tokens', () => {
  const cases = [
    [j('pass', 'word=', body), body],
    [j('API_', 'KEY: ', body), body],
    [j('{"to', 'ken": "', body, '"}'), body],
    [j('https://bob:', body, '@example.org/x'), body],
    [j('ey', 'JhbGciOi.', 'eyJzdWIiOi.', 'abcDEF123'), 'eyJzdWIiOi'],
    [j('AK', 'IA', 'ABCDEFGHIJKLMNOP'), 'ABCDEFGHIJKLMNOP'],
    [j('hv', 's.', body), body],
  ];
  for (const [input, leaked] of cases) assert.ok(!redact(`log: ${input} end`, 500).includes(leaked), input.slice(0, 8));
});

test('redact leaves ordinary text alone', () => {
  assert.equal(redact('job 12 failed after 3 attempts on branch claude/issue-9', 200), 'job 12 failed after 3 attempts on branch claude/issue-9');
});

test('redact caps the scanned input so a long unbroken string stays fast', () => {
  const t = Date.now();
  const out = redact('a'.repeat(2_000_000) + '@', 300);
  assert.ok(Date.now() - t < 1000);
  assert.ok(out.length <= 300);
});

test('scrub hides IPv4 and IPv6 addresses but not a 5-part dotted number', () => {
  assert.equal(scrub('from 192.168.1.20:8080 ok'), 'from [ip] ok');
  assert.ok(!scrub('peer 2001:db8::1 up').includes('2001'));
  assert.ok(!scrub('peer fe80::1ff:fe23:4567:890a up').includes('fe80'));
  assert.equal(scrub('version 1.2.3.4.5 built'), 'version 1.2.3.4.5 built');
});

test('resizeRect ignores a NaN delta', () => {
  const r = { x: 2, y: 2, w: 6, h: 8 };
  assert.deepEqual(resizeRect(r, 'e', NaN, 0, 24), r);
  assert.deepEqual(resizeRect(r, 'se', Infinity, NaN, 24), r);
});

test('dotnet test filter may not start with a dash', () => {
  const base = { sdk: '8', operation: 'test', project: '/src/T.csproj' };
  assert.throws(() => buildCommand({ ...base, filter: '--logger' }), DotnetCommandError);
  assert.throws(() => buildCommand({ ...base, filter: '-x' }), DotnetCommandError);
  assert.ok(buildCommand({ ...base, filter: 'Category!=Slow' }).command.includes('Category!=Slow'));
});

test('early-window projection does not latch on one hour of data', () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const allowance = { windows: [{ name: 'weekly', windowMinutes: 10080, utilization: 0.02, resetsAt: now + 167 * HOUR }], observedAt: now };
  const a = assessAgent({ allowance, now });
  assert.ok(a.projected < 1, `projected ${a.projected}`);
  assert.notEqual(a.mode, 'reviews_only');
});

test('codexAllowanceProbe looks in the local-date day directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex159-'));
  const now = Date.now(), d = new Date(now);
  const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(now / 1000) + 3600 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 86400 } } } });
  fs.writeFileSync(path.join(dir, 'rollout-2026-test-abc.jsonl'), line + '\n');
  const r = codexAllowanceProbe({ home, now });
  assert.ok(r && r.windows.length > 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('redact hides a short bearer token after an Authorization key', () => {
  const tok = ['abc', 'def', 'ghi', 'jkl'].join('');
  for (const input of [`Authorization: Bearer ${tok}`, `authorization=Bearer ${tok}`, `Authorization: bearer ${tok}`]) {
    const out = redact(input, 500);
    assert.ok(!out.includes(tok), input.slice(0, 14));
    assert.ok(!out.includes('Bearer abc'), input.slice(0, 14));
  }
});

test('redact hides a short Basic, Token or Digest credential after an Authorization key', () => {
  const tok = ['dXNl', 'cjpw', 'YXNz'].join('');
  for (const scheme of ['Basic', 'basic', 'Token', 'Digest', 'BASIC']) {
    for (const input of [`Authorization: ${scheme} ${tok}`, `authorization=${scheme} ${tok}`, `Proxy-Authorization: ${scheme} ${tok}`]) {
      const out = redact(input, 500);
      assert.ok(!out.includes(tok), input);
    }
  }
  assert.equal(redact(`{"authorization": "Basic ${tok}"}`, 500).includes(tok), false);
});

test('redact leaves ordinary text near scheme words alone', () => {
  assert.equal(redact('basic usage of the tool', 100), 'basic usage of the tool');
  assert.equal(redact('Authorization: [secret]', 100), 'Authorization: [secret]');
});
