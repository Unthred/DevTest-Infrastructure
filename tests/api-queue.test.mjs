// Issue #1349: GET /api/v1/queue through the real handler and prepared dashboard view, with fixture state shaped like Foreman's cache.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { compactIssues, compactPulls } from '../supervisor/dashdata.mjs';
import { validate } from '../supervisor/api/validate.mjs';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 3600000;
const MINUTE = 60000;
const API = new URL('../supervisor/api/', import.meta.url);
const QUEUED_ISSUE_NUMBERS = Array.from({ length: 14 }, (_, i) => 1141 + i);
const schema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = Object.fromEntries(['common.schema.json', 'queue.schema.json'].map(name => [name, schema(name)]));
const head = number => String(number).repeat(40).slice(0, 40);
const iso = value => new Date(value).toISOString();
const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'OPEN',
  body: '',
  labels: [],
  createdAt: iso(NOW - 3 * HOUR),
  ...extra,
});
const check = conclusion => [{ name: 'ci', status: 'COMPLETED', conclusion }];
const pull = (number, branch, conclusion, extra = {}) => ({
  number,
  title: `Change ${number}`,
  headRefName: branch,
  headRefOid: head(number),
  baseRefName: 'main',
  isDraft: false,
  mergeable: 'MERGEABLE',
  statusCheckRollup: check(conclusion),
  createdAt: iso(NOW - 2 * HOUR),
  url: `https://github.com/o/r/pull/${number}`,
  labels: [],
  closingIssuesReferences: [],
  ...extra,
});
const config = {
  schema_version: 1,
  enabled: true,
  repository: 'o/r',
  repo_path: '/p/r',
  worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3, max_same_cause_attempts: 3 },
  agents: {
    alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [...QUEUED_ISSUE_NUMBERS, 1155, 1157, 1169, 1170, 1185] },
    beta: { provider: 'prov-b', branch_prefix: 'beta/', issues: [] },
  },
};

function fixture() {
  const queuedIssues = QUEUED_ISSUE_NUMBERS.map(number => issue(number));
  const issues = [
    ...queuedIssues,
    issue(1155),
    issue(1157),
    issue(1169, { body: 'Depends on: #1157', labels: ['queue'] }),
    issue(1170),
    issue(1171),
    issue(1185, { body: 'Depends on: #1157 inline' }),
    issue(1190, { state: 'CLOSED', closedAt: iso(NOW - HOUR) }),
  ];
  const pulls = [pull(1178, 'beta/issue-1170-review', 'SUCCESS'), pull(1180, 'alpha/issue-1190-cap', 'FAILURE', { labels: ['needs-homeowner'] })];
  const implementJob = {
    id: 'a'.repeat(32),
    provider: 'prov-a',
    kind: 'implement',
    issue: 1155,
    branch: 'alpha/issue-1155-q',
    status: 'running',
    createdAt: NOW - 20 * MINUTE,
    updatedAt: NOW - MINUTE,
    attempts: 1,
    usage: { inputTokens: 12000, outputTokens: 3000, costUsdEstimate: 0.42 },
  };
  const reviewJob = {
    id: 'b'.repeat(32),
    provider: 'prov-b',
    kind: 'review',
    issue: 1178,
    branch: 'beta/issue-1170-review',
    status: 'running',
    createdAt: NOW - 10 * MINUTE,
    updatedAt: NOW - MINUTE,
    attempts: 1,
  };
  return {
    jobs: [implementJob, reviewJob],
    cache: {
      tick: { at: NOW - MINUTE, status: 'ok', error: null, lastOkAt: NOW - MINUTE },
      fetchedAt: NOW - MINUTE,
      pulls: compactPulls(pulls), issues: compactIssues(issues), delivered: [], mergedNumbers: [1179],
      planned: [
        { type: 'implement', agent: 'alpha', ref: 1170, outcome: 'held', kind: 'slot', reason: 'implementer slot full' },
      ],
      merged: [{
        number: 1179,
        title: 'Merged today',
        mergedAt: iso(NOW - HOUR),
        headRefName: 'alpha/issue-1171-merged',
        closingIssuesReferences: [{ number: 1171 }],
      }],
      dependencies: {
        evaluatedAt: NOW - MINUTE,
        installed: null,
        issues: {
          1169: {
            dependsOn: [{ number: 1157, state: 'open' }],
            malformed: null,
            line: 'Depends on: #1157',
            cycle: null,
            met: false,
            reasons: ['#1157 still open'],
            since: NOW - 4 * HOUR,
          },
          1185: {
            dependsOn: [],
            malformed: '#1157 inline',
            line: 'Depends on: #1157 inline',
            cycle: null,
            met: false,
            reasons: ['malformed Depends on line'],
            since: NOW - 2 * HOUR,
          },
        },
      },
    },
    state: {
      jobs: {
        [implementJob.id]: { kind: 'implement', agent: 'alpha', issue: 1155 },
        [reviewJob.id]: { kind: 'review', agent: 'beta', pr: 1178, head: head(1178) },
      },
      sameCause: { 'fix:1180': { cause: 'ci-failed', count: 3, head: head(1180), at: NOW - 3 * HOUR, raised: false } },
      fixAttempts: {}, verdicts: {}, mergeLog: [{ pr: 1179, issue: 1171, agent: 'alpha', mergedAt: NOW - HOUR }],
    },
  };
}

