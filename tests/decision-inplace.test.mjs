// Issue #1185: a decision card's control is sent in the background and the card shows the result in place. Covers the reply shapes (done, failed,
// cleared), the real /decision route for script (JSON) and no script (redirect to the card's anchor), the working state the server renders after a
// click, and the order of events in the page script's logic (dashui/decision-ui.mjs).
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { doneReply, failedReply, clearedReply, refusalReply, backTo, jsonSend, wantsJson } from '../supervisor/decisionreply.mjs';
import { settle, runCardAction, focusTargetAfter, nextHash, WORKING } from '../supervisor/dashui/decision-ui.mjs';
import { decisionHtml } from '../supervisor/decisioncard-ui.mjs';
import { allStatuses } from '../supervisor/inbox.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';

const HEAD = 'a'.repeat(40);
async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dec1185-')); removeLater(root);
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const inboxDir = path.join(root, 'inbox');
  for (const d of ['items', 'status']) fs.mkdirSync(path.join(inboxDir, d), { recursive: true });
  const now = Date.now(), pull = { number: 7, title: 'T', state: 'OPEN', headRefName: 'codex/issue-7-x', headRefOid: HEAD, labels: ['needs-homeowner'], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [pull], issues: [] }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ fixAttempts: { [`7:${HEAD}`]: 2 }, verdicts: {}, jobs: {} }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const port = server.address().port;
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir },
    github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
  const form = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' };
  const post = (fields, { json = true, proof = writeToken(root) } = {}) => req('POST', '/decision', { headers: { ...form, ...(json ? { accept: 'application/json' } : {}) }, body: new URLSearchParams({ proof, ...fields }).toString() });
  return { get: p => req('GET', p), post, inboxDir, root };
}

test('reply shapes: done, failed and already cleared each say which they are', () => {
  assert.deepEqual(doneReply({ label: 'Park' }), { status: 200, body: { ok: true, outcome: 'done', message: 'Park recorded. Foreman applies it on the next pass.' } });
  assert.deepEqual(failedReply(409, 'no'), { status: 409, body: { ok: false, outcome: 'failed', reason: 'no' } });
  assert.deepEqual(clearedReply('gone'), { status: 409, body: { ok: false, outcome: 'cleared', reason: 'gone' } });
  assert.equal(refusalReply({ status: 409, text: 'gone', cleared: true }).body.outcome, 'cleared');
  assert.equal(refusalReply({ status: 409, text: 'x' }).body.outcome, 'failed');
});
test('reply: the return anchor is the card, and anything odd falls back to the top', () => {
  assert.equal(backTo('att-fixlimit-7'), '/#att-fixlimit-7');
  for (const bad of ['', null, 'a b', 'x"y', '../x', 'a'.repeat(101), 'a#b']) assert.equal(backTo(bad), '/');
  assert.equal(wantsJson({ headers: { accept: 'application/json' } }), true);
  assert.equal(wantsJson({ headers: { accept: 'text/html' } }), false);
});
test('reply: a guard refusal is a failed reply in JSON, never a page or a redirect', () => {
  const seen = []; const send = jsonSend((c, ty, b, h) => seen.push([c, ty, b, h]));
  send(403, 'text/html; charset=utf-8', '<h1>No</h1><p>Bad <b>proof</b>.</p><p><a href="/">Back</a></p>');
  send(303, 'text/plain', 'too soon', { location: '/?notice=inbox-cooldown#x', 'retry-after': '1' });
  assert.equal(seen[0][0], 403); assert.deepEqual(JSON.parse(seen[0][2]), { ok: false, outcome: 'failed', reason: 'Bad proof .' });
  assert.equal(seen[1][0], 429); assert.equal(JSON.parse(seen[1][2]).outcome, 'failed'); assert.equal(seen[1][3]['retry-after'], '1');
});

