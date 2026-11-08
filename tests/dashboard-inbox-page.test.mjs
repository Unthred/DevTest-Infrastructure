// Issue #884: the Inbox card and page. One compact row per overseer proposal (kind, title, short id, time, why, Approve/Reject), its own search text,
// duplicate flags, the bulk write route with the strong-confirm exclusion, Markdown for issue drafts, and the Needs you summary line.
// Fixtures are built at run time; no model is called.
import { removeLater } from './_tmp-leaks.mjs';
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
import { renderMarkdown } from '../supervisor/markdown.mjs';
import { filterListRows } from '../supervisor/dashui/lists.mjs';
import { bulkLabel, bulkSummary, pickedIds } from '../supervisor/dashui/inbox-ui.mjs';

const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
function makeInbox(t) { const dir = tmp(t, 'inbox884-'); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status')); return dir; }
const drop = (dir, item) => { const id = hex(16); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const PROMPT = (title, why) => ({ kind: 'prompt', title, prompt: `Do the thing called ${title}.`, ...(why ? { why } : {}) });
const DRAFT = (title, body, why) => ({ kind: 'issue_draft', title, body, ...(why ? { why } : {}) });
const ACTION = (title, target) => ({ kind: 'action', title, action: 'stop_job', target, reason: 'Nothing moved for a day.' });
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };

async function serve(t, inboxDir) {
  const root = tmp(t, 'dash884-'); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', body: '', labels: [] }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); })); removeLater(root);
  const port = server.address().port, clock = { now: Date.now() };
  server.on('request', handler({ wake: () => {}, root, config: { ...config, inbox: { dir: inboxDir } }, host: '127.0.0.1', port, now: () => clock.now }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject); r.end(body); });
  const bulk = (ids, decision, { proof = writeToken(root), json = true } = {}) => req('POST', '/inbox', { headers: { origin: `http://127.0.0.1:${port}`, ...(json ? { accept: 'application/json' } : {}), 'content-type': 'application/x-www-form-urlencoded' },
    body: [`bulk=1`, `decision=${decision}`, `proof=${proof}`, ...ids.map(i => `id=${i}`)].join('&') });
  return { root, clock, get: p => req('GET', p), bulk };
}
const rowOf = (html, id) => new RegExp(`<li [^>]*id="att-inbox-${id}"[\\s\\S]*?</li>`).exec(html)?.[0] || '';
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const searchOf = row => /data-search="([^"]*)"/.exec(row)?.[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"') ?? '';

test('Needs you carries one summary line, the proposals are in their own Inbox card and page, and the page lists one row each', async t => {
  const dir = makeInbox(t), a = drop(dir, PROMPT('Project board update: one GraphQL rate limit', 'The board query hits the limit.')), b = drop(dir, DRAFT('Retire the old script', '# Heading\n\nSome **bold** text.', 'It is dead code.'));
  inbox.scan(dir, Date.now() - 120000);
  const s = await serve(t, dir);
  const v = JSON.parse((await s.get('/api/view.json')).body);
  assert.equal(v.panels.inbox.length, 2);
  const lines = v.panels.needsYou.filter(x => /^inbox/.test(x.id));
  assert.equal(lines.length, 1, 'one summary item, not one per proposal');
  assert.equal(lines[0].text, '2 overseer proposals waiting'); assert.deepEqual(lines[0].links, [{ url: '/inbox', text: 'Open the Inbox' }]);
  assert.ok(!v.panels.needsYou.some(x => x.inbox), 'no proposal body inside Needs you');
  const home = (await s.get('/')).body;
  assert.ok(!/inbox-text/.test(home.slice(home.indexOf('data-card="needs"'), home.indexOf('data-card="later"'))), 'Needs you has no code block of a proposal');
  assert.match(home, /<h2 id="h-inbox">Inbox \(2\)<\/h2>/);
  const page = await s.get('/inbox'); assert.equal(page.status, 200);
  assert.match(page.body, /<title>Inbox · DevTest team<\/title>/);
  for (const [id, title, kind] of [[a, 'Project board update: one GraphQL rate limit', 'prompt job'], [b, 'Retire the old script', 'issue draft']]) {
    const row = rowOf(page.body, id), txt = textOf(row);
    assert.ok(row, `row for ${id.slice(0, 8)}`);
    assert.ok(txt.includes(title) && txt.includes(id.slice(0, 8)) && txt.includes(kind) && /Submitted .*ago/.test(txt), txt);
    assert.match(row, /class="btn inbox-approve"/); assert.match(row, /class="btn inbox-reject"/);
    assert.match(row, /<details class="inbox-more">/);
  }
  assert.match(rowOf(page.body, a), /Why: The board query hits the limit\./);
  assert.match(rowOf(page.body, b), /<h3 class="md-h">Heading<\/h3><p>Some <strong>bold<\/strong> text\.<\/p>/, 'an issue draft body is rendered as Markdown');
  assert.match(rowOf(page.body, a), /<pre class="inbox-text">Do the thing called/, 'a prompt stays plain text');
  assert.match(rowOf(page.body, a), /Content hash [0-9a-f]{12}/, 'the hash is under the body');
  assert.match(page.body, /data-dlist="inbox"[^>]*>.*?class="dl-q"/s, 'search is offered with only two rows');
});

