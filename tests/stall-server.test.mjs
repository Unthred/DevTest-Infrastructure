// Issue #1222: the Stalled card through the real dashboard request handler, on GET / and GET /api/view.json.
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { handler } from '../supervisor/dashserver.mjs';
import { NOW, config, jobRecord, writeRoot } from './helpers/stall-fixture.mjs';

const statfs = () => ({ bavail: 5e8, blocks: 1e9, bsize: 4096 });

async function serve(t, extraJobs) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stall-srv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRoot(root, extraJobs);
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config: config(root), host: '127.0.0.1', port, now: () => NOW, statfs }));
  return p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => {
    let body = '';
    res.on('data', d => (body += d));
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
}

test('GET / and GET /api/view.json show the Stalled card, both marks and the pill marker for the 12 Nov data', async t => {
  const get = await serve(t, []);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('DevTest team'));
  assert.ok(page.body.includes('id="c-stalled"'));
  assert.ok(page.body.includes('fix PR #1180') && page.body.includes('db849b9f') && page.body.includes('Waiting for you'));
  for (const n of ['claude', 'codex']) assert.ok(page.body.includes(`data-stall-mark="${n}"`));
  assert.ok(page.body.includes('data-pill-stall'));
  const api = await get('/api/view.json');
  assert.equal(api.status, 200);
  const view = JSON.parse(api.body);
  assert.equal(view.stall.stalled, true);
  assert.deepEqual(view.stall.waiting.map(w => [w.type, w.ref]), [['rebase', 1180]]);
});

test('GET / and GET /api/view.json show no card or mark once a running job is added for each agent', async t => {
  const running = (id, provider) => jobRecord(id, provider, { status: 'running', createdAt: NOW - 60000, updatedAt: NOW - 1000 });
  const get = await serve(t, [running('e'.repeat(32), 'claude'), running('f'.repeat(32), 'codex')]);
  const page = await get('/');
  assert.equal(page.status, 200);
  for (const s of ['id="c-stalled"', 'data-stall-mark', 'data-pill-stall']) assert.equal(page.body.includes(s), false, s);
  const view = JSON.parse((await get('/api/view.json')).body);
  assert.equal(view.stall.stalled, false);
});
