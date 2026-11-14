// Issue #1342: one "Foreman cannot save state" alert per failing spell, across ticks. Each tick is a fresh Team on the same root,
// as the command line builds one, and every test calls the Team's own save method.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { SAVE_ALERT_PREFIX, MARKER_NAME } from '../supervisor/statesave.mjs';

const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
const settle = () => new Promise(resolve => setImmediate(resolve));

function world(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'state-save-alert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = stateRoot(path.join(dir, 'state'));
  const sent = [];
  const logged = [];
  const realError = console.error;
  t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });
  t.after(() => { console.error = realError; });
  const tick = (alert = async text => { sent.push(text); }) => new Team({ config: cfg, root, gh: {}, jobs: { listActive: async () => [] }, git: {},
    register: '', clock: { now: () => Date.parse('2026-11-14T10:00:00Z') }, alert });
  const marker = path.join(root, 'team', MARKER_NAME);
  return { tick, sent, logged, marker, root };
}
// A full disk: the state write throws ENOSPC; the marker write (it carries firstFailureAt) is unaffected unless markerToo.
function fullDisk(t, { markerToo = false } = {}) {
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
    if (markerToo || !String(data).includes('firstFailureAt')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return real(file, data, ...rest);
  });
}
const failing = team => assert.throws(() => team.save(), /cannot save state .*state\.json: ENOSPC/);

test('a good save writes the state, leaves no marker and sends nothing', async t => {
  const w = world(t);
  const team = w.tick();
  team.save();
  await settle();
  assert.ok(fs.existsSync(team.file));
  assert.equal(fs.existsSync(w.marker), false);
  assert.deepEqual(w.sent, []);
});

test('four ticks, each a fresh Team on one root, with a write that always throws ENOSPC, send exactly one alert', async t => {
  const w = world(t);
  fullDisk(t);
  for (let n = 0; n < 4; n++) { failing(w.tick()); await settle(); }
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0].startsWith(SAVE_ALERT_PREFIX));
  assert.match(w.sent[0], /state\.json: ENOSPC/);
  const marker = JSON.parse(fs.readFileSync(w.marker, 'utf8'));
  assert.equal(marker.firstFailureAt, Date.parse('2026-11-14T10:00:00Z'));
  assert.match(marker.message, /ENOSPC/);
  assert.equal(w.logged.filter(line => /cannot save state .*state\.json: ENOSPC/.test(line)).length, 4, 'every failed save is printed');
});

test('fail, fail on a second Team, good save on a third, fail on a fourth: two alerts in total', async t => {
  const w = world(t);
  const real = fs.writeFileSync;
  let failNow = true;
  t.mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
    if (failNow && !String(data).includes('firstFailureAt')) throw new Error('ENOSPC: no space left on device, write');
    return real(file, data, ...rest);
  });
  failing(w.tick()); await settle();
  failing(w.tick()); await settle();
  assert.equal(w.sent.length, 1);
  failNow = false;
  w.tick().save();
  assert.equal(fs.existsSync(w.marker), false, 'a good save removes the marker');
  failNow = true;
  failing(w.tick()); await settle();
  assert.equal(w.sent.length, 2);
});

test('a circular state fails every save; the printed line carries the JSON error and the file', async t => {
  const w = world(t);
  const first = w.tick();
  first.s.loop = first.s;
  assert.throws(() => first.save(), /cannot save state .*state\.json: .*circular/i);
  await settle();
  assert.ok(w.logged.some(line => /cannot save state .*state\.json: .*circular/i.test(line)));
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /state\.json/);
});

test('an alert that is not delivered removes the marker and the next failure on a new Team sends it', async t => {
  const w = world(t);
  fullDisk(t);
  failing(w.tick(async () => { throw new Error('channel down'); }));
  await settle();
  assert.equal(fs.existsSync(w.marker), false);
  assert.ok(w.logged.some(line => /alert was not delivered: channel down/.test(line)));
  failing(w.tick()); await settle();
  assert.equal(w.sent.length, 1);
  assert.equal(fs.existsSync(w.marker), true);
});

test('a marker that cannot be written is printed and each process alerts at most once', async t => {
  const w = world(t);
  fullDisk(t, { markerToo: true });
  const team = w.tick();
  for (let n = 0; n < 3; n++) { failing(team); await settle(); }
  failing(w.tick()); await settle();
  assert.equal(w.sent.length, 1, 'later saves in this process, even on a new Team, send nothing more');
  assert.ok(w.logged.some(line => /cannot write .*state-save-failed\.json, so this process alerts at most once/.test(line)));
  assert.equal(fs.existsSync(w.marker), false);
});
