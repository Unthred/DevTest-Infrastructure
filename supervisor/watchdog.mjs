// One detached watchdog for a job's process group, shared by runInGroup (testslots.mjs) and runLimited (resources.mjs).
// It SIGKILLs the group when the runner is gone (dead, a zombie, or its PID reused by another process: the start time differs),
// or when the deadline passes, and exits once the group is empty. Started as `node watchdog.mjs <runner> <runnerStart> <pgid> <deadline> <pollMs>`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processInfo } from './core.mjs';

export function runnerGone(pid, start) {
  const info = processInfo(pid);
  return !info || info.state === 'Z' || info.state === 'X' || (start != null && info.start !== start);
}

export function startGroupWatchdog({ runnerPid = process.pid, pgid, deadlineMs = 0, pollMs = 200 }) {
  const start = processInfo(runnerPid)?.start ?? '';
  const dog = spawn(process.execPath, [fileURLToPath(import.meta.url), String(runnerPid), start, String(pgid), String(deadlineMs), String(pollMs)], { detached: true, stdio: 'ignore' });
  dog.unref(); dog.on('error', () => {});
  return dog;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [r, start, g, d, p] = process.argv.slice(2);
  const runner = Number(r), pgid = Number(g), deadline = Number(d), poll = Number(p) || 200;
  const kill = () => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } process.exit(0); };
  setInterval(() => {
    if (runnerGone(runner, start || null) || (deadline && Date.now() > deadline)) kill();
    try { process.kill(-pgid, 0); } catch (e) { if (e.code !== 'EPERM') process.exit(0); }
  }, poll);
}
