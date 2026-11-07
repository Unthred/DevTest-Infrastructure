// Issue #933: dashboard write actions never replace the page with a bare error. A script gets JSON (toast + in-place refresh), a browser
// without script gets a styled page with a way back; an already-decided inbox item is its current state, not an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import * as inbox from '../supervisor/inbox.mjs';

const T0 = Date.UTC(2026, 10, 3, 12, 40, 0);
const base = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };

async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act933-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const id = 'cd'.repeat(16); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify({ kind: 'prompt', title: 'Tidy the docs index', prompt: 'Fix the broken link in docs/README.md.' })); inbox.scan(dir, T0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'act933root-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { t: T0 };
  server.on('request', handler({ root, config: { ...base, inbox: { dir } }, host: '127.0.0.1', port, now: () => clock.t, probe: async () => ({ ok: false, error: 'nothing' }) }));
  const post = (p, body, { script = false, proof = writeToken(root), headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', ...(script ? { 'x-dashboard-action': '1' } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: h }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body: b, json: () => JSON.parse(b) })); });
    r.on('error', reject); r.end(proof === null ? body : `${body}&proof=${proof}`);
  });
  const decide = (decision, o) => post('/inbox', `id=${id}&decision=${decision}`, o);
  return { dir, id, post, decide, clock, root };
}

test('script: Approve answers JSON; a second Approve is the current state (no-op), not an error', async t => {
  const s = await serve(t);
  const a = await s.decide('approve', { script: true });
  assert.equal(a.status, 200); assert.match(a.type, /application\/json/); assert.equal(a.json().ok, true); assert.equal(a.json().noop, false);
  assert.equal(inbox.statusOf(s.dir, s.id).state, 'approved');
  s.clock.t += 5000;   // past the one-second cooldown
  const b = await s.decide('approve', { script: true });
  assert.equal(b.status, 200); assert.equal(b.json().ok, true); assert.equal(b.json().noop, true); assert.equal(b.json().message, 'Approved at 12:40 UTC');
  assert.equal(inbox.statusOf(s.dir, s.id).decidedAt, T0, 'the second click changed nothing');
});

test('script: the opposite decision on a decided item is a clear refusal that names the state', async t => {
  const s = await serve(t);
  await s.decide('approve', { script: true }); s.clock.t += 5000;
  const r = await s.decide('reject', { script: true });
  assert.equal(r.status, 409); assert.equal(r.json().ok, false); assert.match(r.json().message, /Approved at 12:40 UTC.*cannot be rejected/);
  assert.equal(inbox.statusOf(s.dir, s.id).state, 'approved');
});

test('script: a double click inside the cooldown is a JSON too-soon answer and decides once', async t => {
  const s = await serve(t);
  const [a, b] = await Promise.all([s.decide('reject', { script: true }), s.decide('reject', { script: true })]);
  assert.ok([a, b].every(r => r.status === 200 || r.status === 429), 'one decides; the other is a no-op or too-soon, never an error page');
  assert.equal([a, b].filter(r => r.status === 200 && !r.json().noop).length, 1, 'exactly one request decided');
  assert.ok([a, b].every(r => /application\/json/.test(r.type)));
  assert.equal(inbox.statusOf(s.dir, s.id).state, 'rejected');
});

test('no script: a failed action is a styled page with a way back, never bare text; a repeat of the same decision redirects', async t => {
  const s = await serve(t);
  await s.decide('approve'); s.clock.t += 5000;
  const again = await s.decide('approve');
  assert.equal(again.status, 303); assert.equal(again.headers.location, '/'); assert.equal(again.body, '');
  const r = await s.decide('reject');
  assert.equal(r.status, 409); assert.match(r.type, /text\/html/);
  assert.match(r.body, /<link rel="stylesheet" href="\/static\/style\.css">/); assert.match(r.body, /Approved at 12:40 UTC/); assert.match(r.body, /<a href="\/">Back to the dashboard<\/a>/);
});

