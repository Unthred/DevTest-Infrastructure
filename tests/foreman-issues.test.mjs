// Issue #951: the searchable issue and PR index and the read-only foreman_issues tool. Real dashboard handler over a temporary state root,
// real MCP tool over HTTP, a fake gh runner (no GitHub call). Secret-shaped fixtures are assembled at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { handler } from '../supervisor/dashserver.mjs';
import { updateIndex, readIndex, searchIndex, refreshIndex, redactText, PAGE, indexFile } from '../supervisor/issueindex.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { getJson } from '../foreman-mcp/source.mjs';

const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'issues951-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const BASE = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/nonexistent/repo', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  budget: { enabled: true }, limits: { per_agent: 1, overall: 2, test_slots: 3 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] } } };

const SHA = 'a'.repeat(40);
const ISSUES = [
  { number: 10, title: 'Add MQTT bridge', state: 'CLOSED', body: 'Bridge the garage sensors through mosquitto.', labels: [{ name: 'enhancement' }], author: { login: 'Unthred' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', closedAt: '2026-10-02T00:00:00Z', url: 'https://github.com/o/r/issues/10', comments: [{ author: { login: 'bot' }, createdAt: '2026-10-02T00:00:00Z', body: `done ${GH}` }] },
  { number: 20, title: 'Retry policy', state: 'OPEN', body: 'The scheduler should retry with backoff. ' + ['pass', 'word'].join('') + '=' + ['hunter2', 'hunter2'].join(''), labels: [{ name: 'bug' }], author: { login: 'Other' }, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', closedAt: null, url: 'https://github.com/o/r/issues/20', comments: [] },
];
const PRS = [
  { number: 11, title: 'Bridge garage sensors', state: 'MERGED', body: 'Closes #10', labels: [], author: { login: 'Unthred' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T01:00:00Z', closedAt: '2026-10-02T01:00:00Z', mergedAt: '2026-10-02T01:00:00Z', url: 'https://github.com/o/r/pull/11', comments: [], headRefName: 'claude/issue-10-bridge', headRefOid: SHA, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }], closingIssuesReferences: [{ number: 10 }] },
  { number: 21, title: 'Backoff', state: 'OPEN', body: 'wip', labels: [], author: { login: 'Other' }, createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', closedAt: null, mergedAt: null, url: 'https://github.com/o/r/pull/21', comments: [], headRefName: 'codex/issue-20-backoff', headRefOid: 'b'.repeat(40), isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }], closingIssuesReferences: [{ number: 20 }] },
];
// A fake gh: serves the fixtures that match the `updated:>=` cursor, oldest first, capped at --limit. Records every call.
const fakeGh = (issues, prs, calls = []) => args => {
  calls.push(args);
  const src = args[0] === 'pr' ? prs : issues, search = args[args.indexOf('--search') + 1], since = /updated:>=(\S+)/.exec(search)[1], lim = Number(args[args.indexOf('--limit') + 1]);
  return JSON.stringify(src.filter(i => i.updatedAt >= since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, lim));
};
const build = (t, issues = ISSUES, prs = PRS) => { const root = tmp(t); const calls = []; const r = updateIndex(root, { run: fakeGh(issues, prs, calls), repository: 'o/r' }); return { root, calls, r }; };

test('the index holds closed issues and merged PRs; text search finds an issue by words in its body', t => {
  const { root, r } = build(t);
  assert.equal(r.items, 4); assert.equal(r.caughtUp, true);
  const idx = readIndex(root);
  const hit = searchIndex(idx, { text: 'garage mosquitto' });
  assert.deepEqual(hit.items.map(i => `${i.kind}${i.number}`), ['issue10'], 'both words are in the body of issue 10 only');
  assert.equal(hit.items[0].state, 'CLOSED'); assert.match(hit.items[0].excerpt, /garage sensors/); assert.deepEqual(hit.items[0].labels, ['enhancement']);
  assert.equal(searchIndex(idx, { text: 'no such words anywhere' }).items.length, 0, 'negative: no match');
  assert.equal(searchIndex(idx, { text: 'garage', kind: 'pr', state: 'merged' }).items[0].number, 11);
  assert.equal(searchIndex(idx, { state: 'open' }).items.length, 2);
  assert.equal(searchIndex(idx, { state: 'closed' }).items.length, 2, 'closed includes merged');
  assert.deepEqual(searchIndex(idx, { from: 15, to: 25, kind: 'issue' }).items.map(i => i.number), [20]);
  assert.deepEqual(searchIndex(idx, { label: 'bug' }).items.map(i => i.number), [20]);
  assert.deepEqual(searchIndex(idx, { author: 'other', kind: 'issue' }).items.map(i => i.number), [20]);
  assert.deepEqual(searchIndex(idx, { updatedSince: '2026-10-05T12:00:00Z' }).items.map(i => i.number), [21]);
  assert.match(searchIndex(idx, { updatedSince: 'nonsense' }).error, /ISO date/);
});

test('pull request filters: head, ci, linked issue, verdict', t => {
  const idx = readIndex(build(t).root);
  assert.deepEqual(searchIndex(idx, { kind: 'pr', ci: 'failing' }).items.map(i => i.number), [21]);
  assert.deepEqual(searchIndex(idx, { kind: 'pr', ci: 'passing' }).items.map(i => i.number), [11]);
  assert.deepEqual(searchIndex(idx, { kind: 'pr', head: 'issue-20' }).items.map(i => i.number), [21]);
  assert.deepEqual(searchIndex(idx, { kind: 'pr', issue: 10 }).items.map(i => i.number), [11]);
  const verdicts = { [`21:${'b'.repeat(40)}`]: { verdict: 'CHANGES' }, [`11:${SHA}`]: { verdict: 'PASS' } };
  assert.deepEqual(searchIndex(idx, { kind: 'pr', verdict: 'CHANGES' }, { verdicts }).items.map(i => i.number), [21]);
  assert.deepEqual(searchIndex(idx, { kind: 'pr', verdict: 'none' }, { verdicts: {} }).items.map(i => i.number), [11, 21].sort((a, b) => b - a));
  assert.equal(searchIndex(idx, { kind: 'pr', verdict: 'PASS' }, { verdicts: {} }).items.length, 0);
});

test('a number lookup returns the full redacted body and comments; search results carry only an excerpt', t => {
  const idx = readIndex(build(t).root);
  const one = searchIndex(idx, { number: 20, kind: 'issue' }).items[0];
  assert.match(one.body, /retry with backoff/); assert.ok(!one.body.includes('hunter2hunter2'), 'secret in the body is redacted');
  const ten = searchIndex(idx, { number: 10, kind: 'issue' }).items[0];
  assert.equal(ten.comments.length, 1); assert.ok(!ten.comments[0].body.includes(GH), 'secret in a comment is redacted');
  assert.equal('body' in searchIndex(idx, { text: 'retry' }).items[0], false);
  assert.equal(searchIndex(idx, { number: 9999 }).items.length, 0);
});

test('redaction scans past 2000 characters and truncates', () => {
  const long = `${'x'.repeat(2500)}\npassword=${['hunter2', 'hunter2x'].join('')}\n${'y'.repeat(100)}`;
  const out = redactText(long, 20000);
  assert.ok(!out.includes('hunter2hunter2x')); assert.ok(redactText('z'.repeat(50000), 1000).length < 1100);
});

test('refresh is incremental and bounded: one call per kind, history pages in, an idle pass makes no call', t => {
  const many = Array.from({ length: PAGE + 30 }, (_, k) => ({ ...ISSUES[0], number: 100 + k, title: `Old ${k}`, updatedAt: new Date(Date.UTC(2026, 0, 1) + k * 60000).toISOString().replace('.000Z', 'Z') }));
  const root = tmp(t), calls = [];
  const run = fakeGh(many, [], calls);
  let r = updateIndex(root, { run, repository: 'o/r' });
  assert.equal(calls.length, 2, 'one call per kind'); assert.equal(r.items, PAGE); assert.equal(r.caughtUp, false, 'the first page was full');
  r = updateIndex(root, { run, repository: 'o/r' });
  assert.equal(calls.length, 4); assert.equal(r.items, PAGE + 30); assert.equal(r.caughtUp, true);
  assert.equal(readIndex(root).items['issue:229'].title, 'Old 129');
  assert.deepEqual(updateIndex(root, { run, repository: 'o/r', idle: true }), { skipped: true }); assert.equal(calls.length, 4, 'no call on an idle, caught-up pass');
  // a later edit is picked up by the cursor, replacing the stored item
  many[0] = { ...many[0], title: 'Renamed', updatedAt: '2027-01-01T00:00:00Z' };
  updateIndex(root, { run, repository: 'o/r' });
  assert.equal(readIndex(root).items['issue:100'].title, 'Renamed');
});

test('refresh never throws: a failing gh leaves the old index alone; the status issue is dropped', t => {
  const { root } = build(t);
  const before = fs.readFileSync(indexFile(root), 'utf8');
  const r = updateIndex(root, { run: () => { throw new Error(`gh failed ${GH}`); }, repository: 'o/r' });
  assert.ok(r.error); assert.ok(!r.error.includes(GH)); assert.equal(fs.readFileSync(indexFile(root), 'utf8'), before);
  const idx = refreshIndex(null, { run: fakeGh(ISSUES, []), repository: 'o/r', isStatusIssue: i => i.number === 20 });
  assert.deepEqual(Object.keys(idx.items), ['issue:10']);
});

test('no index yet: a clear error, not a crash', () => { assert.match(searchIndex(null, { text: 'x' }).error, /not been built/); });

test('end to end: tool over the dashboard endpoint, read-only, schema enforced, no secret-shaped output', async t => {
  const { root } = build(t);
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config: () => BASE, host: '127.0.0.1', port, recorderDir: null }));
  const base = `http://127.0.0.1:${port}`;
  const snap = () => fs.readFileSync(indexFile(root), 'utf8');
  const before = snap();
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), getPath: p => getJson(new URL(p, `${base}/api/view.json`).href) });
  assert.equal(tools.list().find(x => x.name === 'foreman_issues').annotations.readOnlyHint, true);
  const s = await tools.call('foreman_issues', { text: 'mosquitto' }); assert.equal(s.isError, false, s.text);
  const sv = JSON.parse(s.text); assert.equal(sv.items[0].number, 10); assert.equal(sv.coverage.caughtUp, true);
  const n = await tools.call('foreman_issues', { number: 10, kind: 'issue' }); const nv = JSON.parse(n.text);
  assert.match(nv.items[0].body, /garage sensors/);
  for (const x of [s.text, n.text, (await tools.call('foreman_issues', { number: 20, kind: 'issue' })).text]) assert.ok(!x.includes(GH) && !x.includes('hunter2hunter2'));
  assert.equal((await tools.call('foreman_issues', { bogus: 1 })).isError, true, 'unknown argument refused');
  assert.equal((await tools.call('foreman_issues', { state: 'weird' })).isError, true, 'bad enum refused');
  const post = await new Promise(res => { const q = http.request({ host: '127.0.0.1', port, path: '/api/issues.json', method: 'POST', headers: { host: `127.0.0.1:${port}` } }, r => { r.resume(); res(r.statusCode); }); q.end(); }); assert.notEqual(post, 200);
  assert.equal(snap(), before, 'the index is untouched by reads');
  const none = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}) });
  assert.equal((await none.call('foreman_issues', { text: 'x' })).isError, true);
});
