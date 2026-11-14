// Issue #1311: GET /api/v1/agent-icon/{agent} and the icon on each liveboard agent, through the real dashboard handler over a temporary state root.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const MIN = 60000;
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => [name, JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'))];
const schemas = Object.fromEntries(['common.schema.json', 'appbar.schema.json', 'liveboard.schema.json'].map(readSchema));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet' } }, codex: { implement: { effort: 'high' } } } },
  agents: { claude: { provider: 'prov-a', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'prov-b', branch_prefix: 'codex/', issues: [] } },
};
const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
  + '<path d="M12 2l3 7h7l-5.500 4.500 2 7.500-6.500-4.500-6.500 4.500 2-7.500L2 9h7z"/></svg>';
const HEXAGON = '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="12,2 21,7 21,17 12,22 3,17 3,7"/></svg>';

async function serve(t, icons = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1311-'));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const tick = { at: NOW - MIN, status: 'ok', error: null, lastOkAt: NOW - MIN };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW - MIN, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  fs.mkdirSync(path.join(root, 'agent-icons'));
  for (const [file, text] of Object.entries(icons)) fs.writeFileSync(path.join(root, 'agent-icons', file), text);
  // A decoy outside the icon folder that a joined path would reach.
  fs.writeFileSync(path.join(root, 'secret.svg'), STAR);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  const get = route => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on('error', reject);
  });
  return { get, root };
}
const iconOf = (reply, id) => JSON.parse(reply.text).data.agents.find(a => a.id === id).icon;

test('a star saved for claude is served with the three headers; the model gives claude its path and codex null', async t => {
  const { get } = await serve(t, { 'claude.svg': STAR });
  const r = await get('/api/v1/agent-icon/claude');
  assert.equal(r.status, 200);
  assert.equal(r.text, STAR);
  assert.equal(r.headers['content-type'], 'image/svg+xml');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  const board = await get('/api/v1/liveboard');
  assert.equal(board.status, 200);
  assert.deepEqual(validate(schemas['liveboard.schema.json'], JSON.parse(board.text), schemas), []);
  assert.match(iconOf(board, 'claude'), /\/agent-icon\/claude$/);
  assert.equal(iconOf(board, 'codex'), null);
  assert.equal((await get(iconOf(board, 'claude'))).status, 200);
});

test('with no folder content every agent icon is null and the route answers 404 not_found', async t => {
  const { get } = await serve(t);
  const board = await get('/api/v1/liveboard');
  assert.deepEqual([iconOf(board, 'claude'), iconOf(board, 'codex')], [null, null]);
  for (const agent of ['claude', 'nosuchagent']) {
    const r = await get(`/api/v1/agent-icon/${agent}`);
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.text).error.code, 'not_found');
  }
});

test('a file for an agent that is not configured is never served', async t => {
  const { get } = await serve(t, { 'stranger.svg': HEXAGON });
  assert.equal((await get('/api/v1/agent-icon/stranger')).status, 404);
});

test('names that are not agent ids answer 404 and read nothing outside the folder', async t => {
  const { get } = await serve(t, { 'claude.svg': STAR });
  for (const route of ['/api/v1/agent-icon/..', '/api/v1/agent-icon/', '/api/v1/agent-icon/a/b', '/api/v1/agent-icon/..%2Fsecret',
    '/api/v1/agent-icon/%2e%2e', '/api/v1/agent-icon/..%2F..%2Fsecret', '/api/v1/agent-icon/claude.svg', '/api/v1/agent-icon/secret']) {
    const r = await get(route);
    assert.equal(r.status, 404, route);
    assert.doesNotMatch(r.text, /<svg/, route);
  }
});

test('an unsafe file is answered 404, shows as null in the model, and is logged once per file change', async t => {
  const { get, root } = await serve(t, { 'claude.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>', 'codex.svg': HEXAGON });
  const lines = [];
  const original = console.error;
  console.error = line => lines.push(String(line));
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await get('/api/v1/agent-icon/claude')).status, 404);
    assert.equal(iconOf(await get('/api/v1/liveboard'), 'claude'), null);
    assert.equal(lines.filter(l => l.includes('claude.svg')).length, 1);
    fs.writeFileSync(path.join(root, 'agent-icons', 'claude.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    await get('/api/v1/agent-icon/claude');
    await get('/api/v1/agent-icon/claude');
  } finally { console.error = original; }
  assert.equal(lines.filter(l => l.includes('claude.svg')).length, 2);
  assert.equal(lines.filter(l => l.includes('codex.svg')).length, 0);
});

test('the file is read on each request: a change shows at once, with no stored copy', async t => {
  const { get, root } = await serve(t, { 'claude.svg': STAR });
  assert.equal((await get('/api/v1/agent-icon/claude')).text, STAR);
  fs.writeFileSync(path.join(root, 'agent-icons', 'claude.svg'), HEXAGON);
  assert.equal((await get('/api/v1/agent-icon/claude')).text, HEXAGON);
  fs.unlinkSync(path.join(root, 'agent-icons', 'claude.svg'));
  assert.equal((await get('/api/v1/agent-icon/claude')).status, 404);
  assert.equal(iconOf(await get('/api/v1/liveboard'), 'claude'), null);
});

test('an oversized file is refused by the route and the model', async t => {
  const { get } = await serve(t, { 'claude.svg': `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(20000)}--></svg>` });
  assert.equal((await get('/api/v1/agent-icon/claude')).status, 404);
  assert.equal(iconOf(await get('/api/v1/liveboard'), 'claude'), null);
});

test('the schema stays closed: an unknown field on an agent is a fault', async t => {
  const { get } = await serve(t);
  const body = JSON.parse((await get('/api/v1/liveboard')).text);
  body.data.agents[0].extra = 1;
  assert.notDeepEqual(validate(schemas['liveboard.schema.json'], body, schemas), []);
});
