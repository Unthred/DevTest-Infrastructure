// Issue #1164: the dashboard side of direct control, through the real request handler: the switch, Undo, the audit trail in the page and in
// /api/view.json, and the refusals of a write that is not a person's click. No browser here; tests/direct-control-browser.mjs checks the page in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { handler, DASHBOARD_VIEW_TTL_MS } from '../supervisor/dashserver.mjs';
import { appendAudit, readAudit, readSwitch, pendingUndos, findRecord } from '../supervisor/directstore.mjs';
import { directCard } from '../supervisor/directcard.mjs';

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const MODELS = { models: { agents: { claude: { implement: { model: 'sonnet' }, review: { model: 'opus' } } } } };
const config = inboxDir => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...MODELS });

async function serve(t, { supervised = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirdash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inboxDir = path.join(root, 'inbox');
  for (const d of ['jobs', 'dashboard', 'team', 'inbox/items', 'inbox/status']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [] }));
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const port = server.address().port, woken = [], clock = { now: NOW };
  server.on('request', handler({ root, config: config(inboxDir), host: '127.0.0.1', port, now: () => clock.now, viewTtlMs: DASHBOARD_VIEW_TTL_MS, supervised: () => supervised, wake: (r, reason) => woken.push(reason) }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.fromEntries(Object.entries({ host: `127.0.0.1:${port}`, ...headers }).filter(([, v]) => v !== undefined)) }, res => {
      let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); r.end(body);
  });
  const click = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1' };
  const post = (body, extra = {}) => req('POST', '/direct', { headers: { ...click, ...extra }, body: `${body}&proof=${writeToken(root)}` });
  return { root, inboxDir, req, post, origin: click.origin, woken, later: () => { clock.now += 2000; }, get: p => req('GET', p) };
}
const record = (dir, over = {}) => appendAudit(dir, { at: NOW - 1000, by: 'overseer', action: 'park', target: '21', reason: 'not this week', outcome: 'done', changed: true,
  before: { parked: false }, after: { parked: true }, text: 'issue #21 is parked.', undo: { op: 'unpark', n: 21 }, ...over });

test('the audit trail shows on the Supervisor page and in /api/view.json, newest first, with an Undo only where one is possible', async t => {
  const s = await serve(t);
  const done = record(s.inboxDir), refused = record(s.inboxDir, { action: 'merge', target: '22', outcome: 'refused', changed: false, undo: null, text: 'merge is not a direct control' });
  const page = (await s.get('/supervisor')).body;
  assert.match(page, /Overseer direct control/); assert.match(page, /data-switch="on"/);
  assert.match(page, new RegExp(`data-audit="${done.id}" data-outcome="done"`)); assert.match(page, new RegExp(`data-audit="${refused.id}" data-outcome="refused"`));
  const rowOf = id => new RegExp(`<li data-audit="${id}".*?</li>`, 's').exec(page)[0];
  assert.match(rowOf(done.id), /<button class="btn" type="submit">Undo<\/button>/); assert.doesNotMatch(rowOf(refused.id), /Undo/);
  assert.match(rowOf(done.id), /Reason: not this week/);
  const view = JSON.parse((await s.get('/api/view.json')).body);
  assert.equal(view.direct.enabled, true); assert.deepEqual(view.direct.audit.map(e => e.id), [refused.id, done.id]); assert.equal(view.direct.audit[1].undoable, true);
});

test('text from the trail is escaped on the page', async t => {
  const s = await serve(t); const rec = record(s.inboxDir, { reason: '<script>alert(1)</script>', text: '<img src=x onerror=alert(1)>' });
  const page = (await s.get('/supervisor')).body;
  assert.doesNotMatch(page, /<script>alert\(1\)/); assert.doesNotMatch(page, /<img src=x/); assert.match(page, new RegExp(`data-audit="${rec.id}"`));
  assert.equal(directCard({}, null), '');
});

test('the switch: a click turns direct control off and on, the page and the view show it, and the change is in the trail', async t => {
  const s = await serve(t);
  const off = await s.post('action=switch&value=off'); assert.equal(off.status, 303); assert.equal(readSwitch(s.inboxDir).enabled, false);
  assert.match((await s.get('/supervisor')).body, /data-switch="off"/); assert.equal(JSON.parse((await s.get('/api/view.json')).body).direct.enabled, false);
  assert.equal(readAudit(s.inboxDir)[0].action, 'switch_off');
  s.later();
  const on = await s.post('action=switch&value=on'); assert.equal(on.status, 303); assert.equal(readSwitch(s.inboxDir).enabled, true);
});

test('Undo leaves one request for the next pass, wakes a pass, and refuses an unknown, unchanged or repeated record', async t => {
  const s = await serve(t);
  const rec = record(s.inboxDir), unchanged = record(s.inboxDir, { changed: false, undo: null });
  const ok = await s.post(`action=undo&id=${rec.id}`); assert.equal(ok.status, 303); assert.deepEqual(pendingUndos(s.inboxDir), [rec.id]); assert.deepEqual(s.woken, ['approve']);
  s.later();
  const again = await s.post(`action=undo&id=${rec.id}`); assert.equal(again.status, 409); assert.match(again.body, /already waiting/);
  s.later();
  const none = await s.post(`action=undo&id=${unchanged.id}`); assert.equal(none.status, 409); assert.match(none.body, /nothing to undo/);
  s.later();
  const unknown = await s.post(`action=undo&id=${'f'.repeat(16)}`); assert.equal(unknown.status, 409); assert.match(unknown.body, /unknown record/);
  assert.equal(findRecord(s.inboxDir, rec.id).id, rec.id);
});

test('a write that is not a person clicking is refused and changes nothing: no proof, a script, a cross-origin post, a supervised caller, bad fields', async t => {
  const s = await serve(t); const rec = record(s.inboxDir);
  const noProof = await s.req('POST', '/direct', { headers: { origin: s.origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1' }, body: 'action=switch&value=off' });
  assert.equal(noProof.status, 403);
  const script = await s.post('action=switch&value=off', { 'sec-fetch-user': undefined, 'sec-fetch-site': 'none' }); assert.equal(script.status, 403); assert.match(script.body, /person clicking/);
  const cross = await s.post('action=switch&value=off', { origin: 'http://evil.example' }); assert.equal(cross.status, 403);
  const wrongProof = await s.req('POST', '/direct', { headers: { origin: s.origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1' }, body: 'action=switch&value=off&proof=nope' });
  assert.equal(wrongProof.status, 403);
  const bad = await s.post('action=switch&value=maybe'); assert.equal(bad.status, 400);
  const worse = await s.post('action=delete&value=off'); assert.equal(worse.status, 400);
  assert.equal(readSwitch(s.inboxDir).enabled, true); assert.deepEqual(pendingUndos(s.inboxDir), []); assert.equal(findRecord(s.inboxDir, rec.id).id, rec.id);
  const sup = await serve(t, { supervised: true });
  const refused = await sup.post('action=switch&value=off'); assert.equal(refused.status, 403); assert.equal(readSwitch(sup.inboxDir).enabled, true);
});
