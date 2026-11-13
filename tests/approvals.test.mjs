// Issue #1101: the "Waiting for approval" list and dropdown. Kinds included, items excluded, oldest first, Approve all skipping the Strong tier,
// one shared decision path with the Inbox, and the dropdown on the Now tab. Fixtures are built at run time.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { toApprovalRows, pendingApprovals as listOf, approveAllIds, tierOf, withApprovals } from '../supervisor/approvals.mjs';
import { approvalsDropdown } from '../supervisor/approvals-ui.mjs';
import { approveEach, summary } from '../supervisor/dashui/approve-all.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';

const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const pendingApprovals = (dir, needsYou = []) => listOf({ inboxDir: dir, needsYou });
const hex = n => crypto.randomBytes(n).toString('hex');
const makeInbox = t => { const dir = tmp(t, 'appr1101-'); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status')); return dir; };
const drop = (dir, item) => { const id = hex(16); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PROMPT = { kind: 'prompt', title: 'Tidy the docs', prompt: 'Fix the broken link.', why: 'A link is dead.' };
const DRAFT = { kind: 'issue_draft', title: 'Add a retry', body: 'Describe the retry.' };
const ACTION = { kind: 'action', title: 'Stop the stuck job', action: 'stop_job', target: 'abcd1234', reason: 'It is stuck.' };

test('list: prompt, issue draft and action items are listed, oldest first, with a title, a kind word and a why', t => {
  const dir = makeInbox(t);
  const c = drop(dir, ACTION); inbox.scan(dir, 3000);
  const a = drop(dir, PROMPT); inbox.scan(dir, 1000);
  const b = drop(dir, DRAFT); inbox.scan(dir, 2000);
  const rows = pendingApprovals(dir);
  assert.deepEqual(rows.map(r => r.id), [a, b, c], 'oldest first');
  assert.deepEqual(rows.map(r => r.kindLabel), ['Prompt', 'Issue draft', 'Action']);
  assert.deepEqual(rows.map(r => r.title), ['Tidy the docs', 'Add a retry', 'Stop the stuck job']);
  assert.equal(rows[0].why, 'A link is dead.');
  assert.ok(rows[2].why.length > 10, 'an action explains what approving does');
});
test('list: decided, refused and finished items are excluded; a broken pending item is listed but cannot be approved', t => {
  const dir = makeInbox(t);
  const ok = drop(dir, PROMPT), done = drop(dir, DRAFT), no = drop(dir, ACTION), bad = drop(dir, { kind: 'bogus' }); inbox.scan(dir, 1000);
  inbox.decide(dir, done, 'approve', 2000); inbox.decide(dir, no, 'reject', 2000);
  assert.deepEqual(pendingApprovals(dir).map(r => r.id), [ok], 'refused and decided items are not waiting');
  fs.writeFileSync(path.join(dir, 'items', `${ok}.json`), JSON.stringify({ ...PROMPT, title: 'Changed after pickup' }));
  const [r] = pendingApprovals(dir);
  assert.equal(r.canApprove, false); assert.deepEqual(approveAllIds([r]), []); assert.ok(!r.title.includes(ok) && bad);
});
test('Approve all: Click tier only; a Strong tier item is never in it', () => {
  const rows = toApprovalRows([{ id: 'a'.repeat(32), kind: 'prompt', title: 'P', createdAt: 1 }, { id: 'b'.repeat(32), kind: 'merge', title: 'Merge it', createdAt: 2 }, { id: 'c'.repeat(32), kind: 'verdict', title: 'V', createdAt: 3 }]);
  assert.deepEqual(rows.map(r => r.tier), ['click', 'strong', 'strong']);
  assert.deepEqual(approveAllIds(rows), ['a'.repeat(32)]);
  assert.deepEqual(['merge', 'approve', 'verdict', 'prompt'].map(tierOf), ['strong', 'strong', 'strong', 'click']);
  const html = approvalsDropdown({ rows, esc, ago: () => '1 min ago' });
  assert.ok(html.includes('Approve all (1)'));
  const strongRow = html.split('<li ').filter(s => s.includes('data-tier="strong"')).join('');
  assert.ok(!/value="approve"/.test(strongRow), 'no Approve form on a Strong tier row');
});
test('dropdown: button with count badge, rows with title, kind and age but no ids, an empty state, a script for Approve all', t => {
  const dir = makeInbox(t); const id = drop(dir, PROMPT); inbox.scan(dir, 1000);
  const html = approvalsDropdown({ rows: pendingApprovals(dir), esc, ago: () => '12 min ago' });
  assert.match(html, /Waiting for approval <span class="badge" data-approvals-count>1<\/span>/);
  const visible = html.replace(/<[^>]*>/g, ' ');
  assert.match(visible, /Tidy the docs/); assert.match(visible, /Prompt · 12 min ago/); assert.ok(!visible.includes(id) && !/[0-9a-f]{12}/.test(visible), 'no hex ids in what is read');
  assert.match(html, /<h3 class="inbox-title t">Tidy the docs<\/h3>/);
  assert.match(html, /<details><summary>Why<\/summary>/); assert.match(html, /value="approve"/); assert.match(html, /value="reject"/);
  const empty = approvalsDropdown({ rows: [], esc, ago: () => '' });
  assert.match(empty, /Nothing waiting for you/); assert.match(empty, /data-approvals-count>0</); assert.ok(!empty.includes('data-approve-all'));
});
test('Approve all runner: posts in order, pauses between, skips already decided, stops at a real refusal', async () => {
  const waits = [], seen = [];
  const answers = [{ ok: true }, { ok: false, reason: 'the item is already approved' }, { ok: false, reason: 'the item file changed after it was picked up' }, { ok: true }];
  const r = await approveEach({ forms: ['f1', 'f2', 'f3', 'f4'], wait: async ms => { waits.push(ms); }, post: async f => { seen.push(f); return answers[seen.length - 1]; } });
  assert.deepEqual(seen, ['f1', 'f2', 'f3'], 'f4 is not reached after a refusal');
  assert.deepEqual(r, { approved: 1, skipped: 1, failed: 'the item file changed after it was picked up' });
  assert.equal(waits.length, 2); assert.ok(waits.every(ms => ms >= 1000), 'the server allows one decision a second');
  assert.match(summary(r), /Approved 1, 1 already decided\. Stopped:/);
});

async function serve(t, inboxDir) {
  const root = tmp(t, 'dash1101-'); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [{ number: 10, title: 'T', state: 'OPEN', labels: [], body: '' }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); })); removeLater(root);
  const port = server.address().port;
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } }, inbox: { dir: inboxDir } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', reject); r.end(body); });
  const post = (id, decision) => req('POST', '/inbox', { headers: { origin: `http://127.0.0.1:${port}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id, decision, proof: writeToken(root) }).toString() });
  return { get: p => req('GET', p), post };
}
test('page: the Now card carries the dropdown; the same POST /inbox path decides it; the item leaves the list and the badge follows', async t => {
  const dir = makeInbox(t); const a = drop(dir, PROMPT), b = drop(dir, DRAFT); inbox.scan(dir, Date.now() - 600000);
  const s = await serve(t, dir);
  const page = (await s.get('/')).body;
  assert.match(page, /Waiting for approval <span class="badge" data-approvals-count>2<\/span>/);
  assert.equal([...page.matchAll(/class="inbox-item approval-row"/g)].length, 2);
  assert.match(page, /Issue draft · 1\dm ago/); assert.ok(!page.includes("approve-all.mjs"), "no extra script on the page; inbox-ui.mjs binds it");
  const r = await s.post(a, 'approve'); assert.equal(JSON.parse(r.body).ok, true);
  assert.equal(inbox.statusOf(dir, a).state, 'approved', 'the recorded outcome is the Inbox decision');
  const after = (await s.get('/')).body;
  assert.match(after, /data-approvals-count>1</); assert.ok(!after.includes(`data-inbox="${a}"`));
  assert.ok(after.includes(`data-inbox="${b}"`));
  assert.equal((await s.get('/static/approve-all.mjs')).status, 200);
});
test('shared path: the dropdown forms post exactly what the Inbox card forms post', async t => {
  const dir = makeInbox(t); drop(dir, PROMPT); inbox.scan(dir, 1000);
  const s = await serve(t, dir);
  const forms = page => [...page.matchAll(/<form method="post" action="([^"]*)" class="inbox-form">(.*?)<\/form>/g)].map(m => `${m[1]}|${m[2].replace(/value="[0-9a-f]{32}"/, 'value="ID"').replace(/<input type="hidden" name="proof"[^>]*>/, '')}`).filter(f => f.includes('value="approve"'));
  const card = forms((await s.get('/inbox')).body), dropdown = forms((await s.get('/')).body);
  assert.equal(card.length, 1, 'the Inbox page owns the proposal card');
  assert.equal(dropdown.length, 1, 'the Waiting for approval dropdown keeps the same decision');
  assert.equal(card[0], dropdown[0], 'identical action and fields');
});

const DECISION = { id: 'fixlimit-77', text: 'PR #77 is still rejected after 2 fix rounds (limit 2)', tried: 'Two rounds ran.', action: 'Choose one: raise the limit, or close it.', links: [{ text: 'PR #77', url: 'https://github.com/o/r/pull/77' }], since: 500 };
const OTHER = { id: 'drift', text: 'The checkout drifted', action: 'Fix it.', since: 100 };
test('list: decisions waiting on the homeowner are listed with their options; other Needs you items are not', t => {
  const dir = makeInbox(t); const a = drop(dir, PROMPT); inbox.scan(dir, 1000);
  const rows = pendingApprovals(dir, [OTHER, DECISION, { id: 'decision-proposal-D-040-12', text: 'Decision D-040 awaits sign-off', since: 2000 }]);
  assert.deepEqual(rows.map(r => r.id), ['fixlimit-77', a, 'decision-proposal-D-040-12'], 'oldest first, decisions and proposals together');
  const [d] = rows;
  assert.equal(d.tier, 'decision'); assert.equal(d.kindLabel, 'Decision'); assert.match(d.options, /^Choose one: raise the limit/); assert.equal(d.link, 'https://github.com/o/r/pull/77');
  assert.deepEqual(approveAllIds(rows), [a], 'a decision is never in Approve all');
  const html = approvalsDropdown({ rows, esc, ago: () => '3 min ago' });
  assert.match(html, /data-approvals-count>3</); assert.match(html, /Decision: Choose one/); assert.match(html, /Open it/);
  const decisionRow = html.split('<li ').find(x => x.includes('data-tier="decision"'));
  assert.ok(!/<form|value="approve"/.test(decisionRow), 'no Approve or Reject form on a decision row');
});
test('list: an action never shows its target job id, in the title or the why', t => {
  const dir = makeInbox(t); drop(dir, ACTION); inbox.scan(dir, 1000);
  const [r] = pendingApprovals(dir);
  assert.ok(r.why.length > 10); assert.ok(!/[0-9a-f]{8}/.test(r.why) && !r.why.includes('Target'), r.why);
  const html = approvalsDropdown({ rows: [r], esc, ago: () => '1 min ago' });
  assert.ok(!/[0-9a-f]{8}/.test(html.replace(/data-inbox="[^"]*"|id="dec-[^"]*"|name="id" value="[^"]*"/g, '')), 'no hex id in what is read');
});
test('view: withApprovals puts the one list on the view the dropdown reads', t => {
  const dir = makeInbox(t); drop(dir, PROMPT); inbox.scan(dir, 1000);
  const view = withApprovals({ panels: { needsYou: [DECISION] } }, { inbox: { dir } });
  assert.deepEqual(view.panels.approvals.map(r => r.kind), ['decision', 'prompt']);
  assert.deepEqual(withApprovals({ panels: { needsYou: [OTHER] } }, {}).panels.approvals, []);
});
test('page: a decision made on the page refreshes the list in place (the decided handler calls the refresher)', () => {
  const app = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  const submit = app.slice(app.indexOf("addEventListener('submit'"), app.indexOf('An Undo link disappears'));
  assert.match(submit, /await runDecision\([\s\S]*\}\) => ?\)?/.source ? /\}\)\.then\(\(\) => refresher\?\.refresh\(true, \{ live: true \}\)\)/ : null, 'every single decision re-reads the page');
});

test('page script: the open page listens to the approvals event stream', async t => {
  const dir = makeInbox(t); drop(dir, PROMPT); inbox.scan(dir, Date.now() - 600000);
  const s = await serve(t, dir);
  const app = (await s.get('/static/approve-all.mjs')).body;
  assert.match(app, /new EventSource\('\/api\/approvals\/events'\)/);
});
