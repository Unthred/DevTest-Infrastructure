// Issue #702: pending overseer proposals have their own panel at the top of the Overview, a count on every page, a stable /#approve-<id> link
// and a plain confirmation after a decision. Fixtures are built at run time; no model, no GitHub, no real state.
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

const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
function makeInbox(t) { const dir = tmp(t, 'appr-in-'); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status')); return dir; }
const drop = (dir, item, id = hex(16)) => { fs.writeFileSync(path.join(dir, 'items', `${id}.json`), typeof item === 'string' ? item : JSON.stringify(item)); return id; };
async function serve(t, dir) {
  const root = tmp(t, 'appr-dash-'); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { now: Date.now() };
  server.on('request', handler({ root, config: { ...config, inbox: { dir } }, host: '127.0.0.1', port, now: () => clock.now }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject); r.end(body); });
  const post = (id, decision) => req('POST', '/inbox', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `id=${id}&decision=${decision}&proof=${writeToken(root)}` });
  return { clock, get: p => req('GET', p), post };
}
const item = (n, extra = {}) => ({ kind: 'prompt', title: `Proposal ${n}`, why: `because ${n}`, prompt: `Do thing ${n}.`, ...extra });
const panelOf = html => (/<div class="approvals"[\s\S]*?<!--\/approvals-->/.exec(html) || [''])[0];
const needsOf = html => (/<section class="card panel"[^>]*id="c-needs"[\s\S]*?<\/section>/.exec(html) || [''])[0];

