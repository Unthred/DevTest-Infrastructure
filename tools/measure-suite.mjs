#!/usr/bin/env node
// Issue #469: the before/after method of #448 for one test suite run. Runs `node --test` once with a given --test-concurrency
// (or none, for the old behaviour) and prints JSON: wall seconds, 1-minute load before/peak, peak child processes, peak RAM used by
// the suite's process tree (sum of VmRSS) and swap change. Usage: node tools/measure-suite.mjs [--concurrency N|none] [--label TEXT]
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2); const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const conc = get('--concurrency') ?? 'none';
const load1 = () => Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const mem = () => Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map(l => { const [k, v] = l.split(':'); return [k, parseInt(v, 10) / 1024]; }));
const procs = () => fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(pid => { try { const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); return { pid: +pid, ppid: +/PPid:\s+(\d+)/.exec(s)[1], rss: +(/VmRSS:\s+(\d+)/.exec(s)?.[1] ?? 0) / 1024 }; } catch { return null; } }).filter(Boolean);
const tree = root => { const all = procs(), keep = new Set([root]); let grew = true; while (grew) { grew = false; for (const p of all) if (!keep.has(p.pid) && keep.has(p.ppid)) { keep.add(p.pid); grew = true; } } return all.filter(p => keep.has(p.pid)); };
const cmd = ['--test', '--test-reporter=dot', ...(conc === 'none' ? [] : [`--test-concurrency=${conc}`]), 'tests/**/*.test.mjs'];
const before = { load: load1(), swapUsed: mem().SwapTotal - mem().SwapFree };
let peakProcs = 0, peakRss = 0, peakLoad = before.load; const t0 = Date.now();
const child = spawn('node', cmd, { stdio: ['ignore', 'ignore', 'ignore'] });
const timer = setInterval(() => { const t = tree(child.pid); peakProcs = Math.max(peakProcs, t.length); peakRss = Math.max(peakRss, t.reduce((s, p) => s + p.rss, 0)); peakLoad = Math.max(peakLoad, load1()); }, 1000);
child.on('exit', code => { clearInterval(timer); const m = mem();
  console.log(JSON.stringify({ label: get('--label') ?? null, concurrency: conc, exit: code, seconds: Math.round((Date.now() - t0) / 100) / 10, loadBefore: before.load, loadPeak: peakLoad, peakProcesses: peakProcs, peakSuiteRssMB: Math.round(peakRss), swapUsedChangeMB: Math.round(m.SwapTotal - m.SwapFree - before.swapUsed), cores: fs.readdirSync('/sys/devices/system/cpu').filter(n => /^cpu\d+$/.test(n)).length }));
  process.exitCode = code ?? 1; });
