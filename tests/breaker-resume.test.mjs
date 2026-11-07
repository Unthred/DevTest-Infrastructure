// Issue #626: the Resume button's write protection (D-029). A real dashboard handler over a temp state root; no model call, no network
// beyond loopback. The halt is written into the state file the dashboard reads; a click may only leave a request for the next tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { takeBreakerResumeRequests } from '../supervisor/breakerresume.mjs';
import { JOB_MARKER, underSupervisedJob } from '../supervisor/breaker.mjs';

const CAUSE = 'review:blocked:postcondition_not_met';
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
async function serve(t, { halted = true, supervised = () => false, peerPid = () => 4242, dashboard } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash626-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const at = Date.now() - 60000;
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at, status: 'ok', lastOkAt: at }, fetchedAt: at, pulls: [], issues: [] }));
  const halt = { cause: CAUSE, since: at, jobs: 3, tokens: 30, inputTokens: 15, outputTokens: 15, cost: 1, prs: [40], issues: [], types: ['review'], jobIds: ['a', 'b', 'c'], trippedBy: 'count' };
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ breaker: { waste: {}, halts: halted ? { [CAUSE]: halt } : {}, global: null, clearedAt: {} } }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { now: Date.now() };
  server.on('request', handler({ root, config: dashboard ? { ...config, dashboard } : config, host: '127.0.0.1', port, now: () => clock.now, supervised, peerPid }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject); r.end(body); });
  // What a browser sends for a click on a form button on the dashboard itself.
  const click = (scope = CAUSE, { proof = writeToken(root), origin = `http://127.0.0.1:${port}`, person = true } = {}) => req('POST', '/breaker-resume', {
    headers: { ...(origin ? { origin } : {}), ...(person ? { 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1' } : {}), 'content-type': 'application/x-www-form-urlencoded' },
    body: `scope=${encodeURIComponent(scope)}&proof=${proof}` });
  return { root, port, clock, click, get: p => req('GET', p) };
}

test('the dashboard shows a Resume button on the halt, carrying the access proof', async t => {
  const s = await serve(t), page = (await s.get('/')).body;
  assert.match(page, /<form method="post" action="\/breaker-resume"[^>]*><input type="hidden" name="proof" value="[a-f0-9]{64}"><input type="hidden" name="scope"/);
  assert.match(page, new RegExp(`Resume ${CAUSE}`));
  const none = await serve(t, { halted: false });
  assert.ok(!(await none.get('/')).body.includes('/breaker-resume'), 'no button when nothing is halted');
});

test('a person click leaves one request and edits no state; the state file is untouched', async t => {
  const s = await serve(t), before = fs.readFileSync(path.join(s.root, 'team', 'state.json'), 'utf8');
  const r = await s.click();
  assert.equal(r.status, 303);
  assert.equal(fs.readFileSync(path.join(s.root, 'team', 'state.json'), 'utf8'), before, 'the dashboard never edits Foreman state');
  assert.deepEqual(takeBreakerResumeRequests(s.root).map(x => x.scope), [CAUSE]);
});

test('refused: a wrong or missing proof, a foreign origin, a script that is not a person click, an unknown scope', async t => {
  const s = await serve(t);
  assert.equal((await s.click(CAUSE, { proof: 'f'.repeat(64) })).status, 403);
  assert.equal((await s.click(CAUSE, { proof: '' })).status, 403);
  assert.equal((await s.click(CAUSE, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.click(CAUSE, { origin: null })).status, 403);
  assert.equal((await s.click(CAUSE, { person: false })).status, 403, 'a request without the browser click markers (an agent using curl) is refused');
  assert.equal((await s.click('no-such-cause')).status, 409);
  assert.equal((await s.click('global')).status, 409, 'there is no global halt to resume');
  assert.deepEqual(takeBreakerResumeRequests(s.root), [], 'no refused request left anything behind');
  // refusals take no cooldown slot: the real click still goes through
  assert.equal((await s.click()).status, 303);
});

test('cooldown: a second click inside five seconds is not recorded; it works again afterwards', async t => {
  const s = await serve(t);
  assert.equal((await s.click()).status, 303);
  const again = await s.click();
  assert.equal(again.status, 303); assert.match(again.headers.location, /breaker-resume-cooldown/); assert.ok(again.headers['retry-after']);
  assert.equal(takeBreakerResumeRequests(s.root).length, 1, 'only the first click was recorded');
  s.clock.now += 6000;
  assert.equal((await s.click()).headers.location, '/');
  assert.equal(takeBreakerResumeRequests(s.root).length, 1);
});

test('a dashboard running under a supervised job refuses, even with a correct proof and click markers', async t => {
  const s = await serve(t, { supervised: () => true });
  assert.equal((await s.click()).status, 403);
  assert.deepEqual(takeBreakerResumeRequests(s.root), []);
});

test('the default guard is the supervised-job check (the job marker in the environment)', () => {
  assert.equal(underSupervisedJob({ env: { [JOB_MARKER]: '1' } }), true);
});

// Issue #737: the peer of the request is checked, not only the dashboard's own process.
import { inodeOf, pidOfInode, isLocalPeer } from '../supervisor/peerpid.mjs';
test('a loopback caller that descends from a supervised job is refused; an unidentifiable caller is refused; a person passes', async t => {
  const asked = [];
  const s = await serve(t, { peerPid: () => 777, supervised: o => { asked.push(o?.pid); return o?.pid === 777; } });
  assert.equal((await s.click()).status, 403);
  assert.deepEqual(takeBreakerResumeRequests(s.root), []);
  assert.ok(asked.includes(777));
  const unknown = await serve(t, { peerPid: () => null });
  assert.equal((await unknown.click()).status, 403);
  assert.deepEqual(takeBreakerResumeRequests(unknown.root), []);
  const person = await serve(t, { peerPid: () => 4242 });
  assert.equal((await person.click()).status, 303);
});

test('peer lookup: port pair to socket inode to pid, from /proc text', () => {
  const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 55555 1 0 0 0
   1: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 66666 1 0 0 0
`;
  const read = p => { if (p === '/proc/net/tcp') return tcp; throw new Error('none'); };
  assert.equal(inodeOf(0xC350, 0x1F90, { read }), '55555');
  assert.equal(inodeOf(1234, 0x1F90, { read }), null);
  const list = p => p === '/proc' ? ['1', 'self', '300', '301'] : p === '/proc/300/fd' ? ['0'] : p === '/proc/301/fd' ? ['0', '3'] : (() => { throw new Error('x'); })();
  const link = p => p === '/proc/301/fd/3' ? 'socket:[55555]' : 'pipe:[1]';
  assert.equal(pidOfInode('55555', { list, link }), 301);
  assert.equal(pidOfInode('99', { list, link }), null);
  assert.equal(pidOfInode('55555', { list: () => { throw new Error('denied'); }, link }), null);
  assert.equal(isLocalPeer({ remoteAddress: '127.0.0.1', localAddress: '10.0.0.5' }), true);
  assert.equal(isLocalPeer({ remoteAddress: '::ffff:10.0.0.5', localAddress: '10.0.0.5' }), true);
  assert.equal(isLocalPeer({ remoteAddress: '10.0.0.9', localAddress: '10.0.0.5' }), false);
});

// Issue #830: Resume takes the same origin rule as the other writes, and its refusals are readable pages.
test('Resume from a configured public origin is accepted; an unlisted one is refused with a readable page', async t => {
  const PUBLIC = 'https://agents.example.test', s = await serve(t, { dashboard: { allowed_origins: [PUBLIC] } });
  const bad = await s.click(CAUSE, { origin: 'https://evil.example' });
  assert.equal(bad.status, 403); assert.match(bad.headers['content-type'], /text\/html/); assert.match(bad.body, /cross-origin request refused/); assert.match(bad.body, /Back to the dashboard/);
  assert.deepEqual(takeBreakerResumeRequests(s.root), []);
  assert.equal((await s.click(CAUSE, { origin: PUBLIC, person: false })).status, 403, 'the person-click check still applies from the public origin');
  assert.equal((await s.click(CAUSE, { origin: PUBLIC })).status, 303);
  assert.deepEqual(takeBreakerResumeRequests(s.root).map(x => x.scope), [CAUSE]);
  const none = await serve(t);
  assert.equal((await none.click(CAUSE, { origin: PUBLIC })).status, 403, 'without the list the public origin is refused');
});
test('a wrong access proof and an oversized body get a readable page', async t => {
  const s = await serve(t), r = await s.click(CAUSE, { proof: 'f'.repeat(64) });
  assert.equal(r.status, 403); assert.match(r.headers['content-type'], /text\/html/); assert.match(r.body, /missing or wrong access proof/); assert.match(r.body, /href="\/"/);
  const big = await s.click(CAUSE, { proof: 'a'.repeat(2000) });
  assert.equal(big.status, 413); assert.match(big.headers['content-type'], /text\/html/);
});
