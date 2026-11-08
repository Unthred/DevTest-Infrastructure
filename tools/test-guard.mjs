// Issue #1007: run a command with TMPDIR set to a fresh folder, then fail if anything is left inside it.
// Usage: node tools/test-guard.mjs [--tmp-base <dir>] -- <command> [args...]
// The folder is always removed afterwards. Exit code: the command's, or 1 when it passed but left files behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function runGuarded(cmd, { base = os.tmpdir(), env = process.env, stdio = 'inherit' } = {}) {
  const tmp = fs.mkdtempSync(path.join(base, 'test-guard-'));
  fs.chmodSync(tmp, 0o755);   // like /tmp: tests that build container-readable clones under TMPDIR need a traversable parent
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio, env: { ...env, TMPDIR: tmp } });
    const left = fs.readdirSync(tmp).sort();
    const status = r.status ?? 1;
    if (r.error) console.error(`test-guard: could not run ${cmd[0]}: ${r.error.code || r.error.message}`);
    else if (r.signal) console.error(`test-guard: ${cmd[0]} was stopped by ${r.signal}`);
    return { status, left, exit: status !== 0 ? status : left.length ? 1 : 0 };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let base;
  if (args[0] === '--tmp-base') { base = args[1]; args.splice(0, 2); }
  if (args[0] === '--') args.shift();
  if (!args.length) { console.error('usage: test-guard.mjs [--tmp-base dir] -- command [args...]'); process.exit(2); }
  const r = runGuarded(args, base ? { base } : {});
  if (r.left.length) console.error(`test-guard: ${r.left.length} item(s) left in TMPDIR: ${r.left.slice(0, 50).join(', ')}`);
  process.exit(r.exit);
}
