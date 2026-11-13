import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as inbox from '../supervisor/inbox.mjs';
import { postIssueDraft } from '../supervisor/issue-drafts.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';

const draft = { kind: 'issue_draft', title: 'A draft', body: 'Depends on: none' };
const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'issue-drafts-'));
  fs.mkdirSync(path.join(dir, 'items'));
  fs.mkdirSync(path.join(dir, 'status'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a draft proposal is refused with the parser reason and its corrected example', t => {
  const dir = tempDir(t);
  const local = inbox.validateItem(draft);
  assert.equal(local.ok, false);
  assert.match(local.reason, /comma-separated list/);
  assert.match(local.reason, /Depends on: #12, #15/);
  assert.throws(() => createInbox({ dir }).propose(draft), /comma-separated list.*Depends on: #12, #15/);
});

test('posting a draft repeats the parser check and makes no GitHub issue', async t => {
  const dir = tempDir(t);
  const id = 'a'.repeat(32);
  const calls = [];
  const team = {
    clock: { now: () => 10 },
    gh: {
      findIssueByMarker: async () => null,
      createIssue: async (...args) => calls.push(args),
    },
  };
  await postIssueDraft(team, dir, { id, state: 'posting' }, draft, { actions: [] });
  assert.deepEqual(calls, []);
  const status = inbox.statusOf(dir, id);
  assert.equal(status.state, 'failed');
  assert.match(status.reason, /Depends on: #12, #15/);
});