test('an expired or wrong access proof shows a reason to a script and a page to a browser', async t => {
  const s = await serve(t), wrong = 'f'.repeat(64);
  const j = await s.decide('approve', { script: true, proof: wrong });
  assert.equal(j.status, 403); assert.equal(j.json().ok, false); assert.match(j.json().message, /access proof/i);
  const h = await s.decide('approve', { proof: wrong });
  assert.equal(h.status, 403); assert.match(h.type, /text\/html/); assert.equal(inbox.statusOf(s.dir, s.id).state, 'pending');
});

test('every write route answers every failure with JSON (script) or HTML (no script), never text/plain', async t => {
  const s = await serve(t);
  const cases = [
    ['/inbox', 'id=nope&decision=approve'], ['/inbox', `id=${s.id}&decision=maybe`],
    ['/mark-read', 'at=abc'], ['/mark-read', `at=${T0 + 999999999}`],
    ['/watch', 'kind=issue&number=x&action=watch'], ['/watch', 'kind=issue&number=999&action=watch'],
    ['/breaker-resume', 'scope=nothing', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1' } }],
    ['/breaker-resume', 'scope=nothing'],
    ['/probe/ghost', ''],
  ];
  for (const [p, body, o = {}] of cases) {
    for (const script of [true, false]) {
      const r = await s.post(p, body, { ...o, script });
      assert.ok(r.status >= 400, `${p} ${body} ${script}: ${r.status}`);
      assert.doesNotMatch(r.type, /text\/plain/, `${p} ${body} script=${script}`);
      if (script) { assert.match(r.type, /json/); assert.equal(r.json().ok, false); assert.ok(r.json().message.length > 5); }
      else { assert.match(r.type, /text\/html/); assert.match(r.body, /<a href="\/">Back to the dashboard<\/a>/); }
    }
  }
  const noProof = await s.post('/mark-read', `at=${T0}`, { proof: null, script: true });
  assert.equal(noProof.status, 403);
});

test('successful redirects carry no bare text body', async t => {
  const s = await serve(t);
  const r = await s.post('/mark-read', `at=${T0 - 1000}`);
  assert.equal(r.status, 303); assert.equal(r.body, ''); assert.doesNotMatch(r.type, /text\/plain/);
});

// The guard: nobody can add a write route that answers with bare text, or an action form that script does not handle.
const read = f => fs.readFileSync(new URL(`../supervisor/${f}`, import.meta.url), 'utf8');
test('guard: the write handlers contain no text/plain reply', () => {
  const src = read('dashserver.mjs');
  const writes = src.slice(src.indexOf('const markRead ='), src.indexOf('if (req.method !== \'GET\''));
  assert.ok(writes.length > 3000);
  assert.doesNotMatch(writes, /text\/plain/);
  assert.doesNotMatch(writes, /\bsend\(\d{3},\s*'/, 'a write route must reply through done/fail/page, not a raw send');
});

test('guard: every POST form is handled by actions.js unless it is explicitly data-native and its route answers with a page', () => {
  const render = read('dashrender.mjs'), forms = render.match(/<form method="post"[^>]*>/g) || [];
  assert.ok(forms.length >= 5, 'the forms were found');
  const native = forms.filter(f => /\bdata-native\b/.test(f));
  assert.deepEqual(native.map(f => /action="([^"]+)"/.exec(f)[1]), ['/breaker-resume'], 'only the breaker Resume stays a native post (it needs a person form click)');
  const js = read('dashui/actions.js');
  assert.match(js, /addEventListener\('submit'/); assert.match(js, /data-native/); assert.match(js, /x-dashboard-action/);
  assert.match(js, /disabled = true/, 'buttons are disabled in flight');
  assert.match(render, /<script type="module" src="\/static\/actions\.js"><\/script>/, 'every page loads the handler');
  assert.match(read('dashserver.mjs'), /'\/static\/actions\.js'/);
});
