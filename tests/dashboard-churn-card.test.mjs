// Issue #1157: a PR the churn rule stopped below the fix limit has its own Needs you card, and that card offers the routine actions.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { severityOf } from '../supervisor/dashui/logic.mjs';

const NOW = Date.UTC(2026, 9, 30, 13, 0, 0);
const HEAD = '1'.repeat(40);
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
};
const pull = { number: 41, title: 'PR forty-one', headRefName: 'claude/issue-30-x', headRefOid: HEAD, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', labels: ['needs-homeowner'], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };
const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [], pulls: [pull], issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [], prerequisites: [] }] };

async function viewOf(t, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-churn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(state));
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW, statfs: () => ({ bavail: 5e8, blocks: 1e9, bsize: 4096 }) }));
  const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/view.json', headers: { host: `127.0.0.1:${port}` } }, res => {
    let b = '';
    res.on('data', d => (b += d));
    res.on('end', () => resolve(b));
  }).on('error', reject));
  return JSON.parse(body);
}

test('a churn-stopped PR below the fix limit gets a churn card with extra_fix_round and close_superseded', async t => {
  const state = { fixAttempts: {}, verdicts: { [`41:${HEAD}`]: { verdict: 'CHANGES' } }, jobs: {}, notified: { [`churn:41:${HEAD}`]: NOW } };
  const v = await viewOf(t, state);
  assert.deepEqual(v.panels.needsYou.map(c => c.id), ['churn-41']);
  const actions = v.panels.needsYou[0].card.controls.map(c => c.action);
  assert.ok(actions.includes('extra_fix_round') && actions.includes('close_superseded'), actions.join());
  assert.equal(severityOf('churn-41'), 'action');
});

test('without the churn record the same PR keeps the plain needs-homeowner card', async t => {
  const state = { fixAttempts: {}, verdicts: { [`41:${HEAD}`]: { verdict: 'CHANGES' } }, jobs: {}, notified: {} };
  const v = await viewOf(t, state);
  assert.deepEqual(v.panels.needsYou.map(c => c.id), ['homeowner-pr-41']);
});
