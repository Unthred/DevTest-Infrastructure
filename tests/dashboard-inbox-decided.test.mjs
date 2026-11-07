// Issue #856: the dashboard inbox shows what was chosen. Decision state and undo (store), the JSON answers of the write route, the
// "Decided today" list and the count on the page, and the browser logic (both buttons off at once, a refusal giving them back).
// Fixtures are built at run time; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { postDecision, runDecision, lowerCount, PRESSED, OUTCOME_TEMPLATE } from '../supervisor/dashui/inbox-ui.mjs';

const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
function makeInbox(t) { const dir = tmp(t, 'inbox856-'); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status')); return dir; }
const drop = (dir, item) => { const id = hex(16); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const GOOD = n => ({ kind: 'prompt', title: `Tidy docs ${n}`, prompt: `Fix the broken link number ${n}.` });
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };

async function serve(t, inboxDir) {
  const root = tmp(t, 'dash856-'); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { now: Date.now() };
  server.on('request', handler({ root, config: { ...config, inbox: { dir: inboxDir } }, host: '127.0.0.1', port, now: () => clock.now }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject); r.end(body); });
  const post = (id, decision, { proof = writeToken(root), origin = `http://127.0.0.1:${port}`, json = true } = {}) => req('POST', '/inbox', { headers: { ...(origin ? { origin } : {}), ...(json ? { accept: 'application/json' } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body: `id=${id}&decision=${decision}&proof=${proof}` });
  return { root, clock, get: p => req('GET', p), post };
}
const view = async s => JSON.parse((await s.get('/api/view.json')).body);

// ---- store
test('decide keeps the decision, the time and the title; undo inside the window restores pending and leaves no decision', () => {
  const dir = makeInbox({ after() {} }); try {
    const id = drop(dir, GOOD(1)); inbox.scan(dir, 1000);
    const r = inbox.decide(dir, id, 'approve', 5000);
    assert.deepEqual([r.ok, r.state, r.decidedAt, r.undoUntil], [true, 'approved', 5000, 5000 + inbox.UNDO_MS]);
    const s = inbox.statusOf(dir, id); assert.equal(s.decision, 'approve'); assert.equal(s.title, 'Tidy docs 1');
    assert.deepEqual(inbox.approvedItems(dir, 'prompt').map(x => x.id), [id]);
    const u = inbox.undo(dir, id, 5000 + 1000); assert.equal(u.ok, true);
    const back = inbox.statusOf(dir, id);
    assert.equal(back.state, 'pending'); for (const k of ['decision', 'decidedAt', 'title', 'result']) assert.ok(!(k in back), `${k} removed`);
    assert.deepEqual(inbox.approvedItems(dir, 'prompt'), [], 'nothing is left to act on');
    assert.equal(inbox.decidedCards(dir, 6000).length, 0);
    assert.equal(inbox.decide(dir, id, 'reject', 7000).ok, true, 'it can be decided again, either way');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('undo is refused after the window, once Foreman has acted, for a pending item and for an unknown one', () => {
  const dir = makeInbox({ after() {} }); try {
    const a = drop(dir, GOOD(1)), b = drop(dir, GOOD(2)); inbox.scan(dir, 1000);
    inbox.decide(dir, a, 'approve', 5000); inbox.decide(dir, b, 'reject', 5000);
    assert.match(inbox.undo(dir, a, 5000 + inbox.UNDO_MS + 1).reason, /window has passed/);
    assert.equal(inbox.undo(dir, b, 5000 + inbox.UNDO_MS).ok, true, 'the last moment of the window still counts');
    inbox.decide(dir, b, 'approve', 9000);
    inbox.finish(dir, a, { state: 'running' }, 6000);
    const r = inbox.undo(dir, a, 6500); assert.equal(r.ok, false); assert.match(r.reason, /already running.*cannot be undone/);
    assert.equal(inbox.statusOf(dir, a).state, 'running', 'unchanged');
    assert.match(inbox.undo(dir, 'f'.repeat(32), 1).reason, /unknown/);
    const c = drop(dir, GOOD(3)); inbox.scan(dir, 10000); assert.match(inbox.undo(dir, c, 10001).reason, /already pending/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('decidedCards: today only, newest first, undo offered only inside the window and only while not acted on', () => {
  const dir = makeInbox({ after() {} }); try {
    const noon = new Date(); noon.setHours(12, 0, 0, 0); const T = noon.getTime();
    const [a, b, c] = [1, 2, 3].map(n => drop(dir, GOOD(n))); inbox.scan(dir, T - 1e6);
    inbox.decide(dir, a, 'approve', T - 3600000); inbox.decide(dir, b, 'reject', T - 60000); inbox.decide(dir, c, 'approve', T - 5000);
    inbox.finish(dir, a, { state: 'running' }, T - 3000000);
    const cards = inbox.decidedCards(dir, T);
    assert.deepEqual(cards.map(x => x.id), [c, b, a]);
    assert.deepEqual(cards.map(x => x.undoUntil !== null), [true, false, false]);
    assert.deepEqual(cards.map(x => x.decision), ['approve', 'reject', 'approve']);
    const yesterday = inbox.decidedCards(dir, T + 86400000 + 1000); assert.equal(yesterday.length, 0, 'a new day starts with an empty list');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the write route
test('route: a JSON decision answers with the state and undo time; the card leaves Needs you at once and is under Decided today with its outcome', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)), b = drop(dir, GOOD(2)); inbox.scan(dir, 1000);
  const s = await serve(t, dir);
  assert.equal((await view(s)).panels.needsYou.filter(x => x.inbox).length, 2);
  const page0 = (await s.get('/')).body; assert.match(page0, /<details class="inbox-decided" hidden>/, 'an empty list is ready for the script to fill'); assert.match(page0, /<span class="inbox-outcome" hidden><\/span>/);
  assert.match(page0, /<div class="inbox-err" role="alert" hidden>/);
  const r = await s.post(a, 'approve'); assert.equal(r.status, 200); assert.match(r.headers['content-type'], /json/);
  const j = JSON.parse(r.body); assert.equal(j.ok, true); assert.equal(j.state, 'approved'); assert.equal(j.undoUntil - j.decidedAt, inbox.UNDO_MS);
  const v = await view(s);
  assert.deepEqual(v.panels.needsYou.filter(x => x.inbox).map(x => x.id), [`inbox-${b}`], 'only the undecided card remains');
  assert.equal(v.panels.inboxDecided.length, 1);
  const page = (await s.get('/')).body;
  assert.ok(!page.includes(`data-inbox="${a}"`), 'the decided card is gone from the pending list');
  assert.match(page, /<summary>Decided today \(<span class="inbox-decided-n">1<\/span>\)<\/summary>/);
  assert.match(page, new RegExp(`data-decided="${a}"><span class="inbox-title">Tidy docs 1</span> <span class="inbox-tag">.*?</span></span> <span class="inbox-outcome approved" data-lms="${j.decidedAt}" data-tpl="Approved {t}, waiting for a free slot" data-tonly>Approved \\d\\d:\\d\\d UTC, waiting for a free slot</span>`));
  assert.match(page, /name="decision" value="undo"/);
  assert.match(page, /Needs you \(1\)/, 'the count dropped');
});
test('route: Reject is shown as Rejected, newest decision first; the plain form post still redirects', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)), b = drop(dir, GOOD(2)); inbox.scan(dir, 1000);
  const s = await serve(t, dir);
  assert.equal((await s.post(a, 'approve', { json: false })).status, 303, 'without JSON the answer is the redirect');
  s.clock.now += 5000;
  assert.equal(JSON.parse((await s.post(b, 'reject')).body).state, 'rejected');
  const page = (await s.get('/')).body;
  assert.ok(page.indexOf(`data-decided="${b}"`) < page.indexOf(`data-decided="${a}"`), 'newest first');
  assert.match(page, /inbox-outcome rejected"[^>]*data-tpl="Rejected \{t\}"/);
});
test('route: a refused decision keeps its status, changes nothing and gives a reason as JSON (item decided already, cross-origin, bad proof, cooldown)', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)), b = drop(dir, GOOD(2)); inbox.scan(dir, 1000);
  const s = await serve(t, dir);
  const origin = await s.post(a, 'approve', { origin: 'http://evil.example' });
  assert.equal(origin.status, 403); assert.equal(JSON.parse(origin.body).ok, false); assert.match(JSON.parse(origin.body).reason, /not allowed|cross-origin/i); assert.ok(!origin.body.includes('<'), 'a reason, not a page');
  const proof = await s.post(a, 'approve', { proof: 'x'.repeat(64) }); assert.equal(proof.status, 403); assert.match(JSON.parse(proof.body).reason, /access proof/);
  assert.equal(inbox.statusOf(dir, a).state, 'pending');
  assert.equal((await s.post(a, 'approve')).status, 200);
  const quick = await s.post(b, 'approve'); assert.equal(quick.status, 429); assert.match(JSON.parse(quick.body).reason, /too soon/i);
  assert.equal(inbox.statusOf(dir, b).state, 'pending');
  s.clock.now += 5000;
  const twice = await s.post(a, 'reject'); assert.equal(twice.status, 409); assert.match(JSON.parse(twice.body).reason, /already approved/);
  assert.equal(inbox.statusOf(dir, a).state, 'approved');
  // the item changed after the card was shown: approving is refused with the reason, and it is not run
  const item = path.join(dir, 'items', `${b}.json`); fs.writeFileSync(item, JSON.stringify({ ...GOOD(2), prompt: 'A different prompt than the one shown.' }));
  s.clock.now += 5000;
  const changed = await s.post(b, 'approve'); assert.equal(changed.status, 409); assert.match(JSON.parse(changed.body).reason, /changed after/);
  assert.notEqual(inbox.statusOf(dir, b).state, 'approved');
});
test('route: Undo inside the window restores the pending card and records no decision; after the window or once acted on it is refused with a reason', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)), b = drop(dir, GOOD(2)); inbox.scan(dir, 1000);
  const s = await serve(t, dir);
  await s.post(a, 'approve'); s.clock.now += 2000;
  const u = await s.post(a, 'undo'); assert.equal(u.status, 200); assert.equal(JSON.parse(u.body).state, 'pending');
  assert.equal(inbox.statusOf(dir, a).state, 'pending'); assert.deepEqual(inbox.approvedItems(dir, 'prompt'), []);
  const v = await view(s); assert.equal(v.panels.needsYou.filter(x => x.inbox).length, 2); assert.equal(v.panels.inboxDecided.length, 0);
  s.clock.now += 2000; await s.post(b, 'reject'); s.clock.now += inbox.UNDO_MS + 1000;
  const late = await s.post(b, 'undo'); assert.equal(late.status, 409); assert.match(JSON.parse(late.body).reason, /window has passed/);
  assert.equal(inbox.statusOf(dir, b).state, 'rejected');
  assert.ok(!(await s.get('/')).body.includes('value="undo"'), 'no Undo is offered after the window');
  s.clock.now += 5000; inbox.finish(dir, a, { state: 'running' }, s.clock.now);   // acted on without a decision record: not an undoable state
  assert.equal((await s.post(a, 'undo')).status, 409);
});
test('route: an unknown decision word is still a bad request', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)); inbox.scan(dir, 1000); const s = await serve(t, dir);
  assert.equal((await s.post(a, 'delete')).status, 400);
});
test('script is served and the page loads it', async t => {
  const dir = makeInbox(t); const s = await serve(t, dir);
  const r = await s.get('/static/inbox-ui.mjs'); assert.equal(r.status, 200); assert.match(r.headers['content-type'], /javascript/);
  assert.match((await s.get('/static/app.js')).body, /from '\.\/inbox-ui\.mjs'/);
});

