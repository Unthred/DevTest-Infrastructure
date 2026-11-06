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
async function serve(t, { halted = true, supervised = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash626-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const at = Date.now() - 60000;
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at, status: 'ok', lastOkAt: at }, fetchedAt: at, pulls: [], issues: [] }));
  const halt = { cause: CAUSE, since: at, jobs: 3, tokens: 30, inputTokens: 15, outputTokens: 15, cost: 1, prs: [40], issues: [], types: ['review'], jobIds: ['a', 'b', 'c'], trippedBy: 'count' };
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ breaker: { waste: {}, halts: halted ? { [CAUSE]: halt } : {}, global: null, clearedAt: {} } }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { now: Date.now() };
  server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => clock.now, supervised }));
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
