// Issue #976: the Inbox sections, the recommended action, issue-draft auto-post under a daily limit, and the renamed surfaces.
// Fixtures are built at run time; no GitHub, model or real state is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { classifyItem, buildInbox, actionCount, SECTIONS } from '../supervisor/inboxsections.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inbsec-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); fs.mkdirSync(path.join(d, 'items')); fs.mkdirSync(path.join(d, 'status')); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
const drop = (dir, item) => { const id = hex(16); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const draft = n => ({ kind: 'issue_draft', title: `Draft ${n}`, body: `Body of draft ${n}.` });
const PROMPT = { kind: 'prompt', title: 'Tidy docs', prompt: 'Fix a link.' };
const NOW = Date.parse('2026-11-07T12:00:00');

test('auto-post: pending issue drafts are approved without a click up to the daily limit, oldest first', t => {
  const dir = tmp(t), ids = [1, 2, 3, 4].map(n => drop(dir, draft(n)));
  inbox.scan(dir, NOW);
  assert.deepEqual(inbox.autoApproveDrafts(dir, NOW + 1, 2), { approved: 2 });
  const states = ids.map(id => inbox.statusOf(dir, id));
  assert.equal(states.filter(s => s.state === 'approved' && s.auto === true).length, 2);
  assert.equal(states.filter(s => s.state === 'pending').length, 2);
  assert.deepEqual(inbox.autoPostSummary(dir, NOW + 1, 2), { posted: 2, limit: 2 });
  assert.deepEqual(inbox.autoApproveDrafts(dir, NOW + 2, 2), { approved: 0 }, 'the limit holds on the next pass');
});
test('auto-post: a prompt and an action always wait for a click; a limit of 0 switches it off', t => {
  const dir = tmp(t), p = drop(dir, PROMPT), a = drop(dir, { kind: 'action', title: 'Reopen', action: 'reopen', target: '9', reason: 'no pr' }), d = drop(dir, draft(1));
  inbox.scan(dir, NOW);
  assert.deepEqual(inbox.autoApproveDrafts(dir, NOW, 0), { approved: 0 });
  assert.equal(inbox.statusOf(dir, d).state, 'pending');
  inbox.autoApproveDrafts(dir, NOW, 50);
  assert.equal(inbox.statusOf(dir, p).state, 'pending'); assert.equal(inbox.statusOf(dir, a).state, 'pending'); assert.equal(inbox.statusOf(dir, d).state, 'approved');
  assert.equal(inbox.autoPostSummary(dir, NOW, 0), null);
});
test('auto-post: the count is per calendar day, and an Undo gives the item back without leaving the auto mark', t => {
  const dir = tmp(t); const a = drop(dir, draft(1)), b = drop(dir, draft(2));
  inbox.scan(dir, NOW); inbox.autoApproveDrafts(dir, NOW, 1);
  assert.equal(inbox.autoPostedToday(dir, NOW), 1);
  assert.equal(inbox.autoPostedToday(dir, NOW + 86400000), 0, 'tomorrow starts at zero');
  assert.equal(inbox.autoApproveDrafts(dir, NOW + 86400000, 1).approved, 1, 'the second draft posts tomorrow');
  const first = [a, b].find(id => inbox.statusOf(dir, id).decidedAt === NOW);
  assert.equal(inbox.undo(dir, first, NOW + 1000).ok, true);
  const s = inbox.statusOf(dir, first); assert.equal(s.state, 'pending'); assert.equal(s.auto, undefined);
});
test('auto-post: a draft changed on disk after pickup is refused by the same hash check as a click', t => {
  const dir = tmp(t), id = drop(dir, draft(1)); inbox.scan(dir, NOW);
  fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify({ ...draft(1), body: 'edited after pickup' }));
  assert.equal(inbox.autoApproveDrafts(dir, NOW, 5).approved, 0);
  assert.equal(inbox.statusOf(dir, id).state, 'refused');
});
const card = (o = {}) => ({ id: 'x', text: 'Something', ref: null, severity: 'action', ...o });
test('sections: blocking and harmful items are Decide now; the rest Can wait; the rule and a recommended action are on every item', () => {
  const items = [card({ id: 'homeowner-7', blocks: 3 }), card({ id: 'stale-mark-9', ref: { kind: 'issue', n: 9 } }), card({ id: 'breaker', blocks: 0 }), card({ id: 'job-abc' }), card({ id: 'homeowner-5', action: 'Answer the question. More.' })];
  const inb = buildInbox(items);
  const by = Object.fromEntries(inb.items.map(i => [i.id, i]));
  assert.equal(by['homeowner-7'].section, 'decide'); assert.match(by['homeowner-7'].rule, /Blocks 3 other items/);
  assert.equal(by.breaker.section, 'decide'); assert.equal(by['job-abc'].section, 'decide');
  assert.equal(by['stale-mark-9'].section, 'wait'); assert.equal(by['stale-mark-9'].recommend.action, 'reopen');
  assert.equal(by['homeowner-5'].section, 'wait');
  for (const i of inb.items) { assert.ok(i.rule, i.id); assert.ok(i.recommend.label && i.recommend.why, i.id); }
  assert.deepEqual(inb.sections.map(s => [s.id, s.count]), [['decide', 3], ['wait', 2], ['auto', 0]]);
  assert.equal(inb.sections.length, SECTIONS.length);
});
test('sections: an issue draft under the daily limit is Handled automatically and does not count toward the badge; over the limit it waits', () => {
  const draftCard = { id: 'inbox-aa', inboxId: 'aa', inboxKind: 'issue_draft', inbox: { kind: 'issue_draft' }, text: 'Overseer proposal (post as an issue): X', severity: 'action' };
  const promptCard = { id: 'inbox-bb', inboxId: 'bb', inboxKind: 'prompt', inbox: { kind: 'prompt' }, text: 'Overseer proposal (run as a job): Y', severity: 'action' };
  const under = buildInbox([draftCard, promptCard], { auto: { limit: 5, posted: 2 } });
  assert.equal(under.items[0].section, 'auto'); assert.match(under.items[0].rule, /2 of 5 posted today/);
  assert.equal(under.items[1].section, 'wait'); assert.equal(under.items[1].recommend.action, 'approve');
  assert.equal(actionCount(under), 1); assert.deepEqual(under.autoPost, { posted: 2, limit: 5 });
  const over = buildInbox([draftCard], { auto: { limit: 5, posted: 5 } });
  assert.equal(over.items[0].section, 'wait'); assert.equal(actionCount(over), 1);
  assert.equal(classifyItem({ ...promptCard, inbox: { kind: 'prompt', broken: 'bad' } }).recommend.action, 'reject');
  assert.equal(buildInbox([draftCard]).autoPost, null, 'auto-post off: no summary');
});

test('mcp: foreman_inbox exists and foreman_needs_you stays as an alias returning the same result', async () => {
  const view = { panels: { needsYou: [{ id: 'homeowner-1', text: 'Q', ref: { kind: 'issue', n: 1 } }] }, health: { count: 1 } };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0, stale: false }) }, readHost: () => ({}) });
  assert.ok(tools.has('foreman_inbox')); assert.ok(tools.has('foreman_needs_you'));
  const a = await tools.call('foreman_inbox', {}), b = await tools.call('foreman_needs_you', {});
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a).includes('inboxItems'), true);
  assert.ok(!tools.list().find(x => x.name === 'foreman_inbox').description.includes('Needs you items'));
});
