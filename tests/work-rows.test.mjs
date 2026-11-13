// Issue #1224: the row builder for the Work page's Table and Board, over the real data path (buildView over a cache, team state and jobs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkRows, dependencyChain, dependencyWait } from '../supervisor/workrows.mjs';
import { workView } from './helpers/work-fixture.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const built = async (patch) => { const v = await workView(NOW); if (patch) patch(v); return buildWorkRows(v); };
const rowOf = (data, key) => data.rows.find(r => r.key === key);

test('an issue held by a dependency: #1169, rank 17 of 21, waiting for #1157 which is still open', async () => {
  const data = await built();
  const r = rowOf(data, 'issue:1169');
  assert.equal(r.state, 'held');
  assert.equal(r.rank, 17);
  assert.equal(r.rankOf, 21);
  assert.deepEqual(r.waitsOn, [1157]);
  assert.match(r.holdReason, /waiting for #1157 still open/);
  assert.equal(r.holdSince, NOW - 4 * 3600000);
  assert.deepEqual(r.labels, ['v2-ui']);
  assert.equal(r.kind, 'issue');
  assert.equal(r.agent, 'claude');
});

test('the detail of #1169 carries its dependency chain and the hold with when it began', async () => {
  const d = (await built()).details['issue:1169'];
  assert.deepEqual(d.chain.map(c => [c.ref, c.state, c.blocking]), [[1157, 'open', true]]);
  assert.equal(d.holdSince, NOW - 4 * 3600000);
  assert.match(d.holdReason, /#1157/);
});

test('a pull request stopped by the retry cap: PR #1180 is held with the cap as its reason and the time it began', async () => {
  const r = rowOf(await built(), 'pr:1180');
  assert.equal(r.kind, 'pr');
  assert.equal(r.state, 'held');
  assert.match(r.holdReason, /stopped after 3 attempts with the same cause \(ci-failed\)/);
  assert.equal(r.holdSince, NOW - 3 * 3600000);
  assert.equal(r.checks, 'red');
  assert.equal(r.fixRounds, 3);
  assert.equal(r.rank, 21);
});

test('a running job: #1155 is running, with the job tokens and cost, and a link to its job page', async () => {
  const data = await built();
  const r = rowOf(data, 'issue:1155');
  assert.equal(r.state, 'running');
  assert.equal(r.tokens, 15000);
  assert.equal(r.cost, 0.42);
  assert.match(r.costText, /^£0\.\d\d$/);
  assert.equal(r.holdReason, null);
  const job = data.details['issue:1155'].jobs[0];
  assert.equal(job.kind, 'implement');
  assert.equal(job.status, 'running');
  assert.equal(job.page, '/work/job/aaaaaaaa');
  assert.ok(r.lastActivity >= NOW - 1000 - 20 * 60000);
});

test('an item with no estimate has an empty estimated start and says so', async () => {
  const r = rowOf(await built(), 'issue:1170');
  assert.equal(r.estStart, null);
  assert.match(r.estText, /no estimate/);
  assert.equal(r.state, 'planned');
});

test('an item with an estimate carries its start time', async () => {
  const data = await built(v => { v.estimates.items['issue:1170'] = { kind: 'issue', ref: 1170, status: 'estimated', start: NOW + 3600000, text: 'est. 13:00–15:00', waits: [{ kind: 'allowance', text: 'claude allowance: after 13:00 reset' }], basis: [] }; });
  const r = rowOf(data, 'issue:1170');
  assert.equal(r.estStart, NOW + 3600000);
  assert.deepEqual(r.waitsText, ['claude allowance: after 13:00 reset']);
});

test('a pull request waiting for a review is waiting for review, owned by the reviewer role', async () => {
  const r = rowOf(await built(), 'pr:1178');
  assert.equal(r.state, 'waiting-review');
  assert.equal(r.role, 'reviewer');
  assert.equal(r.agent, 'codex');
});

test('an issue that needs the homeowner is waiting for you, and an item finished today is done today with no rank', async () => {
  const data = await built();
  assert.equal(rowOf(data, 'issue:1171').state, 'waiting-you');
  for (const key of ['pr:1179', 'issue:1152']) {
    const r = rowOf(data, key);
    assert.equal(r.state, 'done');
    assert.equal(r.rank, null);
  }
  assert.equal(rowOf(data, 'issue:1149'), undefined, 'closed long ago is not listed');
});

test('there is one row per open issue and open pull request, plus the items finished today', async () => {
  const data = await built();
  assert.equal(data.rows.length, 19 + 2 + 2);
  assert.equal(new Set(data.rows.map(r => r.key)).size, data.rows.length);
  assert.deepEqual(data.rows.filter(r => r.state !== 'done').map(r => r.rank), Array.from({ length: 21 }, (_, i) => i + 1));
});

test('the rows are plain JSON and contain no function or undefined value', async () => {
  const data = await built();
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
});

test('dependencyChain follows prerequisites of prerequisites, once each, and stops on a cycle', () => {
  const view = { issues: [{ number: 1, title: 'one' }, { number: 2, title: 'two' }, { number: 3, title: 'three' }],
    dependencies: { issues: { 1: { dependsOn: [{ number: 2, state: 'open' }] }, 2: { dependsOn: [{ number: 3, state: 'installed' }, { number: 1, state: 'open' }] }, 3: { dependsOn: [] } } } };
  assert.deepEqual(dependencyChain(view, 1).map(c => [c.ref, c.depth, c.blocking]), [[2, 1, true], [3, 2, false]]);
  assert.deepEqual(dependencyChain({ issues: [] }, 1), []);
});

test('dependencyWait is null when all prerequisites are met or there is no record', () => {
  assert.equal(dependencyWait({}, 5), null);
  assert.equal(dependencyWait({ dependencies: { issues: { 5: { met: true, dependsOn: [], reasons: [] } } } }, 5), null);
  assert.deepEqual(dependencyWait({ dependencies: { issues: { 5: { met: false, dependsOn: [{ number: 4, state: 'merged_not_installed' }], reasons: ['#4 merged but not installed yet'], since: 7 } } } }, 5),
    { refs: [4], reason: 'waiting for #4 merged but not installed yet', since: 7 });
});

test('the role follows the job: a running review makes the pull request row reviewer, an implementing issue stays implementer', async () => {
  const data = await built(v => {
    const p = v.prs.find(x => x.number === 1178);
    p.jobs = [...p.jobs, { fullId: 'rv-1', id: 'rv-1', kind: 'review', status: 'running', agent: 'claude', ref: 1178 }];
  });
  assert.equal(rowOf(data, 'pr:1178').state, 'running');
  assert.equal(rowOf(data, 'pr:1178').role, 'reviewer');
  assert.equal(rowOf(data, 'issue:1155').role, 'implementer');
});

test('an issue that takes its pull request\'s waiting-review state takes its reviewer role too', async () => {
  const data = await built();
  for (const r of data.rows.filter(x => x.kind === 'issue' && x.state === 'waiting-review')) {
    assert.equal(r.role, 'reviewer', `#${r.ref}`);
  }
});
