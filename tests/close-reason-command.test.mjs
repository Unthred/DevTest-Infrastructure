// Issue #1306: POST /api/v1/commands/work_item.close_reason through the real dashboard request handler with a stub GitHub client, a temporary
// state root and the origin and access proof a real page sends. The real example is issue 895, closed as not planned on 9 Nov 2026 with no comment.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { readRecord, ensureStartedAt } from '../supervisor/closedreason-store.mjs';
import { MARKER } from '../supervisor/closedreason.mjs';
import { asyncGithubClient } from '../supervisor/github-async.mjs';
import { parseIssues } from '../supervisor/api/commands/work-item-close-reason.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const START = Date.UTC(2026, 10, 9, 19, 0, 0);
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = Object.fromEntries(['common', 'audit', 'command-request', 'command-result'].map(n => [`${n}.schema.json`, readSchema(`${n}.schema.json`)]));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const TITLE_895 = 'Explain everything: every skip, refusal and failure records a plain-English reason, shown as a per-item story, grouped Needs you, and an outcome board';
const REASON = 'Dropped in the V2 sweep; the outcome board is now issue 1300';
const dropped = (number, over = {}) => ({ number, title: number === 895 ? TITLE_895 : `Issue ${number}`, state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-11-09T20:14:00Z', labels: [], ...over });
let keyCount = 0;
const nextKey = () => `close-key-${String(++keyCount).padStart(4, '0')}`;

// A GitHub client that holds issues by number and records every comment. `failOn` makes the comment on that number throw.
const stubGithub = (issues, { failOn = null } = {}) => {
  const comments = [];
  const byNumber = new Map(issues.map(i => [i.number, i]));
  return {
    comments,
    getIssue: async n => byNumber.get(n) ?? null,
    comment: async (n, body) => { if (n === failOn) throw new Error('boom'); comments.push([n, body]); },
  };
};

async function serve(t, issues, options = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cr1306-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues, tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  ensureStartedAt(root, START);
  const github = options.client ?? stubGithub(issues, options);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const clock = { now: NOW };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => clock.now, github }));
  const origin = `http://127.0.0.1:${port}`;
  const send = (method, p, body, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const close = async (issuesText, reason = REASON) => {
    clock.now += 5000;
    const text = JSON.stringify({ input: { issues: issuesText }, reason, idempotency_key: nextKey() });
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-foreman-proof': writeToken(root), origin };
    return send('POST', '/api/v1/commands/work_item.close_reason', text, headers);
  };
  const needsYou = async () => (await send('GET', '/api/view.json', undefined, {})).body.panels.needsYou.map(i => i.id);
  return { root, github, close, needsYou, get: p => send('GET', p, undefined, {}) };
}

const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), [], 'the reply fits command-result.schema.json');
const open = number => ({ number, title: `Open ${number}`, state: 'OPEN', stateReason: null, labels: [] });

test('applied: issue 895 gets one comment that starts with the marker, the record holds the reason, and the item is gone on the next read', async t => {
  const s = await serve(t, [dropped(895), dropped(896)]);
  assert.deepEqual(await s.needsYou(), ['closed-noreason']);
  const r = await s.close('895, 896');
  assert.equal(r.status, 200);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome], [true, 'applied']);
  assert.deepEqual(s.github.comments, [[895, `${MARKER}\n${REASON}`], [896, `${MARKER}\n${REASON}`]]);
  assert.ok(s.github.comments.every(([, body]) => body.startsWith('<!-- devtest-close-reason v1 -->')));
  const { reasons } = readRecord(s.root).record;
  assert.deepEqual(Object.keys(reasons), ['895', '896']);
  assert.deepEqual([reasons['895'].reason, typeof reasons['895'].at, reasons['895'].call], [REASON, 'number', 'close-key-0001']);
  assert.deepEqual(await s.needsYou(), []);
});

test('refused: an open issue, with no comment and no record', async t => {
  const s = await serve(t, [dropped(895), open(900)]);
  const r = await s.close('895 900');
  assert.equal(r.status, 409);
  shape(r.body);
  assert.equal(r.body.refusal_code, 'issue_open');
  assert.match(r.body.refusal_text, /Issue 900 is open/);
  assert.deepEqual(s.github.comments, []);
  assert.deepEqual(readRecord(s.root).record.reasons, {});
  assert.deepEqual(await s.needsYou(), ['closed-noreason']);
});

test('refused: a second record for the same issue, and the first reason stays', async t => {
  const s = await serve(t, [dropped(895), dropped(896)]);
  assert.equal((await s.close('895')).body.outcome, 'applied');
  const again = await s.close('895 896', 'A different reason that is long enough');
  assert.equal(again.status, 409);
  shape(again.body);
  assert.equal(again.body.refusal_code, 'already_recorded');
  assert.equal(s.github.comments.length, 1);
  assert.equal(readRecord(s.root).record.reasons['895'].reason, REASON);
  assert.equal(readRecord(s.root).record.reasons['896'], undefined);
});

