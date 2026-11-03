import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATUS_MARKER, STATUS_TITLE, publishStatusIssue, renderBody, readStatusIssueState, scrub } from '../supervisor/statusissue.mjs';
import { githubClient } from '../supervisor/github.mjs';

// Issue #358: the pinned status issue. A fake GitHub holds issues in memory; nothing here touches the network.
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'status-issue-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function fakeGh({ existing = null, failUpdate = false, failPin = false } = {}) {
  const g = { issues: existing ? [existing] : [], calls: [] };
  g.findIssueByMarker = async m => g.issues.find(i => i.body.includes(m))?.number || null;
  g.createIssue = async (title, body) => { g.calls.push('create'); g.issues.push({ number: 900 + g.issues.length, title, body }); return g.issues.at(-1).number; };
  g.updateIssueBody = async (n, body) => { g.calls.push('update'); if (failUpdate) throw new Error('gh issue edit failed: HTTP 502'); g.issues.find(i => i.number === n).body = body; };
  g.pinIssue = async () => { g.calls.push('pin'); if (failPin) throw new Error('pin refused'); };
  return g;
}
const status = (over = {}) => ({ agents: [{ name: 'claude', state: 'running', job: { name: 'implement #358 Foreman: publish live status' } }, { name: 'codex', state: 'idle', job: null }],
  next: { plan: [{ text: 'codex → review PR #400 Some title' }], waiting: [] }, pulls: [{ name: 'PR #400 Some title', status: 'ready', ci: 'green', verdict: { verdict: 'PASS', current: true } }],
  allowance: [{ text: 'claude: normal, 40% of the week used' }], needsYou: [{ text: 'Choose X for #12 Some decision' }], installed: 'abc1234', ...over });

test('first tick creates one issue and pins it; an unchanged tick makes no call at all', async t => {
  const root = tmp(t), gh = fakeGh();
  assert.equal(await publishStatusIssue({ root, gh, status: status(), now: 1000 }), 'created');
  assert.deepEqual(gh.calls, ['create', 'pin']);
  assert.equal(gh.issues[0].title, STATUS_TITLE); assert.ok(gh.issues[0].body.startsWith(STATUS_MARKER));
  assert.equal(await publishStatusIssue({ root, gh, status: status(), now: 999999 }), 'unchanged');   // only the time differs
  assert.deepEqual(gh.calls, ['create', 'pin']);
  assert.equal(gh.issues.length, 1);
});

