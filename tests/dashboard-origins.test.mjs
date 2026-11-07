// Issue #556: the three dashboard writes accept the listen-address origin and the origins listed in dashboard.allowed_origins, and no other.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { validateTeamConfig, applyLocalOverride } from '../supervisor/team.mjs';
import * as inbox from '../supervisor/inbox.mjs';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0), PUBLIC = 'https://agents.example.test';
const base = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
async function serve(t, dashboard = { allowed_origins: [PUBLIC] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origins556-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }], merged: [] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, probes = [];
  const cfg = dashboard === null ? base : { ...base, dashboard };
  server.on('request', handler({ root, config: cfg, host: '127.0.0.1', port, now: () => NOW, probe: async o => { probes.push(o.agent); return { ok: true }; } }));
  const proof = `proof=${writeToken(root)}`;
  // The Host is always the listen address, as a reverse proxy that forwards the upstream Host presents it.
  const call = (p, origin, body, extra = {}) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', ...(origin === undefined ? {} : { origin }), ...extra };
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }); r.on('error', reject); r.end(body);
  });
  const writes = { call, proof, watch: o => call('/watch', o, `kind=issue&number=10&action=watch&${proof}`), markRead: o => call('/mark-read', o, `at=${NOW - 1000}&${proof}`), probe: o => call('/probe/claude', o, proof) };
  return { root, port, probes, writes, lan: `http://127.0.0.1:${port}` };
}

for (const name of ['watch', 'markRead', 'probe']) {
  test(`${name}: accepted from the LAN origin and the listed public origin`, async t => {
    for (const which of ['lan', 'public']) {
      const s = await serve(t), r = await s.writes[name](which === 'lan' ? s.lan : PUBLIC);
      assert.equal(r.status, 303, `${which} origin`);
    }
  });
  test(`${name}: an unlisted origin, a lookalike, "null" and a missing Origin are refused with a readable page`, async t => {
    const s = await serve(t);
    for (const origin of ['https://evil.example', `${PUBLIC}.evil.example`, `${PUBLIC}/`, 'http://agents.example.test', 'null', undefined]) {
      const r = await s.writes[name](origin);
      assert.equal(r.status, 403, String(origin));
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.body, /cross-origin request refused/); assert.match(r.body, /<a href="\/">Back to the dashboard<\/a>/);
    }
    assert.deepEqual(s.probes, [], 'no probe ran');
    assert.equal(fs.existsSync(path.join(s.root, 'dashboard', 'last-seen.json')) || fs.existsSync(path.join(s.root, 'dashboard', 'watchlist.json')), false, 'nothing was written');
  });
  test(`${name}: without any configured origin the public origin is refused`, async t => {
    const s = await serve(t, null);
    assert.equal((await s.writes[name](PUBLIC)).status, 403);
    assert.equal((await s.writes[name](s.lan)).status, 303);
  });
}