test('the search text of a row is title, short id, full id, kind and why: each finds the row, the body does not', async t => {
  const dir = makeInbox(t);
  const ids = [drop(dir, PROMPT('Project board update: one GraphQL rate', 'Because of the limit')), drop(dir, DRAFT('Retire the old script', 'zebra-only-in-body', 'It is dead code')), drop(dir, ACTION('Stop the stuck job', 'abcdef01'))];
  inbox.scan(dir, Date.now() - 1000);
  const s = await serve(t, dir), page = (await s.get('/inbox')).body;
  const rows = ids.map((id, i) => ({ id, i, text: searchOf(rowOf(page, id)), num: null }));
  const find = q => filterListRows(rows, q).map(r => r.id);
  assert.deepEqual(find('graphql rate'), [ids[0]], 'part of the title');
  assert.deepEqual(find('Project board update: one GraphQL rate'), [ids[0]], 'the whole title, with its colon');
  assert.deepEqual(find(ids[1].slice(0, 8)), [ids[1]], 'the 8-character id');
  assert.deepEqual(find(ids[2]), [ids[2]], 'the full id');
  assert.deepEqual(find('issue draft'), [ids[1]], 'kind: issue draft');
  assert.deepEqual(find('prompt job'), [ids[0]], 'kind: prompt job');
  assert.deepEqual(find('action'), [ids[2]], 'kind: action');
  assert.deepEqual(find('dead code'), [ids[1]], 'why');
  assert.deepEqual(find('moved for a day'), [ids[2]], 'why of an action is its reason');
  assert.match(rowOf(page, ids[2]), /Why: Nothing moved for a day/, 'the action row shows a why line');
  assert.deepEqual(find('zebra'), [], 'the body is not searched');
  assert.deepEqual(find('nothing like this'), []);
  assert.deepEqual(find('RETIRE   the'), [ids[1]], 'case and spacing do not matter');
  // curly quotes, dashes: a title typed with straight characters still matches (punctuation folding, issue #977). This is a regression guard on the Inbox rows; the cause of the Needs you miss reported in #884 is not established (see the pull request).
  const curly = drop(dir, PROMPT('Don’t block – retry later', 'x')); inbox.scan(dir, Date.now());
  const page2 = (await s.get('/inbox')).body;
  assert.equal(filterListRows([{ text: searchOf(rowOf(page2, curly)), num: null }], "don't block - retry").length, 1);
});

