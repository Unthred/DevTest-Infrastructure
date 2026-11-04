// Issue #522: a prerequisite outside the fetched issue list is looked up by number instead of being assumed open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { githubClient } from '../supervisor/github.mjs';
import { Team } from '../supervisor/team.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';

const mk = (calls, { open = [], all = [], views = {} } = {}) => githubClient({ repository: 'o/r' }, args => {
  calls.push(args.join(' '));
  if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(args[args.indexOf('--state') + 1] === 'open' ? open : all);
  if (args[0] === 'issue' && args[1] === 'view') {
    const v = views[args[2]];
    if (v instanceof Error) throw v;
    return JSON.stringify(v ?? null);
  }
  throw new Error(`unexpected ${args.join(' ')}`);
});
const blocked = { number: 456, title: 'T', state: 'OPEN', body: 'Prerequisites: #123, #76', labels: [] };
const views = calls => calls.filter(c => c.startsWith('issue view'));

test('old closed prerequisites are looked up once and cached', async () => {
  const calls = [], gh = mk(calls, { open: [blocked], all: [blocked], views: { 123: { number: 123, title: 'a', state: 'CLOSED', labels: [] }, 76: { number: 76, title: 'b', state: 'CLOSED', labels: [] } } });
  const first = await gh.listIssues();
  assert.deepEqual(first.filter(i => i.lookedUp).map(i => [i.number, i.state]), [[76, 'CLOSED'], [123, 'CLOSED']]);
  await gh.listIssues();
  assert.equal(views(calls).length, 2);   // second call served from the cache
});

test('an open prerequisite outside the list stays open and is looked up again', async () => {
  const calls = [], gh = mk(calls, { open: [{ ...blocked, body: 'Prerequisites: #123' }], views: { 123: { number: 123, title: 'a', state: 'OPEN', labels: [] } } });
  assert.equal((await gh.listIssues()).find(i => i.number === 123).state, 'OPEN');
  await gh.listIssues();
  assert.equal(views(calls).length, 2);
});

test('a deleted prerequisite cannot block and is cached', async () => {
  const calls = [], gh = mk(calls, { open: [{ ...blocked, body: 'Prerequisites: #123' }], views: { 123: new Error('gh issue view failed: GraphQL: Could not resolve to an issue or pull request with the number of 123.') } });
  const r = (await gh.listIssues()).find(i => i.number === 123);
  assert.equal(r.state, 'CLOSED'); assert.equal(r.notFound, true);
  await gh.listIssues(); assert.equal(views(calls).length, 1);
});

test('a failed lookup is unknown with its reason, retried, and not cached', async () => {
  const calls = [], views_ = { 123: new Error('gh issue view failed: HTTP 502 bad gateway') }, gh = mk(calls, { open: [{ ...blocked, body: 'Prerequisites: #123' }], views: views_ });
  const r = (await gh.listIssues()).find(i => i.number === 123);
  assert.equal(r.state, 'UNKNOWN'); assert.match(r.unknownReason, /502/);
  views_[123] = { number: 123, title: 'a', state: 'CLOSED', labels: [] };
  assert.equal((await gh.listIssues()).find(i => i.number === 123).state, 'CLOSED');   // recovered on the next tick
});

test('a prerequisite already in the list is not looked up', async () => {
  const calls = [], dep = { number: 123, title: 'a', state: 'CLOSED', body: '', labels: [] }, gh = mk(calls, { open: [{ ...blocked, body: 'Prerequisites: #123' }], all: [dep] });
  await gh.listIssues(); assert.equal(views(calls).length, 0);
});

test('exclusion: closed and deleted do not block; unknown is reported with the reason; open blocks', () => {
  const team = Object.create(Team.prototype); team.c = {};
  const by = (...x) => new Map(x.map(i => [i.number, i]));
  const iss = (n, state, extra = {}) => ({ number: n, title: '', state, body: '', labels: [], ...extra });
  const me = iss(9, 'OPEN', { body: 'Prerequisites: #1' });
  assert.equal(team.exclusion(9, by(me, iss(1, 'CLOSED')), []), null);
  assert.equal(team.exclusion(9, by(me, iss(1, 'CLOSED', { notFound: true })), []), null);
  const ex = team.exclusion(9, by(me, iss(1, 'UNKNOWN', { unknownReason: 'HTTP 502' })), []);
  assert.equal(ex.kind, 'prerequisite'); assert.deepEqual(ex.unknown, [1]); assert.match(ex.text, /unknown.*#1.*HTTP 502/);
  assert.match(team.exclusion(9, by(me, iss(1, 'OPEN')), []).text, /blocked by #1/);
  assert.equal(compactIssues([iss(1, 'UNKNOWN', { unknownReason: 'HTTP 502' })])[0].unknownReason, 'HTTP 502');
});
