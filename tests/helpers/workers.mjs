// Child workers for tests that race processes against each other (incident 2026-11-04).
// No clock is shared with the parent: every child announces "ready" on stdout and then blocks on stdin; the parent writes "go" to all of
// them once all are ready. A child never busy-waits, exits when stdin closes (parent died) and has its own hard cap (setTimeout, real time).
import { spawn } from 'node:child_process';

export const WORKER_CAP_MS = 30000;

export async function raceWorkers(count, body, { capMs = WORKER_CAP_MS, onSpawn } = {}) {
  const code = `const cap = setTimeout(() => process.exit(97), ${Number(capMs)});
    process.stdin.on('end', () => process.exit(98));   // the parent is gone: do not outlive it
    process.stdout.write('ready\\n');
    await new Promise(res => process.stdin.once('data', res));
    process.stdin.resume();   // keep reading so EOF (parent death) is still noticed while the body runs
    const out = await (async () => { ${body} })();
    clearTimeout(cap); process.stdout.write('\\nresult:' + (out ?? '')); process.exit(0);`;
  const kids = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
    const k = { child, pid: child.pid, out: '', ready: null, closed: null };
    k.ready = new Promise(res => child.stdout.on('data', d => { k.out += d; if (k.out.includes('ready\n')) res(); }));
    k.closed = new Promise(res => child.on('close', (c, s) => res({ code: c, signal: s })));
    child.stdin.on('error', () => {});
    return k;
  });
  onSpawn?.(kids);
  try {
    await Promise.race([Promise.all(kids.map(k => k.ready)), new Promise((_, rej) => setTimeout(() => rej(new Error('workers never became ready')), capMs).unref())]);
    for (const k of kids) k.child.stdin.write('go\n');
    const exits = await Promise.all(kids.map(k => k.closed));
    return kids.map((k, i) => ({ code: exits[i].code, out: (k.out.split('result:')[1] ?? '') }));
  } finally {
    for (const k of kids) { try { k.child.kill('SIGKILL'); } catch { /* already gone */ } }
    await Promise.all(kids.map(k => k.closed));
  }
}
