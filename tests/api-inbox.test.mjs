// Issue #1255: GET /api/v1/inbox, driven through the real dashboard request handler with a temporary Inbox folder of status records written
// in the shape the store writes, and checked against the closed schema with the contract validator.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { hashOf } from '../supervisor/inbox.mjs';
import { reasonCodeOf, REASON_CODES } from '../supervisor/api/inbox-reasons.mjs';

const NOW = Date.UTC(2026, 10, 12, 13, 2, 0);
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = { 'common.schema.json': readSchema('common.schema.json'), 'inbox.schema.json': readSchema('inbox.schema.json') };
const baseConfig = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const idOf = n => n.toString(16).padStart(8, '0') + 'a'.repeat(24);
const DRIFT = 'Rules drift check read only Driftcheck';

// The 12 Nov counts: 354 records, 12 pending, 2 running, 281 done, 14 failed, 21 refused, 24 rejected.
const COUNTS = { pending: 12, running: 2, done: 281, failed: 14, refused: 21, rejected: 24 };
function records() {
  const out = [];
  let n = 1;
  for (const [state, count] of Object.entries(COUNTS)) {
    for (let i = 0; i < count; i += 1, n += 1) {
      const at = NOW - n * 60000;
      const rec = { id: idOf(n), state, kind: state === 'refused' ? null : 'prompt', createdAt: at, updatedAt: at, title: `Item ${n}` };
      if (state === 'failed') Object.assign(rec, { reason: 'the job ended failed', result: 'nothing was changed' });
      if (state === 'refused') rec.reason = 'title contains secret-shaped text';
      out.push(rec);
    }
  }
  out.find(r => r.state === 'done').title = DRIFT;
  return out;
}

