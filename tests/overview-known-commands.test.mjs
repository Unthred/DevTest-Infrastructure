// Issue #1282: the overview model enables a control when its command is exported by a loaded route module.
// Driven through the real contract router with the real models folder; the routes folder is the real one or a prepared one.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../supervisor/api/router.mjs';
import { validate } from '../supervisor/api/validate.mjs';

const API = new URL('../supervisor/api/', import.meta.url);
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = {};
for (const f of ['common', 'appbar', 'overview']) schemas[`${f}.schema.json`] = readSchema(`${f}.schema.json`);
const item = { id: 'fixlimit-1192', text: 'Pull request 1192 is at the fix limit.', ref: { kind: 'pull', n: 1192 }, since: NOW - 60000 };
const view = { panels: { needsYou: [item] } };
const CONTROLS = ['work_item.allow_fix_round', 'work_item.accept_split', 'work_item.park'];

// A routes folder holding one module; `commands` is written as source so a non-list value can be tried.
function routesFolder(commandsSource) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1282-'));
  removeLater(dir);
  const lines = [
    "export const name = 'fake';",
    "export const method = 'GET';",
    "export const path = 'fake';",
    'export const handle = () => {};',
    `export const commands = ${commandsSource};`,
  ];
  fs.writeFileSync(path.join(dir, 'fake.mjs'), lines.join('\n'));
  return new URL(`file://${dir}/`);
}

async function overview(t, routesDir) {
  const api = createApiRouter({
    modelsDir: new URL('models/', API), routesDir, schemasDir: new URL('schemas/', API), headers: {}, allowedHost: 'h', now: () => NOW,
    tickAt: () => NOW, staleAfterMs: 1e9, coreVersion: () => 'x', getView: async () => view, root: os.tmpdir(), getConfig: () => ({}), guard: {},
  });
  const server = http.createServer((req, res) => api.handle(req, res, '/api/v1/overview'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const reply = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, headers: { host: 'h' } }, res => {
    let text = '';
    res.on('data', d => (text += d));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
  }).on('error', reject));
  assert.equal(reply.status, 200);
  assert.deepEqual(validate(schemas['overview.schema.json'], reply.body, schemas), [], 'the answer passes the overview schema');
  const found = reply.body.data.needs_you.find(i => i.id === 'fixlimit-1192');
  assert.ok(found, 'the item is a Needs you item');
  return Object.fromEntries(found.actions.map(a => [a.command, a]));
}

const refusalOf = c => ({ enabled: c.enabled, refusal_code: c.refusal_code, refusal_text: c.refusal_text });
const NOT_BUILT = { enabled: false, refusal_code: 'not_built', refusal_text: 'This control is not built yet.' };

test('controls whose command a route module exports are enabled, the rest stay not built', async t => {
  const controls = await overview(t, routesFolder("[{ name: 'work_item.park' }, { name: 'work_item.allow_fix_round' }]"));
  assert.deepEqual(Object.keys(controls).sort(), [...CONTROLS].sort());
  for (const c of ['work_item.park', 'work_item.allow_fix_round']) {
    assert.equal(controls[c].enabled, true);
    assert.equal(controls[c].refusal_code, null);
    assert.equal(controls[c].refusal_text, null);
  }
  assert.deepEqual(refusalOf(controls['work_item.accept_split']), NOT_BUILT);
});

test('the real routes folder: a control is enabled exactly when an installed route module exports its command', async t => {
  const installed = new Set();
  for (const f of fs.readdirSync(new URL('routes/', API)).filter(x => x.endsWith('.mjs'))) {
    const mod = await import(new URL(`routes/${f}`, API));
    for (const c of Array.isArray(mod.commands) ? mod.commands : []) installed.add(c.name);
  }
  const controls = await overview(t, new URL('routes/', API));
  for (const c of CONTROLS) {
    if (installed.has(c)) assert.equal(controls[c].enabled, true);
    else assert.deepEqual(refusalOf(controls[c]), NOT_BUILT);
  }
});

test('a commands export that is not a list leaves every control disabled', async t => {
  const controls = await overview(t, routesFolder("'work_item.park'"));
  for (const c of CONTROLS) assert.equal(controls[c].enabled, false);
});

test('a context with no routes leaves every control disabled', async t => {
  const controls = await overview(t, new URL('missing-routes/', API));
  for (const c of CONTROLS) assert.equal(controls[c].enabled, false);
});

test('the overview model holds no command name as a literal', () => {
  const source = fs.readFileSync(new URL('models/overview.mjs', API), 'utf8');
  assert.doesNotMatch(source, /work_item\.|inbox\.\w+/);
});
