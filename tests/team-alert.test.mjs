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

test('a running job keeps the state file (mode 600) and sends nothing', t => {
  const f = fixture(t, { statusOut: 'x 1 2 running' });
  fs.writeFileSync(f.state, 'idle 1 0\n', { mode: 0o600 });
  const r = f.run();
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
  assert.match(fs.readFileSync(f.state, 'utf8'), /^running \d+ 0\n$/); assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.dir, 'sent')), false);
});

test('a missing state during a running job is recreated without any error output', t => {
  const f = fixture(t, { statusOut: 'x 1 2 running' });
  fs.rmSync(f.state, { force: true });
  const r = f.run();
  assert.equal(r.status, 0); assert.equal(r.stderr, ''); assert.ok(fs.existsSync(f.state));
});

test('a failed alert is not counted as sent, so the next tick retries it', t => {
  const f = fixture(t, { notifyOk: false });
  fs.writeFileSync(f.state, `idle ${Math.floor(Date.now() / 1000) - 99999} 0\n`, { mode: 0o600 });
  const r = f.run();
  assert.match(r.stderr, /team-alert: warning: notify failed: alert not delivered/);
  assert.match(fs.readFileSync(f.state, 'utf8'), /^idle \d+ 0\n$/);
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

test('the installer and the upgrader deploy the reviewed team-alert and never touch alert.state (issue #215)', () => {
  for (const f of ['tools/install-supervisor.sh', 'tools/upgrade-supervisor.sh']) {
    const text = fs.readFileSync(f, 'utf8');
    assert.match(text, /cp "\$source_root\/bin\/team-alert"/, f);
    assert.match(text, /cmp -s "\$source_root\/bin\/team-alert"/, f);
    assert.ok(!/alert\.state\b[^\n]*\b(rm|mv|cp)\b|\b(rm|mv|cp)\b[^\n]*alert\.state/.test(text.replace(/^#.*$/gm, '')), f + ' must not touch alert.state');
  }
  assert.equal(spawnSync('bash', ['-n', 'tools/install-supervisor.sh']).status, 0);
  assert.equal(spawnSync('bash', ['-n', 'tools/upgrade-supervisor.sh']).status, 0);
});

// Issue #200: child stderr must not leak into the log as stray lines that would make a tick an error.
test('a supervisor that writes to stderr and fails gives one warning and no stray stderr', t => {
  const f = fixture(t);
  const sup = path.join(f.dir, 'sup');
  fs.writeFileSync(sup, '#!/bin/bash\necho "ai-supervisor: status failed" >&2\n[ "$1" = status ] && exit 1\necho \'{"actions":[]}\'\n', { mode: 0o755 });
  const r = f.run();
  assert.equal(r.status, 0);
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.ok(lines.length > 0 && lines.every(l => l.startsWith('team-alert: warning: ')), r.stderr);
  assert.ok(!/ai-supervisor/.test(r.stderr));
});

test('a missing supervisor binary leaves no command-not-found text on stderr', t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.dir, 'sup'));
  const r = f.run();
  assert.equal(r.status, 0);
  assert.ok(r.stderr.split('\n').filter(Boolean).every(l => l.startsWith('team-alert: warning: ')), r.stderr);
});

test('a missing node is reported as a team-alert warning, not silenced', t => {
  const f = fixture(t);
  const bin = path.join(f.dir, 'bin'); fs.mkdirSync(bin);
  for (const c of ['bash', 'date', 'grep', 'awk', 'tail', 'tr', 'sed', 'cut', 'dirname', 'cat']) {
    const found = spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(bin, c));
  }
  const r = spawnSync(path.join(bin, 'bash'), [script], { encoding: 'utf8', env: { PATH: bin, TEAM_ALERT_DIR: f.dir, TEAM_ALERT_SUPERVISOR: path.join(f.dir, 'sup'), TEAM_ALERT_NOTIFY: path.join(f.dir, 'notify') } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^team-alert: warning: node not found/m);
  assert.ok(r.stderr.split('\n').filter(Boolean).every(l => l.startsWith('team-alert: warning: ')), r.stderr);
});

test('a failing dry run is a warning', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'sup'), '#!/bin/bash\necho boom >&2\n[ "$1" = team ] && exit 1\nexit 0\n', { mode: 0o755 });
  const r = f.run();
  assert.equal(r.status, 0);
  assert.match(r.stderr, /warning: supervisor team tick --dry-run failed/);
  assert.ok(!/boom/.test(r.stderr));
});