async function serve(t, { statuses = [], inbox = true, itemFiles = [] } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1255-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', 'inbox/status', 'inbox/items']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const s of statuses) fs.writeFileSync(path.join(root, 'inbox', 'status', `${s.id}.json`), JSON.stringify(s));
  for (const f of itemFiles) fs.writeFileSync(path.join(root, 'inbox', 'items', `${f.id}.json`), JSON.stringify(f.item));
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const config = inbox ? { ...baseConfig, inbox: { dir: path.join(root, 'inbox') } } : baseConfig;
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  return (query = '') => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/v1/inbox${query}`, headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }));
    }).on('error', reject);
  });
}
async function ask(get, query) {
  const r = await get(query);
  assert.equal(r.status, 200);
  assert.deepEqual(validate(schemas['inbox.schema.json'], r.body, schemas), [], 'the reply validates against the closed schema');
  return r.body.data;
}

test('valid: the state filter waiting_for_approval returns the 12 waiting items and facets still count all 354 (12 Nov data)', async t => {
  const get = await serve(t, { statuses: records() });
  const data = await ask(get, '?state=waiting_for_approval&limit=500');
  assert.equal(data.items.length, 12);
  assert.ok(data.items.every(i => i.state === 'waiting_for_approval' && i.attention === 'homeowner'));
  assert.equal(data.page.total, 354);
  assert.equal(data.page.matched, 12);
  assert.deepEqual(data.facets.state, { waiting_for_approval: 12, running: 2, done: 281, failed: 14, refused: 21, rejected: 24 });
  assert.equal(Object.values(data.facets.state).reduce((a, b) => a + b, 0), data.page.total);
  assert.equal(data.facets.kind.prompt + data.facets.kind.unknown, 354);
  const raw = await get('?limit=1');
  assert.match(raw.text, /"facets"/);
});

test('valid: a withdrawn record is served as state withdrawn and validates against the closed schema (issue #1316)', async t => {
  const at = NOW - 60000;
  const rec = { id: idOf(900), state: 'withdrawn', kind: 'prompt', createdAt: at, updatedAt: at, title: 'Item withdrawn', reason: 'replaced by Item new', replacedBy: idOf(901) };
  const get = await serve(t, { statuses: [rec] });
  const data = await ask(get, '');
  assert.equal(data.items.find(i => i.full_id === rec.id).state, 'withdrawn');
});

test('valid: q finds the Driftcheck item by title, by 8 character id and by full id, case ignored', async t => {
  const get = await serve(t, { statuses: records() });
  const byTitle = await ask(get, '?q=driftcheck');
  assert.deepEqual(byTitle.items.map(i => [i.title, i.state]), [[DRIFT, 'done']]);
  const { id, full_id: full } = byTitle.items[0];
  assert.equal((await ask(get, `?q=${id.toUpperCase()}`)).items[0].full_id, full);
  assert.equal((await ask(get, `?q=${full}`)).page.matched, 1);
});

test('valid: the state names are served as the contract names, attention, proposer and the item fields are exact', async t => {
  const statuses = [
    { id: idOf(1), state: 'posting', kind: 'issue_draft', createdAt: NOW - 5, title: 'Posting one' },
    { id: idOf(2), state: 'approved', kind: 'prompt', createdAt: NOW - 4, decidedAt: NOW - 1000, decision: 'approve', title: 'Approved one' },
    { id: idOf(3), state: 'pending', kind: 'host_value', createdAt: NOW - 3, title: 'Waiting one' },
  ];
  const data = await ask(await serve(t, { statuses }), '');
  const by = id => data.items.find(i => i.full_id === idOf(id));
  assert.equal(by(1).state, 'running');
  assert.equal(by(3).state, 'waiting_for_approval');
  assert.equal(by(2).state, 'approved');
  assert.equal(by(2).undo_until, new Date(NOW - 1000 + 30000).toISOString());
  assert.equal(by(3).proposed_by, 'foreman');
  assert.equal(by(2).proposed_by, 'overseer');
  assert.equal(by(3).will_text, null, 'a waiting item whose content is no longer kept has null text');
  assert.deepEqual(Object.keys(by(1)).sort(), [
    'actions', 'attention', 'body_text', 'created_at', 'decided_at', 'full_id', 'id', 'job_id', 'kind', 'parked', 'proposed_by', 'reason_code',
    'reason_text', 'result_text', 'state', 'target', 'title', 'undo_until', 'why', 'will_text',
  ]);
});

test('valid: a refused or failed item has a code from the table and keeps its sentence; an unmatched sentence is other', async t => {
  const statuses = [
    { id: idOf(1), state: 'refused', kind: 'prompt', createdAt: NOW - 1, title: 'a', reason: '30 items are already waiting for approval; decide some first' },
    { id: idOf(2), state: 'failed', kind: 'prompt', createdAt: NOW - 2, title: 'b', reason: 'something nobody wrote a row for', job: 'abcdef01' },
    { id: idOf(3), state: 'failed', kind: 'action', createdAt: NOW - 3, title: 'c', reason: 'gh exploded' },
    { id: idOf(4), state: 'done', kind: 'prompt', createdAt: NOW - 4, title: 'd', reason: 'ignored on a done item' },
  ];
  const data = await ask(await serve(t, { statuses }), '');
  const by = id => data.items.find(i => i.full_id === idOf(id));
  assert.deepEqual([by(1).reason_code, by(1).reason_text], ['pending_cap', '30 items are already waiting for approval; decide some first']);
  assert.deepEqual([by(2).reason_code, by(2).reason_text, by(2).job_id], ['other', 'something nobody wrote a row for', 'abcdef01']);
  assert.equal(by(3).reason_code, 'action_failed');
  assert.deepEqual([by(4).reason_code, by(4).reason_text], [null, null]);
});

test('valid: every code of the table is reachable from a sentence the store writes', () => {
  const sentences = {
    pending_cap: '30 items are already waiting for approval; decide some first',
    masked_text: 'title contains text the dashboard would mask (an e-mail address)',
    secret_shaped: 'prompt contains secret-shaped text',
    attribution_text: 'body contains AI attribution text, which this project does not allow',
    malformed_prerequisite_line: 'more than one Depends on line; use exactly "Depends on: #N"',
    too_long: 'title is longer than 200 characters',
    unknown_kind: 'unknown kind (accepted: prompt)',
    item_changed: 'the item file changed after it was picked up',
    inbox_job_stopped: 'the job ended cancelled',
  };
  for (const [code, text] of Object.entries(sentences)) assert.equal(reasonCodeOf(text, { state: 'refused', kind: 'prompt' }), code);
  assert.equal(reasonCodeOf('x', { state: 'failed', kind: 'control' }), 'action_failed');
  assert.equal(reasonCodeOf(null), 'other');
  assert.deepEqual(REASON_CODES.slice().sort(), [...Object.keys(sentences), 'action_failed', 'other'].sort());
});

test('valid: a waiting item and a failed item list their actions, approve and reject enabled by the commands that exist, the rest not_built', async t => {
  const statuses = [
    { id: idOf(1), state: 'pending', kind: 'prompt', createdAt: NOW - 1, title: 'w' },
    { id: idOf(2), state: 'failed', kind: 'prompt', createdAt: NOW - 2, title: 'f', reason: 'x' },
    { id: idOf(3), state: 'done', kind: 'prompt', createdAt: NOW - 3, title: 'd' },
  ];
  const data = await ask(await serve(t, { statuses }), '');
  const by = id => data.items.find(i => i.full_id === idOf(id));
  assert.deepEqual(by(1).actions.map(a => a.command), ['inbox.approve', 'inbox.reject', 'inbox.park']);
  assert.deepEqual(by(2).actions.map(a => a.command), ['inbox.requeue', 'inbox.dismiss']);
  assert.deepEqual(by(3).actions, []);
  const unbuilt = [...by(1).actions.filter(a => a.command === 'inbox.park'), ...by(2).actions];   // issue #1257: approve and reject now exist
  for (const a of unbuilt) assert.deepEqual([a.enabled, a.tier, a.refusal_code], [false, 'person_only', 'not_built']);
  for (const a of by(1).actions.filter(a => a.command !== 'inbox.park')) assert.deepEqual([a.enabled, a.tier, a.refusal_code, a.input], [true, 'person_only', null, { id: by(1).id }]);
  assert.equal(by(1).attention, 'homeowner');
  assert.equal(by(2).attention, 'fault');
});

test('valid: a waiting action item shows its text and a target ref; a prompt item has no target', async t => {
  const action = { kind: 'action', title: 'Stop the job', action: 'stop_job', target: 'abcdef01', reason: 'it is stuck' };
  const prompt = { kind: 'prompt', title: 'Read it', prompt: 'Look at the rules.', why: 'to see' };
  const mk = (n, item) => ({ id: idOf(n), state: 'pending', kind: item.kind, hash: hashOf(item), createdAt: NOW - n, title: item.title });
  const statuses = [mk(1, action), mk(2, prompt)];
  const itemFiles = [{ id: idOf(1), item: action }, { id: idOf(2), item: prompt }];
  const data = await ask(await serve(t, { statuses, itemFiles }), '');
  const by = n => data.items.find(i => i.full_id === idOf(n));
  assert.deepEqual(by(1).target, { kind: 'job', key: 'abcdef01', label: 'Job abcdef01', title: null, source: null, project: null, url: null });
  assert.match(by(1).will_text, /Stop this running or paused job/);
  assert.match(by(1).body_text, /^stop_job abcdef01/);
  assert.equal(by(2).target, null);
  assert.equal(by(2).why, 'to see');
  assert.equal(by(2).body_text, 'Look at the rules.');
});

test('boundary: limit 1 returns one item and following next_cursor returns every matched item once', async t => {
  const get = await serve(t, { statuses: records() });
  for (const sort of ['newest', 'oldest']) {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const data = await ask(get, `?limit=100&sort=${sort}${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...data.items.map(i => i.full_id));
      cursor = data.page.next_cursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 4);
    assert.equal(seen.length, 354);
    assert.equal(new Set(seen).size, 354);
  }
  const first = await ask(get, '?limit=1');
  assert.equal(first.items.length, 1);
  assert.equal(first.page.returned, 1);
  assert.equal(typeof first.page.next_cursor, 'string');
  const small = await ask(get, '?limit=1&state=running');
  const second = await ask(get, `?limit=1&state=running&cursor=${small.page.next_cursor}`);
  assert.equal(second.page.next_cursor, null);
  assert.notEqual(second.items[0].full_id, small.items[0].full_id);
  const newest = await ask(get, '?limit=2');
  assert.ok(newest.items[0].created_at > newest.items[1].created_at);
});

