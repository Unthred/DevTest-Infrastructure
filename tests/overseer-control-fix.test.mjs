// Issue #1115 review fixes: the App identity write, the wake for a control item, and a parked PR staying in the planner's view.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { addLabelAsApp, appConfigured } from '../supervisor/appidentity.mjs';
import { park } from '../supervisor/controlactions.mjs';
import { scanInboxNow, inboxScanDone } from '../supervisor/wake.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
const config = { repository: 'o/r', github_app: { app_id: 7, installation_id: 9, key_file: '/k/app.pem' } };
const reply = (ok, body = {}, status = ok ? 200 : 403) => ({ ok, status, json: async () => body });

test('App label: mints an installation token with a signed JWT, then labels with that token only', async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push({ url, init }); return url.endsWith('/access_tokens') ? reply(true, { token: 'inst-token' }) : reply(true); };
  await addLabelAsApp(config, 5, 'parked', { fetchFn, readKey: () => KEY, now: 1e12 });
  assert.equal(seen[0].url, 'https://api.github.com/app/installations/9/access_tokens');
  const jwt = seen[0].init.headers.authorization.replace('Bearer ', '');
  const [h, c, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, '7');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), crypto.createPublicKey(KEY), Buffer.from(sig, 'base64url')));
  assert.equal(seen[1].url, 'https://api.github.com/repos/o/r/issues/5/labels');
  assert.equal(seen[1].init.headers.authorization, 'Bearer inst-token');
  assert.deepEqual(JSON.parse(seen[1].init.body), { labels: ['parked'] });
});

test('App label: without a configured App it refuses and makes no request, so the owner login is never used', async () => {
  let calls = 0;
  await assert.rejects(addLabelAsApp({ repository: 'o/r' }, 5, 'parked', { fetchFn: async () => { calls++; } }), /no GitHub App identity/);
  assert.equal(calls, 0);
  assert.equal(appConfigured({}), false);
});

test('App label: a failed token request or label write is an error naming the HTTP status, not a secret', async () => {
  await assert.rejects(addLabelAsApp(config, 5, 'parked', { fetchFn: async () => reply(false), readKey: () => KEY }), /token request failed \(HTTP 403\)/);
  const fetchFn = async url => (url.endsWith('/access_tokens') ? reply(true, { token: 'inst-token' }) : reply(false, {}, 404));
  await assert.rejects(addLabelAsApp(config, 5, 'parked', { fetchFn, readKey: () => KEY }), /label write failed \(HTTP 404\)/);
});

test('park: with no App identity the item is refused with the reason and not labelled', async () => {
  const gh = { listPulls: async () => [{ number: 5, labels: [] }], listIssues: async () => [] };
  const labelAsApp = (n, l) => addLabelAsApp({ repository: 'o/r' }, n, l);   // what depsOf wires when no App is configured
  const r = await park(5, { gh, jobs: {}, records: {}, labelAsApp });
  assert.equal(r.outcome, 'refused');
  assert.match(r.text, /was not parked: .*no GitHub App identity/);
});

test('team config: github_app needs ids and an absolute key file', () => {
  const base = { schema_version: 1, repository: 'o/r', repo_path: '/p', worktree_base: '/w', limits: { max_review_attempts: 2, max_fix_attempts: 2, roles: { implementer: 1, reviewer: 1 } }, agents: {} };
  assert.throws(() => validateTeamConfig({ ...base, github_app: { app_id: 1, installation_id: 2, key_file: 'rel.pem' } }), /github_app/);
  assert.throws(() => validateTeamConfig({ ...base, github_app: { app_id: 1, installation_id: 2, key_file: '/k.pem', token: 'x' } }), /github_app/);
});

test('inbox watcher: a scan that picks up a control item still wakes a pass; an ordinary item does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakectl-'));
  try {
    fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
    const add = (id, item) => fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item));
    const r1 = scanInboxNow({ root: dir, inboxDir: dir, scan: inbox.scan, maxPending: 30 });
    assert.equal(r1.controls, 0);
    add('a'.repeat(32), { kind: 'control', title: 'park 5', action: 'park', target: '5', reason: 'runaway' });
    const r2 = scanInboxNow({ root: dir, inboxDir: dir, scan: inbox.scan, maxPending: 30 });
    assert.equal(r2.controls, 1);
    add('b'.repeat(32), { kind: 'prompt', title: 'p', prompt: 'do it' });
    assert.equal(scanInboxNow({ root: dir, inboxDir: dir, scan: inbox.scan, maxPending: 30 }).controls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a parked pull request stays in the view and does not start a duplicate implement job', async () => {
  const HEAD = 'a1'.repeat(20), state = fs.mkdtempSync(path.join(os.tmpdir(), 'parkview-'));
  try {
    const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
      limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] } } };
    const gh = { prs: [{ number: 50, headRefName: 'claude/issue-5-x', headRefOid: HEAD, isDraft: false, labels: ['parked'] }], issues: [{ number: 5, state: 'OPEN', title: 'T', body: '', labels: [] }],
      listPulls: async () => gh.prs, listIssues: async () => gh.issues, getPull: async () => null, board: async () => {}, listMergedPulls: async () => [] };
    const team = new Team({ config: cfg, root: stateRoot(state), gh, jobs: { listActive: async () => [], get: async () => null }, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
      register: '', clock: { now: () => 5000 }, providerModels: { claude: { aliases: ['opus'], pattern: '^claude-', efforts: ['low'] } } });
    const actions = await team.plan();
    assert.ok(!actions.some(a => a.type === 'implement' && a.issue === 5), 'the held item is not started a second time');
    assert.ok(!actions.some(a => a.pr === 50), 'a parked pull request gets no action');
    assert.deepEqual(team.view.prs.map(p => p.number), [50], 'the parked pull request stays in the view for the dashboard and foreman_why_blocked');
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test('inboxScanDone: false (so a pass is requested) when the scan picked up a control item, true for an ordinary item', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scandone-'));
  try {
    fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
    const config = { inbox: { dir, max_pending: 30 } };
    fs.writeFileSync(path.join(dir, 'items', `${'c'.repeat(32)}.json`), JSON.stringify({ kind: 'control', title: 'stop', action: 'stop_job', target: 'abcdef12', reason: 'runaway' }));
    assert.equal(inboxScanDone(dir, config, inbox.scan), false);
    fs.writeFileSync(path.join(dir, 'items', `${'d'.repeat(32)}.json`), JSON.stringify({ kind: 'prompt', title: 'p', prompt: 'do it' }));
    assert.equal(inboxScanDone(dir, config, inbox.scan), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
