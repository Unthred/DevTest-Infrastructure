// Issue #1306: the asynchronous gh client of work_item.close_reason, and the closed-by-update fetch of listIssues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { asyncGh, asyncGithubClient } from '../supervisor/github-async.mjs';
import { githubClient, ghRunner } from '../supervisor/github.mjs';

// A fake process: emits `out` and closes with `code` on a later turn, and keeps what was written to its stdin.
function fakeStart({ out = '', err = '', code = 0, fail = null } = {}) {
  const seen = { args: null, input: '' };
  const start = (_cmd, args) => {
    seen.args = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: text => { seen.input = text; } });
    setImmediate(() => {
      if (fail) return child.emit('error', fail);
      child.stdout.emit('data', out);
      child.stderr.emit('data', err);
      child.emit('close', code);
    });
    return child;
  };
  return { start, seen };
}

test('asyncGh: resolves with stdout and writes stdin', async () => {
  const { start, seen } = fakeStart({ out: 'ok' });
  const pending = asyncGh(['issue', 'comment', '1'], 'body text', start);
  assert.equal(await pending, 'ok');
  assert.equal(seen.input, 'body text');
});

test('asyncGh: a failure carries the first line of stderr; a missing gh is named', async () => {
  await assert.rejects(asyncGh(['issue', 'view', '1'], undefined, fakeStart({ code: 1, err: 'HTTP 404\nmore' }).start), /gh issue view failed: HTTP 404$/);
  await assert.rejects(asyncGh(['x'], undefined, fakeStart({ fail: Object.assign(new Error('x'), { code: 'ENOENT' }) }).start), /binary not found: gh/);
});

test('asyncGithubClient: one view for the issue, one for the comments, and a comment with the body on stdin', async () => {
  const calls = [];
  const gh = async (args, input) => { calls.push([args, input]); return args.includes('comments') ? JSON.stringify({ comments: [{ body: 'x <!-- m --> y' }] }) : JSON.stringify({ number: 5, state: 'CLOSED' }); };
  const client = asyncGithubClient({ repository: 'o/r' }, gh);
  assert.equal((await client.getIssue(5)).number, 5);
  assert.equal(await client.hasComment(5, '<!-- m -->'), true);
  assert.equal(await client.hasComment(5, 'absent'), false);
  await client.comment(5, 'hello');
  assert.deepEqual(calls.at(-1), [['issue', 'comment', '5', '--repo', 'o/r', '--body-file', '-'], 'hello']);
});

test('listIssues also fetches the closed issues updated most recently, so the close of an old issue is seen', async () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    const state = args[args.indexOf('--state') + 1];
    const list = args.includes('--search') ? [{ number: 895, title: 'old', state: 'CLOSED', stateReason: 'NOT_PLANNED', labels: [] }]
      : state === 'open' ? [{ number: 1, title: 'o', state: 'OPEN', labels: [] }] : [{ number: 1300, title: 'n', state: 'OPEN', labels: [] }];
    return { status: 0, stdout: JSON.stringify(list) };
  };
  const client = githubClient({ repository: 'o/r' }, ghRunner(run));
  const numbers = (await client.listIssues()).map(i => i.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [1, 895, 1300]);
  const recent = calls.find(a => a.includes('--search'));
  assert.deepEqual([recent[recent.indexOf('--state') + 1], recent[recent.indexOf('--search') + 1], recent[recent.indexOf('--limit') + 1]], ['closed', 'sort:updated-desc', '200']);
});
