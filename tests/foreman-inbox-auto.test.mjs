// Decision D-035 (proposed): fewer approvals. Issue drafts and a fixed list of named actions run without a click up to a daily limit; prompts
// never do; one switch in team.local.json turns it all off; Approve all approves only what was on screen. No model, GitHub or real state is used;
// secret-shaped text is assembled at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as inbox from '../supervisor/inbox.mjs';
import { Team, validateTeamConfig, loadTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (t, p = 'inboxauto-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
const TOKEN = 'gh' + 'p_' + hex(12);
const ON = { enabled: true, draftLimit: 10, hold: null };
const PROMPT = { kind: 'prompt', title: 'Tidy the docs index', prompt: 'Fix the broken link in docs/README.md.' };
const draft = n => ({ kind: 'issue_draft', title: `Add retry note ${n}`, body: `The probe should say how long it waits (${n}).` });
const act = (action, target, reason = 'Foreman spent the attempts itself.') => ({ kind: 'action', title: `${action} ${target}`, action, target, reason });
function makeInbox(t) { const dir = tmp(t); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status')); return dir; }
const drop = (dir, item, id = hex(16)) => { fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const events = dir => fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const states = (dir, ids) => ids.map(id => inbox.statusOf(dir, id).state);
const H = 3600000;

// ---- the fixed list and the limits
test('the list of automatic actions is a frozen code constant of three names, each limited to 5 a day; drafts to 10', () => {
  assert.deepEqual(Object.entries(inbox.AUTO_ACTIONS), [['new_review_attempt', 5], ['reopen', 5], ['resume_job', 5]]);
  assert.ok(Object.isFrozen(inbox.AUTO_ACTIONS));
  assert.equal(inbox.AUTO_DRAFT_LIMIT, 10);
  assert.equal(inbox.autoSettings({ dir: '/x' }).draftLimit, 10); assert.equal(inbox.autoSettings({ dir: '/x' }).enabled, true);
  // nothing in the config reaches the list of actions or the action limits
  const s = inbox.autoSettings({ dir: '/x', auto_actions: { close_job: 99 }, auto_draft_limit: 3 });
  assert.deepEqual(Object.keys(s).sort(), ['draftLimit', 'enabled', 'hold']); assert.equal(s.draftLimit, 3);
});
test('issue drafts are approved without a click up to the daily limit; over it each becomes a card that says why, and none is dropped', t => {
  const dir = makeInbox(t), ids = Array.from({ length: 4 }, (_, n) => drop(dir, draft(n)));
  inbox.scan(dir, 1000, { ...ON, draftLimit: 3 });
  const st = ids.map(id => inbox.statusOf(dir, id)), by = s => s.filter(x => x.state === 'approved');
  assert.equal(by(st).length, 3); assert.ok(by(st).every(x => x.decidedBy === 'auto' && x.autoKey === 'issue_draft'));
  const waiting = st.filter(x => x.state === 'pending'); assert.equal(waiting.length, 1);
  assert.match(waiting[0].autoNote, /daily limit of 3 automatic issue drafts/);
  const cards = inbox.pendingCards(dir); assert.equal(cards.length, 1); assert.match(cards[0].will, /daily limit of 3/); assert.match(cards[0].will, /needs a click/);
  // the count is kept in the status files, so a later scan (a restart) still sees it, and the window rolls
  const late = drop(dir, draft(9)); inbox.scan(dir, 2000, { ...ON, draftLimit: 3 }); assert.equal(inbox.statusOf(dir, late).state, 'pending');
  const next = drop(dir, draft(10)); inbox.scan(dir, 1000 + 25 * H, { ...ON, draftLimit: 3 }); assert.equal(inbox.statusOf(dir, next).state, 'approved');
});
test('listed actions run without a click up to 5 a day each; the sixth is a card; limits are per action', t => {
  const dir = makeInbox(t), ids = Array.from({ length: 6 }, (_, n) => drop(dir, act('resume_job', hex(4))));
  const other = drop(dir, act('reopen', '12'));
  inbox.scan(dir, 1000, ON);
  const st = states(dir, ids), held = ids.find(id => inbox.statusOf(dir, id).state === 'pending');   // items are taken in file-name order
  assert.equal(st.filter(x => x === 'approved').length, 5); assert.equal(st.filter(x => x === 'pending').length, 1);
  assert.match(inbox.statusOf(dir, held).autoNote, /daily limit of 5 automatic resume_job actions/);
  assert.equal(inbox.statusOf(dir, other).state, 'approved', 'another action has its own count');
});
test('an action that is not on the list stays a card, whatever it says; an unknown name is refused', t => {
  const dir = makeInbox(t), a = drop(dir, act('close_job', hex(4))), b = drop(dir, act('stop_job', hex(4))), c = drop(dir, { ...act('reopen', '3'), action: 'pause_work', target: 'new' });
  inbox.scan(dir, 1000, ON);
  assert.deepEqual(states(dir, [a, b]), ['pending', 'pending']); assert.equal(inbox.statusOf(dir, c).state, 'refused');
  assert.equal(inbox.statusOf(dir, a).autoNote, undefined, 'not eligible: no remark');
  assert.ok(!events(dir).some(e => e.event === 'auto_approved' && [a, b, c].includes(e.id)));
});
test('a prompt can never run without a click, however the settings are written', t => {
  const dir = makeInbox(t), p = drop(dir, PROMPT);
  for (const auto of [ON, { ...ON, draftLimit: 50 }, { ...ON, auto_actions: { prompt: 99 }, auto_prompts: true, prompt: 5 }, inbox.autoSettings({ dir: '/x', auto: true, auto_draft_limit: 50 })]) inbox.scan(dir, 1000, auto);
  assert.equal(inbox.statusOf(dir, p).state, 'pending'); assert.equal(inbox.statusOf(dir, p).decidedBy, undefined);
  assert.equal(inbox.pendingCards(dir)[0].kind, 'prompt'); assert.match(inbox.pendingCards(dir)[0].will, /always needs a click/);
});
test('every existing check still applies: shape, secret-shaped and attribution text are refused, never auto-approved', t => {
  const dir = makeInbox(t);
  const bad = [drop(dir, { ...draft(1), body: `use ${TOKEN} to push` }), drop(dir, { ...draft(2), body: 'Generated with Claude Code' }), drop(dir, { ...draft(3), extra: 1 }), drop(dir, act('resume_job', 'zz'))];
  inbox.scan(dir, 1000, ON);
  assert.deepEqual(states(dir, bad), ['refused', 'refused', 'refused', 'refused']); assert.ok(!events(dir).some(e => e.event === 'auto_approved'));
});
test('the off switch: with automatic handling off every item is a card; a halted breaker also makes cards, with the reason', t => {
  const dir = makeInbox(t), ids = [drop(dir, draft(1)), drop(dir, act('reopen', '5')), drop(dir, PROMPT)];
  inbox.scan(dir, 1000, inbox.autoSettings({ dir: '/x', auto: false })); assert.deepEqual(states(dir, ids), ['pending', 'pending', 'pending']);
  const dir2 = makeInbox(t), j = drop(dir2, draft(1));
  inbox.scan(dir2, 1000, inbox.autoSettings({ dir: '/x' }, 'the circuit breaker has halted work')); assert.equal(inbox.statusOf(dir2, j).state, 'pending'); assert.match(inbox.statusOf(dir2, j).autoNote, /circuit breaker/);
});

// ---- audit and the overseer's view
test('an automatic approval has its own audit event and status field; a human approval keeps its own; later events say by: auto', t => {
  const dir = makeInbox(t), a = drop(dir, draft(1)), p = drop(dir, PROMPT);
  inbox.scan(dir, 1000, ON); assert.equal(inbox.decide(dir, p, 'approve', 1100).ok, true);
  inbox.finish(dir, a, { state: 'done', result: 'posted as issue #5', issue: 5 }, 1200);
  const ev = events(dir);
  assert.ok(ev.some(e => e.id === a && e.event === 'auto_approved')); assert.ok(!ev.some(e => e.id === a && e.event === 'approved'));
  assert.ok(ev.some(e => e.id === p && e.event === 'approved')); assert.ok(!ev.some(e => e.id === p && e.event === 'auto_approved'));
  assert.ok(ev.some(e => e.id === a && e.event === 'done' && e.by === 'auto'));
  assert.ok(!JSON.stringify(ev).includes('retry note'), 'no content in the log');
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), inbox: createInbox({ dir }) });
  const names = tools.list().map(x => x.name); assert.ok(!names.some(n => /approve|reject|run|decide/.test(n)), 'MCP still has no approving tool');
  return tools.call('foreman_proposal_status', { id: a }).then(r => {
    const s = JSON.parse(r.text); assert.equal(s.decidedBy, 'automatic (no click)');
    return tools.call('foreman_proposal_status', { id: p }).then(r2 => assert.equal(JSON.parse(r2.text).decidedBy, 'the homeowner'));
  });
});

// ---- the team: an automatic draft is posted once, with the same final checks
const teamCfg = (dir, inboxExtra = {}) => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir, ...inboxExtra },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
function world(t, inboxExtra) {
  const dir = makeInbox(t), state = tmp(t, 'state-'), posted = [];
  const gh = { issues: [], listPulls: async () => [], getPull: async () => null, listIssues: async () => [], board: async () => {}, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {},
    findIssueByMarker: async m => gh.issues.find(i => i.body.includes(m))?.number || null,
    createIssue: async (title, body) => { const number = 200 + gh.issues.length; gh.issues.push({ number, title, body }); posted.push(number); return number; } };
  const jobs = { seq: 0, states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const team = new Team({ config: teamCfg(dir, inboxExtra), root: stateRoot(state), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n', clock: { now: () => 5000 }, providerModels: { claude: { aliases: ['opus', 'sonnet', 'haiku'], pattern: '^claude-', efforts: ['low', 'medium', 'high'] } } });
  return { dir, team, posted };
}
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });
test('team: a draft is posted by the tick without a click, once; with auto off it waits; a halted breaker makes it wait; over the limit the rest wait', async t => {
  const w = world(t); const id = drop(w.dir, draft(1));
  await w.team.processInbox(rep()); await w.team.processInbox(rep());
  assert.equal(w.posted.length, 1); assert.equal(inbox.statusOf(w.dir, id).state, 'done'); assert.equal(inbox.statusOf(w.dir, id).decidedBy, 'auto');
  const off = world(t, { auto: false }); const o = drop(off.dir, draft(1)); await off.team.processInbox(rep());
  assert.equal(off.posted.length, 0); assert.equal(inbox.statusOf(off.dir, o).state, 'pending');
  const halted = world(t); halted.team.s.breaker = { waste: {}, halts: {}, global: { cause: '@global', at: 1 }, clearedAt: {}, error: null };
  const h = drop(halted.dir, draft(1)); await halted.team.processInbox(rep()); assert.equal(halted.posted.length, 0); assert.equal(inbox.statusOf(halted.dir, h).state, 'pending');
  const lim = world(t, { auto_draft_limit: 2 }); const ls = [1, 2, 3].map(n => drop(lim.dir, draft(n))); await lim.team.processInbox(rep());
  assert.equal(lim.posted.length, 2); assert.equal(inbox.allStatuses(lim.dir).filter(s => s.state === 'pending').length, 1); assert.equal(ls.length, 3);
});
test('config: inbox.auto and inbox.auto_draft_limit are validated and load from team.local.json; nothing else can be added', t => {
  const base = teamCfg('/x');
  assert.doesNotThrow(() => validateTeamConfig({ ...base, inbox: { dir: '/x', auto: false, auto_draft_limit: 4 } }));
  for (const bad of [{ dir: '/x', auto: 'no' }, { dir: '/x', auto_draft_limit: -1 }, { dir: '/x', auto_draft_limit: 1.5 }, { dir: '/x', auto_draft_limit: 51 }, { dir: '/x', auto_actions: ['prompt'] }, { dir: '/x', prompts: true }])
    assert.throws(() => validateTeamConfig({ ...base, inbox: bad }), /invalid inbox/, JSON.stringify(bad));
  const root = tmp(t, 'auto-local-'), shipped = path.join(here, '..', 'supervisor', 'team.json'), local = path.join(root, 'team.local.json');
  fs.writeFileSync(local, JSON.stringify({ inbox: { dir: '/x/inbox', auto: false } }));
  assert.deepEqual(loadTeamConfig(shipped, root).inbox, { dir: '/x/inbox', auto: false });
});

// ---- the dashboard: Approve all and the 24-hour view
async function serve(t, inboxDir, auto = {}) {
  const root = tmp(t, 'dashauto-'); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { now: Date.now() };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } }, inbox: { dir: inboxDir, ...auto } };
  server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => clock.now }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject); r.end(body); });
  const postAll = (items, { proof = writeToken(root), origin = `http://127.0.0.1:${port}` } = {}) => req('POST', '/inbox-all', { headers: { ...(origin ? { origin } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['proof', proof], ...items.map(i => ['item', i])]).toString() });
  return { root, port, clock, get: p => req('GET', p), req, postAll };
}
const key = (dir, id) => `${id}:${inbox.statusOf(dir, id).hash.slice(0, 12)}`;
test('dashboard: Approve all states the item and prompt counts, and carries exactly the ids and hashes on screen', async t => {
  const dir = makeInbox(t), p = drop(dir, PROMPT), q = drop(dir, { ...PROMPT, title: 'Second' }), c = drop(dir, act('close_job', hex(4)));
  inbox.scan(dir, 1000, ON);
  const s = await serve(t, dir, { auto: false }), page = (await s.get('/')).body;
  assert.match(page, /Approve all \(3 items, 2 of them prompts\)/); assert.match(page, /2 prompts will start Foreman jobs on Tower/);
  assert.match(page, /<form method="post" action="\/inbox-all"[^>]*><input type="hidden" name="proof"/);
  for (const id of [p, q, c]) assert.ok(page.includes(`name="item" value="${key(dir, id)}"`));
  const none = makeInbox(t); drop(none, act('close_job', hex(4))); inbox.scan(none, 1000, ON);
  assert.match((await (await serve(t, none)).get('/')).body, /Approve all \(1 item, 0 of them prompts\)/);
  assert.match((await (await serve(t, none)).get('/')).body, /None of them is a prompt/);
});
test('dashboard: Approve all approves what was on screen, re-checked; a late, changed or already-decided item is left waiting; the counts are reported', async t => {
  const dir = makeInbox(t), a = drop(dir, PROMPT), b = drop(dir, act('stop_job', hex(4))), changed = drop(dir, act('close_job', hex(4))), decided = drop(dir, act('close_job', hex(4)));
  inbox.scan(dir, 1000, ON);
  const shown = [a, b, changed, decided].map(id => key(dir, id));
  const late = drop(dir, act('stop_job', hex(4))); inbox.scan(dir, 1100, ON);          // arrived after the page was drawn
  fs.writeFileSync(path.join(dir, 'items', `${changed}.json`), JSON.stringify(act('close_job', '12345678')));   // edited after it was shown
  assert.equal(inbox.decide(dir, decided, 'reject', 1200).ok, true);
  const s = await serve(t, dir, { auto: false });
  const r = await s.postAll(shown);
  assert.equal(r.status, 303); assert.match(r.headers.location, /notice=inbox-all&approved=2&left=2/);
  assert.deepEqual(states(dir, [a, b, changed, decided, late]), ['approved', 'approved', 'pending', 'rejected', 'pending']);
  assert.equal(inbox.statusOf(dir, a).decidedBy, 'homeowner'); assert.ok(events(dir).some(e => e.id === a && e.event === 'approved' && e.via === 'approve_all'));
  assert.match((await s.get(r.headers.location)).body, /Approve all: 2 approved, 2 left waiting/);
  // a wrong hash for a pending item changes nothing
  s.clock.now += 5000; assert.match((await s.postAll([`${late}:${'0'.repeat(12)}`])).headers.location, /approved=0&left=2/); assert.equal(inbox.statusOf(dir, late).state, 'pending');
});
test('dashboard: Approve all has the same write protection as one approval', async t => {
  const dir = makeInbox(t), a = drop(dir, PROMPT); inbox.scan(dir, 1000, ON);
  const s = await serve(t, dir, { auto: false }), item = key(dir, a);
  assert.equal((await s.postAll([item], { proof: 'f'.repeat(64) })).status, 403); assert.equal((await s.postAll([item], { proof: '' })).status, 403);
  assert.equal((await s.postAll([item], { origin: 'http://evil.example' })).status, 403); assert.equal((await s.postAll([item], { origin: null })).status, 403);
  assert.equal((await s.postAll([])).status, 400); assert.equal((await s.postAll(['../x:abc'])).status, 400); assert.equal((await s.postAll(Array.from({ length: 21 }, () => `${hex(16)}:${hex(6)}`))).status, 400);
  assert.equal(inbox.statusOf(dir, a).state, 'pending', 'nothing was decided');
  assert.equal((await s.postAll([item])).status, 303); assert.equal(inbox.statusOf(dir, a).state, 'approved');
  assert.notEqual((await s.req('GET', '/inbox-all')).status, 303);
});
test('dashboard: what ran without a click in the last 24 hours is shown against the limits and is not part of Needs you', async t => {
  const dir = makeInbox(t), now = Date.now();
  const d = drop(dir, draft(1)), r = drop(dir, act('resume_job', 'abcdef01')), held = drop(dir, act('stop_job', hex(4)));
  inbox.scan(dir, now - 2 * H, ON); inbox.finish(dir, d, { state: 'done', result: 'posted as issue #77', issue: 77 }, now - 2 * H + 10);
  const old = drop(dir, draft(2)); inbox.scan(dir, now - 30 * H, ON);                  // outside the window
  const s = await serve(t, dir), view = JSON.parse((await s.get('/api/view.json')).body);
  assert.equal(view.autoRuns.drafts.used, 1); assert.equal(view.autoRuns.drafts.limit, 10);
  assert.deepEqual(view.autoRuns.actions.map(x => [x.name, x.used, x.limit]), [['new_review_attempt', 0, 5], ['reopen', 0, 5], ['resume_job', 1, 5]]);
  assert.equal(view.autoRuns.rows.length, 2); assert.ok(view.autoRuns.rows.some(x => x.issue === 77 && /issue draft/.test(x.what)));
  assert.ok(view.autoRuns.rows.some(x => /resume_job on job abcdef01/.test(x.what)));
  assert.ok(!view.autoRuns.rows.some(x => x.id === old));
  assert.deepEqual(view.panels.needsYou.map(x => x.id).sort(), [`inbox-${held}`], 'only the waiting card is in Needs you');
  const page = (await s.get('/')).body;
  assert.match(page, /Ran without a click \(2\)/); assert.match(page, /issue drafts 1 of 10/); assert.match(page, /resume_job 1 of 5/); assert.match(page, /issue #77/);
  assert.match(page, /Needs you \(1\)/);
  const off = await serve(t, dir, { auto: false }); assert.match((await off.get('/')).body, /Automatic handling is off/);
});
