// Issue #1266: the web UI files under /api/v1/ui/ and the redirect from /api/v1/ui, through the real dashboard request handler.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';

const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const UI = new URL('../supervisor/ui/', import.meta.url);

async function serve(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ui1266-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  return (target, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host: `127.0.0.1:${port}` } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECURITY = ['content-security-policy', 'x-content-type-options'];

test('valid: the shell page is served as html with the security headers', async t => {
  const get = await serve(t);
  const res = await get('/api/v1/ui/index.html');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html; charset=utf-8/);
  for (const name of SECURITY) assert.ok(res.headers[name], `${name} is set`);
  // Issue #1288: the only difference from the file is the one proof meta element the route adds.
  assert.equal(res.body.replace(/<meta name="foreman-proof" content="[a-f0-9]{64}">\n/, ''), fs.readFileSync(new URL('index.html', UI), 'utf8'));
  assert.match(res.body, /id="appbar"/);
});

test('valid: the script, the module files and the style sheet have their content types', async t => {
  const get = await serve(t);
  const types = { 'app.mjs': /^text\/javascript/, 'client.mjs': /^text\/javascript/, 'status.mjs': /^text\/javascript/, 'appbar.mjs': /^text\/javascript/, 'app.css': /^text\/css/ };
  for (const [file, type] of Object.entries(types)) {
    const res = await get(`/api/v1/ui/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers['content-type'], type, file);
    assert.ok(res.headers['content-security-policy'], `${file} has the policy`);
    assert.equal(res.body, fs.readFileSync(new URL(file, UI), 'utf8'), file);
  }
});

test('boundary: HEAD answers the headers and no body', async t => {
  const get = await serve(t);
  const res = await get('/api/v1/ui/app.mjs', 'HEAD');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  assert.equal(res.body, '');
});

test('boundary: the path ui redirects to the shell page', async t => {
  const get = await serve(t);
  const res = await get('/api/v1/ui');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/api/v1/ui/index.html');
  const head = await get('/api/v1/ui', 'HEAD');
  assert.equal(head.status, 302);
  assert.equal(head.headers.location, '/api/v1/ui/index.html');
});

test('invalid: an unknown name, two dots in a row and a percent sign each answer 404 as JSON not_found', async t => {
  const get = await serve(t);
  for (const target of ['/api/v1/ui/nope.txt', '/api/v1/ui/..', '/api/v1/ui/a..b', '/api/v1/ui/%2e%2e', '/api/v1/ui/app%2emjs', '/api/v1/ui/index.html/extra', '/api/v1/ui/']) {
    const res = await get(target);
    assert.equal(res.status, 404, target);
    assert.match(res.headers['content-type'], /^application\/json/, target);
    assert.equal(JSON.parse(res.body).error.code, 'not_found', target);
  }
});

test('invalid: a method other than GET and HEAD is refused and nothing is served', async t => {
  const get = await serve(t);
  const res = await get('/api/v1/ui/index.html', 'POST');
  assert.notEqual(res.status, 200);
  assert.equal(JSON.parse(res.body).error.code.length > 0, true);
});

test('the page has no inline script and reads only paths under /api/v1/', () => {
  const html = fs.readFileSync(new URL('index.html', UI), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /https?:\/\//);
  for (const file of fs.readdirSync(UI).filter(name => name.endsWith('.mjs'))) {
    const code = fs.readFileSync(new URL(file, UI), 'utf8');
    assert.doesNotMatch(code, /https?:\/\//, `${file} makes no external request`);
    assert.doesNotMatch(code, /\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b/, file);
  }
});

test('valid: the live check for the board screen finds hopper in the served board.mjs (issue #1312)', async t => {
  const get = await serve(t);
  const res = await get('/api/v1/ui/board.mjs');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('hopper'));
});

test('valid: the live check for ball travel finds launch in the served boardmotion.mjs (issue #1313)', async t => {
  const get = await serve(t);
  const res = await get('/api/v1/ui/boardmotion.mjs');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('launch'));
});
