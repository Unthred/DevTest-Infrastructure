// Issue #574: resource-aware admission for `ai-supervisor test-slot run`. A job names a size class; the runner grants
// min(request, class cap, live headroom) or queues the job, launches it in its own process group (and, when a cgroup slice is
// configured, its own systemd scope leaf), kills an over-limit job as a unit and records why. With no budget source nothing changes.
// Class caps and the highest class an agent may use come only from the owner's team config; a CLI flag can ask for less, never more.
import fs from 'node:fs';
import path from 'node:path';
import { SupervisorError } from './core.mjs';

export const CLASS_ORDER = ['small', 'suite', 'build'];
export const DEFAULT_CLASSES = {
  small: { memory_mb: 1024, cpus: 1, min_memory_mb: 256 },    // a single test file
  suite: { memory_mb: 4096, cpus: 4, min_memory_mb: 1024 },   // the full node --test suite
  build: { memory_mb: 8192, cpus: 8, min_memory_mb: 2048 },   // browser or build jobs
};
export const DEFAULT_MAX_CLASS = 'suite';   // 'build' needs the owner to raise max_class in the config
const MB = 1048576;

export function validateResourceConfig(r) {
  if (r == null) return undefined;
  const bad = m => { throw new SupervisorError(`invalid team config: test_resources ${m}`); };
  if (typeof r !== 'object' || Array.isArray(r)) bad('must be an object');
  for (const k of Object.keys(r)) if (!['budget_file', 'max_class', 'classes'].includes(k)) bad(`has unknown key ${k}`);
  if ('budget_file' in r && !(typeof r.budget_file === 'string' && path.isAbsolute(r.budget_file))) bad('budget_file must be an absolute path');
  if ('max_class' in r && !CLASS_ORDER.includes(r.max_class)) bad(`max_class must be one of ${CLASS_ORDER.join(', ')}`);
  for (const [name, c] of Object.entries(r.classes || {})) {
    if (!CLASS_ORDER.includes(name)) bad(`unknown class ${name}`);
    for (const k of Object.keys(c)) if (!['memory_mb', 'cpus', 'min_memory_mb'].includes(k) || !(typeof c[k] === 'number' && c[k] > 0)) bad(`class ${name}.${k} must be a positive number`);
  }
  return r;
}

export const classCaps = cfg => Object.fromEntries(CLASS_ORDER.map(n => [n, { ...DEFAULT_CLASSES[n], ...(cfg?.classes?.[n] || {}) }]));

// The host budget: { memory_available_mb, cpus_available, pressure, slice? }. Read-only. Missing/unreadable/garbled file = null = no budget.
export function readBudget(file) {
  if (!file) return null;
  let b; try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!b || typeof b !== 'object' || !(b.memory_available_mb >= 0) || !(b.cpus_available >= 0)) return null;
  return { memory_available_mb: b.memory_available_mb, cpus_available: b.cpus_available, pressure: b.pressure === true, slice: typeof b.slice === 'string' && /^[\w.@-]+\.slice$/.test(b.slice) ? b.slice : null };
}

// Which class a request is allowed to use. Refuses one above the owner-approved maximum.
export function checkClass(name, cfg) {
  if (!CLASS_ORDER.includes(name)) return { ok: false, reason: `unknown size class ${name}; use ${CLASS_ORDER.join(', ')}` };
  const max = cfg?.max_class || DEFAULT_MAX_CLASS;
  if (CLASS_ORDER.indexOf(name) > CLASS_ORDER.indexOf(max)) return { ok: false, approval: true, reason: `size class ${name} is above the approved maximum (${max}); a larger class needs explicit owner approval in the team config` };
  return { ok: true };
}

// grant = min(request, class cap, live headroom); queue when the host is under pressure or headroom is below the class minimum.
// `request` is optional { memory_mb, cpus }. No budget means the legacy behaviour: grant with no limits.
export function decideGrant({ klass, request = {}, budget, cfg }) {
  const cap = classCaps(cfg)[klass];
  if (!budget) return { action: 'grant', limits: null, class: klass };
  if (budget.pressure) return { action: 'queue', reason: 'host reports pressure' };
  if (budget.memory_available_mb < cap.min_memory_mb) return { action: 'queue', reason: `headroom ${budget.memory_available_mb} MB is below the ${klass} minimum ${cap.min_memory_mb} MB` };
  if (budget.cpus_available < 1) return { action: 'queue', reason: 'no CPU headroom' };
  const memory_mb = Math.floor(Math.min(request.memory_mb ?? Infinity, cap.memory_mb, budget.memory_available_mb));
  const cpus = Math.min(request.cpus ?? Infinity, cap.cpus, budget.cpus_available);
  return { action: 'grant', class: klass, limits: { memory_mb, cpus }, slice: budget.slice };
}

