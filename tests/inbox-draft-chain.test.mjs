// Issue #1259: an issue draft may name earlier drafts (`after`); Foreman posts it only once they are issues and writes their numbers into the body.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { parseDependsOn } from '../supervisor/dependencies.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const FIRST = { kind: 'issue_draft', title: 'Contract router extension points for query, keyed paths, route modules and write guard Routerext', body: 'Extend the router.' };
const SECOND = { kind: 'issue_draft', title: 'One change stream that says which read models changed Changestream', body: 'Add one change stream.' };
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });

function world(t, numbers = [1251, 1254, 1260, 1261]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-chain-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'inbox'), posted = [];
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const gh = { listPulls: async () => [], getPull: async () => null, listIssues: async () => [], board: async () => {}, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {},
    findIssueByMarker: async mark => posted.find(p => p.body.includes(mark))?.number ?? null,
    createIssue: async (title, body) => { const number = numbers.shift(); posted.push({ number, title, body }); return number; } };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'e0cc278b'.padEnd(32, '0') }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config, root: stateRoot(path.join(tmp, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 5000 }, providerModels: { claude: { aliases: ['sonnet'], pattern: '^claude-', efforts: ['medium'] } } });
  const mcp = createInbox({ dir });
  const submit = item => { const r = mcp.propose(item); inbox.scan(dir, 1); return r.id; };
  const pass = () => team.processInbox(rep());
  const approve = id => assert.equal(inbox.decide(dir, id, 'approve', 2).ok, true);
  return { dir, posted, mcp, submit, pass, approve, state: id => inbox.statusOf(dir, id) };
}
const rawDraft = (w, item) => { const id = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(w.dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };

test('valid: the second draft names the first; approved in order, it is posted with a line holding the number of the first', async t => {
  const w = world(t);
  const first = w.submit(FIRST), second = w.submit({ ...SECOND, after: [first.slice(0, 8)] });
  w.approve(first); w.approve(second);
  await w.pass(); await w.pass();   // one pass may reach the second draft before the first, which then waits for the next
  assert.equal(w.state(first).issue, 1251);
  assert.equal(w.state(second).state, 'done');
  const body = w.posted.find(p => p.number === 1254).body;
  assert.ok(body.startsWith('Depends on: #1251\n'), body);
  assert.deepEqual(parseDependsOn(body).numbers, [1251]);
  assert.equal(w.posted.length, 2);
});

test('boundary: approved before the named draft it stays approved over two passes, then posts once', async t => {
  const w = world(t);
  const first = w.submit(FIRST), second = w.submit({ ...SECOND, after: [first] });
  w.approve(second);
  await w.pass(); await w.pass();
  assert.equal(w.state(second).state, 'approved');
  assert.match(w.state(second).waitsFor[0], /Routerext \(/);
  assert.match(w.mcp.status(second).waitsFor[0], /Routerext/);
  assert.equal(w.posted.length, 0);
  w.approve(first);
  await w.pass(); await w.pass(); await w.pass();
  assert.equal(w.posted.length, 2);
  assert.equal(w.posted.filter(p => p.title.includes('Changestream')).length, 1);
  assert.equal(w.state(second).issue, w.posted.find(p => p.title.includes('Changestream')).number);
  assert.match(w.posted.find(p => p.title.includes('Changestream')).body, /^Depends on: #1251\n/);
});

test('boundary: a body that already declares a number gets the new number merged into the same line, without repeats', async t => {
  const w = world(t);
  const first = w.submit(FIRST), second = w.submit({ ...SECOND, body: 'Intro.\nDepends on: #900, #1251\nMore.', after: [first] });
  w.approve(first); w.approve(second);
  await w.pass(); await w.pass();
  const body = w.posted.find(p => p.title.includes('Changestream')).body;
  assert.equal(body.split('\n').filter(l => /depends on/i.test(l)).length, 1);
  assert.deepEqual(parseDependsOn(body).numbers, [900, 1251]);
  assert.ok(body.startsWith('Intro.\nDepends on: #900, #1251\nMore.'));
});

test('boundary: exactly 10 entries are accepted and merge into one line', async t => {
  const w = world(t, Array.from({ length: 11 }, (_, i) => 2000 + i));
  const ids = Array.from({ length: 10 }, (_, i) => w.submit({ ...FIRST, title: `Draft ${i}` }));
  const last = w.submit({ ...SECOND, after: ids });
  ids.forEach(w.approve); w.approve(last);
  await w.pass(); await w.pass();
  assert.equal(w.state(last).state, 'done');
  assert.equal(parseDependsOn(w.posted.find(p => p.title.includes('Changestream')).body).numbers.length, 10);
});

test('invalid: 11 entries, a non-id, a non-list, an unknown id and a non-draft are refused at submit and at pickup, naming the entry', async t => {
  const w = world(t);
  const first = w.submit(FIRST), prompt = w.submit({ kind: 'prompt', title: 'A prompt', prompt: 'Do it.' });
  const cases = [
    [Array(11).fill(first), /11 drafts; the limit is 10/],
    [[first, 'not-an-id'], /after entry 2 is not an 8 or 32 character proposal id/],
    ['abcd1234', /after must be a list/],
    [[], /at least one/],
    [[first, 'deadbeef'], /after entry 2 is not an item the Inbox knows/],
    [[prompt], /after entry 1 is not an issue draft/],
  ];
  for (const [after, reason] of cases) {
    assert.throws(() => w.mcp.propose({ ...SECOND, after }), reason);
    const id = rawDraft(w, { ...SECOND, after });
    inbox.scan(w.dir, 1);
    assert.equal(w.state(id).state, 'refused');
    assert.match(w.state(id).reason, reason);
  }
});

test('invalid: a draft naming itself is refused at pickup; other kinds refuse after as an unknown field', async t => {
  const w = world(t);
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(w.dir, 'items', `${id}.json`), JSON.stringify({ ...SECOND, after: [id] }));
  inbox.scan(w.dir, 1);
  assert.match(w.state(id).reason, /after entry 1 names the draft itself/);
  assert.throws(() => w.mcp.propose({ kind: 'prompt', title: 'P', prompt: 'x', after: ['deadbeef'] }), /unknown argument: after/);
  const raw = rawDraft(w, { kind: 'prompt', title: 'P', prompt: 'x', after: ['deadbeef'] });
  inbox.scan(w.dir, 1);
  assert.match(w.state(raw).reason, /unknown field: after/);
});

test('invalid: a named draft that was rejected fails the draft with a reason naming it, and nothing is posted', async t => {
  const w = world(t);
  const first = w.submit(FIRST), second = w.submit({ ...SECOND, after: [first] });
  assert.equal(inbox.decide(w.dir, first, 'reject', 2).ok, true);
  w.approve(second);
  await w.pass();
  const st = w.state(second);
  assert.equal(st.state, 'failed');
  assert.match(st.reason, /Routerext.*was rejected/);
  assert.equal(w.posted.length, 0);
});

test('the content hash covers after, and the card names the drafts it waits for', async t => {
  const w = world(t);
  const first = w.submit(FIRST), second = w.submit({ ...SECOND, after: [first] });
  const card = inbox.pendingCards(w.dir).find(c => c.id === second);
  assert.match(card.waitsFor[0], /Routerext/);
  assert.match(card.will, /waits for the earlier drafts: .*Routerext/);
  const file = path.join(w.dir, 'items', `${second}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, after: [] }));
  assert.equal(inbox.loadItem(w.dir, second).ok, false);
});
