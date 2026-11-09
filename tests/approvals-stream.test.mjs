// Issue #1101: the open page learns that a proposal arrived or was decided without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { approvalsSignature, approvalsStream, APPROVALS_MAX_STREAMS } from '../supervisor/approvals-stream.mjs';

const fake = () => { const res = { head: null, out: '', ended: false, writeHead(c, h) { this.head = [c, h]; }, write(s) { this.out += s; }, end(s) { this.out += s || ''; this.ended = true; } }; return { req: new EventEmitter(), res }; };
const tick = ms => new Promise(r => setTimeout(r, ms));

test('signature: changes exactly when an item is added or removed, whatever the order', () => {
  assert.equal(approvalsSignature([{ id: 'b' }, { id: 'a' }]), approvalsSignature([{ id: 'a' }, { id: 'b' }]));
  assert.notEqual(approvalsSignature([{ id: 'a' }]), approvalsSignature([{ id: 'a' }, { id: 'c' }]));
  assert.equal(approvalsSignature(undefined), '');
});

test('stream: says nothing at first, then "changed" when an item arrives and again when one is decided', async () => {
  const { req, res } = fake(); let rows = [{ id: 'a' }];
  approvalsStream({ req, res, headers: {}, active: new Set(), read: async () => rows, pollMs: 10 });
  await tick(40); assert.ok(!res.out.includes('event: changed'));
  rows = [{ id: 'a' }, { id: 'b' }]; await tick(40);
  assert.match(res.out, /event: changed\ndata: \{"count":2\}/);
  rows = []; await tick(40);
  assert.match(res.out, /data: \{"count":0\}/);
  req.emit('close'); assert.ok(res.ended);
});

test('stream: refuses a new viewer when too many are open, and a failed read ends the stream', async () => {
  const full = new Set(Array.from({ length: APPROVALS_MAX_STREAMS }, () => ({})));
  const a = fake(); approvalsStream({ ...a, headers: {}, active: full, read: async () => [] });
  assert.equal(a.res.head[0], 503);
  const b = fake(); approvalsStream({ ...b, headers: {}, active: new Set(), read: async () => { throw new Error('x'); }, pollMs: 10 });
  await tick(20); assert.ok(b.res.ended);
});
