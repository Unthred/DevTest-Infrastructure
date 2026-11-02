// Issue #153: config migrations on install. Real files in a temp state root; no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations, readMigrationState, readIncidents, LOCAL_FILE } from '../supervisor/migrations.mjs';
import { applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';

const shippedFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supervisor', 'team.json');
const realDir = path.join(path.dirname(shippedFile), 'migrations');
const shipped = () => JSON.parse(fs.readFileSync(shippedFile, 'utf8'));
const validate = next => validateTeamConfig(applyLocalOverride(shipped(), next));
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const mkMig = (dir, file, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), body); };
const local = root => JSON.parse(fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8'));
const put = (root, obj) => fs.writeFileSync(path.join(root, LOCAL_FILE), JSON.stringify(obj));
const backups = root => fs.readdirSync(root).filter(f => f.includes('.bak-'));
// a harmless overridable key records the order the steps ran in
const tag = n => `export const description = 'step ${n}'; export function migrate(l) { return { ...l, depends_on_overrides: { ...l.depends_on_overrides, ${n + 900}: [] } }; }`;
const order = root => Object.keys(local(root).depends_on_overrides || {}).map(k => Number(k) - 900);

test('pending migrations apply once, in order, with a mode-600 backup, state and an incident', async t => {
  const root = tmp(t), dir = path.join(root, 'm');
  mkMig(dir, '002-b.mjs', tag(2)); mkMig(dir, '001-a.mjs', tag(1));
  put(root, { enabled: true });
  const r = await runMigrations({ root, dir, validate, now: 1_800_000_000_000 });
  assert.deepEqual(r.applied.map(a => a.number), [1, 2]);
  assert.equal(r.failed, null);
  assert.deepEqual(order(root), [1, 2]); assert.equal(local(root).enabled, true);
  assert.equal(readMigrationState(root).applied, 2);
  const bs = backups(root); assert.equal(bs.length, 2);
  for (const b of bs) assert.equal(fs.statSync(path.join(root, b)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, bs.sort()[0]), 'utf8')), { enabled: true });   // the first backup holds the original
  const inc = readIncidents(root); assert.deepEqual(inc.map(i => [i.kind, i.result, i.number]), [['migration', 'applied', 1], ['migration', 'applied', 2]]);
  assert.equal(fs.statSync(path.join(root, 'team', 'incidents.jsonl')).mode & 0o777, 0o600);
});

