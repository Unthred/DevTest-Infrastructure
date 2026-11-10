// The environment for a supervisor process a test starts. Tests run on Tower, where the account's agent sessions, allowance
// readings and CLI logins are live: a live tick that inherits them reads the real Codex 94% and can start a real `claude` probe.
// Every place a probe, adapter or provider CLI looks for its data is pointed under `dir`, which the caller owns and removes.
import fs from 'node:fs';
import path from 'node:path';

export const ISOLATED_KEYS = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

// binDir, when given, goes first on PATH (the test's stub gh, git or provider CLIs).
export function isolatedEnv(dir, extra = {}, binDir = null) {
  const home = path.join(dir, 'home');
  const env = {
    ...process.env,
    PATH: binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  };
  for (const key of ISOLATED_KEYS) fs.mkdirSync(env[key], { recursive: true, mode: 0o700 });
  return { ...env, ...extra };
}
