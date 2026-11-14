// Issue #1414: every Inbox card has a short running number ("C142") and shows its issue number once posted. Driven through the real
// Inbox store, the real foreman_propose path and the real dashboard handler, each with a temporary Inbox folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from '../supervisor/inbox.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { referenceText, numberFromReference } from '../foreman-mcp/inbox-reference.mjs';
import { reserveNumber } from '../foreman-mcp/inbox-reserve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROWS = "Inbox Table and Compact rows give the title the room, look like the Now card rows and carry the decision controls Inboxrows";
const LOOK = 'Inbox Table and Compact rows give the title the room and look like the Now card rows Inboxlook';
const hex = () => crypto.randomBytes(16).toString('hex');
const propose = (inbox, title) => inbox.propose({ kind: 'prompt', title, prompt: 'Read the page and report.' });
const stored = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'status', `${id}.json`), 'utf8'));

function makeInbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-number-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'items'));
  fs.mkdirSync(path.join(dir, 'status'));
  return dir;
}
// A status file as an older Foreman wrote it: no number.
function legacy(dir, title, createdAt, extra = {}) {
  const id = hex();
  fs.writeFileSync(path.join(dir, 'status', `${id}.json`), JSON.stringify({ id, state: 'done', kind: 'prompt', title, createdAt, updatedAt: createdAt + 1000, ...extra }));
  return id;
}

test('valid: two proposals get consecutive numbers, in the reply and in Foreman\'s record after pickup', t => {
  const dir = makeInbox(t);
  const inbox = createInbox({ dir });
  const first = propose(inbox, ROWS);
  const second = propose(inbox, LOOK);
  assert.deepEqual([first.number, second.number, first.reference, second.reference], [1, 2, 'C1', 'C2']);
  store.scan(dir);
  assert.equal(stored(dir, first.id).number, 1);
  assert.equal(stored(dir, second.id).number, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'items')).filter(n => n.startsWith('.n')), [], 'the reservations are used up');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'status', 'number.json'), 'utf8')), { last: 2 });
  assert.equal(propose(inbox, 'A third card').number, 3, 'the counter goes on after pickup');
});

test('the two cards of 14 Nov 2026 get different numbers and each is found by its own number', t => {
  const dir = makeInbox(t);
  const inbox = createInbox({ dir });
  const rows = propose(inbox, ROWS);
  const look = propose(inbox, LOOK);
  store.scan(dir);
  assert.notEqual(rows.number, look.number);
  const found = reference => inbox.list({ search: reference }).items.map(i => i.id);
  assert.deepEqual(found(look.reference), [look.id]);
  assert.deepEqual(found(rows.reference), [rows.id]);
  assert.equal(inbox.status(look.reference).id, look.id, 'foreman_proposal_status takes the reference');
  assert.equal(inbox.status(look.reference.toLowerCase()).id, look.id);
  assert.throws(() => inbox.status('C99'), /no such item/);
  assert.equal(inbox.status(rows.id).reference, rows.reference);
});

test('a number is known before Foreman has picked the item up, and the tools return it', async t => {
  const dir = makeInbox(t);
  const inbox = createInbox({ dir });
  const tools = createTools({ source: { get: async () => ({ view: { panels: { approvals: [] } }, ageMs: 0 }) }, readHost: () => ({}), inbox });
  const reply = JSON.parse((await tools.call('foreman_propose', { kind: 'prompt', title: ROWS, prompt: 'Read the page.' })).text);
  assert.equal(reply.reference, 'C1');
  assert.equal(inbox.status(reply.id).reference, 'C1', 'waiting state');
  const cards = JSON.parse((await tools.call('foreman_inbox', {})).text).cards;
  assert.deepEqual([cards[0].number, cards[0].reference], [1, 'C1']);
  store.scan(dir);
  const status = JSON.parse((await tools.call('foreman_proposal_status', { id: 'C1' })).text);
  assert.deepEqual([status.id, status.number, status.reference], [reply.id, 1, 'C1']);
  const items = JSON.parse((await tools.call('foreman_inbox_items', { search: 'C1' })).text);
  assert.equal(items.count, 1);
});

test('boundary: numbering existing items gives them numbers once, oldest first, and a second run changes nothing', t => {
  const dir = makeInbox(t);
  const newest = legacy(dir, 'Newest', 3000);
  const oldest = legacy(dir, 'Oldest', 1000);
  const middle = legacy(dir, 'Middle', 2000);
  store.scan(dir, 9000);
  assert.deepEqual([oldest, middle, newest].map(id => stored(dir, id).number), [1, 2, 3]);
  assert.equal(stored(dir, oldest).updatedAt, 2000, 'numbering does not restart the clean-up clock');
  const before = fs.readdirSync(path.join(dir, 'status')).sort().map(n => fs.readFileSync(path.join(dir, 'status', n), 'utf8'));
  store.scan(dir, 9500);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'status')).sort().map(n => fs.readFileSync(path.join(dir, 'status', n), 'utf8')), before);
  const fresh = createInbox({ dir });
  assert.equal(propose(fresh, 'After the upgrade').number, 4);
});

