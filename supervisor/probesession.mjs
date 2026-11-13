// Issue #1330: one minimal provider session (no repository, no tools, one short reply) run only so the provider writes a fresh reading into its own
// session log. Its output is discarded; the caller reads the log afterwards. Resolves { ok } or { ok: false, reason: 'failed' }.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeEnvironment } from './core.mjs';

export function runMinimalSession({ spec, config, spawnFn = spawn, env = process.env }) {
  return new Promise(resolve => {
    let dir; try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-session-')); } catch { resolve({ ok: false, reason: 'failed' }); return; }
    let child, done = false, timer = null;
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* an empty leftover directory in tmp is harmless */ }
      resolve(ok ? { ok: true } : { ok: false, reason: 'failed' });
    };
    try { child = spawnFn(spec.command, spec.args || [], { cwd: dir, env: safeEnvironment(env, config.manifest.launch.env_allowlist || []), stdio: ['ignore', 'ignore', 'ignore'], detached: true }); }
    catch { finish(false); return; }
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      finish(false);
    }, (spec.timeout_seconds ?? 90) * 1000);
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
  });
}
