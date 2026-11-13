// Issue #1325: the stored records, the one-time rebuild from verdict comments, and the check on a new verdict or merge.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBest, refreshBestDay, readVerdictHistory, verdictsOfComments, PAGE_SIZE, RETRY_MS } from '../supervisor/best-day-store.mjs';
import { githubCommentPages } from '../supervisor/best-day-step.mjs';

const T0 = Date.UTC(2026, 10, 6, 8, 0, 0);
const MIN = 60000;
const HOUR = 3600000;
const dir = t => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'best-')); removeLater(d); return d; };
const comment = (pr, verdict, at, lead = '') => ({ created_at: new Date(at).toISOString(), body: `${lead}<!-- devtest-verdict v1 job=${'a'.repeat(32)} pr=${pr} head=${'b'.repeat(40)} verdict=${verdict} reviewer=x -->\n**${verdict}**` });
const comments = (n, approved, at, first = 1) => Array.from({ length: n }, (_, i) => comment(first + i, i < approved ? 'PASS' : 'CHANGES', at + i * MIN));
const pager = list => page => list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
const noGithub = () => { throw new Error('GitHub must not be read'); };

test('only a comment that starts with the verdict marker is a verdict', () => {
  const list = [comment(7, 'PASS', T0), comment(8, 'PASS', T0, 'quoted: '), { created_at: 'bad', body: comment(9, 'PASS', T0).body }, { body: 'hello' }, null];
  assert.deepEqual(verdictsOfComments(list), [{ pr: 7, at: T0, verdict: 'PASS' }]);
});

test('the history is read page by page until a short page, and a refused page throws', () => {
  const list = comments(250, 250, T0);
  const asked = [];
  const verdicts = readVerdictHistory(page => { asked.push(page); return pager(list)(page); });
  assert.equal(verdicts.length, 250);
  assert.deepEqual(asked, [1, 2, 3]);
  assert.throws(() => readVerdictHistory(() => { throw new Error('refused'); }), /refused/);
});

test('with nothing stored the records are built once from the comments and the timeline merges; the second call reads nothing', () => {
  const root = dir();
  const timeline = [{ kind: 'merge', pr: 1, at: T0 + HOUR }, { kind: 'merge', pr: 2, at: T0 + 2 * HOUR }];
  assert.equal(refreshBestDay({ root, now: T0 + 3 * HOUR, timeline, fetchPage: pager(comments(20, 15, T0)) }), 'built');
  const stored = readBest(root);
  assert.equal(stored.records.approval.reviewed, 20);
  assert.equal(stored.records.approval.approved, 15);
  assert.equal(stored.records.merges.merged, 2);
  assert.equal(refreshBestDay({ root, now: T0 + 4 * HOUR, timeline, fetchPage: noGithub }), 'unchanged');
});

test('a new verdict or merge entry starts the check; entries already counted do not', () => {
  const root = dir();
  refreshBestDay({ root, now: T0 + HOUR, timeline: [], fetchPage: pager(comments(20, 10, T0)) });
  const now = T0 + 5 * HOUR;
  const fresh = [{ kind: 'merge', pr: 40, at: T0 + 2 * HOUR }, { kind: 'verdict', pr: 41, at: T0 + 3 * HOUR, verdict: 'PASS' }, { kind: 'job', at: T0 + 4 * HOUR }];
  assert.equal(refreshBestDay({ root, now, timeline: fresh, fetchPage: noGithub }), 'updated');
  const stored = readBest(root);
  assert.equal(stored.records.merges.merged, 1);
  assert.equal(stored.records.approval.reviewed, 21);
  assert.equal(refreshBestDay({ root, now, timeline: fresh, fetchPage: noGithub }), 'unchanged');
  assert.equal(refreshBestDay({ root, now, timeline: [...fresh, { kind: 'job', at: now }], fetchPage: noGithub }), 'unchanged');
});

test('a stored record is replaced only by a window that beats it, and kept when the records it came from are gone', () => {
  const root = dir();
  refreshBestDay({ root, now: T0 + HOUR, timeline: [], fetchPage: pager(comments(20, 18, T0)) });
  const record = readBest(root).records.approval;
  assert.equal(record.rate, 90);
  // A later window of 20 reviews at 50 percent does not replace it; the same 90 percent over 20 reviews does not either (not better).
  const later = T0 + 5 * 86400000;
  const worse = comments(20, 10, later, 100).map(c => ({ kind: 'verdict', pr: Number(/pr=(\d+)/.exec(c.body)[1]), at: Date.parse(c.created_at), verdict: /verdict=(\w+)/.exec(c.body)[1] }));
  refreshBestDay({ root, now: later + HOUR, timeline: worse, fetchPage: noGithub });
  assert.deepEqual(readBest(root).records.approval, record);
  const equal = comments(20, 18, later + 2 * 86400000, 300).map(c => ({ kind: 'verdict', pr: Number(/pr=(\d+)/.exec(c.body)[1]), at: Date.parse(c.created_at), verdict: /verdict=(\w+)/.exec(c.body)[1] }));
  refreshBestDay({ root, now: later + 3 * 86400000, timeline: equal, fetchPage: noGithub });
  assert.deepEqual(readBest(root).records.approval, record);
  // A better window replaces it.
  const better = comments(30, 30, later + 4 * 86400000, 500).map(c => ({ kind: 'verdict', pr: Number(/pr=(\d+)/.exec(c.body)[1]), at: Date.parse(c.created_at), verdict: 'PASS' }));
  refreshBestDay({ root, now: later + 5 * 86400000, timeline: better, fetchPage: noGithub });
  assert.equal(readBest(root).records.approval.rate, 100);
});

test('the record outlives the ledger it came from: old verdicts age out, the record stays', () => {
  const root = dir();
  refreshBestDay({ root, now: T0 + HOUR, timeline: [], fetchPage: pager(comments(20, 20, T0)) });
  const much = T0 + 100 * 86400000;
  refreshBestDay({ root, now: much, timeline: [{ kind: 'merge', pr: 900, at: much - HOUR }], fetchPage: noGithub });
  const stored = readBest(root);
  assert.equal(stored.verdicts.length, 0);
  assert.equal(stored.records.approval.rate, 100);
  assert.equal(stored.records.approval.reviewed, 20);
});

test('a failed read keeps what was stored, waits before the next try, and then tries again', () => {
  const root = dir();
  const failing = () => { throw new Error('rate limited'); };
  assert.equal(refreshBestDay({ root, now: T0, timeline: [], fetchPage: failing }), 'failed');
  assert.equal(readBest(root).built, false);
  assert.equal(refreshBestDay({ root, now: T0 + RETRY_MS - 1, timeline: [], fetchPage: noGithub }), 'waiting');
  assert.equal(refreshBestDay({ root, now: T0 + RETRY_MS, timeline: [], fetchPage: pager(comments(20, 20, T0)) }), 'built');
  assert.equal(readBest(root).records.approval.rate, 100);
});

test('the GitHub reader asks for one page of repository issue comments with fixed arguments', () => {
  const calls = [];
  const read = githubCommentPages('o/r', args => { calls.push(args); return '[{"body":"x"}]'; });
  assert.deepEqual(read(3), [{ body: 'x' }]);
  assert.deepEqual(calls[0], ['api', '--method', 'GET', 'repos/o/r/issues/comments', '-f', 'per_page=100', '-f', 'page=3']);
});
