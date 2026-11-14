// Issue #1280: the helper that records an already approved Inbox action. Real Inbox store and real dispatch function on a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../supervisor/inbox.mjs';
import { dispatchApproved } from '../supervisor/controlactions.mjs';
import { recordApprovedAction, SOURCE } from '../supervisor/api/approved-action.mjs';

const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);
const REASON = 'Rebase cap on PR 1189 cleared from the Overview screen';
const FIELDS = { action: 'clear_retry_cap', target: '1189', reason: REASON, title: 'Clear the retry cap on PR 1189', now: NOW };
const call = (dir, over = {}) => recordApprovedAction({ inboxDir: dir, ...FIELDS, ...over });
const inbox = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-action-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const written = dir => ['items', 'status'].flatMap(sub => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter(n => /^[a-f0-9]{32}\./.test(n)) : []));   // issue #1414: not the number counter or a reservation

test('valid: the item loads with a matching hash and is listed among approved actions', t => {
  const dir = inbox(t), r = call(dir);
  assert.equal(r.ok, true);
  assert.match(r.id, /^[a-f0-9]{32}$/);
  const loaded = store.loadItem(dir, r.id);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.item, { kind: 'action', title: 'Clear the retry cap on PR 1189', action: 'clear_retry_cap', target: '1189', reason: REASON });
  assert.deepEqual(store.approvedItems(dir, 'action').map(s => s.id), [r.id]);
});

test('the status is approved with the hash, time, title, action, target and source, and no decision', t => {
  const dir = inbox(t), r = call(dir), s = store.statusOf(dir, r.id);
  assert.equal(s.state, 'approved');
  assert.equal(s.kind, 'action');
  assert.equal(s.createdAt, NOW);
  assert.equal(s.title, 'Clear the retry cap on PR 1189');
  assert.equal(s.action, 'clear_retry_cap');
  assert.equal(s.target, '1189');
  assert.equal(s.source, SOURCE);
  assert.equal(s.hash, store.hashOf(JSON.parse(fs.readFileSync(path.join(dir, 'items', `${r.id}.json`), 'utf8'))));
  assert.equal('decision' in s, false);
});

test('boundary: a reason of 300 characters is accepted and 301 is refused', t => {
  const dir = inbox(t);
  const words = n => 'cleared the cap '.repeat(30).slice(0, n);   // plain words: a long unbroken run would count as secret shaped
  assert.equal(call(dir, { reason: words(300) }).ok, true);
  const long = call(inbox(t), { reason: words(301) });
  assert.equal(long.ok, false);
  assert.match(long.reason, /300/);
});

test('invalid: unknown action, non-numeric pull request target, empty and secret shaped reasons write nothing', t => {
  const bad = [{ action: 'format_disk' }, { target: 'abc' }, { reason: '   ' }, { reason: `token ghp_${'a1'.repeat(18)}` }];
  for (const over of bad) {
    const dir = inbox(t), r = call(dir, over);
    assert.equal(r.ok, false, JSON.stringify(Object.keys(over)));
    assert.equal(typeof r.reason, 'string');
    assert.deepEqual(written(dir), []);
  }
});

test('repeat: refused while the first is approved or running, accepted once it is done', t => {
  const dir = inbox(t), first = call(dir);
  const again = call(dir);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already queued/);
  assert.equal(written(dir).length, 2);
  assert.equal(call(dir, { target: '1190' }).ok, true);   // a different target is not a repeat
  store.finish(dir, first.id, { state: 'running' }, NOW);
  assert.equal(call(dir).ok, false);
  store.finish(dir, first.id, { state: 'done', result: 'cleared' }, NOW);
  assert.equal(call(dir).ok, true);
});

test('real scan leaves the item approved, not waiting, not refused', t => {
  const dir = inbox(t), r = call(dir);
  const before = store.statusOf(dir, r.id);
  const out = store.scan(dir, NOW + 1000);
  assert.equal(out.picked, 0);
  assert.deepEqual(store.statusOf(dir, r.id), before);
  assert.equal(store.pendingCards(dir).length, 0);
});

test('real dispatch runs the action once with the same action, target and reason', async t => {
  const dir = inbox(t), r = call(dir), ran = [];
  const team = { runInboxAction: async (d, st, item) => { ran.push(item); store.finish(d, st.id, { state: 'done', result: 'ok' }, NOW); } };
  const loaded = store.loadItem(dir, r.id);
  await dispatchApproved(team, store, dir, store.statusOf(dir, r.id), loaded.item, {});
  assert.equal(ran.length, 1);
  assert.deepEqual([ran[0].action, ran[0].target, ran[0].reason], ['clear_retry_cap', '1189', REASON]);
  await dispatchApproved(team, store, dir, store.statusOf(dir, r.id), loaded.item, {});   // a second pass finds it done
  assert.equal(ran.length, 1);
});

test('undo is refused for the new item', t => {
  const dir = inbox(t), r = call(dir), u = store.undo(dir, r.id, NOW + 1000);
  assert.equal(u.ok, false);
  assert.equal(store.statusOf(dir, r.id).state, 'approved');
});
