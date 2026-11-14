// Issue #1344: sending an alert and saving that it was sent are reported apart. Every test drives a Team on a temp state root
// through its budget update (the allowance alert) or its fix limit notice, never the helper alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { alertSender } from '../supervisor/alert.mjs';

const HEAD = 'a'.repeat(40);
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [6] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
// The allowance mode change from issue #1144: codex is limited to reviews until Thursday 04:04 at 94% of the week.
const MODES = { codex: { mode: 'reviews_only', reason: 'weekly 94%', until: Date.parse('2026-11-12T04:04:00Z'), rule: null } };
const ALLOWANCE = /Allowance: codex: .*weekly 94%/;
// PR #1146 itself: its third review round left it rejected at the fix limit.
const PR1146 = { number: 1146, title: 'Separate alert delivery from saving', headRefName: 'claude/issue-1144-alert-save-hardening', headRefOid: HEAD, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [] };

function world(t, { alert } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'alert-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = stateRoot(path.join(dir, 'state'));
  const sent = [];
  const printed = [];
  const realError = console.error;
  t.mock.method(console, 'error', (...args) => { printed.push(args.join(' ')); });
  t.after(() => { console.error = realError; });
  const channel = { fail: 0 };
  const send = alert || (async text => {
    if (channel.fail > 0) { channel.fail--; throw new Error('channel refused'); }
    sent.push(text);
  });
  const gh = { listPulls: async () => [PR1146], comment: async () => {}, addLabel: async () => {}, board: async () => {}, listIssues: async () => [], getPull: async () => PR1146 };
  const team = new Team({ config: cfg, root, gh, jobs: { listActive: async () => [] }, git: {}, register: '', clock: { now: () => Date.parse('2026-11-10T22:00:00Z') }, alert: send });
  team.modes = MODES;
  // Fail the state write while the switch is on: the temp file is renamed onto state.json by the real save.
  const disk = { failing: false, failOnce: false };
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === team.file && (disk.failing || disk.failOnce)) { disk.failOnce = false; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); }
    return realRename(from, to);
  });
  const stored = () => JSON.parse(fs.readFileSync(team.file, 'utf8'));
  const allowances = () => sent.filter(text => ALLOWANCE.test(text));
  return { team, sent, printed, channel, disk, stored, allowances, root };
}
const rejectAtLimit = team => {
  team.s.fixAttempts[`1146:${HEAD}`] = 2;
  team.s.unblock.escalated[1146] = { head: HEAD, at: 1 };
  team.s.verdicts[`1146:${HEAD}`] = { verdict: 'CHANGES', reviewer: 'codex' };
};
const fixLimitAlerts = w => w.sent.filter(text => /still rejected/.test(text));

test('valid: delivery and save succeed, one allowance alert, the mark is saved, a second run sends nothing', async t => {
  const w = world(t);
  const report = {};
  await w.team.updateBudget(report);
  assert.equal(w.allowances().length, 1);
  assert.equal(w.stored().budget.codex.alerted, true);
  assert.equal(report.skipped, undefined);
  await w.team.updateBudget({});
  assert.equal(w.allowances().length, 1);
});

