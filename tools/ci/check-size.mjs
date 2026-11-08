#!/usr/bin/env node
// Issue #1067: size check and ratchet for docs/coding-standards.md.
// Usage: node tools/ci/check-size.mjs [--root DIR] [--baseline FILE] [--update-baseline] [--init-baseline]
//   default            compare with the baseline, print the table; exit 1 on a failure, 0 otherwise (warnings never fail)
//   --update-baseline  write the baseline with shrunk units lowered (never raises a size)
//   --init-baseline    write a baseline listing every unit now over a threshold (first run, or a deliberate reset reviewed in the diff)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THRESHOLDS, measureFile } from './size-scan.mjs';
import { compare, updatedBaseline, fullBaseline } from './size-ratchet.mjs';

const EXT = /\.(mjs|js|cjs|cs|razor)$/;
const SKIP_DIR = /^(\.git|node_modules)$/;
const SKIP_PATH = /(^|\/)fixtures?\//;   // test fixtures are sample input, not project code

export function listSources(root) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) { if (!SKIP_PATH.test(`${rel}/`)) walk(full); } else if (EXT.test(e.name)) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

// Scan every source file. A file that cannot be tokenised is reported by name and fails the run.
export function scan(root) {
  const current = [];
  const stats = {};
  const errors = [];
  for (const name of listSources(root)) {
    try {
      const r = measureFile(name, fs.readFileSync(path.join(root, name), 'utf8'));
      current.push(...r.over);
      stats[name] = r.stats;
    } catch (e) { errors.push(`${name}: parse error: ${e.message}`); }
  }
  return { current, stats, errors };
}

function table(rows) {
  const head = ['unit', 'threshold', 'before', 'after', 'result'];
  const body = rows.map(r => [r.unit, String(r.threshold), String(r.before), String(r.size), r.result]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(w[i])).join(' | ');
  return [fmt(head), w.map(n => '-'.repeat(n)).join('-|-'), ...body.map(fmt)].join('\n');
}

// The table always lists the baselined files over the file threshold, so a PR with no change still shows unit, threshold, before, after.
function unchangedFiles(result, rows) {
  const listed = new Set(rows.map(r => r.unit));
  return Object.entries(result.units)
    .filter(([unit, u]) => u.kind === 'file' && !listed.has(unit))
    .map(([unit, u]) => ({ unit, threshold: u.threshold, before: u.size, size: u.size, result: 'unchanged' }));
}

function annotate(level, r, text) {
  const file = r.unit.split('::')[0];
  return process.env.GITHUB_ACTIONS ? `::${level} file=${file},line=${r.line}::${text}` : `${level}: ${r.unit} (line ${r.line}): ${text}`;
}

function writeBaseline(file, b) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${formatBaseline(b)}\n`);
}

function parseArgs(argv) {
  const o = { root: process.cwd(), baseline: null, update: false, init: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') o.root = path.resolve(argv[++i]);
    else if (argv[i] === '--baseline') o.baseline = path.resolve(argv[++i]);
    else if (argv[i] === '--update-baseline') o.update = true;
    else if (argv[i] === '--init-baseline') o.init = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  o.baseline ||= path.join(o.root, 'tools/ci/size-baseline.json');
  return o;
}

export function run(argv, out = console.log) {
  const o = parseArgs(argv);
  const { current, stats, errors } = scan(o.root);
  if (errors.length) { for (const e of errors) out(`ERROR ${e}`); return 1; }
  if (o.init) {
    writeBaseline(o.baseline, fullBaseline(current, stats, THRESHOLDS));
    out(`size baseline written: ${current.length} unit(s) over a threshold`);
    return 0;
  }
  const base = fs.existsSync(o.baseline) ? JSON.parse(fs.readFileSync(o.baseline, 'utf8')) : { thresholds: THRESHOLDS, units: {} };
  const result = compare(current, base);
  const rows = [
    ...result.failures.map(r => ({ ...r, result: `FAIL (${r.reason})` })),
    ...result.warnings.map(r => ({ ...r, result: 'warning (new, file not already over)' })),
    ...result.shrinks.map(r => ({ ...r, result: 'smaller' })),
  ];
  const tableRows = [...rows, ...unchangedFiles(result, rows)];
  out(table(tableRows));
  if (!rows.length) out('size check: no unit grew, crossed a threshold or shrank');
  for (const r of result.failures) {
    out(annotate('error', r, `${r.reason}: ${r.before} -> ${r.size} (threshold ${r.threshold}); put new behaviour in a new focused unit`));
  }
  for (const r of result.warnings) {
    out(annotate('warning', r, `${r.kind} is ${r.size}, threshold ${r.threshold}; judge whether responsibilities should be separated`));
  }
  const next = updatedBaseline(base, result, stats);
  if (o.update || result.shrinks.length) {
    if (o.update) { writeBaseline(o.baseline, next); out('baseline updated; commit it'); }
    else { out('Updated baseline (commit it with this change; node tools/ci/check-size.mjs --update-baseline writes it):'); out(formatBaseline(next)); }
  }
  out(`size check: ${result.failures.length} failure(s), ${result.warnings.length} warning(s), ${result.shrinks.length} smaller`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Size check\n\n\`\`\`\n${table(tableRows)}\n\`\`\`\n`);
  return result.failures.length ? 1 : 0;
}

// One unit per line keeps the diff of a baseline change readable.
export function formatBaseline(b) {
  const block = obj => Object.entries(obj).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  const head = `{\n  "version": ${b.version},\n  "thresholds": ${JSON.stringify(b.thresholds)},`;
  return `${head}\n  "files": {\n${block(b.files)}\n  },\n  "units": {\n${block(b.units)}\n  }\n}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (e) { console.error(`check-size: ${e.message}`); process.exitCode = 2; }
}