test('same-titled proposals are flagged as possible duplicates and the newer one is marked; different titles are not', async t => {
  const dir = makeInbox(t);
  const old = drop(dir, PROMPT('Tidy the docs', 'first')); inbox.scan(dir, 1000);
  const mid = drop(dir, PROMPT('tidy  the DOCS', 'second')), other = drop(dir, PROMPT('Something else', 'third')); inbox.scan(dir, 2000);
  const cards = inbox.markDuplicates(inbox.pendingCards(dir));
  const by = id => cards.find(c => c.id === id);
  assert.deepEqual(by(old).duplicate, { copies: 2, newer: false }); assert.deepEqual(by(mid).duplicate, { copies: 2, newer: true }); assert.equal(by(other).duplicate, undefined);
  const s = await serve(t, dir), page = (await s.get('/inbox')).body;
  assert.match(textOf(rowOf(page, mid)), /Possible duplicate: 2 with this title, this is the newer one/);
  assert.match(textOf(rowOf(page, old)), /Possible duplicate: 2 with this title, a newer one exists/);
  assert.ok(!/Possible duplicate/.test(textOf(rowOf(page, other))));
  assert.match(searchOf(rowOf(page, old)), /possible duplicate/, 'a search for "duplicate" finds the flagged rows');
});

test('bulk approve and reject decide each selected item once, and report a refusal per item without stopping the others', async t => {
  const dir = makeInbox(t), ids = [1, 2, 3, 4].map(n => drop(dir, PROMPT(`Task ${n}`)));
  inbox.scan(dir, Date.now() - 1000);
  const s = await serve(t, dir);
  const r = await s.bulk([ids[0], ids[1]], 'approve'); assert.equal(r.status, 200);
  const j = JSON.parse(r.body); assert.equal(j.ok, true); assert.deepEqual(j.results.map(x => [x.id, x.ok, x.state]), [[ids[0], true, 'approved'], [ids[1], true, 'approved']]);
  assert.equal(inbox.statusOf(dir, ids[0]).state, 'approved'); assert.equal(inbox.statusOf(dir, ids[2]).state, 'pending', 'unselected items are untouched');
  s.clock.now += 5000;
  const again = JSON.parse((await s.bulk([ids[1], ids[2], ids[3]], 'reject')).body);
  assert.deepEqual(again.results.map(x => [x.ok, x.ok ? x.state : x.reason]), [[false, 'the item is already approved'], [true, 'rejected'], [true, 'rejected']]);
  assert.equal(inbox.statusOf(dir, ids[1]).state, 'approved', 'a refused one is not changed');
  s.clock.now += 5000;
  const none = await s.bulk([ids[0]], 'approve'); assert.equal(none.status, 409, 'every item refused = an error answer');
  assert.match(JSON.parse(none.body).reason, /already approved/);
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(audit.filter(e => e.event === 'approved').length, 2); assert.equal(audit.filter(e => e.event === 'rejected').length, 2);
});

test('bulk is refused without the access proof, with nothing selected, with a bad id or a bad decision; a plain form post redirects to the Inbox', async t => {
  const dir = makeInbox(t), id = drop(dir, PROMPT('One')); inbox.scan(dir, Date.now() - 1000);
  const s = await serve(t, dir);
  assert.equal((await s.bulk([id], 'approve', { proof: 'wrong' })).status, 403);
  assert.equal((await s.bulk([], 'approve')).status, 400);
  assert.equal((await s.bulk(['not-an-id'], 'approve')).status, 400);
  assert.equal((await s.bulk([id], 'undo')).status, 400);
  assert.equal(inbox.statusOf(dir, id).state, 'pending', 'nothing changed');
  const plain = await s.bulk([id], 'approve', { json: false }); assert.equal(plain.status, 303); assert.equal(plain.headers.location, '/inbox');
  assert.equal(inbox.statusOf(dir, id).state, 'approved');
});