test('a listed origin still needs the access proof and the expected Host', async t => {
  const s = await serve(t);
  assert.equal((await new Promise(res => { const r = http.request({ host: '127.0.0.1', port: s.port, path: '/watch', method: 'POST', headers: { host: `127.0.0.1:${s.port}`, origin: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' } }, x => { x.resume(); res(x.statusCode); }); r.end('kind=issue&number=10&action=watch&proof=' + 'f'.repeat(64)); })), 403);
  assert.equal((await new Promise(res => { const r = http.request({ host: '127.0.0.1', port: s.port, path: '/watch', method: 'POST', headers: { host: 'evil.example', origin: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' } }, x => { x.resume(); res(x.statusCode); }); r.end('kind=issue&number=10&action=watch'); })), 421);
});

test('the refusal page escapes the received Origin and Host', async t => {
  const s = await serve(t), r = await s.writes.watch('http://x"><script>alert(1)</script>');
  assert.equal(r.status, 403); assert.ok(!r.body.includes('<script>')); assert.match(r.body, /&#60;script&#62;/);
});

test('dashboard.allowed_origins accepts exact origins only', () => {
  const ok = o => validateTeamConfig({ ...base, dashboard: { allowed_origins: o } });
  ok([PUBLIC, 'http://10.0.0.5:8731']);
  for (const bad of [['*'], ['https://*.example.test'], [`${PUBLIC}/x`], [`${PUBLIC}/`], ['ftp://x.test'], ['https://u:p@x.test'], ['x.test'], [5], 'https://x.test', ['https://x.test?a=1'], ['https://Agents.Example.test'], ['https://x.test:443'], ['http://x.test:80'], ['http://[::1]:8731']]) assert.throws(() => ok(bad), /allowed_origins/, JSON.stringify(bad));
  assert.throws(() => validateTeamConfig({ ...base, dashboard: { other: 1 } }), /dashboard/);
  assert.equal(applyLocalOverride(base, { dashboard: { allowed_origins: [PUBLIC] } }).dashboard.allowed_origins[0], PUBLIC);
  assert.throws(() => applyLocalOverride(base, { dashboard: { allowed_origins: ['*'] } }), /allowed_origins/);
});

test('a refused write is logged, and a wrong Host gets a readable page with the received values', async t => {
  const s = await serve(t), lines = [], orig = console.error; console.error = (...a) => lines.push(a.join(' ')); t.after(() => { console.error = orig; });
  await s.writes.watch('https://other.example.test');
  const r = await new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: s.port, path: '/watch', method: 'POST', headers: { host: 'evil.example', origin: PUBLIC, 'content-type': 'application/x-www-form-urlencoded' } }, x => { let b = ''; x.on('data', d => (b += d)); x.on('end', () => res({ status: x.statusCode, body: b })); }); q.on('error', rej); q.end('kind=issue&number=10&action=watch'); });
  console.error = orig;
  assert.equal(r.status, 421); assert.match(r.body, /Back to the dashboard/); assert.match(r.body, /evil\.example/);
  assert.ok(lines.some(l => l.includes('write refused') && l.includes('"https://other.example.test"')));
  assert.ok(lines.some(l => l.includes('unexpected host') && l.includes('host="evil.example"')));
});

// The inbox write (issue #124) is a fourth dashboard write; it takes the same origin rule, and still needs the host, the proof and the cooldown (D-029).
async function serveInbox(t, dashboard = { allowed_origins: [PUBLIC] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox556-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const id = 'ab'.repeat(16); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify({ kind: 'prompt', title: 'Tidy the docs index', prompt: 'Fix the broken link in docs/README.md.' })); inbox.scan(dir, NOW);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inboxroot556-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port;
  server.on('request', handler({ root, config: { ...base, inbox: { dir }, ...(dashboard ? { dashboard } : {}) }, host: '127.0.0.1', port, now: () => NOW }));
  const post = ({ origin, proof = writeToken(root), host = `127.0.0.1:${port}`, decision = 'approve' }) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/inbox', method: 'POST', headers: { host, 'content-type': 'application/x-www-form-urlencoded', ...(origin === undefined ? {} : { origin }) } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', reject); r.end(`id=${id}&decision=${decision}&proof=${proof}`);
  });
  return { dir, id, port, post, lan: `http://127.0.0.1:${port}` };
}

test('/inbox: Approve works from the listed public origin and from the LAN origin', async t => {
  for (const which of ['public', 'lan']) {
    const s = await serveInbox(t), r = await s.post({ origin: which === 'public' ? PUBLIC : s.lan });
    assert.equal(r.status, 303, which); assert.equal(inbox.statusOf(s.dir, s.id).state, 'approved', which);
  }
});

test('/inbox: an unlisted, lookalike, "null" or missing Origin is refused with a readable page and decides nothing', async t => {
  const s = await serveInbox(t);
  for (const origin of ['https://evil.example', `${PUBLIC}.evil.example`, `${PUBLIC}/`, 'http://agents.example.test', 'null', undefined]) {
    const r = await s.post({ origin });
    assert.equal(r.status, 403, String(origin)); assert.match(r.headers['content-type'], /text\/html/); assert.match(r.body, /Back to the dashboard/);
  }
  assert.equal(inbox.statusOf(s.dir, s.id).state, 'pending');
  const none = await serveInbox(t, null);
  assert.equal((await none.post({ origin: PUBLIC })).status, 403, 'no origin configured: the public origin is refused');
  assert.equal(inbox.statusOf(none.dir, none.id).state, 'pending');
});

test('/inbox: a listed origin still needs the access proof and the expected Host, and the cooldown applies', async t => {
  const s = await serveInbox(t);
  assert.equal((await s.post({ origin: PUBLIC, proof: 'f'.repeat(64) })).status, 403);
  assert.equal((await s.post({ origin: PUBLIC, proof: '' })).status, 403);
  assert.equal((await s.post({ origin: PUBLIC, host: 'evil.example' })).status, 421);
  assert.equal(inbox.statusOf(s.dir, s.id).state, 'pending');
  assert.equal((await s.post({ origin: PUBLIC })).status, 303);
  const again = await s.post({ origin: PUBLIC, decision: 'reject' });
  // Issue #933: an item that is already decided answers with its state (a styled page here), not a cooldown redirect.
  assert.equal(again.status, 409); assert.match(again.headers['content-type'], /text\/html/); assert.match(again.body, /Approved at/);
  assert.equal(inbox.statusOf(s.dir, s.id).state, 'approved', 'the second click changed nothing');
});

// Behind a reverse proxy: forwarding headers are not trusted. Acceptance depends only on Origin (exact match) and the upstream Host.
test('X-Forwarded-Host and X-Forwarded-Proto neither grant nor remove acceptance', async t => {
  const s = await serve(t), fwd = { 'x-forwarded-host': 'agents.example.test', 'x-forwarded-proto': 'https' };
  const body = `kind=issue&number=10&action=watch&${s.writes.proof}`;
  assert.equal((await s.writes.call('/watch', PUBLIC, body, fwd)).status, 303, 'listed public origin with proxy headers');
  assert.equal((await s.writes.call('/watch', 'https://evil.example', body, fwd)).status, 403, 'forwarded headers do not legitimise an unlisted origin');
  assert.equal((await s.writes.call('/watch', undefined, body, fwd)).status, 403, 'no Origin is refused even with forwarded headers');
  assert.equal((await s.writes.call('/watch', PUBLIC, body, { host: 'agents.example.test' })).status, 421, 'a proxy that forwards the public Host is refused at the Host check');
});
