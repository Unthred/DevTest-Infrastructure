// Issue #1316: the overseer withdraws or replaces its own pending Inbox items; drafts that wait for a replaced draft follow the replacement.
// Real MCP handlers (propose, status, withdraw), the real pickup (scan) and the real pass (Team.processInbox) on a temporary Inbox with a fake GitHub client.
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
import { inboxToolDefs } from '../foreman-mcp/inbox-tools.mjs';
import { controlTools } from '../foreman-mcp/controltools.mjs';

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
  // The tools as the MCP server offers them; the withdraw waits by running the real pickup and the real pass, as the woken pass would.
  const wait = async () => { inbox.scan(dir, 1); await pass(); };
  const withdrawTool = controlTools({ inbox: mcp, wait, waitMs: 5000 }).find(d => d.name === 'foreman_withdraw');
  const propose = inboxToolDefs(mcp).find(d => d.name === 'foreman_propose');
  return { dir, posted, mcp, submit, pass, approve, state: id => inbox.statusOf(dir, id), withdraw: (id, reason = 'wrong') => withdrawTool.run({ id, reason }),
    replace: (old, item) => { const r = propose.run({ ...item, replaces: old }); inbox.scan(dir, 1); return r; }, wait };
}

const MOTION = { kind: 'issue_draft', title: 'Live board balls travel from hopper to lane and bounce down the pegs into their box Boardmotion', body: 'Balls travel.' };
const STYLES = { kind: 'issue_draft', title: 'Live board drawing styles behind one switch with the peg board as the first style Boardstyles', body: 'Styles.' };
const MARBLE = { kind: 'issue_draft', title: 'Live board Marble run style where balls roll down sloped tracks to a sorting rail with a gate above each box Marblerun', body: 'Marbles.' };
const rawDraft = (w, item) => { const id = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(w.dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const PROMPT = { kind: 'prompt', title: 'A prompt', prompt: 'Do it.' };

test('valid: Boardstyles is replaced by a copy that waits for Boardmotion; Marblerun follows; approved in reverse they post in chain order', async t => {
  const w = world(t, [101, 102, 103]);
  const motion = w.submit(MOTION), styles = w.submit(STYLES), marble = w.submit({ ...MARBLE, after: [styles] });
  const reply = w.replace(styles, { ...STYLES, body: 'Styles, corrected.', after: [motion] });
  assert.equal(reply.replaces.id, styles);
  assert.match(reply.replaces.title, /Boardstyles/);
  assert.deepEqual(reply.linksMoved.map(m => m.id), [marble]);
  const fresh = reply.id;
  assert.equal(w.state(styles).state, 'withdrawn');
  assert.match(w.state(styles).reason, /^replaced by Live board drawing styles .* Boardstyles$/);
  assert.equal(w.state(fresh).state, 'pending');
  assert.deepEqual(w.state(fresh).replaced.linksMoved.map(m => m.id), [marble]);
  assert.equal(inbox.pendingCards(w.dir).some(c => c.id === styles), false);
  assert.match(inbox.pendingCards(w.dir).find(c => c.id === marble).waitsFor[0], new RegExp(`Boardstyles \\(${fresh.slice(0, 8)}\\)`));
  w.approve(marble); w.approve(fresh); w.approve(motion);
  for (let i = 0; i < 4; i++) await w.pass();
  assert.deepEqual(w.posted.map(p => p.number), [101, 102, 103]);
  assert.match(w.posted[0].title, /Boardmotion/);
  assert.match(w.posted[1].body, /^Depends on: #101\n/);
  assert.match(w.posted[1].body, /Styles, corrected/);
  assert.match(w.posted[2].body, /^Depends on: #102\n/);
  assert.equal(w.state(marble).issue, 103);
});

test('valid: the audit log names both ids and titles, and the status of the dependent names the replacement', async t => {
  const w = world(t);
  const styles = w.submit(STYLES), marble = w.submit({ ...MARBLE, after: [styles] });
  const { id: fresh } = w.replace(styles, STYLES);
  const lines = fs.readFileSync(path.join(w.dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const entry = lines.find(l => l.event === 'replaced');
  assert.equal(entry.id, styles);
  assert.equal(entry.replacedBy, fresh);
  assert.match(entry.title, /Boardstyles/);
  assert.match(entry.replacedByTitle, /Boardstyles/);
  assert.deepEqual(entry.linksMoved.map(m => m.id), [marble]);
  const proposed = lines.find(l => l.event === 'proposed' && l.id === fresh);
  assert.equal(proposed.replaces, styles);
  assert.match(w.mcp.status(marble).waitsFor[0], new RegExp(fresh.slice(0, 8)));
});

test('valid: withdraw through the tool; the item leaves pending, the record is kept and readable, and the audit has it', async t => {
  const w = world(t);
  const a = w.submit(STYLES), keep = w.submit(MOTION);
  const out = await w.withdraw(a, 'wrong card');
  assert.equal(out.state, 'done');
  assert.equal(inbox.pendingCards(w.dir).some(c => c.id === a), false);
  assert.equal(inbox.pendingCards(w.dir).some(c => c.id === keep), true);
  const status = w.mcp.status(a);
  assert.equal(status.state, 'withdrawn');
  assert.equal(status.reason, 'wrong card');
  assert.ok(status.withdrawnAt);
  assert.equal(status.replacedBy, null);
  assert.equal(w.mcp.list({ state: 'withdrawn' }).items.length, 1);
  const audit = fs.readFileSync(path.join(w.dir, 'audit.jsonl'), 'utf8');
  assert.match(audit, /"event":"withdrawn"/);
  assert.match(audit, /Boardstyles/);
});

test('boundary: replacing an item nothing waits for moves no links and says so', async t => {
  const w = world(t);
  const a = w.submit(MOTION);
  const reply = w.replace(a, MOTION);
  assert.deepEqual(reply.linksMoved, []);
  assert.equal(w.state(a).state, 'withdrawn');
});

test('boundary: replacing twice in a row: the links follow to the newest', async t => {
  const w = world(t, [1, 2, 3]);
  const motion = w.submit(MOTION), styles = w.submit(STYLES), marble = w.submit({ ...MARBLE, after: [styles] });
  const second = w.replace(styles, { ...STYLES, after: [motion] }).id;
  const reply = w.replace(second, { ...STYLES, body: 'Third.', after: [motion] });
  assert.deepEqual(reply.linksMoved.map(m => m.id), [marble]);
  assert.equal(w.state(styles).state, 'withdrawn');
  assert.equal(w.state(second).state, 'withdrawn');
  w.approve(marble); w.approve(reply.id); w.approve(motion);
  for (let i = 0; i < 4; i++) await w.pass();
  assert.deepEqual(w.posted.map(p => p.number), [1, 2, 3]);
  assert.match(w.posted[1].body, /Third/);
  assert.match(w.posted[2].body, /^Depends on: #2\n/);
});

test('boundary: at the pending limit a replace is still accepted at submit and at pickup, a plain proposal is not', async t => {
  const w = world(t);
  const ids = [];
  for (let i = 0; i < inbox.LIMITS.pending; i++) ids.push(w.submit({ ...PROMPT, title: `Prompt ${i}` }));
  assert.throws(() => w.mcp.propose({ ...PROMPT, title: 'Extra' }), /inbox is full/);
  const reply = w.replace(ids[0], { ...PROMPT, title: 'Prompt 0 corrected' });
  assert.equal(w.state(reply.id).state, 'pending');
  assert.equal(inbox.allStatuses(w.dir).filter(s => s.state === 'pending').length, inbox.LIMITS.pending);
  const raw = rawDraft(w, { ...PROMPT, title: 'Raw extra' });
  inbox.scan(w.dir, 1);
  assert.match(w.state(raw).reason, /already waiting/);
});

test('invalid: withdraw or replace an approved, running, rejected or unknown item changes nothing and names the state', async t => {
  const w = world(t);
  const approved = w.submit({ ...PROMPT, title: 'Approved' }), running = w.submit({ ...PROMPT, title: 'Running' }), rejected = w.submit({ ...PROMPT, title: 'Rejected' });
  w.approve(approved); w.approve(running);
  inbox.claim(w.dir, running, 'approved', { state: 'running' }, 3);
  inbox.decide(w.dir, rejected, 'reject', 2);
  for (const [id, state] of [[approved, 'approved'], [running, 'running'], [rejected, 'rejected']]) {
    const out = await w.withdraw(id);
    assert.equal(out.state, 'refused');
    assert.match(out.reason, new RegExp(`is ${state}, not pending`));
    assert.throws(() => w.mcp.propose({ ...PROMPT, title: 'New', replaces: id }), new RegExp(`is ${state}, not pending`));
    assert.equal(w.state(id).state, state);
  }
  assert.equal(inbox.allStatuses(w.dir).filter(s => s.title === 'New').length, 0);
  assert.equal(fs.readdirSync(path.join(w.dir, 'items')).length, 3);   // a refused replace wrote no item file
  const unknown = 'deadbeef';
  assert.equal((await w.withdraw(unknown)).state, 'refused');
  assert.throws(() => w.mcp.propose({ ...PROMPT, replaces: unknown }), /no item with that id/);
});

test('invalid: a replace at pickup for a no longer pending item is refused with its state, and no second live version exists', async t => {
  const w = world(t);
  const old = w.submit(PROMPT);
  const raw = rawDraft(w, { ...PROMPT, title: 'Newer', replaces: old });
  w.approve(old);
  inbox.scan(w.dir, 1);
  assert.equal(w.state(raw).state, 'refused');
  assert.match(w.state(raw).reason, /is approved, not pending/);
  assert.equal(w.state(old).state, 'approved');
});

test('invalid: an unknown (decision card) id, a finished control item and a host value cannot be withdrawn; a prompt cannot replace a draft', async t => {
  const w = world(t);
  const draft = w.submit(STYLES);
  const out = await w.withdraw('0123abcd');
  assert.equal(out.state, 'refused');
  assert.throws(() => w.mcp.propose({ ...PROMPT, replaces: draft }), /is issue_draft but the new item is prompt/);
  const raw = rawDraft(w, { ...PROMPT, replaces: draft });
  inbox.scan(w.dir, 1);
  assert.match(w.state(raw).reason, /same kind/);
  assert.equal(w.state(draft).state, 'pending');
  const control = (await w.withdraw(draft.slice(0, 8), 'x')).state;
  assert.equal(control, 'done');
  const again = await w.withdraw(draft);
  assert.match(again.reason, /is withdrawn, not pending/);
  const hostId = inbox.raiseHostValue(w.dir, { key: 'dashboard.allowed_origins', value: 'http://tower:8080', why: 'x' }, 1);
  const hostCard = inbox.allStatuses(w.dir).find(x => x.kind === 'host_value');
  assert.ok(hostId && hostCard);
  assert.match((await w.withdraw(hostCard.id)).reason, /not an item of the propose tool/);
  const controlId = inbox.allStatuses(w.dir).find(x => x.kind === 'control').id;
  assert.match((await w.withdraw(controlId)).reason, /not pending/);
});

test('invalid: approving a withdrawn or replaced item is refused with the text, and no approve control remains', async t => {
  const w = world(t);
  const styles = w.submit(STYLES);
  const fresh = w.replace(styles, STYLES).id;
  const refused = inbox.decide(w.dir, styles, 'approve', 5);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /withdrawn: it was replaced by "Live board drawing styles .* Boardstyles"/);
  assert.equal(inbox.decide(w.dir, styles, 'reject', 5).ok, false);
  assert.equal(w.state(styles).state, 'withdrawn');
  const plain = w.submit(MOTION);
  await w.withdraw(plain, 'not needed');
  assert.match(inbox.decide(w.dir, plain, 'approve', 5).reason, /withdrawn: not needed/);
  assert.equal(inbox.pendingCards(w.dir).filter(c => [styles, plain].includes(c.id)).length, 0);
  assert.equal(inbox.undo(w.dir, styles, 6).ok, false);
  assert.equal(w.state(fresh).state, 'pending');
});

test('invalid: a replacement whose after names the item it replaces is refused; a draft that waits for a plainly withdrawn draft fails', async t => {
  const w = world(t);
  const styles = w.submit(STYLES);
  assert.throws(() => w.mcp.propose({ ...STYLES, after: [styles], replaces: styles }), /would wait for itself/);
  const marble = w.submit({ ...MARBLE, after: [styles] });
  await w.withdraw(styles, 'dropped');
  w.approve(marble);
  await w.pass();
  assert.equal(w.state(marble).state, 'failed');
  assert.match(w.state(marble).reason, /was withdrawn/);
  assert.equal(w.posted.length, 0);
});

test('invalid: a replacement that would wait for itself through another draft is refused at submit and at pickup, and nothing is withdrawn', async t => {
  const w = world(t);
  const motion = w.submit(MOTION);
  const styles = w.submit({ ...STYLES, after: [motion] });
  assert.throws(() => w.mcp.propose({ ...MOTION, replaces: motion, after: [styles] }), /would wait for itself/);
  const raw = rawDraft(w, { ...MOTION, replaces: motion, after: [styles] });
  inbox.scan(w.dir, 1);
  assert.equal(w.state(raw).state, 'refused');
  assert.match(w.state(raw).reason, /would wait for itself/);
  assert.equal(w.state(motion).state, 'pending');
});

test('the withdraw is applied when the control item is picked up, with no timer: one scan and one pass finish it', async t => {
  const w = world(t);
  const a = w.submit(MOTION);
  const sent = w.mcp.propose({ kind: 'control', title: `withdraw ${a.slice(0, 8)}`, action: 'withdraw', target: a.slice(0, 8), reason: 'no longer needed' });
  assert.equal(w.mcp.status(sent.id).state, 'waiting');
  assert.equal(w.state(a).state, 'pending');
  inbox.scan(w.dir, 1);
  await w.pass();
  assert.equal(w.state(a).state, 'withdrawn');
  assert.equal(w.state(sent.id).state, 'done');
  assert.equal(inbox.pendingCards(w.dir).length, 0);
});
