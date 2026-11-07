// Issue #853: a merged change that needs a local setting applies it at install; a host-specific value becomes one approval item.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, readIncidents, LOCAL_FILE } from '../supervisor/migrations.mjs';
import * as ls from '../supervisor/localsettings.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { validateTeamConfig, applyLocalOverride, reviewPrompt } from '../supervisor/team.mjs';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0), ORIGIN = 'https://agents.example.test';
const base = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
const validate = next => validateTeamConfig(applyLocalOverride(base, next));
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lset-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const put = (root, o) => fs.writeFileSync(path.join(root, LOCAL_FILE), typeof o === 'string' ? o : JSON.stringify(o));
const local = root => JSON.parse(fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8'));
const backups = root => fs.readdirSync(root).filter(f => f.includes('.bak-'));

test('a release that needs a new local key and ships a migration applies it at install, once', async t => {
  const root = tmp(t), dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '002-need-key.mjs'), "export const description = 'add a depends_on override'; export function migrate(l) { return { ...l, depends_on_overrides: { ...l.depends_on_overrides, 5: [] } }; }");
  put(root, { enabled: true });
  const r = await runMigrations({ root, dir, validate, now: NOW });
  assert.deepEqual(r.applied.map(a => a.number), [2]);
  assert.deepEqual(local(root).depends_on_overrides, { 5: [] });
  assert.equal(backups(root).length, 1);
  assert.deepEqual((await runMigrations({ root, dir, validate, now: NOW + 1 })).applied, []);   // never again
});

test('a migration that declares a host-specific setting yields exactly one item, however often install runs', async t => {
  const root = tmp(t), dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '002-origin.mjs'), "export const description = 'dashboard origin needs approval'; export const settings = [{ key: 'dashboard.allowed_origins', pr: 562 }, { nokey: 1 }]; export const migrate = l => l;");
  put(root, { enabled: true });
  const r = await runMigrations({ root, dir, validate, now: NOW });
  assert.deepEqual(r.applied[0].settings, [{ key: 'dashboard.allowed_origins', pr: 562 }]);
  for (const s of r.applied[0].settings) ls.raise(root, { ...s, now: NOW });
  ls.raise(root, { key: 'dashboard.allowed_origins', pr: 562, now: NOW + 5 });   // a second install pass
  assert.equal(ls.readItems(root).length, 1);
  assert.equal(ls.readItems(root)[0].state, 'awaiting');
  assert.equal(JSON.stringify(ls.readItems(root)).includes('example'), false, 'no host value is committed or invented');
  assert.equal(ls.cards(root).length, 0, 'no card until a value is known');
  assert.equal(readIncidents(root).filter(i => i.result === 'setting-raised').length, 1);
});

test('raise refuses an unknown key, a bad PR number and a bad value', t => {
  const root = tmp(t);
  assert.throws(() => ls.raise(root, { key: 'limits.overall', pr: 1 }), /unknown setting key/);
  assert.throws(() => ls.raise(root, { key: 'dashboard.allowed_origins', pr: 0 }), /pull request number/);
  assert.throws(() => ls.raise(root, { key: 'dashboard.allowed_origins', pr: 1, value: 'https://a.test/path' }), /not acceptable/);
  assert.equal(ls.readItems(root).length, 0);
});

test('the first valid refused Origin fills the item; later ones, bad shapes and the listen address do not', t => {
  const root = tmp(t); ls.raise(root, { key: 'dashboard.allowed_origins', pr: 562, now: NOW });
  for (const bad of ['null', undefined, '*', 'https://x.test/a', 'javascript:alert(1)', 'http://10.0.0.2:8731']) assert.equal(ls.observeOrigin(root, bad, { allowedHost: '10.0.0.2:8731' }), null, String(bad));
  assert.equal(ls.readItems(root)[0].state, 'awaiting');
  const id = ls.observeOrigin(root, ORIGIN, { now: NOW });
  assert.equal(id, ls.readItems(root)[0].id);
  assert.equal(ls.observeOrigin(root, 'https://other.example.test', { now: NOW }), null, 'the pending item is not replaced');
  assert.equal(ls.observeOrigin(root, ORIGIN), id, 'the same origin finds the same item');
  const [card] = ls.cards(root);
  assert.equal(card.title, `Apply setting dashboard.allowed_origins = ${ORIGIN} needed by PR #562`);
});

test('approving applies the value with a mode-600 backup and a parse check; the result is recorded', t => {
  const root = tmp(t); put(root, { enabled: true, dashboard: { allowed_origins: ['http://10.0.0.5:8731'] } });
  ls.raise(root, { key: 'dashboard.allowed_origins', pr: 562, now: NOW }); const id = ls.observeOrigin(root, ORIGIN, { now: NOW });
  assert.deepEqual(ls.applyApproved(root, { validate, now: NOW }), [], 'nothing is applied before approval');
  assert.equal(backups(root).length, 0);
  assert.equal(ls.decide(root, id, 'approve', NOW).ok, true);
  assert.equal(ls.decide(root, id, 'approve', NOW).ok, false, 'decided once');
  const [r] = ls.applyApproved(root, { validate, now: NOW + 1000 });
  assert.equal(r.ok, true);
  assert.deepEqual(local(root).dashboard.allowed_origins, ['http://10.0.0.5:8731', ORIGIN]);
  assert.equal(local(root).enabled, true);
  const [b] = backups(root); assert.equal(fs.statSync(path.join(root, b)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, b), 'utf8')), { enabled: true, dashboard: { allowed_origins: ['http://10.0.0.5:8731'] } });
  assert.equal(ls.find(root, id).state, 'applied');
  assert.ok(readIncidents(root).some(i => i.result === 'setting-applied'));
  assert.deepEqual(ls.applyApproved(root, { validate }), [], 'applied once');
});

