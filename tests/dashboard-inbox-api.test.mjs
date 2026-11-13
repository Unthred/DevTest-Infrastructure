// Issue #1197: GET /api/inbox.json through the real dashboard handler. Fixtures are built at run time.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { handler } from '../supervisor/dashserver.mjs';

const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };

async function serve(t, inbox) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash1197-'));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  removeLater(root);
  const port = server.address().port;
  const cfg = inbox ? { ...config, inbox: { dir: inbox } } : config;
  server.on('request', handler({ wake: () => {}, root, config: cfg, host: '127.0.0.1', port, now: () => 10 * 60000 }));
  return p => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('#1197: /api/inbox.json answers 200 with titles, newest first, read-only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox1197-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'items'));
  const write = (title, createdAt, state) => {
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(dir, 'status', `${id}.json`), JSON.stringify({ id, kind: 'prompt', state, title, createdAt }));
    return id;
  };
  write("Owner's older", 2 * 60000, 'pending');
  const newest = write('Newest', 4 * 60000, 'done');
  const before = fs.readdirSync(path.join(dir, 'status')).map(n => fs.readFileSync(path.join(dir, 'status', n), 'utf8'));
  const get = await serve(t, dir);
  const r = await get('/api/inbox.json');
  assert.equal(r.status, 200);
  assert.match(r.body, /"title"/);
  const out = JSON.parse(r.body);
  assert.deepEqual(out.cards.map(c => c.title), ['Newest', "Owner's older"]);
  assert.equal(out.cards[0].id, newest.slice(0, 8));
  assert.equal(out.cards[0].ageMinutes, 6);
  const after = fs.readdirSync(path.join(dir, 'status')).map(n => fs.readFileSync(path.join(dir, 'status', n), 'utf8'));
  assert.deepEqual(after, before);
});

test('#1197: /api/inbox.json is 404 when no inbox is configured', async t => {
  const get = await serve(t, null);
  assert.equal((await get('/api/inbox.json')).status, 404);
});
