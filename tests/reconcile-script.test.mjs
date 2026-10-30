import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const install = new URL('../tools/install-reconcile-user-script.sh', import.meta.url).pathname;
const remove = new URL('../tools/remove-reconcile-user-script.sh', import.meta.url).pathname;
test('User Scripts reconciliation install and rollback preserve all existing schedules', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-cron-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  const existing = { '/existing/script': { script: '/existing/script', frequency: 'custom', id: 'other', custom: '17 6 * * *' } };
  fs.writeFileSync(path.join(root, 'schedule.json'), JSON.stringify(existing));
  fs.writeFileSync(path.join(root, 'customSchedule.cron'), '# Generated cron schedule for user.scripts\n17 6 * * * existing\n');
  const env = { ...process.env, AI_SUPERVISOR_USER_SCRIPTS_ROOT: root, AI_SUPERVISOR_RECONCILE_TEST: '1' };
  execFileSync('bash', [install], { env, stdio: 'ignore' });
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
  assert.deepEqual(installed['/existing/script'], existing['/existing/script']);
  assert.equal(Object.keys(installed).length, 2);
  const key = path.join(root, 'scripts', 'AI Supervisor Reconcile', 'script');
  assert.equal(installed[key].custom, '*/5 * * * *');
  assert.equal(fs.readFileSync(path.join(root, 'customSchedule.cron'), 'utf8').split('\n').filter(x => x.includes(key)).length, 1);
  execFileSync('bash', [remove], { env, stdio: 'ignore' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8')), existing);
  assert.ok(!fs.existsSync(path.dirname(key)));
});
