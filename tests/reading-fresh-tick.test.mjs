// Issue #1163 through the real `team tick` command: a normal agent with no fresh reading is probed once before admission, but only when work is
// waiting (an open issue seen by the previous pass); an idle repository spends no probe. The provider and GitHub are fake executables; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, INERT_ALERTS } from './helpers/isolated-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'supervisor', 'cli.mjs'), register = path.join(here, '..', 'docs', 'DECISIONS.md');

function world(t, { openIssue }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-tick-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'state'), bin = path.join(dir, 'bin'), marker = path.join(dir, 'probe-calls');
  fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700); fs.mkdirSync(bin);
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const issue = JSON.stringify([{ number: 900, title: 'Some work', body: '', labels: [], state: 'OPEN', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', author: { login: 'o' }, assignees: [], comments: [] }]);
  exe('gh', `case "$*" in *"issue list"*) echo '${openIssue ? issue : '[]'}';; *) echo "[]";; esac`);
  exe('git', `case "$*" in *"show origin/main:docs/DECISIONS.md"*) cat '${register}';; esac\nexit 0`);
  exe('claude', `echo probe >> '${marker}'`);
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true, alerts: INERT_ALERTS }));
  const run = () => spawnSync(process.execPath, [cli, 'team', 'tick', '--state-root', root], { encoding: 'utf8', timeout: 90000, env: isolatedEnv(dir, { TMPDIR: dir }, bin) });
  const calls = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
  return { run, calls };
}

test('a normal agent with no reading is probed once when work is waiting, not on an idle repository, and not again inside the interval', t => {
  const idle = world(t, { openIssue: false });
  idle.run(); idle.run();
  assert.equal(idle.calls(), 0, 'no work waiting: no probe, however old the reading');
  const busy = world(t, { openIssue: true });
  busy.run();                         // the first pass has no cache yet and records the open issue
  assert.equal(busy.calls(), 0, 'nothing is known to be waiting on the first pass');
  busy.run();
  assert.equal(busy.calls(), 1, 'the second pass sees work waiting and refreshes the missing reading first');
  const after = busy.calls();
  busy.run();
  assert.equal(busy.calls(), after, 'one attempt per interval');
});
