// Delivery and persistence are separate outcomes (#1144). A delivered alert whose save then failed must not be sent again, a
// failing save raises one "cannot save state" alert per spell, and a channel that refused an alert is still retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { alertSender } from '../supervisor/alert.mjs';
import { stateSaver, SAVE_ALERT_PREFIX } from '../supervisor/statesave.mjs';

const NOW = Date.parse('2026-11-10T18:50:00Z'), HOUR = 3600000;
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
const REVIEWS_ONLY = { mode: 'reviews_only', reason: 'weekly 94%: remaining capacity at or below the reserve', until: NOW + 30 * HOUR, rule: 'high-water' };
const settle = () => new Promise(resolve => setImmediate(resolve));
// As the tick's guard(): a step that throws is recorded and the tick goes on.
const guarded = async step => { try { await step(); } catch (error) { return error; } return null; };

function world(t, { alert } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const send = alert || (async text => { sent.push(text); });
  const gh = { listPulls: async () => [], listIssues: async () => [], listMergedPulls: async () => [] };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [] }, git: {}, register: '',
    clock: { now: () => NOW }, timeZone: 'Europe/London', alert: send });
  team.modes = { codex: REVIEWS_ONLY };
  return { team, sent, dir };
}
const allowance = sent => sent.filter(text => text.startsWith('Allowance: codex'));
const saveAlerts = sent => sent.filter(text => text.startsWith(SAVE_ALERT_PREFIX));

test('a save that fails after a delivered allowance alert is a save failure, and the next tick sends no repeat', async t => {
  const w = world(t), logged = [];
  let writes = 0;
  const write = (file, value) => {
    writes++;
    if (writes === 2) throw new Error('disk said no');   // the save right after the alert was delivered
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  w.team.saveState = stateSaver({ file: w.team.file, alertOf: () => w.team.alert, write, log: line => logged.push(line) });
  const first = {};
  await w.team.updateBudget(first);
  assert.equal(allowance(w.sent).length, 1);
  assert.equal(w.team.s.budget.codex.alerted, true, 'marked sent in memory before the save');
  assert.deepEqual(first.skipped.map(s => s.what), ['alert allowance codex']);
  assert.match(first.skipped[0].reason, /^alert delivered; saving that it was sent failed: cannot save state .*state\.json: disk said no/);
  assert.doesNotMatch(first.skipped[0].reason, /delivery failed/);
  for (let tick = 0; tick < 3; tick++) await w.team.updateBudget({});
  await settle();
  assert.equal(allowance(w.sent).length, 1, 'no repeat on later ticks');
  w.team.save();
  assert.equal(JSON.parse(fs.readFileSync(w.team.file, 'utf8')).budget.codex.alerted, true, 'the next good save persists it');
  assert.ok(logged.some(line => /cannot save state .*state\.json: disk said no/.test(line)), 'the failure is logged with the file');
});

test('a save that keeps failing sends exactly one "cannot save state" alert across ticks, logs every failure, and re-arms after a good save', async t => {
  const w = world(t), errors = t.mock.method(console, 'error', () => {});
  const loop = {};
  loop.self = loop;
  w.team.s.unserialisable = loop;   // a value JSON.stringify cannot write: every save fails until it is removed
  for (let tick = 0; tick < 4; tick++) {
    w.team.modes = { codex: { ...REVIEWS_ONLY, until: NOW + (40 + tick) * HOUR } };   // a new until each tick: a real change, a real save
    await guarded(() => w.team.updateBudget({}));
    await settle();
  }
  const raised = saveAlerts(w.sent);
  assert.equal(raised.length, 1, 'one alert per failing spell');
  assert.match(raised[0], /^Foreman cannot save state: .*state\.json: Converting circular structure to JSON/);
  const lines = errors.mock.calls.map(c => String(c.arguments[0])).filter(line => line.startsWith('ai-supervisor: cannot save state'));
  assert.ok(lines.length >= 4, `every failed save is logged (${lines.length})`);
  delete w.team.s.unserialisable;
  w.team.save();
  w.team.s.unserialisable = loop;
  assert.throws(() => w.team.save(), /cannot save state/);
  await settle();
  assert.equal(saveAlerts(w.sent).length, 2, 'a good save ends the spell; the next failure alerts again');
});

test('a channel that refused the allowance alert is retried on the next tick', async t => {
  let calls = 0;
  const w = world(t, { alert: async () => { calls++; if (calls === 1) throw new Error('channel down'); } });
  const errors = t.mock.method(console, 'error', () => {});
  const first = {};
  await w.team.updateBudget(first);
  assert.equal(w.team.s.budget.codex.alerted, false);
  assert.equal(first.skipped[0].reason, 'alert delivery failed; will retry: channel down');
  assert.ok(errors.mock.calls.some(c => /alert allowance codex: alert delivery failed; will retry: channel down/.test(c.arguments[0])), 'logged');
  await w.team.updateBudget({});
  assert.equal(calls, 2);
  assert.equal(w.team.s.budget.codex.alerted, true);
  await w.team.updateBudget({});
  assert.equal(calls, 2, 'delivered once, never again');
});

test('allowance alerts are recorded in alerts.jsonl with their delivery result', async t => {
  const w = world(t);
  w.team.alert = alertSender(w.team.root, { alerts: { command: ['/bin/notify'] } }, { run: () => ({ status: 0 }), env: {} });
  await w.team.updateBudget({});
  const rows = fs.readFileSync(path.join(w.team.root, 'team', 'alerts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /^Allowance: codex: reviews only/);
  assert.equal(rows[0].delivered, true);
});

test('an alert log that cannot be written does not turn a delivered alert into a delivery failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'team'), 'a file where the team folder should be');
  const logged = [], runs = [];
  const send = alertSender(dir, { alerts: { command: ['/bin/notify'] } }, { run: (...a) => (runs.push(a), { status: 0 }), env: {}, log: l => logged.push(l) });
  await send('Allowance: codex: reviews only');
  assert.equal(runs.length, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^ai-supervisor: alert delivered but not recorded in team\/alerts\.jsonl: /);
});
