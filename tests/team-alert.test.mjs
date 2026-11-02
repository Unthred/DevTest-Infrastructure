import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Issue #143: bin/team-alert creates its state file and never fails the tick.
const script = path.resolve('bin/team-alert');
function fixture(t, { statusOut = '', notifyOk = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-alert-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sup = path.join(dir, 'sup'), notify = path.join(dir, 'notify');
  fs.writeFileSync(sup, `#!/bin/bash\n[ "$1" = status ] && printf '%s' ${JSON.stringify(statusOut)}\n[ "$1" = team ] && echo '{"actions":[]}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(notify, `#!/bin/bash\n${notifyOk ? 'echo "$@" >> "$(dirname "$0")/sent"; exit 0' : 'exit 1'}\n`, { mode: 0o755 });
  const state = path.join(dir, 'alert.state');
  fs.writeFileSync(path.join(dir, 'reconcile.log'), '');
  const run = () => spawnSync('bash', [script], { encoding: 'utf8', env: { PATH: process.env.PATH, TEAM_ALERT_DIR: dir, TEAM_ALERT_SUPERVISOR: sup, TEAM_ALERT_NOTIFY: notify } });
  return { dir, state, run };
}

test('missing alert.state is created with mode 600 and the run succeeds', t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.state), false);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(f.state, 'utf8'), /^idle \d+ 0\n$/);
});

test('an unwritable state location is a warning, not a failure', t => {
  const f = fixture(t);
  fs.mkdirSync(f.state);   // a directory where the file belongs: it can be neither created nor written
  const r = f.run();
  assert.equal(r.status, 0);
  assert.match(r.stderr, /team-alert: warning: cannot write/);
});

test('a failing notify is a warning and the exit status stays 0', t => {
  const f = fixture(t, { notifyOk: false });
  fs.writeFileSync(f.state, `idle ${Math.floor(Date.now() / 1000) - 99999} 0\n`, { mode: 0o600 });
  const r = f.run();
  assert.equal(r.status, 0);
  assert.match(r.stderr, /warning: notify failed/);
});

test('a running job removes the state file and sends nothing', t => {
  const f = fixture(t, { statusOut: 'x 1 2 running' });
  fs.writeFileSync(f.state, 'idle 1 0\n');
  assert.equal(f.run().status, 0);
  assert.equal(fs.existsSync(f.state), false); assert.equal(fs.existsSync(path.join(f.dir, 'sent')), false);
});

test('an overdue idle state sends one alert', t => {
  const f = fixture(t);
  fs.writeFileSync(f.state, `idle ${Math.floor(Date.now() / 1000) - 99999} 0\n`, { mode: 0o600 });
  assert.equal(f.run().status, 0);
  assert.match(fs.readFileSync(path.join(f.dir, 'sent'), 'utf8'), /out of work/);
});

test('a corrupt state file is reset instead of aborting with a bash arithmetic error', t => {
  const f = fixture(t);
  fs.writeFileSync(f.state, 'idle 12x 0\n', { mode: 0o600 });
  const r = f.run();
  assert.equal(r.status, 0); assert.equal(String(r.stderr || ''), '');
  assert.match(fs.readFileSync(f.state, 'utf8'), /^idle \d+ 0\n$/);
});