test('refused: a reason under 10 characters, 9 refused and 10 accepted, with nothing posted for the short one', async t => {
  const s = await serve(t, [dropped(895)]);
  const short = await s.close('895', '123456789');
  assert.equal(short.status, 409);
  shape(short.body);
  assert.equal(short.body.refusal_code, 'reason_too_short');
  assert.deepEqual(s.github.comments, []);
  assert.equal((await s.close('895', 'abcdefghij')).body.outcome, 'applied');
  assert.equal(s.github.comments.length, 1);
});

test('refused: no reason at all and a blank one are reason_required before the command runs', async t => {
  const s = await serve(t, [dropped(895)]);
  for (const reason of [null, '   ']) {
    const r = await s.close('895', reason);
    assert.deepEqual([r.status, r.body.refusal_code], [400, 'reason_required']);
  }
  assert.deepEqual(s.github.comments, []);
});

test('invalid issue lists are refused: none, a word, a negative number, a number too large and more than 250', async t => {
  const s = await serve(t, [dropped(895)]);
  for (const bad of ['', 'abc', '-5', '895;896', '0', '1234567890']) {
    const r = await s.close(bad);
    assert.equal(r.body.refusal_code, 'bad_issues', bad);
  }
  const many = await s.close(Array.from({ length: 251 }, (_, i) => i + 1).join(','));
  assert.equal(many.body.refusal_code, 'too_many');
  assert.deepEqual(s.github.comments, []);
});

test('refused: an issue that GitHub does not know, one closed as completed, and nothing is posted', async t => {
  const s = await serve(t, [dropped(895), dropped(901, { stateReason: 'COMPLETED' })]);
  assert.equal((await s.close('999')).body.refusal_code, 'not_found');
  assert.equal((await s.close('901')).body.refusal_code, 'not_dropped');
  assert.deepEqual(s.github.comments, []);
});

test('one comment per issue even when a number is repeated in the list', async t => {
  const s = await serve(t, [dropped(895)]);
  assert.equal((await s.close('895, 895 895')).body.outcome, 'applied');
  assert.equal(s.github.comments.length, 1);
});

test('a comment that fails part way: the issues before it are recorded and the refusal names those still needing a reason', async t => {
  const s = await serve(t, [dropped(895), dropped(896), dropped(897)], { failOn: 896 });
  const r = await s.close('895 896 897');
  assert.equal(r.status, 409);
  assert.equal(r.body.refusal_code, 'partly_recorded');
  assert.match(r.body.refusal_text, /Recorded 1 of 3; issue 896 failed, so 896, 897 still need a reason/);
  assert.deepEqual(Object.keys(readRecord(s.root).record.reasons), ['895']);
  assert.deepEqual(await s.needsYou(), ['closed-noreason']);
});

test('audit: the applied and the refused call are each audited with the command name', async t => {
  const s = await serve(t, [dropped(895)]);
  await s.close('895', 'short');
  await s.close('895');
  const entries = (await s.get('/api/v1/audit')).body.data.entries;
  assert.deepEqual(entries.map(e => [e.command, e.outcome, e.refusal_code]), [['work_item.close_reason', 'applied', null], ['work_item.close_reason', 'refused', 'reason_too_short']]);
});

test('parseIssues reads commas and spaces, drops repeats and refuses anything else', () => {
  assert.deepEqual(parseIssues('895,896 897'), [895, 896, 897]);
  assert.deepEqual(parseIssues(' 5 ,5'), [5]);
  assert.equal(parseIssues('5x'), null);
  assert.equal(parseIssues(''), null);
});

test('the server keeps answering while a sweep is recorded: the real async client with a gh that takes 20 ms a call, 10 issues, a second request answered first', async t => {
  const issues = Array.from({ length: 10 }, (_, k) => dropped(2000 + k));
  const calls = [];
  let started;
  const sweepStarted = new Promise(resolve => { started = resolve; });
  const gh = async (args, input) => {
    calls.push(args.slice(0, 2).join(' '));
    started();
    await new Promise(resolve => setTimeout(resolve, 20));
    if (args[1] === 'view' && args.includes('comments')) return JSON.stringify({ comments: [] });
    if (args[1] === 'view') return JSON.stringify(issues.find(i => String(i.number) === args[2]));
    assert.ok(input.startsWith(MARKER));
    return '';
  };
  const s = await serve(t, issues, { client: asyncGithubClient({ repository: 'o/r' }, gh) });
  // By order, not by milliseconds (issue #1321): a request sent while the sweep is in flight must be answered before the sweep is.
  const order = [];
  const sweep = s.close(issues.map(i => i.number).join(' ')).then(r => { order.push('sweep'); return r; });
  await sweepStarted;
  const second = await s.get('/api/view.json').then(r => { order.push('second request'); return r; });
  const r = await sweep;
  assert.equal(second.status, 200);
  assert.deepEqual(order, ['second request', 'sweep'], 'the second request was answered while the sweep was still running');
  assert.equal(r.body.outcome, 'applied');
  assert.equal(calls.length, 30);
  assert.deepEqual(await s.needsYou(), []);
});
