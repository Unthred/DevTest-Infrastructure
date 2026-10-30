import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createOpenBaoBackend, checkHealth, checkAddress, readTokenFile, safeSecretPath, BrokerError } from '../broker/openbao.mjs';
import { createMockBackend, MOCK_PREFIX } from '../broker/mock.mjs';
import { reduceSession, domainAllowed } from '../broker/session.mjs';
import { materialize, withSecrets, validatePolicy, assertAllowed, decisionApproved } from '../broker/broker.mjs';
import { buildPlanForVerifiedPaths, verifySecrets, RunnerError } from '../docker/runner.mjs';

const policy = JSON.parse(fs.readFileSync(new URL('../broker/policy.example.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const limits = { cpus: 1, memoryMb: 1024, pids: 128, shmMb: 64, timeoutMs: 60000, diskMb: 64, cacheMb: 64 };
const RUN = 'a'.repeat(16);
// Secret-looking values are built at run time so this file never contains one.
const canary = (tag) => ['canary', tag, 'x9Q2', 'm7Lp4Zr8'].join('-');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-broker-'));
const secretRoot = () => { const d = tmp(); fs.chmodSync(d, 0o700); return d; };
const me = { uid: process.getuid(), gid: process.getgid() };

// A real HTTP server that behaves like the OpenBao API surface used here. It records what it received, never stores a token.
async function fakeBao({ caps = ['read'], data = {}, lease = null, token } = {}) {
  const seen = { tokens: [], paths: [], revoked: [], urls: [] };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      seen.tokens.push(req.headers['x-vault-token']); seen.urls.push(req.url);
      if (req.headers['x-vault-token'] !== token) { res.writeHead(403).end('{}'); return; }
      const send = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (req.url === '/v1/sys/capabilities-self') { const p = JSON.parse(body).paths[0]; return send({ data: { [p]: caps } }); }
      if (req.url === '/v1/sys/leases/revoke') { seen.revoked.push(JSON.parse(body).lease_id); return send({}); }
      const m = req.url.match(/^\/v1\/kv\/data\/(.+)$/);
      if (m && data[m[1]]) { seen.paths.push(m[1]); return send({ data: { data: data[m[1]] }, lease_id: lease }); }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { seen, address: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
function tokenFile(value, mode = 0o600) { const f = path.join(tmp(), 'tok'); fs.writeFileSync(f, `${value}\n`, { mode }); fs.chmodSync(f, mode); return f; }

test('OpenBao retrieval: scoped read-only identity, token from an owner-only file, value lands in a 0400 file, nothing in the plan arguments', async () => {
  const token = canary('token'), password = canary('password');
  const bao = await fakeBao({ token, data: { 'devtest/browser/fixture-login': { username: 'tester', password } } });
  const root = secretRoot();
  try {
    const backend = createOpenBaoBackend({ address: bao.address, tokenFile: tokenFile(token) });
    const handle = await materialize({ policy, names: ['fixture-login'], backend, runId: RUN, root, ...me });
    const file = path.join(root, RUN, 'fixture-login');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { username: 'tester', password });
    assert.equal(fs.statSync(file).mode & 0o777, 0o400);
    assert.equal(fs.statSync(path.join(root, RUN)).mode & 0o777, 0o700);
    assert.ok(bao.seen.tokens.every(t => t === token), 'the token went only in the header');
    assert.ok(bao.seen.urls.every(u => !u.includes(token) && !u.includes(password)), 'never in a URL');
    assert.equal(JSON.stringify(handle).includes(password), false, 'a handle serialises without values');
    const plan = buildPlanForVerifiedPaths({ runId: RUN, image: 'playwright', command: ['node', 'x'], secrets: ['fixture-login'] }, { lock, uid: 99, gid: 100, limits, secretRoot: '/dev/shm/devtest-secrets' }, '/mnt/user/projects/p', '/mnt/cache/appdata/x');
    assert.ok(plan.args.includes(`type=bind,src=/dev/shm/devtest-secrets/${RUN}/fixture-login,dst=/secrets/fixture-login,readonly`));
    assert.equal(plan.args.join('\0').includes(password), false);
    assert.equal(plan.args.some(a => a === '-e' || a === '--env' || a.startsWith('--env')), false, 'no environment delivery');
    await handle.cleanup();
  } finally { bao.close(); }
});

test('cleanup overwrites, deletes and revokes leases; a second cleanup is harmless; revocation failure is reported without values', async () => {
  const token = canary('token'), password = canary('password');
  const bao = await fakeBao({ token, lease: 'kv/lease/abc', data: { 'devtest/browser/fixture-login': { username: 'u', password } } });
  const root = secretRoot();
  try {
    const backend = createOpenBaoBackend({ address: bao.address, tokenFile: tokenFile(token) });
    const handle = await materialize({ policy, names: ['fixture-login'], backend, runId: RUN, root, ...me });
    const result = await handle.cleanup();
    assert.deepEqual([result.filesRemoved, result.leasesRevoked, result.errors.length], [1, 1, 0]);
    assert.deepEqual(bao.seen.revoked, ['kv/lease/abc']);
    assert.equal(fs.existsSync(path.join(root, RUN)), false);
    assert.equal(handle.cleaned, true);
    assert.equal((await handle.cleanup()).errors.length, 0);
    const failing = { ...backend, revoke: async () => { throw new Error(`boom ${password}`); } };
    const h2 = await materialize({ policy, names: ['fixture-login'], backend: { ...failing, read: backend.read, assertReadOnly: backend.assertReadOnly, kind: 'openbao' }, runId: 'b'.repeat(16), root, ...me });
    const r2 = await h2.cleanup();
    assert.equal(r2.errors.length, 1);
    assert.equal(JSON.stringify(r2).includes(password), false);
    assert.equal(h2.cleaned, false);
  } finally { bao.close(); }
});

test('negative: a wrong token, a writable identity, a missing secret, and a world-readable token file are all refused with nothing left on disk', async () => {
  const token = canary('token'); const root = secretRoot();
  const data = { 'devtest/browser/fixture-login': { username: 'u', password: canary('pw') } };
  const run = async (opts, file = tokenFile(token)) => {
    const bao = await fakeBao({ token, data, ...opts });
    try { return await materialize({ policy, names: ['fixture-login'], backend: createOpenBaoBackend({ address: bao.address, tokenFile: file }), runId: RUN, root, ...me }); }
    finally { bao.close(); }
  };
  await assert.rejects(run({}, tokenFile(canary('wrong'))), /refused the identity/);
  for (const caps of [['read', 'update'], ['read', 'delete'], ['read', 'create'], ['root'], ['read', 'sudo']]) await assert.rejects(run({ caps }), /can modify this path/, JSON.stringify(caps));
  await assert.rejects(run({ caps: ['list'] }), /cannot read/);
  await assert.rejects(run({ data: {} }), /not found/);
  await assert.rejects(run({}, tokenFile(token, 0o644)), /mode 0600/);
  await assert.rejects(run({ data: { 'devtest/browser/fixture-login': { username: 'u' } } }), /fields are missing/);
  assert.deepEqual(fs.readdirSync(root), [], 'a failed run leaves no secret directory');
});

test('negative: undeclared names, bad addresses, redirects, unsafe paths and unsafe token files', async () => {
  assert.throws(() => assertAllowed(policy, 'nope'), /not declared/);
  assert.throws(() => validatePolicy({ schema_version: 1, secrets: { Bad: {} } }), /invalid secret name/);
  assert.throws(() => validatePolicy({ schema_version: 1, secrets: { ok: { path: 'a/../b', kind: 'credential', domains: ['x.test'], maxTtlSeconds: 100 } } }), /invalid path/);
  assert.throws(() => validatePolicy({ schema_version: 1, secrets: { ok: { path: 'a/b', kind: 'credential', domains: [], maxTtlSeconds: 100 } } }), /domain allow-list/);
  assert.throws(() => validatePolicy({ schema_version: 1, secrets: { ok: { path: 'a/b', kind: 'credential', domains: ['x.test'], maxTtlSeconds: 999999 } } }), /maxTtlSeconds/);
  for (const bad of ['http://bao.example.com:8200', 'ftp://127.0.0.1', 'http://u:p@127.0.0.1:8200', 'http://127.0.0.1:8200/x?y=1', 'nonsense']) assert.throws(() => checkAddress(bad), BrokerError, bad);
  assert.equal(checkAddress('https://bao.example.com:8200'), 'https://bao.example.com:8200');
  for (const p of ['../x', 'a//b', '/abs', 'a/b c', 'a/' + 'b'.repeat(70)]) assert.equal(safeSecretPath(p), false, p);
  const d = tmp(); const real = path.join(d, 'real'); fs.writeFileSync(real, 'tok\n', { mode: 0o600 }); fs.symlinkSync(real, path.join(d, 'link'));
  assert.throws(() => readTokenFile(path.join(d, 'link')), /regular file/);
  assert.throws(() => readTokenFile(path.join(d, 'missing')), /missing/);
  fs.writeFileSync(path.join(d, 'two'), 'a b\n', { mode: 0o600 });
  assert.throws(() => readTokenFile(path.join(d, 'two')), /single token/);
  // A redirect must never carry the token to another host.
  const target = http.createServer((req, res) => { target.seenToken = req.headers['x-vault-token']; res.writeHead(200).end('{}'); });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const hop = http.createServer((req, res) => res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/` }).end());
  await new Promise(r => hop.listen(0, '127.0.0.1', r));
  try {
    const backend = createOpenBaoBackend({ address: `http://127.0.0.1:${hop.address().port}`, tokenFile: tokenFile(canary('tok')) });
    await assert.rejects(backend.read('devtest/browser/fixture-login'), /unreachable/);
    assert.equal(target.seenToken, undefined);
  } finally { hop.close(); target.close(); }
});

test('live Home Assistant login is refused until a dedicated devtest- identity is confirmed by a recorded decision', async () => {
  const backend = createMockBackend(); const root = secretRoot();
  await assert.rejects(materialize({ policy, names: ['ha-test-login'], backend, runId: RUN, root, ...me }), /production login is refused/);
  const half = structuredClone(policy); half.productionIdentity = { confirmed: true, decision: null };
  await assert.rejects(materialize({ policy: half, names: ['ha-test-login'], backend, runId: RUN, root, ...me }), /refused/);
  const wrongId = structuredClone(policy); wrongId.productionIdentity = { confirmed: true, decision: 'D-021' }; wrongId.secrets['ha-test-login'].identity = 'admin';
  await assert.rejects(materialize({ policy: wrongId, names: ['ha-test-login'], backend, runId: RUN, root, ...me }), /refused/);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(policy.productionIdentity.confirmed, false, 'the shipped example never confirms a production identity');
  const ok = structuredClone(policy); ok.productionIdentity = { confirmed: true, decision: 'D-020' };
  assert.doesNotThrow(() => assertAllowed(ok, 'ha-test-login', REGISTER));
});

// PR #41 review: a syntactically valid decision id is not enough. It must be homeowner-approved in the register.
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: agent-proposal\n';
test('production login needs a homeowner-approved decision in the register, not any valid-looking id', async () => {
  const mk = (decision) => { const p = structuredClone(policy); p.productionIdentity = { confirmed: true, decision }; return p; };
  const approved = REGISTER.replace('D-021 — y\n- Status: agent-proposal', 'D-021 — y\n- Status: homeowner-approved');
  assert.equal(decisionApproved(REGISTER, 'D-020'), true);
  assert.equal(decisionApproved(REGISTER, 'D-021'), false, 'an agent proposal');
  assert.equal(decisionApproved(REGISTER, 'D-999'), false, 'not in the register');
  assert.equal(decisionApproved('', 'D-020'), false); assert.equal(decisionApproved(undefined, 'D-020'), false); assert.equal(decisionApproved(REGISTER, 'D-02'), false);
  for (const decision of ['D-999', 'D-021']) assert.throws(() => assertAllowed(mk(decision), 'ha-test-login', REGISTER), /not a homeowner-approved decision/, decision);
  assert.throws(() => assertAllowed(mk('D-020'), 'ha-test-login', ''), /not a homeowner-approved decision/, 'an unreadable register refuses');
  assert.doesNotThrow(() => assertAllowed(mk('D-020'), 'ha-test-login', REGISTER));
  assert.doesNotThrow(() => assertAllowed(mk('D-021'), 'ha-test-login', approved));
  const root = secretRoot(), backend = createMockBackend();
  await assert.rejects(materialize({ policy: mk('D-999'), names: ['ha-test-login'], backend, runId: RUN, root, decisions: REGISTER, ...me }), /not a homeowner-approved/);
  assert.deepEqual(fs.readdirSync(root), []);
  // the shipped register: D-021 is still an agent proposal, so it cannot unlock production
  assert.throws(() => assertAllowed(mk('D-021'), 'ha-test-login'), /not a homeowner-approved decision/);
});

test('withSecrets: a leak or an incomplete cleanup is reported even when the subject also fails', async () => {
  const root = secretRoot(), out = tmp();
  const value = canary('pw2');
  const mkBackend = (revoke) => ({ kind: 'openbao', assertReadOnly: async () => {}, read: async () => ({ values: { username: 'u', password: value }, leaseId: 'lease-1' }), revoke });
  const base = { policy, names: ['fixture-login'], root, ...me };
  await assert.rejects(withSecrets({ ...base, backend: mkBackend(async () => {}), runId: '1'.repeat(16) }, async () => { fs.writeFileSync(path.join(out, 'copied.txt'), value); throw new Error(`subject failure ${value}`); }, { outputRoots: [out] }),
    e => e.exitCode === 8 && /secret value was found/.test(e.message) && /subject also failed \(Error\)/.test(e.message) && !e.message.includes(value) && e.subjectFailed === true);
  assert.equal(fs.existsSync(path.join(root, '1'.repeat(16))), false);
  await assert.rejects(withSecrets({ ...base, backend: mkBackend(async () => { throw new Error(`revoke boom ${value}`); }), runId: '2'.repeat(16) }, async () => { throw new Error('subject failure'); }),
    e => e.exitCode === 7 && /cleanup was incomplete/.test(e.message) && /subject also failed/.test(e.message) && !e.message.includes(value));
  await assert.rejects(withSecrets({ ...base, backend: mkBackend(async () => { throw new Error('boom'); }), runId: '3'.repeat(16) }, async () => { fs.writeFileSync(path.join(out, 'again.txt'), value); throw new Error('x'); }, { outputRoots: [out] }),
    e => e.exitCode === 8 && /secret value was found/.test(e.message) && /cleanup was incomplete/.test(e.message));
  const clean = tmp();
  await assert.rejects(withSecrets({ ...base, backend: mkBackend(async () => {}), runId: '4'.repeat(16) }, async () => { throw new Error('plain subject failure'); }, { outputRoots: [clean] }), /plain subject failure/);
});

test('dry-run mock backend: documented, random, labelled, valid nowhere, and it needs no OpenBao or credential', async () => {
  const root = secretRoot(); const backend = createMockBackend();
  const h = await materialize({ policy, names: ['fixture-login'], backend, runId: RUN, root, ...me });
  assert.equal(h.dryRun, true);
  const a = JSON.parse(fs.readFileSync(path.join(root, RUN, 'fixture-login'), 'utf8'));
  assert.ok(Object.values(a).every(v => v.startsWith(MOCK_PREFIX)));
  await h.cleanup();
  const h2 = await materialize({ policy, names: ['fixture-login'], backend, runId: RUN, root, ...me });
  assert.notDeepEqual(JSON.parse(fs.readFileSync(path.join(root, RUN, 'fixture-login'), 'utf8')), a, 'fresh values every call');
  await h2.cleanup();
});

test('health check works without credentials and reports an unreachable or sealed server', async () => {
  const sealed = http.createServer((q, r) => r.writeHead(200).end(JSON.stringify({ initialized: true, sealed: true, version: '2.6.1' })));
  await new Promise(r => sealed.listen(0, '127.0.0.1', r));
  try {
    assert.deepEqual(await checkHealth({ address: `http://127.0.0.1:${sealed.address().port}` }), { reachable: true, initialized: true, sealed: true, version: '2.6.1' });
  } finally { sealed.close(); }
  assert.equal((await checkHealth({ address: 'http://127.0.0.1:1', timeoutMs: 500 })).reachable, false);
});

test('sessions: expiry, domain allow-list and TTL ceiling; session cookies, expired cookies and foreign domains are dropped', () => {
  const now = Date.UTC(2026, 9, 30) , sec = now / 1000;
  const ck = (domain, expires, value = canary('cookie')) => ({ name: 'sid', value, domain, path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' });
  const state = { cookies: [ck('fixture.test', sec + 600), ck('.fixture.test', sec + 999999), ck('evil.test', sec + 600), ck('fixture.test', sec - 5), ck('fixture.test', -1), ck('notfixture.test', sec + 600)],
    origins: [{ origin: 'https://app.fixture.test', localStorage: [{ name: 'k', value: 'v' }] }, { origin: 'https://evil.test', localStorage: [] }] };
  const r = reduceSession(state, { domains: ['fixture.test'], maxTtlSeconds: 3600, now });
  assert.equal(r.state.cookies.length, 2);
  assert.ok(r.state.cookies.every(c => c.expires <= sec + 3600), 'expiry is capped at the TTL');
  assert.deepEqual([r.summary.cookiesKept, r.summary.cookiesDropped, r.summary.originsKept, r.summary.originsDropped], [2, 4, 1, 1]);
  assert.equal(JSON.stringify(r.summary).includes('sid'), false, 'the summary carries no cookie names or values');
  assert.throws(() => reduceSession({ cookies: [ck('fixture.test', sec - 1)] }, { domains: ['fixture.test'], maxTtlSeconds: 3600, now }), /expired or outside/);
  assert.throws(() => reduceSession({ cookies: [ck('evil.test', sec + 600)] }, { domains: ['fixture.test'], maxTtlSeconds: 3600, now }), /expired or outside/);
  assert.throws(() => reduceSession(state, { domains: [], maxTtlSeconds: 3600, now }), /allow-list/);
  assert.throws(() => reduceSession(state, { domains: ['fixture.test'], maxTtlSeconds: 5, now }), /TTL/);
  assert.equal(domainAllowed('evilfixture.test', ['fixture.test']), false);
  assert.equal(domainAllowed('fixture.test', ['*.fixture.test']), false);
  assert.equal(domainAllowed('a.fixture.test', ['*.fixture.test']), true);
});

test('a session secret is reduced before it is written, and an expired stored session is refused', async () => {
  const token = canary('token'); const cookie = canary('cookie'); const evil = canary('evil');
  const sec = Math.floor(Date.now() / 1000);
  const mk = (expires) => JSON.stringify({ cookies: [{ name: 'sid', value: cookie, domain: 'fixture.test', path: '/', expires }, { name: 'x', value: evil, domain: 'evil.test', path: '/', expires }], origins: [] });
  const bao = await fakeBao({ token, data: { 'devtest/browser/fixture-session': { storage_state: mk(sec + 300) } } });
  const root = secretRoot();
  try {
    const backend = createOpenBaoBackend({ address: bao.address, tokenFile: tokenFile(token) });
    const h = await materialize({ policy, names: ['fixture-session'], backend, runId: RUN, root, ...me });
    const written = fs.readFileSync(path.join(root, RUN, 'fixture-session'), 'utf8');
    assert.ok(written.includes(cookie)); assert.equal(written.includes(evil), false, 'foreign-domain cookie never written');
    assert.ok(Date.parse(h.expiresAt) <= Date.now() + 301000);
    await h.cleanup();
  } finally { bao.close(); }
  const old = await fakeBao({ token, data: { 'devtest/browser/fixture-session': { storage_state: mk(sec - 10) } } });
  try {
    await assert.rejects(materialize({ policy, names: ['fixture-session'], backend: createOpenBaoBackend({ address: old.address, tokenFile: tokenFile(token) }), runId: RUN, root, ...me }), /expired or outside/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { old.close(); }
});

test('withSecrets: cleans on success and on failure; the scan catches a leak in raw, base64, URL-encoded and JSON-escaped form; a clean output passes', async () => {
  const root = secretRoot(); const out = tmp();
  const secretValue = canary('pw') + '"/ ';   // forces distinct encodings
  const backend = { kind: 'openbao', assertReadOnly: async () => {}, read: async () => ({ values: { username: 'u', password: secretValue }, leaseId: null }), revoke: async () => {} };
  const opts = { policy, names: ['fixture-login'], backend, runId: RUN, root, ...me };
  const ok = await withSecrets(opts, async () => { fs.writeFileSync(path.join(out, 'report.json'), '{"ok":true}'); return 'done'; }, { outputRoots: [out] });
  assert.equal(ok.result, 'done'); assert.equal(ok.leak.clean, true); assert.equal(fs.existsSync(path.join(root, RUN)), false);
  const forms = { raw: secretValue, b64: Buffer.from(secretValue).toString('base64'), url: encodeURIComponent(secretValue), json: JSON.stringify(secretValue).slice(1, -1) };
  for (const [kind, text] of Object.entries(forms)) {
    const dir = tmp();
    await assert.rejects(withSecrets({ ...opts, runId: 'c'.repeat(16) }, async () => { fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'log.txt'), `line ${text} end`); }, { outputRoots: [dir] }), (e) => e.exitCode === 8 && !e.message.includes(secretValue), kind);
    assert.equal(fs.existsSync(path.join(root, 'c'.repeat(16))), false, `${kind}: cleaned despite the leak`);
  }
  await assert.rejects(withSecrets({ ...opts, runId: 'd'.repeat(16) }, async () => { throw new Error('subject failed'); }), /subject failed/);
  assert.deepEqual(fs.readdirSync(root), [], 'cleaned on failure too');
});

test('session storage values from allowed origins are included in the output leak scan', async () => {
  const root = secretRoot(), out = tmp();
  const local = canary('local'), session = canary('session');
  const state = { cookies: [], origins: [{ origin: 'https://app.fixture.test',
    localStorage: [{ name: 'auth', value: local }], sessionStorage: [{ name: 'transient', value: session }] }] };
  const backend = { kind: 'openbao', assertReadOnly: async () => {},
    read: async () => ({ values: { storage_state: state }, leaseId: null }), revoke: async () => {} };
  const opts = { policy, names: ['fixture-session'], backend, root, ...me };
  for (const [i, value] of [local, session].entries()) {
    const runId = String(i + 1).repeat(16);
    await assert.rejects(withSecrets({ ...opts, runId }, async () => {
      fs.writeFileSync(path.join(out, `leak-${i}`), value);
    }, { outputRoots: [out] }), e => e.exitCode === 8 && !e.message.includes(value));
    assert.equal(fs.existsSync(path.join(root, runId)), false);
    fs.unlinkSync(path.join(out, `leak-${i}`));
  }
});

test('scan failure still removes secret files and revokes the lease', async () => {
  const root = secretRoot(), revoked = [];
  const backend = { kind: 'openbao', assertReadOnly: async () => {},
    read: async () => ({ values: { username: 'u', password: canary('scan') }, leaseId: 'test-lease' }),
    revoke: async id => { revoked.push(id); } };
  await assert.rejects(withSecrets({ policy, names: ['fixture-login'], backend, runId: RUN, root, ...me },
    async () => 'finished', { outputRoots: ['/proc/self/mem'] }));
  assert.equal(fs.existsSync(path.join(root, RUN)), false);
  assert.deepEqual(revoked, ['test-lease']);
});

test('isolation between runs: distinct directories, an existing run directory is refused, traces are refused', async () => {
  const root = secretRoot(); const backend = createMockBackend();
  const a = await materialize({ policy, names: ['fixture-login'], backend, runId: 'a'.repeat(16), root, ...me });
  const b = await materialize({ policy, names: ['fixture-login'], backend, runId: 'b'.repeat(16), root, ...me });
  assert.notEqual(fs.readFileSync(a.mounts[0].host, 'utf8'), fs.readFileSync(b.mounts[0].host, 'utf8'));
  await assert.rejects(materialize({ policy, names: ['fixture-login'], backend, runId: 'a'.repeat(16), root, ...me }), BrokerError);
  assert.equal(fs.existsSync(a.mounts[0].host), true, 'a refused collision does not delete the other run');   // regression: failed materialise must not clean a foreign dir
  await assert.rejects(materialize({ policy, names: ['fixture-login'], backend, runId: 'e'.repeat(16), root, trace: true, ...me }), /traces/);
  await assert.rejects(materialize({ policy, names: [], backend, runId: 'e'.repeat(16), root, ...me }), /one to four/);
  await assert.rejects(materialize({ policy, names: ['fixture-login'], backend, runId: 'short', root, ...me }), /run id/);
  await a.cleanup(); await b.cleanup();
});

test('runner: secrets are validated in the plan and verified on disk before a container starts', () => {
  const cfg = { lock, uid: 99, gid: 100, limits, secretRoot: '/dev/shm/devtest-secrets' };
  const mk = (spec, c = cfg) => buildPlanForVerifiedPaths({ runId: RUN, image: 'playwright', command: ['node', 'x'], ...spec }, c, '/mnt/user/projects/p', '/mnt/cache/appdata/x');
  assert.throws(() => mk({ secrets: ['A/b'] }), RunnerError);
  assert.throws(() => mk({ secrets: ['a', 'a'] }), RunnerError);
  assert.throws(() => mk({ secrets: ['a', 'b', 'c', 'd', 'e'] }), RunnerError);
  assert.throws(() => mk({ secrets: ['a'] }, { ...cfg, secretRoot: '/mnt/cache/secrets' }), /tmpfs/);
  assert.throws(() => mk({ secrets: ['a'] }, { ...cfg, secretRoot: '/dev/shm/../etc' }), /tmpfs/);
  assert.deepEqual(mk({}).secrets, []);
  const root = secretRoot(); const dir = path.join(root, RUN); fs.mkdirSync(dir, { mode: 0o700 });
  const plan = mk({ secrets: ['tok'] }, { ...cfg, secretRoot: root.startsWith('/dev/shm') ? root : '/dev/shm/x' });
  const real = { ...plan, secrets: [{ name: 'tok', host: path.join(dir, 'tok'), container: '/secrets/tok' }] };
  assert.throws(() => verifySecrets(real), /not a prepared regular file/);
  fs.writeFileSync(path.join(dir, 'tok'), 's', { mode: 0o400 });
  assert.doesNotThrow(() => verifySecrets(real));
  fs.chmodSync(path.join(dir, 'tok'), 0o644); assert.throws(() => verifySecrets(real), /unsafe/);
  fs.chmodSync(path.join(dir, 'tok'), 0o400); fs.linkSync(path.join(dir, 'tok'), path.join(dir, 'hard')); assert.throws(() => verifySecrets(real), /not a prepared/);
  fs.unlinkSync(path.join(dir, 'hard')); fs.unlinkSync(path.join(dir, 'tok')); fs.symlinkSync('/etc/hostname', path.join(dir, 'tok')); assert.throws(() => verifySecrets(real), /not a prepared/);
  fs.chmodSync(dir, 0o755); fs.unlinkSync(path.join(dir, 'tok')); fs.writeFileSync(path.join(dir, 'tok'), 's', { mode: 0o400 }); assert.throws(() => verifySecrets(real), /directory is missing or unsafe/);
});