test('a changed status updates the same issue and does not pin or create again', async t => {
  const root = tmp(t), gh = fakeGh();
  await publishStatusIssue({ root, gh, status: status(), now: 1 });
  assert.equal(await publishStatusIssue({ root, gh, status: status({ needsYou: [] }), now: 2 }), 'updated');
  assert.deepEqual(gh.calls, ['create', 'pin', 'update']);
  assert.match(gh.issues[0].body, /## Needs you\n- nothing/);
  assert.equal(gh.issues.length, 1);
});

test('after a restart (state lost) the existing issue is found by its marker and never duplicated', async t => {
  const gh = fakeGh();
  await publishStatusIssue({ root: tmp(t), gh, status: status(), now: 1 });
  const root2 = tmp(t);   // a fresh state directory
  assert.equal(await publishStatusIssue({ root: root2, gh, status: status({ installed: 'def5678' }), now: 2 }), 'updated');
  assert.equal(gh.issues.length, 1); assert.equal(gh.calls.filter(c => c === 'create').length, 1);
  assert.equal(readStatusIssueState(root2).number, gh.issues[0].number);
});

test('the body lists the required sections with items by number and exact title', () => {
  const b = renderBody(status(), Date.UTC(2026, 10, 2, 12, 30));
  for (const h of ['## Running jobs', '## Queue', '## Open pull requests', '## Allowance by provider', '## Needs you']) assert.ok(b.includes(h), h);
  assert.match(b, /- claude: implement #358 Foreman: publish live status/);
  assert.match(b, /PR #400 Some title - ready, CI green, PASS/);
  assert.match(b, /Installed version: abc1234/); assert.match(b, /Last updated: 2026-11-02 12:30 UTC/);
});

test('allowlist redaction: logs, prompts, addresses, hostnames, paths, session ids and secrets never reach the body', () => {
  const tok = ['gh', 'p_'].join('') + 'A'.repeat(30);
  const sid = '123e4567-e89b-12d3-a456-426614174000';
  const b = renderBody(status({
    rawLog: 'RAW-LOG-LINE', prompt: 'SECRET-PROMPT', agents: [{ name: 'claude', state: 'running', job: { name: `implement #1 Title at 192.168.1.20:8080 on tower.local in /mnt/user/projects/x session ${sid} ${tok}`, sessionId: sid } }],
    needsYou: [{ text: 'password=hunter2 see /root/.claude/x and fd00::1 <!-- foreman-status-issue --> @someone' }] }), 0);
  for (const bad of ['RAW-LOG-LINE', 'SECRET-PROMPT', '192.168.1.20', 'tower.local', '/mnt/user', '/root/', sid, tok, 'hunter2', 'fd00::1']) assert.ok(!b.includes(bad), `leaked ${bad}`);
  assert.equal(b.split(STATUS_MARKER).length - 1, 1);   // a title cannot forge a second marker
  assert.ok(!/@someone/.test(b));
  assert.equal(scrub('ordinary title #12'), 'ordinary title #12');
});

test('an update failure is recorded, never thrown, and the dashboard shows a warning; the next success clears it', async t => {
  const root = tmp(t), gh = fakeGh();
  await publishStatusIssue({ root, gh, status: status(), now: 1 });
  gh.updateIssueBody = async () => { throw new Error('gh issue edit failed: HTTP 502 from 10.0.0.5'); };
  assert.equal(await publishStatusIssue({ root, gh, status: status({ needsYou: [] }), now: 2 }), 'failed');
  const e = readStatusIssueState(root).error;
  assert.match(e, /status issue not updated/); assert.ok(!e.includes('10.0.0.5'));
  // the retry works again and clears the warning
  const ok = fakeGh({ existing: gh.issues[0] });
  assert.equal(await publishStatusIssue({ root, gh: ok, status: status({ needsYou: [] }), now: 3 }), 'updated');
  assert.equal(readStatusIssueState(root).error, null);
});

test('a status that cannot be built, and a create failure, also never throw', async t => {
  const root = tmp(t);
  assert.equal(await publishStatusIssue({ root, gh: fakeGh(), status: () => { throw new Error('no cache'); }, now: 1 }), 'failed');
  const gh = fakeGh(); gh.createIssue = async () => { throw new Error('gh issue create failed'); };
  assert.equal(await publishStatusIssue({ root, gh, status: status(), now: 2 }), 'failed');
  assert.match(readStatusIssueState(root).error, /not updated/);
});

test('a pin failure is a warning only, and is retried on the next tick', async t => {
  const root = tmp(t), gh = fakeGh({ failPin: true });
  assert.equal(await publishStatusIssue({ root, gh, status: status(), now: 1 }), 'created');
  assert.match(readStatusIssueState(root).error, /could not pin/);
  gh.pinIssue = async () => { gh.calls.push('pin'); };
  await publishStatusIssue({ root, gh, status: status(), now: 2 });
  assert.equal(readStatusIssueState(root).pinned, true); assert.equal(readStatusIssueState(root).error, null);
  assert.deepEqual(gh.calls, ['create', 'pin', 'pin']);   // the retry pins only; the unchanged body is not rewritten
});

test('the dispatcher never sees the status issue: listIssues drops it', async () => {
  const rows = [{ number: 5, title: 'Real work', state: 'OPEN', body: 'do it', labels: [] }, { number: 358, title: STATUS_TITLE, state: 'OPEN', body: `${STATUS_MARKER}\n## Queue`, labels: [] }];
  const gh = githubClient({ repository: 'o/r' }, () => JSON.stringify(rows));
  assert.deepEqual((await gh.listIssues()).map(i => i.number), [5]);
});

test('github client edit and pin build argument arrays and reject bad numbers', async () => {
  const seen = [];
  const gh = githubClient({ repository: 'o/r' }, (args, input) => { seen.push([args, input]); return ''; });
  await gh.updateIssueBody(7, 'body'); await gh.pinIssue(7);
  assert.deepEqual(seen[0], [['issue', 'edit', '7', '--repo', 'o/r', '--body-file', '-'], 'body']);
  assert.deepEqual(seen[1][0], ['issue', 'pin', '7', '--repo', 'o/r']);
  await assert.rejects(() => gh.updateIssueBody('7; rm', 'x')); await assert.rejects(() => gh.pinIssue(0));
});
