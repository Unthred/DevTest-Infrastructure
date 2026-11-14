// Issue #1416: the Table and Compact rows lead with the Now card's chips, say what was decided and when, and show the Result column only when
// a visible row has a result. Pure renderer checks plus the real /inbox page; the pixel checks are in browser/inbox-views-scenario.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { handler } from '../supervisor/dashserver.mjs';
import { inboxCard } from '../supervisor/inbox-page.mjs';
import { inboxViews, tableRow, compactRow } from '../supervisor/inbox-views.mjs';
import { decidedOf, rowOf } from '../supervisor/dashui/inbox-views.mjs';
import { withDecisionCards } from '../supervisor/decisioncards.mjs';
import { buildInbox, CIWATCH_TITLE, DECIDED_TITLE } from './helpers/inbox-views-fixture.mjs';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ctx = { esc, highlight: esc, form: (id, d, label, cls) => `<form class="inbox-form"><button class="btn ${cls}">${label}</button></form>` };
const NOW = 1_700_000_000_000;
const at = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const PR1175 = 'PR #1175 Diagnose and resolve failed Inbox jobs instead of letting them expire is parked and a split into 4 items is proposed';
const splitCard = o => ({ type: 'split', controls: [{ action: 'approve_split', label: 'Approve split' }, { action: 'reject_split', label: 'Reject split' }], ...o });
const decisionRec = card => ({ id: 'split-1175', kind: 'decision', state: 'pending', title: PR1175, decision: true, card });

test('Kind and State are Now card badges that keep their word, ahead of the title', () => {
  const html = tableRow(rowOf({ id: 'a', kind: 'issue_draft', state: 'pending', title: CIWATCH_TITLE, createdAt: NOW }, NOW), ctx);
  assert.match(html, /<td data-col="kind"[^>]*><span class="badge sev-info"><span aria-hidden="true">[^<]*<\/span> Issue draft<\/span>/);
  assert.match(html, /<td data-col="state"[^>]*><span class="badge sev-warning"><span aria-hidden="true">◔<\/span> waiting<\/span>/);
  assert.ok(html.indexOf('data-col="state"') < html.indexOf('data-col="title"'));
  assert.match(compactRow(rowOf({ id: 'a', kind: 'prompt', state: 'failed', title: 't' }, NOW), ctx), /class="iv-chips"><span class="badge sev-action">[^]*failed<\/span> <span class="badge sev-info">[^]*Prompt/);
});
test('the PR #1175 decision row shows what was pressed and when, in place of the bare waiting', () => {
  const clicked = NOW - 600000;
  const row = rowOf(decisionRec(splitCard({ pending: ['approve_split'], pendingAt: { approve_split: clicked } })), NOW);
  assert.equal(row.decided, `Approve split pressed ${at(clicked)}, waiting for the next pass`);
  for (const html of [tableRow(row, ctx), compactRow(row, ctx)]) {
    assert.ok(html.includes(esc(row.decided)));
    assert.match(html, /<span aria-hidden="true">✔<\/span> decided/);
    assert.doesNotMatch(html, /waiting<\/span>/, 'the bare word is replaced');
  }
});
test('a decision with no recorded time is shown without a time and the row stays well formed', () => {
  const row = rowOf(decisionRec(splitCard({ pending: ['approve_split'] })), NOW);
  assert.equal(row.decided, 'Approve split pressed, waiting for the next pass');
  assert.equal(decidedOf({ card: splitCard({ pending: ['gone_action'], pendingAt: { gone_action: null } }) }), 'gone_action pressed, waiting for the next pass');
  assert.equal(decidedOf({ decision: 'approve', state: 'approved', decidedAt: NaN }), 'Approved, waiting for the next pass');
  assert.equal(decidedOf({ decision: 'approve', state: 'done', decidedAt: NOW }), '', 'a finished item is not waiting');
  assert.equal(rowOf({ id: 'a', state: 'done', decision: 'approve', title: 't' }, NOW).source, 'Overseer');
  assert.equal(rowOf(decisionRec(splitCard({})), NOW).source, 'Decision');
  assert.match(tableRow(row, ctx), /^<tr [^]*<\/tr>$/);
});
test('nothing decided reads as nothing decided', () => {
  assert.equal(rowOf(decisionRec(splitCard({})), NOW).decided, '');
  assert.equal(decidedOf({ decision: 'reject', state: 'rejected', decidedAt: NOW }), `Rejected ${at(NOW)}`);
  assert.equal(decidedOf({ decision: true, state: 'pending' }), '');
});
test('the Result column is absent when no visible row has a result and present when one has', () => {
  const none = inboxViews({ records: [rowOf0({ state: 'pending' })], now: NOW, ...ctx, cardsHtml: '' });
  assert.match(none, /<th scope="col" data-col="result" data-empty="1" hidden>/);
  assert.match(none, /<col data-col="result" data-empty="1" hidden>/);
  assert.match(none, /<td data-col="result"[^>]* data-empty="1" hidden>/);
  const some = inboxViews({ records: [rowOf0({ state: 'done', reason: 'ok' })], now: NOW, ...ctx, cardsHtml: '' });
  assert.doesNotMatch(some, /data-empty/);
});
const rowOf0 = o => ({ id: 'b'.repeat(32), kind: 'prompt', title: 'T', createdAt: NOW, ...o });