test('an applied migration never re-runs after a reinstall (new code, same state root)', async t => {
  const root = tmp(t), dir = path.join(root, 'm');
  mkMig(dir, '001-a.mjs', tag(1)); put(root, {});
  await runMigrations({ root, dir, validate });
  const after = fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8');
  const again = await runMigrations({ root, dir, validate });
  assert.deepEqual(again.applied, []);
  assert.equal(fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8'), after);
  assert.equal(backups(root).length, 1);
  mkMig(dir, '002-b.mjs', tag(2));   // a later release adds one: only that runs
  assert.deepEqual((await runMigrations({ root, dir, validate })).applied.map(a => a.number), [2]);
  assert.deepEqual(order(root), [1, 2]);
});

test('negative: a throwing migration leaves the file unchanged, stops later ones and is recorded as failed', async t => {
  const root = tmp(t), dir = path.join(root, 'm');
  mkMig(dir, '001-a.mjs', tag(1));
  mkMig(dir, '002-bad.mjs', "export const description = 'bad'; export function migrate() { throw new Error('boom'); }");
  mkMig(dir, '003-c.mjs', tag(3));
  put(root, { enabled: true });
  const r = await runMigrations({ root, dir, validate });
  assert.deepEqual(r.applied.map(a => a.number), [1]);
  assert.equal(r.failed.number, 2); assert.equal(r.failed.name, 'bad'); assert.match(r.failed.error, /boom/);
  assert.deepEqual(order(root), [1]); assert.equal(local(root).enabled, true);   // only 001's result; 002 and 003 changed nothing
  const st = readMigrationState(root); assert.equal(st.applied, 1); assert.equal(st.failed.number, 2);
  assert.equal(readIncidents(root).at(-1).result, 'failed');
  await runMigrations({ root, dir, validate });   // the same failure on the next tick is not logged again
  assert.equal(readIncidents(root).filter(i => i.result === 'failed').length, 1);
});

test('negative: a result that fails validation is not written and no backup is made', async t => {
  const root = tmp(t), dir = path.join(root, 'm');
  mkMig(dir, '001-a.mjs', "export const description = 'breaks'; export function migrate(l) { return { ...l, bogus: 1 }; }");
  put(root, { enabled: true });
  const before = fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8');
  const r = await runMigrations({ root, dir, validate });
  assert.match(r.failed.error, /not overridable/);
  assert.equal(fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8'), before);
  assert.equal(backups(root).length, 0);
});

test('negative: unparsable team.local.json and a migration without a description both fail without touching the file', async t => {
  const root = tmp(t), dir = path.join(root, 'm');
  mkMig(dir, '001-a.mjs', tag(1));
  fs.writeFileSync(path.join(root, LOCAL_FILE), '{ nope');
  assert.match((await runMigrations({ root, dir, validate })).failed.error, /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8'), '{ nope');
  const dir2 = path.join(root, 'm2'); mkMig(dir2, '001-x.mjs', 'export function migrate(l) { return l; }');
  put(root, {});
  assert.match((await runMigrations({ root, dir: dir2, validate })).failed.error, /description/);
});

test('a failed migration is retried on the next tick once the file is fixed, and clears the failure', async t => {
  const root = tmp(t), dir = path.join(root, 'm');
  mkMig(dir, '001-a.mjs', tag(1));
  fs.writeFileSync(path.join(root, LOCAL_FILE), '{ nope');
  await runMigrations({ root, dir, validate });
  assert.ok(readMigrationState(root).failed);
  put(root, { enabled: false });
  assert.equal((await runMigrations({ root, dir, validate })).failed, null);
  assert.equal(readMigrationState(root).failed, null); assert.equal(readMigrationState(root).applied, 1);
});

test('no team.local.json: migrations are recorded as applied and no file or backup is created', async t => {
  const root = tmp(t), dir = path.join(root, 'm');
  mkMig(dir, '001-a.mjs', tag(1));
  const r = await runMigrations({ root, dir, validate });
  assert.equal(r.applied.length, 1);
  assert.equal(fs.existsSync(path.join(root, LOCAL_FILE)), false);
  assert.equal(readIncidents(root)[0].changed, false);
});

test('the shipped 001 removes limits.per_agent, so the shipped roles apply (one implementer)', async t => {
  const root = tmp(t);
  put(root, { enabled: true, limits: { per_agent: 2, max_fix_attempts: 3 } });
  assert.equal(validate(local(root)).limits.roles.implementer, 2);   // before: the old key overrides the roles' slot count
  const r = await runMigrations({ root, dir: realDir, validate });
  assert.deepEqual(r.applied.map(a => a.number), [1]);
  assert.deepEqual(local(root), { enabled: true, limits: { max_fix_attempts: 3 } });
  const cfg = validate(local(root));
  assert.deepEqual(cfg.limits.roles, shipped().limits.roles); assert.equal('per_agent' in cfg.limits, false);
  assert.equal(cfg.limits.roles.implementer, 1);
});

test('shipped 001 negative: per_agent stays when limits.roles is set locally; a file without per_agent is unchanged; limits empties away', async () => {
  const { migrate } = await import('../supervisor/migrations/001-drop-per-agent.mjs');
  const keep = { limits: { per_agent: 2, roles: { implementer: 2 } } };
  assert.deepEqual(migrate(keep), keep);
  const plain = { enabled: true, limits: { overall: 3 } }; assert.deepEqual(migrate(plain), plain);
  assert.deepEqual(migrate({ limits: { per_agent: 1 } }), {});
  const input = { limits: { per_agent: 1 } }; migrate(input); assert.deepEqual(input, { limits: { per_agent: 1 } });   // pure: input untouched
});

// ---- dashboard: Needs you and Activity
test('dashboard: a failed migration is a Needs you item naming it, and applied/failed migrations show in Activity; none when clean', async t => {
  const { buildView } = await import('../supervisor/dashboard.mjs');
  const root = tmp(t), dir = path.join(root, 'm'), NOW = Date.now();
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1] } } };
  const cache = { pulls: [], issues: [], tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 } };
  const build = () => buildView({ config: cfg, root, jobs: [], events: [], state: {}, cache, snapshots: [], now: NOW });
  mkMig(dir, '001-ok.mjs', tag(1)); put(root, {});
  await runMigrations({ root, dir, validate, now: NOW - 5000 });
  let v = await build();
  assert.equal(v.attention.some(a => a.id === 'migration-failed'), false);
  assert.ok(v.activity.some(r => /config migration 001-ok applied/.test(r.text)));
  mkMig(dir, '002-broken.mjs', "export const description = 'x'; export function migrate() { throw new Error('boom'); }");
  await runMigrations({ root, dir, validate, now: NOW - 1000 });
  v = await build();
  const item = v.panels.needsYou.find(a => a.id === 'migration-failed');
  assert.ok(item && item.severity === 'action' && /002-broken/.test(item.text) && /boom/.test(item.text));
  assert.equal(v.health.state, 'needs_you');
  assert.ok(v.activity.some(r => /002-broken failed: boom/.test(r.text)));
});
