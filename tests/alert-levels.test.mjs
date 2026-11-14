// Issue #1421: every alert has a level and only an alert that needs the homeowner or reports a problem reaches the phone.
// Real data: the info alert of 14 Nov 2026 07:38 UTC and the fix-limit alert for PR #1324 of 13 Nov 2026 23:01 UTC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alertSender, alertRoute, validateAlertsConfig } from '../supervisor/alert.mjs';
import { alertsView } from '../supervisor/alertsview.mjs';
import { SelfUpgrade } from '../supervisor/upgrade.mjs';
import { alertThenRecord } from '../supervisor/alertflow.mjs';

const SHA = '290d58f4a1b2c3d4e5f60718293a4b5c6d7e8f90';
const UPGRADED = 'Supervisor upgraded to 290d58f (PR #1412 Dispatcher chooses the agent for implement and repair slots).';
const FIX_LIMIT = 'Needs the homeowner: PR #1324 is still rejected after 3 fix rounds. Decision needed.';
const unraid = extra => ({ alerts: { channel: 'unraid', ...extra } });

function setup(t, status = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-levels-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], logged = [];
  const run = (program, args, options) => { calls.push({ program, args, input: options.input }); return { status }; };
  const sender = config => alertSender(root, config, { notify: '/opt/notify', run, env: {}, log: l => logged.push(l) });
  const rows = () => fs.readFileSync(path.join(root, 'team', 'alerts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { root, calls, logged, sender, rows };
}
const subject = call => call.args[call.args.indexOf('-s') + 1];

test('the upgraded notice of 14 Nov is recorded as info and the notify program is not run, through the real upgrade step', async t => {
  const w = setup(t), send = w.sender(unraid());
  const H = n => String(n).repeat(40);
  const state = { installed: H('a') };
  const deps = {
    config: { agents: { claude: { branch_prefix: 'claude/' }, codex: { branch_prefix: 'codex/' } } }, independenceApproved: () => true,
    installed: () => state.installed, fetchMain: () => SHA, isAncestor: () => true, changedFiles: () => ['supervisor/team.mjs'],
    mainCommits: () => [{ sha: H('c'), pr: 1412, head: H('d') }],
    mergedPull: async () => ({ state: 'MERGED', headRefName: 'claude/issue-9-x', headRefOid: H('d'), statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    verdict: () => ({ verdict: 'PASS', reviewer: 'codex' }), activeJobs: async () => 0,
    names: async () => ({ pr: () => ({ text: 'PR #1412 Dispatcher chooses the agent for implement and repair slots' }) }),
    preChecks: async () => ({ ok: true }), upgrade: async () => ({ ok: true }), dryRunTick: async () => ({ ok: true }), alert: send,
  };
  const up = new SelfUpgrade({ root: path.join(w.root, 'up'), deps, clock: { now: () => 10_000_000 }, log: () => {} });
  assert.equal(await up.step(), 'upgraded');
  assert.equal(w.calls.length, 0, 'an info alert never starts the notify program');
  const row = w.rows().at(-1);
  assert.equal(row.text, UPGRADED);
  assert.equal(row.level, 'info');
  assert.equal(row.delivered, false);
  assert.match(row.skipped, /level info is not in alerts\.notify_levels/);
  assert.equal('error' in row, false, 'not a delivery failure');
  assert.deepEqual(w.logged, []);
});

test('the fix-limit alert for PR #1324 is still sent with the subject Tower | Foreman needs you', async t => {
  const w = setup(t);
  const team = { alert: w.sender(unraid()), save() {} }, report = {};
  assert.equal(await alertThenRecord(team, { report, what: 'alert fix-limit 1324', text: FIX_LIMIT, sent: () => {} }), true);
  assert.equal(w.calls.length, 1);
  assert.equal(subject(w.calls[0]), 'Tower | Foreman needs you');
  assert.ok(!w.calls[0].args.includes('Tower | Agents need the homeowner'));
  assert.equal(w.rows().at(-1).level, 'action');
  assert.equal(w.rows().at(-1).delivered, true);
});

test('a problem alert is sent with its own subject, and the level reaches a custom command as the first input line', async t => {
  const w = setup(t);
  await w.sender(unraid())('Foreman MCP server not updated', { level: 'problem' });
  assert.equal(subject(w.calls[0]), 'Tower | Foreman problem');
  assert.equal(w.rows().at(-1).level, 'problem');
  await w.sender({ alerts: { command: ['/bin/notify-x', 'a'] } })('hello', { level: 'problem' });
  assert.deepEqual([w.calls[1].program, w.calls[1].args, w.calls[1].input], ['/bin/notify-x', ['a'], 'problem\nhello']);
  assert.equal(alertRoute({ command: ['/bin/x'] }, 'hello').input, 'action\nhello', 'no level means action');
});

test('boundary: no level is action; notify_levels action only skips but records a problem; an empty list sends nothing', async t => {
  const w = setup(t);
  await w.sender(unraid())('plain');
  assert.equal(w.rows().at(-1).level, 'action');
  assert.equal(w.calls.length, 1);
  const onlyAction = w.sender(unraid({ notify_levels: ['action'] }));
  await onlyAction('a problem', { level: 'problem' });
  assert.equal(w.calls.length, 1, 'the problem alert was not sent');
  assert.deepEqual([w.rows().at(-1).level, w.rows().at(-1).delivered], ['problem', false]);
  await onlyAction('needs you', { level: 'action' });
  assert.equal(w.calls.length, 2);
  const none = w.sender(unraid({ notify_levels: [] }));
  for (const level of ['action', 'problem', 'info']) await none(`x ${level}`, { level });
  assert.equal(w.calls.length, 2, 'an empty list sends nothing');
  assert.deepEqual(w.rows().slice(-3).map(r => r.level), ['action', 'problem', 'info']);
  const withInfo = w.sender(unraid({ notify_levels: ['info'] }));
  await withInfo('now sent', { level: 'info' });
  assert.equal(w.calls.length, 3);
});

test('invalid: an unknown level from a caller is refused and nothing is sent or recorded', async t => {
  const w = setup(t);
  await assert.rejects(w.sender(unraid())('x', { level: 'urgent' }), /unknown alert level "urgent"/);
  assert.equal(w.calls.length, 0);
  assert.equal(fs.existsSync(path.join(w.root, 'team', 'alerts.jsonl')), false);
});

test('notify_levels is validated at load: a list of known levels, default action and problem', () => {
  assert.deepEqual(validateAlertsConfig({ channel: 'unraid', notify_levels: ['action', 'info', 'info'] }), { channel: 'unraid', notify_levels: ['action', 'info'] });
  assert.deepEqual(validateAlertsConfig({ command: ['/bin/x'], notify_levels: [] }), { command: ['/bin/x'], notify_levels: [] });
  assert.deepEqual(validateAlertsConfig({ channel: 'unraid' }), { channel: 'unraid' }, 'unset stays unset; the default applies when sending');
  for (const bad of [['urgent'], 'action', ['action', 3], null, { action: true }]) {
    assert.throws(() => validateAlertsConfig({ channel: 'unraid', notify_levels: bad }), /notify_levels must be a list of levels from: action, problem, info/);
  }
  assert.throws(() => validateAlertsConfig({ notify_levels: ['action'] }), /exactly one of/);
});

test('a failed delivery of an action alert is still reported and retried as today', async t => {
  const w = setup(t, 3);
  const team = { alert: w.sender(unraid()), save() {} }, report = {};
  let marked = 0;
  assert.equal(await alertThenRecord(team, { report, what: 'alert fix-limit 1324', text: FIX_LIMIT, sent: () => { marked++; }, log: () => {} }), false);
  assert.equal(marked, 0, 'not marked sent, so a later tick retries');
  assert.match(report.skipped[0].reason, /alert delivery failed; will retry/);
  assert.equal(w.rows().at(-1).delivered, false);
  assert.match(w.rows().at(-1).error, /exit 3/);
});

test('foreman_alerts shows the level of each alert', async t => {
  const w = setup(t);
  await w.sender(unraid())(UPGRADED, { level: 'info' });
  await w.sender(unraid())(FIX_LIMIT);
  const view = alertsView(w.root, { now: Date.now() + 1000 });
  assert.deepEqual(view.alerts.map(a => [a.level, a.delivered]).sort(), [['action', true], ['info', false]]);
});

test('the supervisor doc table lists every source file that raises an alert', () => {
  const doc = fs.readFileSync(new URL('../docs/supervisor.md', import.meta.url), 'utf8');
  for (const file of ['upgrade.mjs', 'team.mjs', 'pendingstepssync.mjs', 'watchlist.mjs', 'statesave.mjs']) {
    assert.ok(doc.includes(`\`${file}\``), `${file} raises an alert but is not in the docs/supervisor.md table`);
  }
});
