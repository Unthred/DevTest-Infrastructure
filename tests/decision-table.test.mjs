// Issue #1156: the decision table, the card HTML, the click route and the existing approved-action pipeline behind it.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { RANK } from '../supervisor/needsyou.mjs';
import { DECISION_TYPES, CONTROLS, typeOf, decisionCard } from '../supervisor/decisiontable.mjs';
import { decisionHtml } from '../supervisor/decisioncard-ui.mjs';
import { withDecisionCards } from '../supervisor/decisioncards.mjs';
import { ACTIONS, CONTROLS as INBOX_CONTROLS, statusOf, allStatuses, loadItem } from '../supervisor/inbox.mjs';
import { toDecisionRows } from '../supervisor/approvals.mjs';
import { approvalsDropdown } from '../supervisor/approvals-ui.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import * as robust from '../supervisor/robust.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';

const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PR = n => ({ kind: 'pull', n });
const ITEMS = {
  fixlimit: { id: 'fixlimit-7', text: 'PR #7 is still rejected after 2 fix rounds (limit 2)', tried: '2 fix rounds.', ref: PR(7) },
  retrycap: { id: 'retrycap-rebase-7', text: 'rebase on #7 stopped after 2 attempts', ref: PR(7) },
  reviewlimit: { id: 'reviewlimit-7', text: 'PR #7 could not be reviewed within 2 attempts', ref: PR(7) },
  reviewrefused: { id: 'reviewrefused-7', text: 'verdict file refused', ref: PR(7) },
  'selfcheck-review': { id: 'selfcheck-review-7', text: 'review finished with no verdict', ref: PR(7) },
  'selfcheck-job': { id: 'selfcheck-job-abcd1234', text: 'Job abcd1234 is recorded as running but gone', ref: null },
  job: { id: `job-abcd1234${'0'.repeat(24)}`, text: 'Job is failed', ref: PR(7) },
  'stale-mark': { id: 'stale-mark-9', text: 'Issue #9: stuck', ref: { kind: 'issue', n: 9 } },
};