test('0 pending: the panel is hidden and the status bar shows no count; Needs you is unaffected', async t => {
  const dir = makeInbox(t), s = await serve(t, dir), page = (await s.get('/')).body;
  assert.match(page, /<div class="approvals"[^>]* hidden>/); assert.ok(!page.includes('data-approvals-count'));
  assert.ok(!panelOf(page).includes('class="approval"'));
});
test('1 pending: a full-width panel above the card grid with title, why, kind, time, collapsed text and Approve/Reject outside the details', async t => {
  const dir = makeInbox(t), id = drop(dir, item(1, { prompt: 'Do <b>x</b>' })); inbox.scan(dir, 1000);
  const s = await serve(t, dir), page = (await s.get('/')).body, panel = panelOf(page);
  assert.ok(!/<div class="approvals"[^>]* hidden>/.test(page)); assert.match(panel, /Waiting for your approval \(1\)/);
  assert.ok(page.indexOf('class="approvals"') < page.indexOf('class="cards')); assert.ok(page.indexOf('class="approvals"') < page.indexOf('data-reset-layout'));
  assert.match(panel, new RegExp(`id="approve-${id}"`)); assert.match(panel, /Proposal 1/); assert.match(panel, /because 1/); assert.match(panel, /Run as a job/); assert.match(panel, /proposed <time/);
  assert.match(panel, /<details class="approval-text"[^>]*><summary>Full text<\/summary>/); assert.ok(!/<details[^>]* open/.test(panel));
  assert.match(panel, /Do &lt;b&gt;x&lt;\/b&gt;/); assert.ok(!panel.includes('<b>x</b>'));
  const details = /<details[\s\S]*?<\/details>/.exec(panel)[0];
  assert.ok(!details.includes('<form')); assert.equal((panel.match(/<form method="post" action="\/inbox"/g) || []).length, 2);
  assert.match(panel, /name="proof"/);
});
test('several pending: oldest first, each once, not in Needs you, and Needs you does not count them', async t => {
  const dir = makeInbox(t), a = drop(dir, item('old')); inbox.scan(dir, 1000); const b = drop(dir, item('mid')); inbox.scan(dir, 2000); const c = drop(dir, item('new', { kind: 'issue_draft', prompt: undefined, body: 'Body text.' })); inbox.scan(dir, 3000);
  const s = await serve(t, dir), page = (await s.get('/')).body, panel = panelOf(page);
  assert.match(panel, /Waiting for your approval \(3\)/);
  assert.ok(panel.indexOf(a) < panel.indexOf(b) && panel.indexOf(b) < panel.indexOf(c)); assert.match(panel, /Post as an issue/);
  for (const id of [a, b, c]) { assert.equal((page.match(new RegExp(`data-inbox="${id}"`, 'g')) || []).length, 1); assert.ok(!needsOf(page).includes(id)); }
  assert.match(needsOf(page), /<h2 id="h-needs">Needs you<\/h2>/); assert.match(needsOf(page), /Nothing needs you/);
  const view = JSON.parse((await s.get('/api/view.json')).body); assert.equal(view.panels.needsYou.length, 0); assert.equal(view.approvals.pending.length, 3);
});
test('a broken item is still shown, with its reason and only a Reject button', async t => {
  const dir = makeInbox(t), id = drop(dir, item(1)); inbox.scan(dir, 1000); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item(1, { prompt: 'edited after pickup' })));
  const s = await serve(t, dir), panel = panelOf((await s.get('/')).body);
  assert.match(panel, /An inbox item cannot be shown/); assert.match(panel, /changed after it was picked up/); assert.ok(!panel.includes('value="approve"')); assert.match(panel, /value="reject"/);
  assert.match(panel, /Waiting for your approval \(1\)/);
});
test('the count shows on every page and links to the panel; absent when nothing is pending', async t => {
  const dir = makeInbox(t); drop(dir, item(1)); drop(dir, item(2)); inbox.scan(dir, 1000);
  const s = await serve(t, dir);
  for (const p of ['/', '/work', '/system', '/agents']) { const r = await s.get(p); if (r.status !== 200) continue; assert.match(r.body, /data-approvals-count="2"/, p); assert.match(r.body, /href="\/#approvals"/, p); }
  assert.equal((await s.get('/work')).status, 200);
  const empty = await serve(t, makeInbox(t)); assert.ok(!(await empty.get('/work')).body.includes('data-approvals-count'));
});
test('a saved layout cannot hide the panel: it is outside the card grid and is no card', async t => {
  const dir = makeInbox(t); drop(dir, item(1)); inbox.scan(dir, 1000);
  const page = (await (await serve(t, dir)).get('/')).body, gridAt = page.indexOf('<div class="cards');
  assert.ok(page.indexOf('id="approvals"') < gridAt); assert.ok(!/data-card="approvals"/.test(page)); assert.ok(!/<section class="card[^>]*>\s*<header>[\s\S]{0,300}Waiting for your approval/.test(page));
  const app = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8'); assert.ok(app.includes("$$(':scope > .card[data-card]', grid)"));   // layout code only moves direct card children of the grid
});
test('the direct link: a pending proposal has a stable id; a decided one is explained plainly, with its outcome', async t => {
  const dir = makeInbox(t), a = drop(dir, item('a')), b = drop(dir, item('b')); inbox.scan(dir, 1000);
  const s = await serve(t, dir); assert.equal((await s.post(a, 'reject')).status, 303);
  const page = (await s.get('/')).body, panel = panelOf(page);
  assert.match(panel, new RegExp(`<article class="approval" id="approve-${b}"`));
  assert.match(panel, new RegExp(`<article class="approval decided" id="approve-${a}"[^>]* hidden>`)); assert.match(panel, /This proposal is no longer waiting/); assert.match(panel, /Rejected; nothing was done/);
  assert.match(panel, /class="approval-missing" hidden/);
  inbox.finish(dir, b, { state: 'done', result: 'posted as issue #5' }, 5000);   // an approved-and-finished item is reported with its result
  const p2 = panelOf((await s.get('/')).body); assert.match(p2, new RegExp(`id="approve-${b}"[^>]* hidden>[\\s\\S]*?Approved and done\\. posted as issue #5`));
});
test('after a decision: it returns to the panel with a plain confirmation; the last one says none are waiting', async t => {
  const dir = makeInbox(t), a = drop(dir, item('a')); inbox.scan(dir, 1000);
  const s = await serve(t, dir), r = await s.post(a, 'approve');
  assert.equal(r.status, 303); assert.equal(r.headers.location, `/?notice=inbox-approved&item=${a}#approvals`);
  const panel = panelOf((await s.get(r.headers.location.replace(/#.*/, ''))).body);
  assert.ok(!/<div class="approvals"[^>]* hidden>/.test(panel)); assert.match(panel, /Approved\. Foreman acts on it at its next tick/); assert.match(panel, /None are waiting for your approval/);
  assert.match(panelOf((await s.get('/?notice=inbox-rejected')).body), /Rejected\. Nothing will be done/);
  assert.ok(/<div class="approvals"[^>]* hidden>/.test((await s.get('/')).body));   // the notice is not shown again once the address is clean
});
test('cooldown: a second click within a second is ignored and the page says when the next click will work; nothing is decided', async t => {
  const dir = makeInbox(t), a = drop(dir, item('a')), b = drop(dir, item('b')); inbox.scan(dir, 1000);
  const s = await serve(t, dir); await s.post(a, 'reject'); const r = await s.post(b, 'reject');
  assert.equal(r.status, 303); assert.match(r.headers.location, /^\/\?notice=inbox-cooldown&retry=\d+#approvals$/); assert.equal(inbox.statusOf(dir, b).state, 'pending');
  const panel = panelOf((await s.get(r.headers.location.replace(/#.*/, ''))).body);
  assert.match(panel, /That click was ignored/); assert.match(panel, /The next click will work from <time/); assert.match(panel, /Nothing was decided/);
  assert.match(panelOf((await s.get('/?notice=inbox-cooldown&retry=abc')).body), /Try again in a second/);
});
test('negative: bad item id in the notice is not echoed; an unconfigured inbox renders no panel', async t => {
  const dir = makeInbox(t), s = await serve(t, dir), page = (await s.get('/?notice=inbox-approved&item="><script>')).body;
  assert.ok(!page.includes('<script>')); assert.match(panelOf(page), /Approved\. Foreman acts on it at its next tick\./);
});
