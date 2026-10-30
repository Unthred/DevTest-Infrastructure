import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { buildPlanForVerifiedPaths, verifyTargets, targetSocketPath, validateLock, RunnerError } from '../docker/runner.mjs';
import { parseArguments, isAllowed, redactUrl, PROFILES, EXIT } from '../browser/capture.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';

const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const limits = { cpus: 1, memoryMb: 1024, pids: 128, shmMb: 64, timeoutMs: 60000, diskMb: 64, cacheMb: 64 };
const plan = (spec, storage = '/mnt/cache/appdata/x') => buildPlanForVerifiedPaths({ runId: 'a'.repeat(16), image: 'playwright', command: ['node', 'x'], ...spec },
  { lock, uid: 99, gid: 100, limits }, '/mnt/user/projects/p', storage);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-browser-'));

test('the Playwright image is an official digest with its tag and date, and the npm package is integrity-pinned', () => {
  const entry = validateLock(lock).images.playwright;
  assert.match(entry.reference, /^mcr\.microsoft\.com\/playwright@sha256:[0-9a-f]{64}$/);
  assert.match(entry.tag, /^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble$/);
  assert.match(entry.resolved_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(entry.tag.split(':')[1], `v${lock.packages['playwright-core'].version}-noble`, 'package and image versions match');
  assert.match(lock.packages['playwright-core'].integrity, /^sha512-/);
});

test('browser runs keep the network-none baseline and mount each declared target read-only', () => {
  const p = plan({ targets: ['fixture', 'api'] });
  assert.ok(p.args.includes('--network=none'));
  assert.equal(p.args.filter(a => a.startsWith('--network')).length, 1);
  assert.deepEqual(p.targets.map(t => t.container), ['/targets/fixture.sock', '/targets/api.sock']);
  assert.ok(p.args.includes(`type=bind,src=${targetSocketPath('/mnt/cache/appdata/x', 'a'.repeat(16), 'fixture')},dst=/targets/fixture.sock,readonly`));
  assert.deepEqual(plan({}).targets, []);
});

test('bad target declarations and any other network request are refused', () => {
  for (const targets of [['../etc'], ['A'], ['a b'], ['x'.repeat(33)], ['dup', 'dup'], ['a', 'b', 'c', 'd', 'e'], 'fixture', [''], [1]])
    assert.throws(() => plan({ targets }), RunnerError, JSON.stringify(targets));
  for (const network of ['host', 'bridge', 'internal']) assert.throws(() => plan({ network }), /later approved phase policy/);
});

test('a target must be a real socket in a private directory owned by the runner', async t => {
  const storage = tmp(); t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const p = plan({ targets: ['fixture'] }, storage);
  p.uid = process.getuid();
  assert.throws(() => verifyTargets(p), /socket directory is missing or unsafe/);
  const dir = path.dirname(p.targets[0].host);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assert.throws(() => verifyTargets(p), /no host-side socket/);
  fs.writeFileSync(p.targets[0].host, '');
  assert.throws(() => verifyTargets(p), /no host-side socket/, 'a regular file is not a socket');
  fs.rmSync(p.targets[0].host);
  fs.symlinkSync('/etc/passwd', p.targets[0].host);
  assert.throws(() => verifyTargets(p), /no host-side socket/, 'a symlink is not followed');
  fs.rmSync(p.targets[0].host);
  fs.chmodSync(dir, 0o755);
  assert.throws(() => verifyTargets(p), /unsafe/, 'a group/world-accessible directory is refused');
  fs.chmodSync(dir, 0o700);
  const handle = await listenOnSocket(createStaticServer(storage), p.targets[0].host, { uid: process.getuid(), gid: process.getgid() });
  try { assert.doesNotThrow(() => verifyTargets(p)); } finally { fs.chmodSync(dir, 0o700); await handle.close(); }
});

const get = (socket, requestPath, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ socketPath: socket, path: requestPath, method }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] })); });
  req.on('error', reject); req.end();
});

test('the static server serves files below its root only', async t => {
  const root = tmp(), outside = tmp(), sockets = tmp();
  t.after(() => { for (const d of [root, outside, sockets]) fs.rmSync(d, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  fs.mkdirSync(path.join(root, 'dir'));
  const socket = path.join(sockets, 's', 'a.sock');
  const handle = await listenOnSocket(createStaticServer(root), socket, { uid: process.getuid(), gid: process.getgid() });
  try {
    const ok = await get(socket, '/'); assert.equal(ok.status, 200); assert.equal(ok.body, '<h1>ok</h1>'); assert.match(ok.type, /text\/html/);
    assert.equal((await get(socket, '/index.html', 'HEAD')).status, 200);
    assert.equal((await get(socket, '/missing')).status, 404);
    assert.equal((await get(socket, '/dir')).status, 404, 'no directory listing');
    assert.equal((await get(socket, '/link.txt')).status, 403, 'symlinks are not followed');
    for (const bad of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2f..%2fetc/passwd', `/${path.relative(root, path.join(outside, 'secret.txt'))}`]) {
      const r = await get(socket, bad); assert.notEqual(r.status, 200, bad); assert.ok(!r.body.includes('SECRET'), bad);
    }
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await get(socket, '/', method)).status, 405);
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  } finally { await handle.close(); }
  assert.equal(fs.existsSync(path.dirname(socket)), false, 'closing removes the socket directory');
});

test('capture arguments are validated', () => {
  const ok = parseArguments(['--target', 'fixture', '--path', '/a.html', '--profile', 'phone', '--full-page']);
  assert.equal(ok.profile, 'phone'); assert.equal(ok.fullPage, true); assert.equal(ok.browser, 'chromium'); assert.equal(ok.timeoutMs, 15000);
  for (const bad of [[], ['--target', 'Bad Name'], ['--target', 'f', '--path', 'relative'], ['--target', 'f', '--path', '//evil.example/x'], ['--target', 'f', '--path', '/a\nb'],
    ['--target', 'f', '--browser', 'ie'], ['--target', 'f', '--profile', 'tv'], ['--target', 'f', '--wait', 'never'], ['--target', 'f', '--name', '../x'],
    ['--target', 'f', '--timeout-ms', '5'], ['--target', 'f', '--timeout-ms', '999999'], ['--target', 'f', '--surprise', '1'], ['--target', 'f', '--path']])
    assert.throws(() => parseArguments(bad), Error, JSON.stringify(bad));
  assert.deepEqual(Object.keys(PROFILES), ['phone', 'desktop']);
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length);
});

test('only the bridged loopback port and inline URLs are allowed; reports never keep query strings', () => {
  assert.equal(isAllowed('http://127.0.0.1:4000/a.css', 4000), true);
  assert.equal(isAllowed('data:text/plain,hi', 4000), true);
  for (const url of ['http://127.0.0.1:4001/', 'http://localhost:4000/', 'https://127.0.0.1:4000/', 'http://192.0.2.1/', 'https://example.com/', 'ftp://127.0.0.1:4000/', 'ws://127.0.0.1:4000/', 'file:///etc/passwd', 'not a url', 'http://127.0.0.1.evil.example:4000/'])
    assert.equal(isAllowed(url, 4000), false, url);
  const query = ['tok', 'en=SHOULD_NOT_APPEAR'].join('');
  assert.equal(redactUrl(`http://198.51.100.7/beacon?${query}#frag`), 'http://198.51.100.7/beacon');
  assert.equal(redactUrl('nonsense'), 'invalid-url');
});