// ---- the browser logic (no DOM: app.js hands in what to disable, label and show)
const fakeUi = () => { const log = []; return { log, ui: { lock: l => log.push(['lock', l]), unlock: () => log.push(['unlock']), error: e => log.push(['error', e]), decided: j => log.push(['decided', j.state]) } }; };
test('script: Approve locks both buttons and labels the pressed one before the answer arrives, then reports the decided card', async () => {
  const { log, ui } = fakeUi(); let release;
  const pending = runDecision({ decision: 'approve', ui, post: () => new Promise(r => { release = () => r({ ok: true, state: 'approved' }); }) });
  assert.deepEqual(log, [['error', null], ['lock', 'Approved ✓']], 'locked while the post is in flight');
  release(); await pending;
  assert.deepEqual(log.slice(2), [['decided', 'approved']]);
  assert.equal(PRESSED.reject, 'Rejected ✗');
});
test('script: a refusal enables the buttons again and shows the reason inline', async () => {
  const { log, ui } = fakeUi();
  const r = await runDecision({ decision: 'reject', ui, post: async () => ({ ok: false, reason: 'the dashboard could not be reached' }) });
  assert.equal(r.ok, false);
  assert.deepEqual(log, [['error', null], ['lock', 'Rejected ✗'], ['unlock'], ['error', 'Not recorded: the dashboard could not be reached']]);
  await assert.rejects(runDecision({ decision: 'maybe', ui, post: async () => ({}) }));
});
test('script: a refusal saying the item is already decided keeps the buttons off and says so; a second decision does nothing', async () => {
  const log = []; const ui = { lock: l => log.push(['lock', l]), unlock: () => log.push(['unlock']), error: e => log.push(['error', e]), decided: () => log.push(['decided']), settled: t => log.push(['settled', t]) };
  const r = await runDecision({ decision: 'approve', ui, post: async () => ({ ok: false, reason: 'the item is already approved' }) });
  assert.equal(r.ok, false);
  assert.deepEqual(log, [['error', null], ['lock', 'Approved ✓'], ['settled', 'Already decided: it is already approved. Nothing was changed.']]);
  assert.ok(!log.some(x => x[0] === 'unlock' || x[0] === 'decided'));
  assert.ok(OUTCOME_TEMPLATE.approve.endsWith('waiting for a free slot') && OUTCOME_TEMPLATE.reject === 'Rejected {t}');
});
test('route: a second click on an approved item is refused and changes nothing; once the tick took it the row reads plain Approved', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)); inbox.scan(dir, 1000); const s = await serve(t, dir);
  assert.equal((await s.post(a, 'approve')).status, 200);
  s.clock.now += 5000; const again = await s.post(a, 'reject'); assert.equal(again.status, 409); assert.match(JSON.parse(again.body).reason, /^the item is already approved/);
  assert.equal(inbox.statusOf(dir, a).decision, 'approve');
  inbox.finish(dir, a, { state: 'running' });
  const page = (await s.get('/')).body; assert.match(page, new RegExp(`data-decided="${a}">[^]*?>Approved \\d\\d:\\d\\d UTC</span>`));
  assert.ok(!page.includes('waiting for a free slot'));
});
test('script: postDecision turns a server refusal, a non-JSON page and a network failure into a reason, never a success', async () => {
  const res = (status, body) => async () => ({ status, json: async () => JSON.parse(body) });
  assert.deepEqual(await postDecision(res(409, '{"ok":false,"reason":"cooldown"}'), '/inbox', { id: 'x' }), { ok: false, reason: 'cooldown' });
  assert.equal((await postDecision(res(200, '{"ok":true,"state":"approved"}'), '/inbox', {})).ok, true);
  const html = await postDecision(async () => ({ status: 502, json: async () => { throw new SyntaxError('not json'); } }), '/inbox', {});
  assert.deepEqual([html.ok, html.reason], [false, 'The dashboard refused the decision (HTTP 502).']);
  assert.equal((await postDecision(res(200, '{"ok":false}'), '/inbox', {})).ok, false, 'a refusal with no reason still reads as refused');
  assert.match((await postDecision(async () => { throw new Error('offline'); }, '/inbox', {})).reason, /could not be reached/);
  let sent; await postDecision(async (u, o) => { sent = o; return res(200, '{"ok":true}')(); }, '/inbox', { id: 'a', decision: 'approve' });
  assert.equal(sent.headers.accept, 'application/json'); assert.equal(sent.body, 'id=a&decision=approve');
});
test('script: the Needs you count drops with the card and disappears at zero', () => {
  assert.equal(lowerCount('Needs you (3)'), 'Needs you (2)'); assert.equal(lowerCount('Needs you (1)'), 'Needs you'); assert.equal(lowerCount('Needs you'), 'Needs you');
});

