// Issue #1340: a parked pull request is closed as superseded once every item of its split has merged. The real tick (Team.tick) runs the real
// close as superseded action of issue #1337; only the GitHub adapter is faked. Real data: PR 1139 was split into issues 1171, 1172 and 1173.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stuckWorld } from './helpers/split-stuck-world.mjs';
import { withStuckSplits } from '../supervisor/splitstuck-view.mjs';
import { decisionCard } from '../supervisor/decisiontable.mjs';

const HEAD = 'b'.repeat(40);
const PR = { number: 1139, branch: 'codex/issue-1127-thing', head: HEAD, files: ['a.mjs'] };
const FILED = [1171, 1172, 1173];
const names = { pr: n => ({ text: `PR #${n}` }) };
const REFUSED = 'HTTP 403: Resource not accessible by integration';

// A filed split of PR 1139 over a fake GitHub that records the writes; `states` says whether each item is merged (closed as completed).
function world(t, { states = ['CLOSED', 'CLOSED', 'CLOSED'], saveError = null, closeError = null } = {}) {
  const w = stuckWorld(t, { pr: PR });
  const writes = [];
  const issueState = new Map(FILED.map((n, i) => [n, states[i]]));
  Object.assign(w.gh, {
    getIssue: async n => (issueState.has(n) ? { number: n, state: issueState.get(n), stateReason: issueState.get(n) === 'CLOSED' ? 'COMPLETED' : null } : null),
    saveBranch: async (name, sha) => { if (saveError) throw new Error(saveError); writes.push(['save', name, sha]); return 'created'; },
    closeItem: async (n, kind) => { if (closeError) throw new Error(closeError); writes.push(['close', n, kind]); w.gh.pulls = w.gh.pulls.filter(p => p.number !== n); }
  });
  w.team.s.stuckSplits = { 1139: { status: 'filed', cause: 'fix-limit', reason: '4 fix rounds', issue: 1127, head: HEAD, agent: 'codex', parked: true,
    filed: FILED, items: FILED.map(n => ({ title: `item ${n}`, files: [`f${n}.mjs`] })) } };
  w.team.save();
  return { ...w, writes, issueState };
}
const card = w => withStuckSplits([], { state: w.team.s, names, open: new Set([1139]), repo: 'o/r' })[0];

test('all three items merged: the parked PR is closed once as superseded by all three, with its branch saved first', async t => {
  const w = world(t);
  await w.team.tick();
  assert.deepEqual(w.writes, [['save', `saved/pr-1139-codex-issue-1127-thing-${HEAD.slice(0, 7)}`, HEAD], ['close', 1139, 'pull']]);
  assert.deepEqual(w.calls.comments.filter(([n]) => n === 1139).map(([, b]) => b.match(/^Closed as superseded by (.*?)\./)?.[1]).filter(Boolean), ['#1171, #1172, #1173']);
  assert.equal(w.team.s.stuckSplits[1139].status, 'closed');
});

test('a second tick after the close does nothing', async t => {
  const w = world(t);
  await w.team.tick();
  const before = JSON.stringify([w.writes, w.calls.comments]);
  await w.team.tick();
  assert.equal(JSON.stringify([w.writes, w.calls.comments]), before);
});

test('two of three merged: nothing is closed, no copy is saved and the branch is kept', async t => {
  const w = world(t, { states: ['CLOSED', 'CLOSED', 'OPEN'] });
  await w.team.tick();
  assert.deepEqual(w.writes, []);
  assert.equal(w.team.s.stuckSplits[1139].status, 'filed');
  assert.equal(card(w).id, 'split-wait-1139');
});

test('an item closed as not planned is not a merge: nothing is closed', async t => {
  const w = world(t);
  w.gh.getIssue = async n => ({ number: n, state: 'CLOSED', stateReason: n === 1173 ? 'NOT_PLANNED' : 'COMPLETED' });
  await w.team.tick();
  assert.deepEqual(w.writes, []);
});

test('the saved copy refused: the card names Contents write as a homeowner step and nothing is closed', async t => {
  const w = world(t, { saveError: REFUSED });
  await w.team.tick();
  assert.deepEqual(w.writes, []);
  assert.equal(w.team.s.stuckSplits[1139].status, 'filed');
  const shown = card(w);
  assert.equal(shown.id, 'split-closefail-1139');
  assert.match(shown.action, /Homeowner step: .*Contents write/);
  assert.equal(decisionCard({ id: shown.id, ref: shown.ref }, { parked: new Set([1139]) }).error, undefined);
});

test('the close refused after the saved copy succeeded: the card names the close and its cause, never Contents write', async t => {
  const w = world(t, { closeError: REFUSED });
  await w.team.tick();
  assert.deepEqual(w.writes.map(x => x[0]), ['save']);
  const shown = card(w);
  assert.equal(shown.id, 'split-closefail-1139');
  assert.match(shown.tried, /close as superseded action failed \(HTTP 403: Resource not accessible by integration\)/);
  assert.doesNotMatch(`${shown.tried} ${shown.action}`, /Contents write/);
});

test('a refused close is retried and succeeds once the cause is gone', async t => {
  const w = world(t, { saveError: REFUSED });
  await w.team.tick();
  w.gh.saveBranch = async (name, sha) => { w.writes.push(['save', name, sha]); return 'created'; };
  await w.team.tick();
  assert.equal(w.team.s.stuckSplits[1139].status, 'closed');
  assert.equal(w.team.s.stuckSplits[1139].closeError, undefined);
});
