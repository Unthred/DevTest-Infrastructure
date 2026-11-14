// Issue #1341: a delivered alert stays delivered when the alert log line cannot be written, and the catches around alert delivery print.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alertSender } from '../supervisor/alert.mjs';
import { SelfUpgrade } from '../supervisor/upgrade.mjs';
import { applyAction, readWatchlist, advanceWatchlist, factsFromCache } from '../supervisor/watchlist.mjs';

const TEXT = 'Allowance: codex: reviews only until Thu 04:04, weekly 94%';
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const tmp = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'alertrec-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); return r; };
const config = { alerts: { command: ['/bin/true'] } };
const sender = (root, status, lines) => alertSender(root, config, { run: () => ({ status }), env: {}, log: l => lines.push(l) });

test('valid: a writable root delivers, writes one row with delivered true, prints nothing', async t => {
  const root = tmp(t), lines = [];
  await sender(root, 0, lines)(TEXT);
  const rows = fs.readFileSync(path.join(root, 'team/alerts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1); assert.equal(rows[0].delivered, true); assert.equal(rows[0].text, TEXT);
  assert.deepEqual(lines, []);
});

test('boundary: the log cannot be written after a delivered alert: returns, prints one "not recorded" line', async t => {
  const root = tmp(t), lines = [];
  fs.writeFileSync(path.join(root, 'team'), 'a plain file');
  await sender(root, 0, lines)(TEXT);
  assert.equal(lines.length, 1); assert.match(lines[0], /delivered but not recorded/); assert.match(lines[0], /EEXIST|ENOTDIR/);
});

test('invalid: delivery exits 1 and the log write fails: the delivery error is thrown and both lines are printed', async t => {
  const root = tmp(t), lines = [];
  fs.writeFileSync(path.join(root, 'team'), 'a plain file');
  await assert.rejects(sender(root, 1, lines)(TEXT), { message: 'alert command failed: exit 1' });
  assert.equal(lines.length, 2); assert.match(lines[0], /not recorded/); assert.match(lines[1], /alert not delivered: alert command failed: exit 1/);
});

test('upgrade: a throwing alert prints its message, the alert stays recorded before sending, the decision is unchanged', async t => {
  const root = tmp(t), lines = [];
  const up = new SelfUpgrade({ root, deps: { alert: async () => { throw new Error('channel down'); } }, log: l => lines.push(l) });
  await up.alert('k', 'text');
  assert.equal(lines.length, 1); assert.match(lines[0], /channel down/);
  assert.ok(up.s.alerted.k);
  await up.alert('k', 'text');
  assert.equal(lines.length, 1, 'recorded once, not retried');
});

test('watch list: a throwing alert prints its message and nothing is marked sent', async t => {
  const root = tmp(t), lines = [];
  for (const d of ['dashboard', 'team']) fs.mkdirSync(path.join(root, d));
  applyAction(root, { kind: 'pr', number: 12, action: 'watch', now: NOW - 1000 });
  const cache = { pulls: [{ number: 12, title: 'T', headRefName: 'claude/issue-10-x', headRefOid: 'a'.repeat(40), isDraft: false, labels: ['needs-homeowner'], statusCheckRollup: [] }], merged: [] };
  const checksOf = () => 'green';
  const r = await advanceWatchlist({ root, cache, state: {}, now: NOW, checksOf, alert: async () => { throw new Error('channel down'); }, log: l => lines.push(l), factsFor: factsFromCache({ cache, state: {}, now: NOW, checksOf }) });
  assert.deepEqual(r.sent, []); assert.equal(lines.length, 1); assert.match(lines[0], /channel down/);
  assert.equal(readWatchlist(root).items[0].alerts.needs, undefined);
});
