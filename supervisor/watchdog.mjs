// One detached watchdog for a job's process group, shared by runInGroup (testslots.mjs) and runLimited (resources.mjs).
// It SIGKILLs the group when the runner is gone (dead, a zombie, or its PID reused by another process: the start time differs),
// or when the deadline passes, and exits once the group is empty. Started as `node watchdog.mjs <runner> <runnerStart> <pgid> <deadline> <pollMs>`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processInfo } from './core.mjs';

// An unreadable /proc/<pid>/stat means "gone" only when the runner's start time was read at launch (so /proc works here). With no recorded
// start time (no readable /proc: not Linux, or hidepid) fall back to process.kill(pid, 0), as the older watchdog did (issue #695).
function pidExists(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// Limitation: in this fallback kill(pid, 0) cannot tell a zombie runner or a reused PID from a live one. That matches the older watchdog and
// does not apply on Foreman's Linux host, where /proc is readable so the start time is normally recorded (it is empty only if /proc is unreadable).
export function runnerGone(pid, start, readInfo = processInfo, exists = pidExists) {
  const info = readInfo(pid);
  if (!info && start == null) return !exists(pid);
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

// Closes the window between spawning a job and spawning its watchdog (issue #659). The job starts behind a gate: a tiny shell that
// waits for a gate file, gives up if the runner disappears (or after maxWaitS seconds), and only then execs the real command (same PID,
// so the job's pgid is unchanged). The runner opens the gate once the watchdog exists. A runner that dies first leaves no running job.
export function gateJob(cmd, { runnerPid = process.pid, maxWaitS = 10 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-gate-'));
  const file = path.join(dir, 'open');
  // The gate removes its own directory on every way out (opened, runner gone, timed out), so a SIGKILLed runner leaves nothing behind
  // (issue #736). It also treats a zombie or exited runner as gone, reading /proc/<pid>/stat as runnerGone does; with no readable /proc
  // it falls back to kill -0.
  const script = 'r=$1; d=$2; n=$3; shift 3; f=$d/open; i=0; '
    + 'alive() { if [ -r /proc/$$/stat ]; then { read -r l < /proc/$r/stat; } 2>/dev/null || return 1; l=${l##*) }; case ${l%% *} in Z|X) return 1;; esac; return 0; else kill -0 "$r" 2>/dev/null; fi; }; '
    + 'while [ ! -e "$f" ]; do alive || { rm -rf "$d"; exit 125; }; i=$((i+1)); [ "$i" -gt "$n" ] && { rm -rf "$d"; exit 125; }; sleep 0.05; done; rm -rf "$d"; exec "$@"';
  return {
    argv: ['sh', '-c', script, 'job-gate', String(runnerPid), dir, String(Math.round(maxWaitS * 20)), ...cmd],
    open() { try { fs.writeFileSync(file, ''); } catch { /* the gate times out and the job does not run */ } },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}
