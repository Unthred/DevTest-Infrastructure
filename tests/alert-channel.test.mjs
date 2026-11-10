// The alert channel is explicit and a test can never reach the homeowner. On 2026-11-10 every live tick a test started on
// Tower fell through to the real Unraid notify script and sent "Agents need the homeowner" with the account's real allowance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alertRoute, alertSender, validateAlertsConfig, UNRAID_NOTIFY } from '../supervisor/alert.mjs';
import { agentHome } from '../supervisor/agenthome.mjs';
import { applyLocalOverride } from '../supervisor/team.mjs';
import { isolatedEnv, ISOLATED_KEYS } from './helpers/isolated-env.mjs';

function stateRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-channel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const rows = root => fs.readFileSync(path.join(root, 'team', 'alerts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const spy = (status = 0) => {
  const calls = [];
  const run = (program, args, options) => { calls.push({ program, args, options }); return { status }; };
  return { calls, run };
};

test('alerts.channel "unraid" is the only named channel; a section names exactly one of channel or command', () => {
  const shipped = { enabled: false, limits: {}, agents: {}, depends_on_overrides: {} };
  assert.deepEqual(applyLocalOverride(shipped, { alerts: { channel: 'unraid' } }).alerts, { channel: 'unraid' });
  assert.deepEqual(validateAlertsConfig({ command: ['/bin/notify', 'x'] }), { command: ['/bin/notify', 'x'] });
  assert.throws(() => validateAlertsConfig({ channel: 'slack' }), /alerts\.channel must be one of: unraid/);
  const bad = [{}, { channel: 'unraid', command: ['/x'] }, { command: ['x'] }, null, []];
  for (const alerts of bad) assert.throws(() => validateAlertsConfig(alerts), /exactly one of/);
});

test('with no channel configured nothing is run, even when the notify script exists, and the refusal is recorded and logged', async t => {
  const root = stateRoot(t), { calls, run } = spy(), logged = [];
  const send = alertSender(root, {}, { notify: process.execPath, run, env: {}, log: line => logged.push(line) });
  await assert.rejects(send('Allowance: codex: reviews only'), /no alert channel configured/);
  assert.equal(calls.length, 0, 'no default channel: the notify script is never run');
  const row = rows(root).at(-1);
  assert.equal(row.delivered, false);
  assert.match(row.error, /set alerts\.channel to "unraid" or alerts\.command/);
  assert.deepEqual(logged, [`ai-supervisor: alert not delivered: ${row.error}`]);
});

test('alerts.channel "unraid" delivers through the notify script outside a test run', async t => {
  const root = stateRoot(t), { calls, run } = spy();
  const options = { notify: '/opt/notify', run, env: { PATH: '/bin' }, log: () => assert.fail('nothing to log') };
  await alertSender(root, { alerts: { channel: 'unraid' } }, options)('hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, '/opt/notify');
  assert.ok(calls[0].args.includes('hello'));
  assert.equal(rows(root).at(-1).delivered, true);
  assert.equal('error' in rows(root).at(-1), false);
});

test('under the test runner the real notify script is refused even when the channel is configured', async t => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under node --test');
  const root = stateRoot(t), { calls, run } = spy(), logged = [];
  await assert.rejects(alertSender(root, { alerts: { channel: 'unraid' } }, { run, log: line => logged.push(line) })('x'), /never used from a test run/);
  assert.equal(calls.length, 0, 'the real notify script is never started from a test');
  assert.equal(rows(root).at(-1).delivered, false);
  assert.equal(logged.length, 1);
  const refused = alertRoute({ channel: 'unraid' }, 'x', { notify: UNRAID_NOTIFY, testRun: true }).refused;
  assert.equal(refused, 'the Unraid notify script is never used from a test run');
  assert.equal(alertRoute({ channel: 'unraid' }, 'x', { notify: UNRAID_NOTIFY, testRun: false }).program, UNRAID_NOTIFY);
});

test('a failed delivery command is recorded with its reason and thrown', async t => {
  const root = stateRoot(t), { run } = spy(3), logged = [];
  const send = alertSender(root, { alerts: { command: ['/bin/x'] } }, { run, env: {}, log: line => logged.push(line) });
  await assert.rejects(send('x'), /alert command failed: exit 3/);
  assert.equal(rows(root).at(-1).error, 'alert command failed: exit 3');
  assert.equal(logged.length, 1);
});

test('agent session reads refuse the account home under the test runner and allow an isolated one', t => {
  const accountHome = '/home/account';
  assert.throws(() => agentHome({ env: { HOME: accountHome, NODE_TEST_CONTEXT: 'child' }, accountHome }), /refusing to read agent sessions/);
  assert.throws(() => agentHome({ env: { HOME: `${accountHome}/`, NODE_TEST_CONTEXT: 'child' }, accountHome }), /refusing/);
  assert.equal(agentHome({ env: { HOME: '/tmp/x/home', NODE_TEST_CONTEXT: 'child' }, accountHome }), '/tmp/x/home');
  assert.equal(agentHome({ env: { HOME: accountHome }, accountHome }), accountHome, 'production reads the account home');
  const dir = stateRoot(t), env = isolatedEnv(dir);
  for (const key of ISOLATED_KEYS) assert.ok(env[key].startsWith(dir), `${key} is under the test's own folder`);
  assert.equal(agentHome({ env }), env.HOME);
});

// A live tick runs only for an enabled team. Every test file that starts the supervisor CLI with a command that can run one
// (team tick, reconcile, a worker) for an enabled team builds its environment with isolatedEnv, so the process never inherits
// the account's HOME or provider folders. agentHome is the runtime check; this names the file before anything runs.
test('every test that starts a live supervisor tick uses the isolated environment', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const startsCli = /process\.execPath,\s*\[\s*(cli|CLI)\b/;
  const liveCommand = /[[,]\s*'(tick|reconcile|worker)'\s*[,\]]/;
  const enablesTeam = /enabled: ?true|"enabled": ?true/;
  const missing = [];
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.test.mjs') && n !== 'alert-channel.test.mjs')) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const live = startsCli.test(text) && liveCommand.test(text) && enablesTeam.test(text);
    if (live && !text.includes('isolatedEnv(')) missing.push(name);
  }
  assert.deepEqual(missing, [], `start these with env: isolatedEnv(dir): ${missing.join(', ')}`);
});
