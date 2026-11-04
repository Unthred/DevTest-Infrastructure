// Measures the cost of one live process reading (issue #568) on the host it runs on: wall time and CPU per sample, with the number
// of processes read and the load average at the time. Read-only; usage: node tools/measure-procsample.mjs [samples=50]
import os from 'node:os';
import { readTable, attribute } from '../supervisor/procsample.mjs';
const n = Math.max(5, Number(process.argv[2]) || 50), wall = [], cpu = [];
let procs = 0;
for (let i = 0; i < n; i++) {
  const c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
  const table = readTable('/proc'); attribute(table, [], Date.now());
  wall.push(Number(process.hrtime.bigint() - t0) / 1e6); const c = process.cpuUsage(c0); cpu.push((c.user + c.system) / 1000); procs = table.procs.length;
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
console.log(JSON.stringify({ samples: n, processes: procs, loadavg: os.loadavg().map(x => +x.toFixed(2)), cpus: os.cpus().length, wallMs: { median: q(wall, .5), p95: q(wall, .95), max: q(wall, 1) }, cpuMs: { median: q(cpu, .5), p95: q(cpu, .95) } }));