export const smallerClass = klass => CLASS_ORDER[Math.max(0, CLASS_ORDER.indexOf(klass) - 1)];

// Wrapper command putting the job in its own scope under the agent slice (killed as a unit by the kernel). Null when not configured.
export function cgroupWrapper(grant, id, { slice = grant?.slice, available = true } = {}) {
  if (!grant?.limits || !slice || !available) return null;
  return ['systemd-run', '--scope', '--quiet', '--collect', `--slice=${slice}`, `--unit=devtest-job-${String(id).replace(/[^\w.-]/g, '')}`,
    '-p', `MemoryMax=${grant.limits.memory_mb}M`, '-p', 'MemorySwapMax=0', '-p', `CPUQuota=${Math.round(grant.limits.cpus * 100)}%`, '--'];
}

// Resident memory (bytes) of every process in a process group, read from /proc.
export function groupRss(pgid, procDir = '/proc', pageSize = 4096) {
  let total = 0;
  for (const pid of fs.readdirSync(procDir).filter(n => /^\d+$/.test(n))) {
    try {
      const stat = fs.readFileSync(path.join(procDir, pid, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');   // state ppid pgrp ...
      if (Number(fields[2]) !== pgid) continue;
      total += Number(fs.readFileSync(path.join(procDir, pid, 'statm'), 'utf8').split(' ')[1]) * pageSize;
    } catch { /* exited meanwhile */ }
  }
  return total;
}

export function killGroup(pgid, signal = 'SIGKILL') { try { process.kill(-pgid, signal); } catch { /* already gone */ } }

// The record explaining a kill, for the job result.
export const killRecord = ({ klass, limitMb, observedMb, id }) => ({
  id, killed: true, reason: 'memory-limit', class: klass, limit_mb: limitMb, observed_mb: observedMb,
  suggested_class: smallerClass(klass) === klass ? null : smallerClass(klass),
  note: `killed for exceeding the ${klass} class memory grant of ${limitMb} MB; split the job or run a smaller piece (class ${smallerClass(klass)}); a larger class needs owner approval`,
});

// Runs `cmd` in its own process group, watching group memory against the grant. Resolves { code, kill? }.
export function runLimited(cmd, { env, limits, klass, id, intervalMs = 250, rss = groupRss, spawnFn, wrapper } = {}) {
  return new Promise(async resolve => {
    const { spawn } = await import('node:child_process');
    const argv = wrapper ? [...wrapper, ...cmd] : cmd;
    const child = (spawnFn || spawn)(argv[0], argv.slice(1), { stdio: 'inherit', env, detached: Boolean(limits) });
    let kill = null, timer = null;
    const forward = sig => (limits ? killGroup(child.pid, sig) : child.kill(sig));   // without limits the child shares our group, as before
    // The limited job leaves our process group, so a watchdog outside it kills the job's group if this runner disappears (SIGKILL, OOM kill).
    let dog = null;
    if (limits && !spawnFn && child.pid) {
      const src = 'const [r,g]=process.argv.slice(1).map(Number);setInterval(()=>{try{process.kill(r,0)}catch{try{process.kill(-g,"SIGKILL")}catch{}process.exit(0)}try{process.kill(-g,0)}catch{process.exit(0)}},300);';
      dog = spawn(process.execPath, ['-e', src, String(process.pid), String(child.pid)], { detached: true, stdio: 'ignore' }); dog.unref(); dog.on('error', () => {});
    }
    const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP']; for (const s of sigs) process.on(s, forward);
    const done = code => { clearInterval(timer); if (dog) { try { dog.kill('SIGKILL'); } catch {} } for (const s of sigs) process.off(s, forward); if (limits) killGroup(child.pid); resolve({ code, kill }); };   // nothing left behind
    if (limits) timer = setInterval(() => {
      const used = rss(child.pid);
      if (!kill && used > limits.memory_mb * MB) { kill = killRecord({ klass, limitMb: limits.memory_mb, observedMb: Math.round(used / MB), id }); killGroup(child.pid); }
    }, intervalMs);
    child.on('error', () => done(127));
    child.on('exit', (c, s) => done(kill ? 137 : (c ?? (s ? 128 : 1))));
  });
}

// Waits until the decision is a grant (backpressure: no new admissions under pressure; running jobs are untouched).
export async function admit({ klass, request, cfg, readB = () => readBudget(cfg?.budget_file), sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 5000, timeoutMs = 3600000, now = () => Date.now(), onQueue = () => {} }) {
  const start = now(); let told = false;
  for (;;) {
    const d = decideGrant({ klass, request, budget: readB(), cfg });
    if (d.action === 'grant') return d;
    if (!told) { told = true; onQueue(d.reason); }
    if (now() - start >= timeoutMs) return { action: 'timeout', reason: d.reason };
    await sleep(pollMs);
  }
}