async function serve(t) {
  const root = removeLater(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1349-')));
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const data = fixture();
  for (const job of data.jobs) fs.writeFileSync(path.join(root, 'jobs', `${job.id}.json`), JSON.stringify(job));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(data.cache));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(data.state));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  return route => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}` } }, response => {
    let text = '';
    response.on('data', part => { text += part; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
  }).on('error', reject));
}

const byKey = (reply, key) => reply.body.data.items.find(item => item.key === key);

test('valid: the real router serves the closed queue schema with #1169 ranked 17 of 21 and its dependency hold', async t => {
  const get = await serve(t);
  const reply = await get('/api/v1/queue');
  assert.equal(reply.status, 200);
  assert.deepEqual(validate(schemas['queue.schema.json'], reply.body, schemas), []);
  const item = byKey(reply, 'issue-1169');
  assert.deepEqual([item.rank, item.rank_of, item.prerequisites.open], [17, 21, [1157]]);
  assert.deepEqual([item.condition.reason_code, item.condition.since], ['prerequisite_open', new Date(NOW - 4 * HOUR).toISOString()]);
  assert.match(item.condition.reason_text, /waiting for #1157 still open/);
  assert.deepEqual(item.labels, ['queue']);
});

test('valid: retry cap has its real since and clear action; active implement and review work choose their roles', async t => {
  const reply = await (await serve(t))('/api/v1/queue');
  const capped = byKey(reply, 'change-1180');
  assert.equal(capped.condition.reason_code, 'retry_capped');
  assert.equal(capped.condition.since, new Date(NOW - 3 * HOUR).toISOString());
  assert.deepEqual(capped.actions.map(action => action.command), ['work_item.clear_retry_cap']);
  assert.deepEqual(capped.labels, ['needs-homeowner']);
  const active = byKey(reply, 'issue-1155');
  assert.deepEqual([active.stage, active.role, active.usage], ['implementing', 'implementer', { tokens: 15000, cost_pence: 32 }]);
  const review = byKey(reply, 'change-1178');
  assert.deepEqual([review.stage, review.role, review.condition.state], ['in_review', 'reviewer', 'running']);
  assert.equal(reply.body.data.summary.open_changes, 2);
});

test('boundary: a slot hold has no since, a no-line issue has no actions, and a change merged today appears once without its issue', async t => {
  const reply = await (await serve(t))('/api/v1/queue');
  const item = byKey(reply, 'issue-1170');
  assert.equal(item.estimated_start_at, null);
  assert.deepEqual(item.prerequisites, { line_state: 'none', raw_line: null, declared: [], open: [] });
  assert.deepEqual([item.condition.reason_code, item.condition.since, item.actions, item.role], ['slot', null, [], 'reviewer']);
  assert.equal(byKey(reply, 'change-1179').stage, 'installed');
  assert.equal(byKey(reply, 'issue-1171'), undefined);
});

test('invalid: inline prerequisite declaration is a fault and a closed unmerged issue is absent', async t => {
  const reply = await (await serve(t))('/api/v1/queue');
  const malformed = byKey(reply, 'issue-1185');
  assert.deepEqual(
    [malformed.prerequisites.line_state, malformed.condition.attention, malformed.condition.reason_code],
    ['malformed', 'fault', 'malformed_prerequisite_line'],
  );
  assert.equal(byKey(reply, 'issue-1190'), undefined);
});

test('the discovered meta model and served schema include queue', async t => {
  const get = await serve(t);
  const meta = await get('/api/v1/meta');
  assert.ok(meta.body.data.models.some(model => model.name === 'queue' && model.path === '/api/v1/queue'));
  assert.equal((await get('/api/v1/schemas/queue.schema.json')).body.$id, 'queue.schema.json');
});