test('invariant: every Needs you rank and every id the source raises has a table entry', () => {
  for (const p of RANK) assert.ok(typeOf(p), `RANK type ${p} has no decision entry`);
  const files = ['dashboard', 'selfcheck', 'teamdeps', 'robust', 'dashassign', 'faults', 'faultview'];
  const raised = new Set();
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../supervisor/${f}.mjs`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:\badd\(|\bid: )[`']([a-z][a-z-]*?)(?:[`'$]|-\$)/g)) raised.add(m[1].replace(/-$/, ''));
  }
  assert.ok(raised.size > 25, 'the scan found the raised ids');
  for (const id of raised) assert.ok(typeOf(id), `raised id ${id} has no decision entry`);
});
test('every control the table offers is an existing action; none is a slice 2 or 3 action', () => {
  const known = new Set([...Object.keys(ACTIONS), ...Object.keys(INBOX_CONTROLS)]);
  for (const a of Object.keys(CONTROLS)) assert.ok(known.has(a), `${a} is not an existing action`);
  for (const later of ['extra_fix_round', 'close_superseded', 'resume_breaker', 'merge', 'approve', 'verdict']) assert.ok(!(later in CONTROLS));
});
test('longest type wins and unmapped ids have no type', () => {
  assert.equal(typeOf('homeowner-pr-12'), 'homeowner-pr'); assert.equal(typeOf('homeowner-12'), 'homeowner');
  assert.equal(typeOf('noreviewer-refused-3'), 'noreviewer-refused'); assert.equal(typeOf('mystery-1'), null); assert.equal(typeOf('fixlimitation-1'), null);
});
test('each mapped type with items renders a reason, a clear condition and its controls', () => {
  const want = { fixlimit: [], retrycap: ['clear_retry_cap'], reviewlimit: ['new_review_attempt'], reviewrefused: ['new_review_attempt'], 'selfcheck-review': ['new_review_attempt'],
    'selfcheck-job': ['stop_job'], job: ['resume_job', 'close_job'], 'stale-mark': ['reopen'] };
  for (const [k, item] of Object.entries(ITEMS)) {
    const card = decisionCard(item);
    assert.ok(card.reason.length > 10, `${k} has a reason`); assert.match(card.clears, /^clears /);
    assert.deepEqual(card.controls.map(c => c.action), want[k], k);
    const html = decisionHtml({ ...item, card });
    assert.match(html, /Why: /); assert.match(html, /Clears /);
    for (const c of card.controls) assert.match(html, new RegExp(`name="control" value="${c.action}"`));
  }
});
test('fixlimit says what clears it and names the slice that will bring its other options', () => {
  const card = decisionCard(ITEMS.fixlimit);
  assert.equal(card.clears, 'clears when a new head is reviewed PASS; no more fix jobs start');
  assert.match(card.reason, /still rejected after 2 fix rounds/); assert.match(card.later, /slice 2/);
  assert.match(decisionHtml({ ...ITEMS.fixlimit, card }), /slice 2/);
});
test('a card with no text still has a reason; the reason is never empty', () => {
  assert.match(decisionCard({ id: 'drift', text: '' }).reason, /drift/);
});
test('park only with the GitHub App; unpark only when parked; the target is the item number', () => {
  const none = decisionCard(ITEMS.fixlimit, { appConfigured: false });
  assert.deepEqual(none.controls, []);
  const app = decisionCard(ITEMS.fixlimit, { appConfigured: true });
  assert.deepEqual(app.controls.map(c => [c.action, c.target]), [['park', '7']]);
  const parked = decisionCard(ITEMS.fixlimit, { appConfigured: true, parked: new Set([7]) });
  assert.deepEqual(parked.controls.map(c => c.action), ['unpark']);
});
test('a type with no entry renders the explicit error card with no control', () => {
  const card = decisionCard({ id: 'mystery-1', text: 'x', ref: PR(1) });
  assert.ok(card.error); assert.equal(card.controls, undefined);
  const html = decisionHtml({ id: 'mystery-1', card });
  assert.match(html, /decision-error/); assert.match(html, /bug/); assert.ok(!/<form/.test(html));
});
test('card text is escaped', () => {
  const html = decisionHtml({ id: 'drift', card: decisionCard({ id: 'drift', text: '<img src=x onerror=1>' }) });
  assert.ok(!html.includes('<img'));
});
test('withDecisionCards puts a card on every Needs you item and reads parked labels from the cache', () => {
  const view = { panels: { needsYou: [ITEMS.fixlimit, { id: 'mystery-1', text: 'x' }] } };
  const cfg = { github_app: { app_id: 1, installation_id: 2, key_file: '/k' } };
  withDecisionCards(view, cfg, { pulls: [{ number: 7, labels: ['parked'] }] });
  assert.deepEqual(view.panels.needsYou[0].card.controls.map(c => c.action), ['unpark']);
  assert.ok(view.panels.needsYou[1].card.error);
  assert.deepEqual(withDecisionCards({ panels: {} }, cfg, {}), { panels: {} });
});
test('the waiting-for-approval row shows the reason, clear condition and control instead of "no button here"', () => {
  const item = { ...ITEMS.retrycap, since: 5, links: [{ url: 'https://github.com/o/r/pull/7', text: 'PR #7' }] };
  item.card = decisionCard(item);
  const rows = toDecisionRows([item]);
  assert.equal(rows.length, 1); assert.equal(rows[0].why, item.card.reason);
  const html = approvalsDropdown({ rows, esc, ago: () => '1 min ago' });
  assert.match(html, /Why: rebase on #7 stopped/); assert.match(html, /Clears when you clear the retry cap/);
  assert.match(html, /name="control" value="clear_retry_cap"/); assert.ok(!/it has no button here/.test(html));
});

const HEAD = 'a'.repeat(40);
const APP = { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' };
async function serve(t, { app = true } = {}) {
  const root = tmp(t, 'dec1156-'); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const inboxDir = path.join(root, 'inbox'); fs.mkdirSync(path.join(inboxDir, 'items'), { recursive: true }); fs.mkdirSync(path.join(inboxDir, 'status'), { recursive: true });
  const now = Date.now(), pull = { number: 7, title: 'T', state: 'OPEN', headRefName: 'codex/issue-7-x', headRefOid: HEAD, labels: ['needs-homeowner'], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [pull], issues: [] }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ fixAttempts: { [`7:${HEAD}`]: 2 }, verdicts: {}, jobs: {} }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); })); removeLater(root);
  const port = server.address().port;
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir }, ...(app ? { github_app: APP } : {}),
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers })); }); r.on('error', reject); if (body) r.write(body); r.end(); });
  const origin = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' };
  const click = (card, control, proof = writeToken(root), headers = origin) => req('POST', '/decision', { headers, body: new URLSearchParams({ card, control, proof }).toString() });
  return { get: p => req('GET', p), click, inboxDir, root, origin, req };
}
test('page: the fix limit card shows a non-empty reason and the clear condition, with no dead end', async t => {
  const s = await serve(t);
  const body = (await s.get('/')).body;
  const card = body.slice(body.indexOf('att-fixlimit-7'));
  assert.match(card, /Why: [^<]*is still rejected after 2 fix rounds/);
  assert.match(card, /Clears when a new head is reviewed PASS; no more fix jobs start\./);
  assert.match(card, /slice 2 of #1111/);
  assert.ok(!/Decide it here|it has no button here/.test(body));
  assert.match(card, /name="card" value="fixlimit-7"[^>]*><input type="hidden" name="control" value="park"/, 'park is offered with the GitHub App');
});
test('page: without the GitHub App no park control is offered, and clicking one anyway is refused', async t => {
  const s = await serve(t, { app: false });
  assert.ok(!/name="control" value="park"/.test((await s.get('/')).body));
  const r = await s.click('fixlimit-7', 'park');
  assert.equal(r.status, 409); assert.match(r.body, /no longer applies/); assert.equal(allStatuses(s.inboxDir).length, 0);
});
test('click: negative cases change nothing and say so', async t => {
  const s = await serve(t);
  const gone = await s.click('fixlimit-999', 'park'); assert.equal(gone.status, 409); assert.match(gone.body, /already cleared/); assert.match(gone.body, /Nothing was changed/);
  assert.equal((await s.click('fixlimit-7', 'merge')).status, 409, 'a control outside the table is refused');
  assert.equal((await s.click('fixlimit-7', 'park', 'wrong')).status, 403, 'the access proof is required');
  const evil = await s.click('fixlimit-7', 'park', writeToken(s.root), { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' });
  assert.equal(evil.status, 403, 'a foreign origin is refused');
  assert.equal(allStatuses(s.inboxDir).length, 0, 'nothing was recorded by any refused click');
});
test('click: park records an approved control with who, when and why; a second click while it waits is refused', async t => {
  const s = await serve(t);
  const r = await s.click('fixlimit-7', 'park');
  assert.equal(r.status, 303);
  const [st] = allStatuses(s.inboxDir);
  assert.equal(st.state, 'approved'); assert.equal(st.kind, 'control'); assert.equal(st.decision, 'approve'); assert.ok(Number.isFinite(st.decidedAt));
  assert.deepEqual([st.click.by, st.click.card, st.click.action, st.click.target], ['homeowner', 'fixlimit-7', 'park', '7']);
  assert.match(st.control.reason, /pressed Park on the fixlimit card/);
  assert.equal(loadItem(s.inboxDir, st.id).ok, true, 'the item passes the same re-validation as every inbox item');
  await new Promise(r2 => setTimeout(r2, 1100));   // past the inbox cooldown
  const again = await s.click('fixlimit-7', 'park');
  assert.equal(again.status, 409); assert.match(again.body, /already waiting/); assert.equal(allStatuses(s.inboxDir).length, 1);
});

const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
function teamFor(t, inboxDir) {
  const dir = tmp(t, 'dec1156-team-');
  const pr = { number: 7, title: 't', headRefName: 'codex/issue-7-x', headRefOid: HEAD, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [] };
  const added = [];
  const gh = { listPulls: async () => [pr], listIssues: async () => [], getPull: async () => pr, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, addLabelAsApp: async (n, l) => { added.push([n, l]); }, removeLabel: async () => {} };
  const jobs = { get: async () => null, listActive: async () => [] };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir }, github_app: APP,
    limits: { roles: { implementer: 1, reviewer: 1 }, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  const team = new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n' });
  return { team, added };
}
test('end to end: a clicked park and a clicked clear_retry_cap are each applied once by the next tick, and a repeat pass changes nothing', async t => {
  const s = await serve(t);
  const w = teamFor(t, s.inboxDir);
  for (let i = 0; i < 2; i++) robust.noteFailure(w.team.s, { type: 'rebase', subject: 7, cause: 'postcondition_not_met', head: HEAD }, 1);
  assert.equal((await s.click('fixlimit-7', 'park')).status, 303);
  await w.team.processInbox({});
  assert.deepEqual(w.added, [[7, 'parked']], 'the parked label was written once, as the GitHub App');
  const [st] = allStatuses(s.inboxDir);
  assert.equal(st.state, 'done'); assert.match(st.result, /is parked/);
  await w.team.processInbox({});
  assert.deepEqual(w.added, [[7, 'parked']], 'a repeat pass applies nothing again');
  // The retry cap control: applied through the action pipeline, then refused as a no-op when nothing is capped any more.
  const { recordClick } = await import('../supervisor/decisionclick.mjs');
  const item = { id: 'retrycap-rebase-7', card: { type: 'retrycap' } }, control = { action: 'clear_retry_cap', target: '7', label: 'Clear retry cap' };
  assert.equal(recordClick(s.inboxDir, { item, control }, Date.now()).ok, true);
  await w.team.processInbox({});
  assert.deepEqual(Object.keys(w.team.s.sameCause || {}), [], 'the cap was cleared');
  assert.equal(allStatuses(s.inboxDir).filter(x => x.state === 'done').length, 2);
  assert.equal(recordClick(s.inboxDir, { item, control }, Date.now()).ok, true);
  await w.team.processInbox({});
  const failed = allStatuses(s.inboxDir).filter(x => x.state === 'failed');
  assert.equal(failed.length, 1); assert.match(failed[0].reason, /nothing to clear/); assert.match(failed[0].result, /nothing was changed/);
});