test('strong-confirm items are never decided in bulk, in either direction, and show no tick box', async t => {
  const dir = makeInbox(t), normal = drop(dir, PROMPT('Normal')); inbox.scan(dir, Date.now() - 1000);
  // A strong-confirm kind cannot pass today's validator, so its pending status and item file are written directly, as a later kind would be.
  const strong = hex(16), item = { kind: 'action', title: 'Merge pull request 5', action: 'merge', target: '5', reason: 'ready' };
  fs.writeFileSync(path.join(dir, 'items', `${strong}.json`), JSON.stringify(item));
  fs.writeFileSync(path.join(dir, 'status', `${strong}.json`), JSON.stringify({ id: strong, state: 'pending', kind: 'action', hash: inbox.hashOf(item), createdAt: Date.now() - 500, updatedAt: Date.now() - 500 }));
  assert.equal(inbox.isStrongConfirm(item), true); assert.equal(inbox.isStrongConfirm({ kind: 'prompt' }), false); assert.equal(inbox.isStrongConfirm({ kind: 'action', action: 'verdict' }), true);
  const s = await serve(t, dir);
  const page = (await s.get('/inbox')).body;
  assert.match(rowOf(page, normal), /class="inbox-check"/); assert.ok(!/inbox-check/.test(rowOf(page, strong)), 'no tick box on the strong row');
  for (const decision of ['approve', 'reject']) {
    const r = JSON.parse((await s.bulk([normal, strong], decision)).body).results;
    assert.equal(r.find(x => x.id === strong).ok, false); assert.match(r.find(x => x.id === strong).reason, /own confirmation/);
    assert.equal(inbox.statusOf(dir, strong).state, 'pending', `${decision}: the strong item stays pending`);
    if (decision === 'approve') { assert.equal(r.find(x => x.id === normal).ok, true); inbox.undo(dir, normal, s.clock.now + 1); s.clock.now += 5000; }
  }
  s.clock.now += 5000; const only = await s.bulk([strong], 'approve'); assert.equal(only.status, 409);
  assert.equal(inbox.decideMany(dir, [strong], 'reject').results[0].ok, false);
});

test('the markdown renderer escapes everything and only links http(s)', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.match(renderMarkdown('[docs](https://example.com/a?b=1&c="2")'), /<a href="https:\/\/example\.com\/a\?b=1&amp;c=&quot;2&quot;" rel="noopener noreferrer" target="_blank">docs<\/a>/);
  assert.equal(renderMarkdown('[a](https://x.test/*y*)'), '<p><a href="https://x.test/*y*" rel="noopener noreferrer" target="_blank">a</a></p>', 'no emphasis inside an href');
  assert.equal(renderMarkdown('- one\n- two **b**\n\n1. first\n2. second'), '<ul><li>one</li><li>two <strong>b</strong></li></ul><ol><li>first</li><li>second</li></ol>');
  assert.equal(renderMarkdown('```\n<b>x</b>\n```'), '<pre class="md-code"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  assert.equal(renderMarkdown('use `a*b*c` here'), '<p>use <code>a*b*c</code> here</p>');
  assert.equal(renderMarkdown('> quote\n> more'), '<blockquote>quote<br>more</blockquote>');
  assert.equal(renderMarkdown(''), '');
  assert.ok(!/<(img|iframe|script|style)/i.test(renderMarkdown('![i](https://x/y.png)<iframe src=x>')));
});

test('the bulk bar helpers: labels, only visible ticked rows count, and the summary names the first refusal', () => {
  assert.equal(bulkLabel('Approve', 0), 'Approve selected'); assert.equal(bulkLabel('Reject', 3), 'Reject selected (3)');
  assert.deepEqual(pickedIds([{ value: 'a', checked: true }, { value: 'b', checked: false }, { value: 'c', checked: true, visible: false }, { value: 'd', checked: true, disabled: true }, { value: 'e', checked: true, visible: true }]), ['a', 'e']);
  assert.equal(bulkSummary('approve', [{ ok: true }, { ok: true }]), 'Approved 2.');
  assert.equal(bulkSummary('reject', [{ ok: true }, { ok: false, reason: 'the item is already approved' }, { ok: false, reason: 'x' }]), 'Rejected 1. 2 refused: the item is already approved (see each row)');
  assert.equal(bulkSummary('approve', [{ ok: false, reason: 'unknown item' }]), 'Nothing was changed. 1 refused: unknown item');
});

test('with no proposals the Inbox page says so, and Needs you has no inbox line', async t => {
  const dir = makeInbox(t), s = await serve(t, dir);
  const v = JSON.parse((await s.get('/api/view.json')).body);
  assert.deepEqual(v.panels.inbox, []); assert.ok(!v.panels.needsYou.some(x => /^inbox/.test(x.id)));
  assert.match((await s.get('/inbox')).body, /The inbox is empty/);
  assert.ok(!/data-card="inbox"/.test((await s.get('/')).body), 'no Inbox card on the Overview while it is empty and nothing was decided today');
});
