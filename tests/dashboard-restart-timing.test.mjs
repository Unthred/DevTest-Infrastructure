import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restartDashboardServer } from '../supervisor/upgrade.mjs';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const cli = sha => `/mnt/cache/ai-supervisor/versions/${sha}/supervisor/cli.mjs`;

function fakeStartKit(t) {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-timing-'));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  const write = (pid, argv) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
  };
  write(100, ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731']);
  const kill = (pid, signal) => {
    if (signal === 0) {
      if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' });
      return;
    }
    fs.rmSync(path.join(proc, String(pid)), { recursive: true });
  };
  const start = (wrapper, args) => write(200, ['node', cli(NEW), ...args]);
  return { proc, kill, start };
}

test('issue #632: the settle wait uses elapsed time when every probe is slow', async t => {
  const { proc, kill, start } = fakeStartKit(t);
  let answered = false;
  let elapsed = 0;
  const health = async () => {
    if (!fs.existsSync(path.join(proc, '200'))) return true;
    if (!answered) { answered = true; return true; }
    elapsed += 400;
    return false;
  };
  const result = await restartDashboardServer(NEW, {
    procRoot: proc,
    kill,
    start: (...args) => { answered = false; start(...args); },
    startOld: () => { throw new Error('old dashboard is not started in this fixture'); },
    sleep: async milliseconds => { elapsed += milliseconds; },
    tries: 3,
    settleMs: 0,
    settleMaxMs: 300,
    settleMinMs: 300,
    settleProbeMs: 50,
    health,
    logTail: () => '',
    now: () => elapsed
  });
  assert.equal(result.ok, false);
  assert.equal(result.cause, 'unresponsive');
  assert.ok(elapsed >= 800, `settle probes advanced only ${elapsed} ms`);
});

test('issue #725: a slow first health probe prevents a second start attempt', async t => {
  const { proc, kill, start } = fakeStartKit(t);
  let starts = 0;
  let elapsed = 0;
  const health = async () => { elapsed += 400; return false; };
  const result = await restartDashboardServer(NEW, {
    procRoot: proc,
    kill,
    start: (...args) => { starts++; start(...args); },
    startOld: () => { throw new Error('old dashboard is not started in this fixture'); },
    sleep: async milliseconds => { elapsed += milliseconds; },
    tries: 50,
    restartMaxMs: 300,
    recoverMaxMs: 200,
    health,
    logTail: () => '',
    now: () => elapsed
  });
  assert.equal(result.ok, false);
  assert.equal(result.cause, 'unresponsive');
  assert.equal(starts, 1, 'no second attempt after the deadline');
  assert.ok(elapsed >= 400, `health probe advanced only ${elapsed} ms`);
});

test('issue #810: the settle window stays at its minimum when the deadline passes', async t => {
  const { proc, kill, start } = fakeStartKit(t);
  let elapsed = 0;
  const result = await restartDashboardServer(NEW, {
    procRoot: proc,
    kill,
    start,
    startOld: () => {},
    sleep: async milliseconds => { elapsed += Math.min(milliseconds, 20); },
    tries: 50,
    settleMs: 0,
    settleMaxMs: 60000,
    settleMinMs: 1000,
    settleProbeMs: 20,
    restartMaxMs: 300,
    health: async () => elapsed > 250,
    logTail: () => '',
    now: () => elapsed
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});