test('boundary: proposals arriving together in separate processes never share a number', async t => {
  const dir = makeInbox(t);
  const script = `import { reserveNumber } from ${JSON.stringify(path.join(here, '..', 'foreman-mcp', 'inbox-reserve.mjs'))};
    process.stdout.write(String(reserveNumber(process.argv[1], process.argv[2])));`;
  const run = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, id], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => (code === 0 ? resolve(Number(out)) : reject(new Error(`exit ${code}`))));
  });
  const numbers = await Promise.all(Array.from({ length: 8 }, () => run(hex())));
  assert.equal(new Set(numbers).size, 8, `numbers were ${numbers}`);
  assert.equal(Math.min(...numbers), 1);
  assert.equal(Math.max(...numbers), 8);
});

test('boundary: a reserved number that Foreman already gave away is not adopted twice', t => {
  const dir = makeInbox(t);
  const inbox = createInbox({ dir });
  const first = propose(inbox, ROWS);
  store.scan(dir);
  assert.equal(stored(dir, first.id).number, 1);
  // A reader with a stale counter reserves number 1 again for the second proposal.
  const second = hex();
  fs.writeFileSync(path.join(dir, 'items', '.n1'), second);
  fs.writeFileSync(path.join(dir, 'items', `${second}.json`), JSON.stringify({ kind: 'prompt', title: LOOK, prompt: 'Read the page.' }));
  store.scan(dir);
  assert.equal(stored(dir, second).number, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'items')).filter(n => n.startsWith('.n')), []);
});

test('invalid: a damaged counter file is rebuilt from the highest number in use, not reset to one', t => {
  const dir = makeInbox(t);
  legacy(dir, 'Old', 1000, { number: 41 });
  fs.writeFileSync(path.join(dir, 'status', 'number.json'), '{ this is not json');
  const inbox = createInbox({ dir });
  assert.equal(propose(inbox, ROWS).number, 42);
  store.scan(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'status', 'number.json'), 'utf8')), { last: 42 });
  fs.writeFileSync(path.join(dir, 'status', 'number.json'), JSON.stringify({ last: -5 }));
  assert.equal(propose(inbox, LOOK).number, 43, 'a counter that is not a positive whole number counts for nothing');
});

test('the reference text names the issue only for a real posted issue', () => {
  assert.equal(referenceText(142, null), 'C142');
  assert.equal(referenceText(142, 1411), 'C142, issue #1411');
  assert.equal(referenceText(142, 900000123), 'C142', 'a placeholder issue number is never shown');
  assert.equal(referenceText(null, 1411), null);
  assert.equal(referenceText(0, 5), null);
  assert.equal(numberFromReference(' c142 '), 142);
  assert.equal(numberFromReference('C14x'), null);
  assert.equal(numberFromReference('1411'), null);
  assert.throws(() => reserveNumber('/nonexistent-inbox-dir', hex()));
});

async function serve(t, dir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-number-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [] }));
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } }, inbox: { dir } };
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  return p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
}

test('the Inbox page shows the reference at the start of the title in Cards, Table and Compact, and finds a card by it', async t => {
  const dir = makeInbox(t);
  const inbox = createInbox({ dir });
  const rows = propose(inbox, ROWS);
  const look = propose(inbox, LOOK);
  store.scan(dir);
  const get = await serve(t, dir);
  const page = await get('/inbox?state=all');
  assert.equal(page.status, 200);
  assert.match(page.body, /Inbox/);
  for (const reference of [rows.reference, look.reference]) {
    assert.ok(page.body.includes(`<h3 class="inbox-title t"><span class="inbox-ref">${reference}</span> `), `card ${reference}`);
    assert.equal([...page.body.matchAll(new RegExp(`<span class="iv-title"><span class="inbox-ref">${reference}</span> `, 'g'))].length, 2, `table and compact ${reference}`);
  }
  const found = await get(`/inbox?state=all&search=${look.reference}`);
  assert.ok(found.body.includes(look.id));
  assert.ok(!found.body.includes(rows.id), 'the other card is not found by this number');
  const none = await get('/inbox?state=all&search=C99');
  assert.ok(!none.body.includes(look.id) && !none.body.includes(rows.id));
});

test('a posted item shows its issue number beside the reference, on the page, in the card page, the API and the tools', async t => {
  const dir = makeInbox(t);
  const inbox = createInbox({ dir });
  const sent = inbox.propose({ kind: 'issue_draft', title: 'Post this one', body: 'A body.' });
  store.scan(dir);
  store.decide(dir, sent.id, 'approve');
  store.finish(dir, sent.id, { state: 'done', issue: 1411, result: 'posted as issue #1411' });
  const get = await serve(t, dir);
  const page = await get('/inbox?state=all');
  assert.ok(page.body.includes('<span class="inbox-ref">C1, issue #1411</span> '));
  assert.match((await get(`/inbox/${sent.id}`)).body, /Reference: C1, issue #1411/);
  const api = JSON.parse((await get('/api/v1/inbox')).body).data.items[0];
  assert.deepEqual([api.number, api.reference], [1, 'C1, issue #1411']);
  assert.equal(inbox.status(sent.id).reference, 'C1, issue #1411');
  assert.equal(inbox.list({ search: 'C1' }).items[0].reference, 'C1, issue #1411');
  assert.equal(inbox.list({ search: 'issue 1411' }).count, 1);
});