test('route (script): a recorded click answers done; the server then renders the card as working, with no control to press twice', async t => {
  const s = await serve(t);
  const r = await s.post({ card: 'fixlimit-7', control: 'park', back: 'att-fixlimit-7' });
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(r.body), { ok: true, outcome: 'done', message: 'Park recorded. Foreman applies it on the next pass.' });
  assert.equal(allStatuses(s.inboxDir).length, 1);
  const page = (await s.get('/')).body, card = page.slice(page.indexOf('att-fixlimit-7'));
  assert.match(card, /data-state="working"[^>]*>Working: Park recorded/);
  assert.ok(!/name="control" value="park"/.test(page), 'the pressed control is not offered again while it waits');
});
test('route (script): a card that has already cleared answers cleared and changes nothing', async t => {
  const s = await serve(t);
  const r = await s.post({ card: 'fixlimit-999', control: 'park' });
  assert.equal(r.status, 409);
  const j = JSON.parse(r.body); assert.equal(j.ok, false); assert.equal(j.outcome, 'cleared'); assert.match(j.reason, /already cleared.*Nothing was changed/);
  assert.equal(allStatuses(s.inboxDir).length, 0);
});
test('route (script): refusals answer failed with their reason and change nothing', async t => {
  const s = await serve(t);
  const noControl = JSON.parse((await s.post({ card: 'fixlimit-7', control: 'merge' })).body);
  assert.equal(noControl.outcome, 'failed'); assert.match(noControl.reason, /no longer applies/);
  const proof = await s.post({ card: 'fixlimit-7', control: 'park' }, { proof: 'wrong' });
  assert.equal(proof.status, 403); assert.equal(JSON.parse(proof.body).outcome, 'failed');
  assert.equal(allStatuses(s.inboxDir).length, 0);
  assert.equal((await s.post({ card: 'fixlimit-7', control: 'park' })).status, 200);
  const soon = await s.post({ card: 'fixlimit-7', control: 'park' });   // inside the cooldown
  assert.equal(soon.status, 429); assert.equal(JSON.parse(soon.body).outcome, 'failed'); assert.ok(soon.headers['retry-after']);
});
test('route (no script): a form post redirects to the card anchor; a refusal links back to it', async t => {
  const s = await serve(t);
  const gone = await s.post({ card: 'fixlimit-999', control: 'park', back: 'att-fixlimit-999' }, { json: false });
  assert.equal(gone.status, 409); assert.match(gone.body, /already cleared/); assert.match(gone.body, /href="\/#att-fixlimit-999"/);
  const ok = await s.post({ card: 'fixlimit-7', control: 'park', back: 'dec-fixlimit-7' }, { json: false });
  assert.equal(ok.status, 303); assert.equal(ok.headers.location, '/#dec-fixlimit-7');
  const none = await s.post({ card: 'fixlimit-7', control: 'park', back: 'bad anchor' }, { json: false });
  assert.equal(none.status, 303, 'a repeat inside the cooldown is a redirect back'); assert.match(none.headers.location, /^\/\?notice=inbox-cooldown/);
});
test('page: every control form carries the anchor of the card it sits in, in both lists', async t => {
  const s = await serve(t);
  const page = (await s.get('/')).body;
  assert.match(page, /name="control" value="park"><input type="hidden" name="back" value="att-fixlimit-7"/);
  assert.match(page, /name="control" value="park"><input type="hidden" name="back" value="dec-fixlimit-7"/);
  assert.match(page, /<li id="dec-fixlimit-7" class="inbox-item approval-row"/);
  assert.match(page, /<details class="approvals" id="approvals"/);
});
test('card html: no pending click means no working text; a pending one hides only its own control', () => {
  const card = { type: 'x', reason: 'r', clears: 'clears', controls: [{ action: 'park', label: 'Park', does: 'd' }, { action: 'unpark', label: 'Unpark', does: 'd' }] };
  const idle = decisionHtml({ id: 'a-1', card }, 'att-a-1');
  assert.match(idle, /data-state="idle" hidden>/); assert.match(idle, /value="park"/);
  const busy = decisionHtml({ id: 'a-1', card: { ...card, pending: ['park'] } }, 'att-a-1');
  assert.ok(!/value="park"/.test(busy)); assert.match(busy, /value="unpark"/); assert.match(busy, /Working: Park recorded/);
});

test('script logic: settle turns every reply into done, failed or cleared with words', () => {
  assert.deepEqual(settle({ ok: true, outcome: 'done', message: 'Park recorded.' }), { state: 'done', text: 'Park recorded.' });
  assert.deepEqual(settle({ ok: false, outcome: 'cleared', reason: 'gone' }), { state: 'cleared', text: 'gone' });
  assert.deepEqual(settle({ ok: false, outcome: 'failed', reason: 'no' }), { state: 'failed', text: 'no' });
  assert.equal(settle({ ok: false, reason: 'proxy' }).state, 'failed');
  assert.equal(settle({ ok: false, outcome: 'done', reason: 'odd' }).state, 'failed', 'a refusal can never read as done');
  assert.equal(settle(null).state, 'failed'); assert.ok(settle(null).text.length > 10);
});
test('script logic: controls go off before the answer; done and cleared move focus on; failed gives the controls back and keeps focus', async () => {
  for (const [reply, state, moves] of [[{ ok: true, message: 'm' }, 'done', 1], [{ ok: false, outcome: 'cleared', reason: 'g' }, 'cleared', 1], [{ ok: false, outcome: 'failed', reason: 'f' }, 'failed', 0]]) {
    const log = [];
    const got = await runCardAction({ post: async () => { log.push('post'); return reply; }, ui: { working: () => log.push('working'), show: s => log.push(`show:${s}`), unlock: () => log.push('unlock'), moveFocus: () => log.push('focus') } });
    assert.equal(got, state);
    assert.deepEqual(log, ['working', 'post', `show:${state}`, ...(moves ? ['focus'] : ['unlock'])]);
  }
  assert.equal(WORKING, 'Working…');
});
test('script logic: focus goes to the next card, or to the list heading after the last', () => {
  assert.equal(focusTargetAfter(['a', 'b', 'c'], 0, 'H'), 'b');
  assert.equal(focusTargetAfter(['a', 'b', 'c'], 2, 'H'), 'H');
  assert.equal(focusTargetAfter(['a'], 0, 'H'), 'H');
});
test('script logic: the open section is the address; closing clears only its own fragment', () => {
  const inside = id => id === 'dec-x';
  assert.equal(nextHash({ open: true, hash: '' }, inside), '#approvals');
  assert.equal(nextHash({ open: true, hash: '#dec-x' }, inside), '#dec-x', 'a link to a card inside keeps its fragment');
  assert.equal(nextHash({ open: false, hash: '#approvals' }, inside), '');
  assert.equal(nextHash({ open: false, hash: '#dec-x' }, inside), '');
  assert.equal(nextHash({ open: false, hash: '#other' }, inside), '#other');
});