test('boundary: an empty Inbox gives zero counts and a null cursor', async t => {
  const data = await ask(await serve(t), '');
  assert.deepEqual(data, { facets: { state: {}, kind: {} }, page: { total: 0, matched: 0, returned: 0, next_cursor: null }, items: [] });
});

test('invalid: an unknown state or kind value gives an empty page with 200, and a bad cursor an empty page', async t => {
  const get = await serve(t, { statuses: records() });
  const unknown = await ask(get, '?state=bogus');
  assert.deepEqual([unknown.items.length, unknown.page.matched, unknown.page.total, unknown.page.next_cursor], [0, 0, 354, null]);
  assert.equal((await ask(get, '?kind=bogus')).page.matched, 0);
  assert.equal((await ask(get, '?state=done,bogus')).page.matched, 281);
  const bad = await ask(get, '?cursor=not-a-cursor');
  assert.deepEqual([bad.items.length, bad.page.next_cursor], [0, null]);
});

test('invalid: limit 0 and limit 9999 are brought into range, and a non-number gets the default', async t => {
  const get = await serve(t, { statuses: records() });
  assert.equal((await ask(get, '?limit=0')).page.returned, 1);
  assert.equal((await ask(get, '?limit=-5')).page.returned, 1);
  assert.equal((await ask(get, '?limit=9999')).page.returned, 354);
  assert.equal((await ask(get, '?limit=abc')).page.returned, 50);
  assert.equal((await ask(get, '')).page.returned, 50);
});

test('invalid: no Inbox configured gives empty lists, not an error', async t => {
  const data = await ask(await serve(t, { statuses: records(), inbox: false }), '');
  assert.deepEqual([data.page.total, data.items, data.facets], [0, [], { state: {}, kind: {} }]);
});

test('the schema is closed: an extra field in an item or in data is reported', async t => {
  const body = (await (await serve(t, { statuses: records().slice(0, 1) }))('')).body;
  const bad = structuredClone(body);
  bad.data.items[0].extra = 1;
  bad.data.surprise = 1;
  const errors = validate(schemas['inbox.schema.json'], bad, schemas);
  assert.ok(errors.some(e => e.includes('extra')) && errors.some(e => e.includes('surprise')), errors.join('\n'));
});