test('reject changes nothing; an unparsable or invalid file is left untouched and the failure is recorded', t => {
  let root = tmp(t); put(root, { enabled: true });
  ls.raise(root, { key: 'dashboard.allowed_origins', pr: 1, now: NOW }); let id = ls.observeOrigin(root, ORIGIN);
  assert.equal(ls.decide(root, id, 'reject', NOW).ok, true);
  assert.deepEqual(ls.applyApproved(root, { validate }), []); assert.deepEqual(local(root), { enabled: true }); assert.equal(ls.find(root, id).state, 'rejected');
  root = tmp(t); put(root, '{ not json');
  ls.raise(root, { key: 'dashboard.allowed_origins', pr: 1, now: NOW }); id = ls.observeOrigin(root, ORIGIN); ls.decide(root, id, 'approve', NOW);
  assert.equal(ls.applyApproved(root, { validate })[0].ok, false);
  assert.equal(fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8'), '{ not json'); assert.equal(backups(root).length, 0);
  assert.equal(ls.find(root, id).state, 'failed');
  root = tmp(t); put(root, { enabled: true });
  ls.raise(root, { key: 'dashboard.allowed_origins', pr: 1, now: NOW }); id = ls.observeOrigin(root, ORIGIN); ls.decide(root, id, 'approve', NOW);
  assert.equal(ls.applyApproved(root, { validate: () => { throw new Error('invalid team config'); } })[0].ok, false);
  assert.deepEqual(local(root), { enabled: true }); assert.equal(backups(root).length, 0);
});

test('an item edited after approval is not applied', t => {
  const root = tmp(t); put(root, { enabled: true });
  ls.raise(root, { key: 'dashboard.allowed_origins', pr: 1, now: NOW }); const id = ls.observeOrigin(root, ORIGIN); ls.decide(root, id, 'approve', NOW);
  const f = path.join(root, 'team', 'local-settings.json'), s = JSON.parse(fs.readFileSync(f, 'utf8')); s.items[0].value = 'https://evil.example'; fs.writeFileSync(f, JSON.stringify(s));
  assert.equal(ls.applyApproved(root, { validate })[0].ok, false); assert.deepEqual(local(root), { enabled: true });
});

async function serve(t, root) {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port;
  server.on('request', handler({ root, config: base, host: '127.0.0.1', port, now: () => NOW }));
  const post = (p, origin, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end(body);
  });
  return { port, post, lan: `http://127.0.0.1:${port}` };
}

test('the refusal page links to the approval item for the awaited origin, and one click on the dashboard approves it', async t => {
  const root = tmp(t); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d));
  ls.raise(root, { key: 'dashboard.allowed_origins', pr: 562, now: NOW });
  const s = await serve(t, root), proof = `proof=${writeToken(root)}`;
  const other = await s.post('/mark-read', 'https://unrelated.example.test', `at=${NOW}&${proof}`);   // the first refused origin is the awaited one
  const id = ls.readItems(root)[0].id;
  assert.equal(other.status, 403); assert.match(other.body, new RegExp(`href="http://127\\.0\\.0\\.1:${s.port}/#att-inbox-${id}"`));
  const second = await s.post('/mark-read', 'https://second.example.test', `at=${NOW}&${proof}`);
  assert.equal(second.status, 403); assert.ok(!second.body.includes('waiting for your approval'), 'a different origin gets no link');
  const refused = await s.post('/inbox', 'https://unrelated.example.test', `id=${id}&decision=approve&${proof}`);   // approval from the refused origin is itself refused
  assert.equal(refused.status, 403); assert.equal(ls.find(root, id).state, 'pending');
  const bad = await s.post('/inbox', s.lan, `id=${id}&decision=approve&proof=${'0'.repeat(64)}`);
  assert.equal(bad.status, 403); assert.equal(ls.find(root, id).state, 'pending');
  const ok = await s.post('/inbox', s.lan, `id=${id}&decision=approve&${proof}`);
  assert.equal(ok.status, 303); assert.equal(ls.find(root, id).state, 'approved');
});

test('the review prompt makes a missing migration for a needed setting a blocking finding', () => {
  const p = reviewPrompt({ pr: 7, head: 'a'.repeat(40), branch: 'b', repository: 'o/r', inbox: '/x' });
  assert.match(p, /ship a numbered migration/); assert.match(p, /blocking finding/); assert.match(p, /Homeowner steps/);
});

test('homeownerSteps reads the list under the heading and stops at the next heading', () => {
  const body = '## Summary\ntext\n\n## Homeowner steps\n- [ ] Run `foo`\n- [x] Done thing\n1. Numbered\n\n## Tests\n- not a step\n';
  assert.deepEqual(ls.homeownerSteps(body), [{ text: 'Run `foo`', done: false }, { text: 'Done thing', done: true }, { text: 'Numbered', done: false }]);
  assert.deepEqual(ls.homeownerSteps('Homeowner steps are none'), []); assert.deepEqual(ls.homeownerSteps(null), []);
});
