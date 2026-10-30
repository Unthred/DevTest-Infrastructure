#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { git, provider, defaultRegistry, safeEnvironment } from '../supervisor/core.mjs';
const worktree = process.argv[2];
if (!worktree) throw new Error('worktree required');
const before = git(worktree, 'status', '--porcelain');
const prompt = 'Read-only CLI smoke test. Do not call tools, read files, modify files, make network requests, or perform any action. Reply with exactly: SMOKE_OK';
for (const id of ['claude', 'codex']) {
  const { config, adapter } = await provider(defaultRegistry, id);
  const job = { role: 'devtest', worktree, sessionId: null };
  if (!adapter.preflight(job)) { console.log(JSON.stringify({ provider: id, result: 'subscription_auth_or_governance_unavailable' })); continue; }
  const argv = adapter.command(config, job, false);
  const child = spawn(argv[0], argv.slice(1), { cwd: worktree, env: safeEnvironment(process.env, config.manifest.launch.env_allowlist), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(prompt);
  let output = '', timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 90000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-100000); });
  const exit = await new Promise(resolve => { child.on('error', () => resolve(127)); child.on('close', code => resolve(code ?? 1)); });
  clearTimeout(timeout);
  const events = [];
  for (const line of output.split('\n')) {
    const classified = adapter.observe(line);
    if (classified.event) events.push(classified.event);
  }
  console.log(JSON.stringify({ provider: id, exit, timedOut, subscriptionAuth: true, observedEvents: [...new Set(events)], completionMarker: output.includes('SMOKE_OK') }));
}
const after = git(worktree, 'status', '--porcelain');
console.log(JSON.stringify({ worktreeUnchanged: before === after }));
