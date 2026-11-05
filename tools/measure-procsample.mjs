// Measures the cost of one live process reading (issue #568) on the host it runs on: wall time and CPU per sample, with the number
// of processes and job files read and the load average, for the full path the dashboard runs (job files + /proc + attribution).
// Read-only; usage: node tools/measure-procsample.mjs [samples=50] [state-root]
import os from 'node:os';
import { createSampler } from '../supervisor/procsample.mjs';
import { readJobs } from '../supervisor/dashdata.mjs';
const root = process.argv[3] || '/mnt/cache/ai-supervisor';
const n = Math.max(5, Number(process.argv[2]) || 50), wall = [], cpu = [];
let procs = 0, jobsRead = 0;
for (let i = 0; i < n; i++) {
  const c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
  const s = createSampler({ readJobs: () => readJobs(root), ttlMs: 0 }).get(); if (!s.ok) throw new Error(s.error);
  wall.push(Number(process.hrtime.bigint() - t0) / 1e6); const c = process.cpuUsage(c0); cpu.push((c.user + c.system) / 1000); procs = s.reading.total.processes; jobsRead = readJobs(root).length;
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
console.log(JSON.stringify({ samples: n, processes: procs, jobFiles: jobsRead, loadavg: os.loadavg().map(x => +x.toFixed(2)), cpus: os.cpus().length, wallMs: { median: q(wall, .5), p95: q(wall, .95), max: q(wall, 1) }, cpuMs: { median: q(cpu, .5), p95: q(cpu, .95) } }));