// ---- issue #977: ids, search, direct link
import { filterListRows } from '../supervisor/dashui/lists.mjs';
test('#977: a pending item shows its short id and kind as a link, with the full id findable by search', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)); inbox.scan(dir, 1000);
  const page = (await (await serve(t, dir)).get('/')).body;
  assert.ok(page.includes(`<a class="inbox-id" href="/inbox/${a}" title="Direct link to this item"><code>${a.slice(0, 8)}</code></a> <span class="inbox-kind">prompt</span><span class="inbox-fullid" hidden>${a}</span>`));
  assert.ok(!page.includes(`<code>${a.slice(0, 9)}`), 'only eight characters are shown');
});
test('#977: /inbox/<id> redirects a waiting item to its card (full or short id); a decided one gets a state page; unknown, malformed and ambiguous ids are refused', async t => {
  const dir = makeInbox(t), a = drop(dir, GOOD(1)), b = drop(dir, GOOD(2)); inbox.scan(dir, 1000);
  const s = await serve(t, dir);
  for (const id of [a, a.slice(0, 8)]) { const r = await s.get(`/inbox/${id}`); assert.equal(r.status, 302); assert.equal(r.headers.location, `/#att-inbox-${a}`); }
  const n = (await s.post(b, 'reject')); assert.equal(n.status, 200);
  const r = await s.get(`/inbox/${b}`); assert.equal(r.status, 200); assert.match(r.body, /State: rejected/); assert.match(r.body, /Title: Tidy docs 2/);
  assert.equal((await s.get(`/inbox/${'0'.repeat(32)}`)).status, 404);
  assert.equal((await s.get('/inbox/zzzzzzzz')).status, 404, 'a malformed id is not a route');
  assert.equal((await s.get(`/inbox/${a}/x`)).status, 404);
  const c = 'ab'.repeat(16), d = 'ab' + 'cd'.repeat(15) + 'ef'; fs.writeFileSync(path.join(dir, 'items', `${c}.json`), JSON.stringify(GOOD(3))); fs.writeFileSync(path.join(dir, 'items', `${d}.json`), JSON.stringify(GOOD(4))); inbox.scan(dir, 2000);
  assert.equal((await s.get('/inbox/abababab')).status, 302, 'distinct 8-char prefixes still resolve');
  const e = 'ee' + 'a'.repeat(30), f = 'ee' + 'a'.repeat(28) + 'bb'; for (const [x, i] of [[e, 5], [f, 6]]) fs.writeFileSync(path.join(dir, 'items', `${x}.json`), JSON.stringify(GOOD(i))); inbox.scan(dir, 3000);
  assert.equal((await s.get('/inbox/eeaaaaaa')).status, 409, 'a short id shared by two items is refused');
});
test('#977: a posted draft shows the GitHub issue number as a link in the decided list', async t => {
  const dir = makeInbox(t), a = drop(dir, { kind: 'issue_draft', title: 'Draft one', body: 'Body text here.' }); inbox.scan(dir, Date.now());
  const s = await serve(t, dir); assert.equal((await s.post(a, 'approve')).status, 200);
  inbox.finish(dir, a, { state: 'done', issue: 321, result: 'posted as issue #321' }, Date.now());
  assert.match((await s.get('/')).body, /data-decided="[a-f0-9]{32}">[\s\S]*?href="\/work\/issue\/321"/);
});
test('#977: search finds an item by short id, full id, title and body, and ignores quote and dash differences', () => {
  const rows = [{ i: 0, text: 'Overseer proposal 35db929d 35db929d00112233445566778899aabb prompt Don’t stall — fix the log' }, { i: 1, text: 'Other item abcdef01 body about retries' }];
  const ids = q => filterListRows(rows, q).map(r => r.i);
  assert.deepEqual(ids('35db929d'), [0]); assert.deepEqual(ids('35db929d00112233445566778899aabb'), [0]);
  assert.deepEqual(ids("don't stall"), [0], 'straight apostrophe finds a curly one'); assert.deepEqual(ids('Don’t stall'), [0]);
  assert.deepEqual(ids('stall - fix'), [0], 'a hyphen finds an em dash'); assert.deepEqual(ids('stall – fix'), [0]); assert.deepEqual(ids('retries'), [1]);
  assert.deepEqual(ids('nomatch'), []);
});
