// Issue #110, through the real `team tick` command (teamTick in supervisor/cli.mjs): a held agent with a stale reading gets one
// allowance probe before planning; a dry run gets none. The provider and GitHub are fake executables on PATH; no model is called.
// This fails if the runDueProbes call in teamTick is removed (as happened in PR #222's rebase).
// Hermetic: the shipped config names a checkout path that exists only on the host, so `git` is faked too. It answers the one question
// the tick asks before probing (the decision register, read from origin/main) with this repository's own file; CI has no such path.
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

function world(t, { held = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'state'), bin = path.join(dir, 'bin'), marker = path.join(dir, 'probe-calls');
  fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  fs.mkdirSync(bin);
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  exe('gh', 'echo "[]"');
  exe('git', `case "$*" in *"show origin/main:docs/DECISIONS.md"*) cat '${register}';; esac\nexit 0`);
  exe('claude', `echo probe >> '${marker}'`);   // records the call and prints nothing: the probe finds no reading
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true, alerts: INERT_ALERTS }));
  // Claude was held until a reset time that has now passed and has no newer reading: a probe is owed ("reset").
  const now = Date.now();
  if (held) fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ budget: { claude: { mode: 'waiting', until: now - 10 * 60000, since: now - 30 * 3600000, reason: 'weekly 100%: used up', alerted: true } } }));
  const run = args => spawnSync(process.execPath, [cli, 'team', 'tick', ...args, '--state-root', root], { encoding: 'utf8', timeout: 90000, env: isolatedEnv(dir, { TMPDIR: dir }, bin) });
  const calls = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
  return { run, calls, root };
}

test('a live tick probes a held agent with a stale reading before planning; a dry run does not', t => {
  const dry = world(t);
  dry.run(['--dry-run']);
  assert.equal(dry.calls(), 0, 'a dry run never spends a probe run');
  const live = world(t);
  live.run([]);
  assert.equal(live.calls(), 1, 'one probe for the held agent');
  const state = JSON.parse(fs.readFileSync(path.join(live.root, 'team', 'state.json'), 'utf8'));
  assert.ok(state.probes?.claude?.at, 'the attempt is recorded, so it is not repeated inside the interval');
  // Issue #1144: the real entry point ran migration 003 here. A test root keeps its inert alert command and never gets the
  // Unraid channel, so a test file run directly (no NODE_TEST_CONTEXT) still cannot reach the notify script.
  const local = JSON.parse(fs.readFileSync(path.join(live.root, 'team.local.json'), 'utf8'));
  assert.deepEqual(local.alerts, INERT_ALERTS);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live.root, 'team', 'migrations.json'), 'utf8')).applied >= 3, true, 'migrations ran in this tick');
});

test('a live tick with no held agent runs no probe', t => {
  const w = world(t, { held: false });
  w.run([]);
  assert.equal(w.calls(), 0);
});