test('valid: the fix limit alert for PR #1146 is sent once and its mark is saved', async t => {
  const w = world(t);
  rejectAtLimit(w.team);
  await w.team.notifyFixLimit({});
  await w.team.notifyFixLimit({});
  assert.equal(fixLimitAlerts(w).length, 1);
  assert.match(fixLimitAlerts(w)[0], /#1146|PR 1146|1146/);
  assert.ok(w.stored().notified['fixlimit-alert:1146']);
});

test('boundary: a save that fails right after a delivered allowance alert is a save failure, nothing is re-sent, the next good save stores the mark', async t => {
  const w = world(t);
  const report = {};
  // The first save (the mode change) succeeds; the one that records the alert fails.
  const realSave = w.team.save.bind(w.team);
  let saves = 0;
  w.team.save = () => { if (++saves === 2) w.disk.failOnce = true; realSave(); };
  await w.team.updateBudget(report);
  assert.equal(w.allowances().length, 1);
  const skipped = report.skipped.find(s => s.what === 'alert allowance codex');
  assert.match(skipped.reason, /^alert delivered; saving that it was sent failed: .*ENOSPC/);
  assert.doesNotMatch(skipped.reason, /delivery failed/);
  assert.ok(w.printed.some(line => /alert delivered; saving that it was sent failed/.test(line)));
  for (let i = 0; i < 3; i++) await w.team.updateBudget({});
  assert.equal(w.allowances().length, 1);
  w.team.save();
  assert.equal(w.stored().budget.codex.alerted, true);
});

test('boundary: a save that fails after the fix limit alert is a save failure and the alert is not re-sent', async t => {
  const w = world(t);
  rejectAtLimit(w.team);
  const report = {};
  const realSave = w.team.save.bind(w.team);
  let failed = false;
  w.team.save = () => { if (fixLimitAlerts(w).length && !failed) { failed = true; w.disk.failOnce = true; } realSave(); };
  await w.team.notifyFixLimit(report);
  assert.match(report.skipped.find(s => s.what === 'alert fix-limit 1146').reason, /alert delivered; saving that it was sent failed/);
  await w.team.notifyFixLimit({});
  await w.team.notifyFixLimit({});
  assert.equal(fixLimitAlerts(w).length, 1);
});

test('invalid: a refused allowance alert is a delivery failure with the error, marks nothing, is retried once and then never again', async t => {
  const w = world(t);
  w.channel.fail = 1;
  const report = {};
  await w.team.updateBudget(report);
  const skipped = report.skipped.find(s => s.what === 'alert allowance codex');
  assert.match(skipped.reason, /^alert delivery failed; will retry: channel refused/);
  assert.ok(w.printed.some(line => /alert allowance codex: alert delivery failed; will retry: channel refused/.test(line)));
  assert.equal(w.stored().budget.codex.alerted, false);
  assert.equal(w.allowances().length, 0);
  await w.team.updateBudget({});
  assert.equal(w.allowances().length, 1);
  await w.team.updateBudget({});
  assert.equal(w.allowances().length, 1);
  assert.equal(w.stored().budget.codex.alerted, true);
});

test('invalid: a refused fix limit alert is retried on the next tick and then sent once', async t => {
  const w = world(t);
  rejectAtLimit(w.team);
  w.channel.fail = 1;
  const report = {};
  await w.team.notifyFixLimit(report);
  assert.match(report.skipped.find(s => s.what === 'alert fix-limit 1146').reason, /alert delivery failed; will retry: channel refused/);
  assert.equal(fixLimitAlerts(w).length, 0);
  await w.team.notifyFixLimit({});
  await w.team.notifyFixLimit({});
  assert.equal(fixLimitAlerts(w).length, 1);
});

test('alerts with no sent mark: a refused unblock limit alert is reported with its reason, not dropped', async t => {
  const w = world(t);
  w.channel.fail = 1;
  const report = {};
  await w.team.raiseUnblockLimit(report, 1146, { key: 'day', text: 'the daily limit of 3 unblocks' }, 'pull');
  assert.match(report.skipped.find(s => s.what === 'alert unblock limit').reason, /alert delivery failed: channel refused/);
});

test('breaker: a failing breaker save puts the save error message on the report breaker entry', async t => {
  const w = world(t);
  w.disk.failing = true;
  const report = {};
  w.team.breakerFailed(new Error('breaker tripped'), report);
  assert.equal(report.breaker.error, 'breaker tripped');
  assert.match(report.breaker.saveError, /ENOSPC/);
});

test('alert log: allowance alerts are written to the alert log with their delivery result', async t => {
  const w = world(t, { alert: null });
  const log = line => w.printed.push(line);
  let config = { alerts: { command: ['/bin/false'] } };
  w.team.alert = alertSender(w.root, config, { log });
  const report = {};
  await w.team.updateBudget(report);
  config = { alerts: { command: ['/bin/cat'] } };
  w.team.alert = alertSender(w.root, config, { log, run: () => ({ status: 0 }) });
  await w.team.updateBudget({});
  const rows = fs.readFileSync(path.join(w.root, 'team', 'alerts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(r => r.delivered), [false, true]);
  assert.match(rows[0].text, ALLOWANCE);
  assert.match(rows[0].error, /alert command failed/);
  assert.equal(w.stored().budget.codex.alerted, true);
});