test('the decision card records the time of the click (withDecisionCards)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowlayout-'));
  try {
    fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'status', `${'c'.repeat(32)}.json`), JSON.stringify({ id: 'c'.repeat(32), state: 'approved', decidedAt: NOW, click: { card: 'retrycap-rebase-7', action: 'clear_retry_cap', target: '7' } }));
    const view = withDecisionCards({ panels: { needsYou: [{ id: 'retrycap-rebase-7', text: 'rebase on #7 stopped after 2 attempts', ref: { kind: 'pull', n: 7 } }] } }, { inbox: { dir } }, {});
    const card = view.panels.needsYou[0].card;
    assert.deepEqual(card.pending, ['clear_retry_cap']);
    assert.deepEqual(card.pendingAt, { clear_retry_cap: NOW });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the real /inbox page: the Ciwatch draft keeps its whole title, the decided item says what was decided, the Result column is shown', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rowlayout-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [] }));
  const now = Date.now();
  buildInbox(path.join(root, 'inbox'), now, { layout: true });
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: path.join(root, 'inbox') },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
  const dash = handler({ wake: () => {}, root, config, host: '127.0.0.1', port: 8080 });
  const server = http.createServer((req, res) => { req.headers.host = '127.0.0.1:8080'; dash(req, res); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const body = await new Promise((resolve, reject) => http.get({ port: server.address().port, path: '/inbox?state=all', headers: { host: '127.0.0.1:8080' } }, res => {
    let s = ''; res.on('data', c => { s += c; }).on('end', () => resolve(s)); }).on('error', reject));
  const table = body.match(/<tbody>[^]*?<\/tbody>/)[0];
  const rows = table.match(/<tr [^]*?<\/tr>/g);
  const ciwatch = rows.find(r => r.includes('Ciwatch')), decided = rows.find(r => r.includes('Splitdecided'));
  assert.ok(ciwatch.includes(CIWATCH_TITLE) && decided.includes(DECIDED_TITLE));
  assert.ok(decided.includes(`Approved ${at(now - 1800000)}, waiting for the next pass`), decided);
  assert.equal((decided.match(/<form /g) || []).length, 0);
  assert.equal((ciwatch.match(/<form /g) || []).length, 2, 'an undecided row still has its controls');
  assert.doesNotMatch(body, /data-col="result" data-empty/);
});
test('a decided inbox item keeps its tag in the Cards view; only a decision card goes without one', () => {
  const tag = id => `<span class="inbox-tag">${id}</span>`;
  const form = () => '';
  const decidedItem = inboxCard({ id: 'a'.repeat(32), kind: 'prompt', state: 'approved', title: 't', decision: 'approve', decidedAt: NOW }, '', { esc, tag, form });
  assert.match(decidedItem, /class="inbox-tag"/);
  assert.doesNotMatch(inboxCard({ id: 'split-1175', kind: 'decision', state: 'pending', title: 't', decision: true }, '', { esc, tag, form }), /inbox-tag/);
});
