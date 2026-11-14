// Issue #1337: the GitHub close helper, driven with a fake gh runner. The exact argument arrays are asserted, because the runner takes no
// shell and these are the only writes close_superseded makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeWrites, SAVED_PREFIX } from '../supervisor/ghclose.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const NAME = 'saved/pr-1189-claude-issue-1157-v2-item-27-aaaaaaa';

// refs: name -> sha. Records every call as [args, input, opts]. A missing ref fails as gh does.
function runner(refs = {}) {
  const calls = [];
  const run = (args, input, opts) => {
    calls.push([args, input, opts]);
    if (args[0] === 'api' && args.includes('GET')) {
      const name = args[args.length - 1].split('/git/ref/heads/')[1];
      if (!refs[name]) throw new Error('gh api failed: Not Found');
      return JSON.stringify({ object: { sha: refs[name] } });
    }
    return '';
  };
  return { run, calls };
}
const READ = ['api', '--method', 'GET', `repos/o/r/git/ref/heads/${NAME}`];
const CREATE = [['api', '--method', 'POST', 'repos/o/r/git/refs', '-f', `ref=refs/heads/${NAME}`, '-f', `sha=${SHA}`], undefined, { retry: false }];

test('a new saved branch: one read, then one create at the sha, not retried', async () => {
  const r = runner();
  assert.equal(await closeWrites('o/r', r.run).saveBranch(NAME, SHA), 'created');
  assert.deepEqual(r.calls, [[READ, undefined, undefined], CREATE]);
});

test('the same commit again is a repeat: one read, no create', async () => {
  const r = runner({ [NAME]: SHA });
  assert.equal(await closeWrites('o/r', r.run).saveBranch(NAME, SHA), 'exists');
  assert.deepEqual(r.calls, [[READ, undefined, undefined]]);
});

test('another commit at the same name is refused and nothing is created', async () => {
  const r = runner({ [NAME]: OTHER });
  await assert.rejects(() => closeWrites('o/r', r.run).saveBranch(NAME, SHA), /already exists at another commit/);
  assert.equal(r.calls.length, 1);
});

test('a name outside the saved prefix, an odd name or a bad sha is refused before any call', async () => {
  const r = runner(), w = closeWrites('o/r', r.run);
  for (const name of ['main', 'saved/', 'saved/a b', 'saved/../x', 'saved/a..b', 'saved/a;b', `${SAVED_PREFIX}`, 'refs/heads/saved/x']) await assert.rejects(() => w.saveBranch(name, SHA), /invalid branch to save/, name);
  for (const sha of ['', 'abc', 'A'.repeat(40), `${SHA}0`, undefined]) await assert.rejects(() => w.saveBranch(NAME, sha), /invalid branch to save/, String(sha));
  assert.deepEqual(r.calls, []);
});

test('a pull request close and an issue close (as not planned) are exact, not retried', async () => {
  const r = runner(), w = closeWrites('o/r', r.run);
  await w.closeItem(1189, 'pull');
  await w.closeItem(1200, 'issue');
  assert.deepEqual(r.calls, [
    [['pr', 'close', '1189', '--repo', 'o/r'], undefined, { retry: false }],
    [['issue', 'close', '1200', '--repo', 'o/r', '--reason', 'not planned'], undefined, { retry: false }],
  ]);
});

test('a bad number or kind is refused before any call', async () => {
  const r = runner(), w = closeWrites('o/r', r.run);
  for (const n of [0, -1, 1.5, NaN, '12', null, 2 ** 60]) await assert.rejects(() => w.closeItem(n, 'pull'), /invalid number/, String(n));
  await assert.rejects(() => w.closeItem(5, 'branch'), /invalid item kind/);
  assert.deepEqual(r.calls, []);
});

test('the error of a failing runner reaches the caller', async () => {
  const w = closeWrites('o/r', () => { throw new Error('gh pr close failed: boom'); });
  await assert.rejects(() => w.closeItem(5, 'pull'), /boom/);
});
