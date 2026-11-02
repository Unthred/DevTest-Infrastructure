// Argument parsing for the dev-test CLI (issue #8). Pure: no I/O. Values are separate argv entries and are never interpreted by a shell.
import { PROFILES, STANDARD_PROFILES } from '../browser/capture.mjs';
import { CHECKS } from '../browser/responsive-lib.mjs';

export class UsageError extends Error { constructor(message) { super(message); this.name = 'UsageError'; } }

export const VERSION = '1.0.0';
export const CONTRACT_VERSION = 1;
export const BROWSERS = ['chromium', 'firefox', 'webkit'];
const GLOBAL = { '--json': 'flag', '--no-color': 'flag', '--run-dir': 'value', '--timeout': 'value', '--help': 'flag' };

// command name -> { options: name -> 'flag'|'value'|'repeat', required: [names], positionals: {min,max} }
export const COMMANDS = {
  version: { options: {}, required: [], positionals: [0, 0] },
  help: { options: {}, required: [], positionals: [0, 2] },
  doctor: { options: {}, required: [], positionals: [0, 0] },
  'dotnet build': { options: { '--sdk': 'value', '--project': 'value' }, required: ['--sdk', '--project'], positionals: [0, 0] },
  'dotnet test': { options: { '--sdk': 'value', '--project': 'value', '--coverage': 'flag' }, required: ['--sdk', '--project'], positionals: [0, 0] },
  'web screenshot': { options: { '--url': 'value', '--profile': 'value', '--browser': 'value', '--full-page': 'flag', '--root': 'value' }, required: ['--url', '--profile'], positionals: [0, 0] },
  'web responsive': { options: { '--url': 'value', '--profiles': 'value', '--browser': 'value', '--assert': 'repeat', '--root': 'value' }, required: ['--url', '--profiles'], positionals: [0, 0] },
  'web ha': { options: { '--live': 'flag', '--browser': 'value' }, required: [], positionals: [0, 0] },
  report: { options: {}, required: [], positionals: [1, 1] },
  cleanup: { options: { '--run-id': 'value', '--older-than': 'value', '--dry-run': 'flag' }, required: [], positionals: [0, 0] }
};

const RUN_ID = /^[a-f0-9]{16,32}$/;
export const isRunId = (v) => typeof v === 'string' && RUN_ID.test(v);

// "90" and "90s" are seconds; ms, m, h and d are accepted. Returns milliseconds.
export function parseDuration(text, label) {
  const m = /^(\d{1,9})(ms|s|m|h|d)?$/.exec(String(text));
  if (!m) throw new UsageError(`${label} must be a duration such as 90, 90s, 5m, 2h or 7d`);
  const ms = Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] ?? 's'];
  if (!Number.isSafeInteger(ms) || ms < 1) throw new UsageError(`${label} must be greater than zero`);
  return ms;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string' || /[\0\r\n]/.test(a))) throw new UsageError('arguments must be plain single-line strings');
  const words = [];
  let i = 0;
  while (i < argv.length && !argv[i].startsWith('-') && words.length < 2) {
    const candidate = [...words, argv[i]].join(' ');
    if (!(candidate in COMMANDS) && !Object.keys(COMMANDS).some((c) => c.startsWith(`${candidate} `))) break;
    words.push(argv[i++]);
  }
  // `help` takes positionals (a command name); everything else resolved as far as possible.
  if (words.length === 0 && argv[0] === undefined) return { command: 'help', options: {}, global: {}, positionals: [] };
  let command = words.join(' ');
  if (!(command in COMMANDS)) {
    if (argv[0]?.startsWith('-') && !['--help', '--version'].includes(argv[0])) throw new UsageError(`unknown option ${argv[0]} (expected a command; try: dev-test help)`);
    if (argv[0] === '--help') return { command: 'help', options: {}, global: {}, positionals: [] };
    if (argv[0] === '--version') return { command: 'version', options: {}, global: {}, positionals: [] };
    throw new UsageError(`unknown command ${JSON.stringify(words.length ? command : argv[0])} (try: dev-test help)`);
  }
  const spec = COMMANDS[command];
  const options = {}, global = {}, positionals = [];
  let help = false;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) throw new UsageError(`write ${arg.slice(0, eq)} and its value as two arguments (no "=")`);
    const kind = spec.options[arg] ?? GLOBAL[arg];
    if (!kind) throw new UsageError(`unknown option ${arg} for "${command}"`);
    const bucket = arg in GLOBAL && !(arg in spec.options) ? global : options;
    if (arg === '--help') { help = true; continue; }
    if (kind === 'flag') {
      if (arg in bucket) throw new UsageError(`${arg} given more than once`);
      bucket[arg] = true; continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--') || value === '') throw new UsageError(`missing value for ${arg}`);
    if (kind === 'repeat') (bucket[arg] ??= []).push(value);
    else { if (arg in bucket) throw new UsageError(`${arg} given more than once`); bucket[arg] = value; }
  }
  if (help) return { command: 'help', options: {}, global, positionals: command === 'help' ? positionals : command.split(' ') };
  if (positionals.length < spec.positionals[0] || positionals.length > spec.positionals[1]) throw new UsageError(`"${command}" takes ${spec.positionals[0] === spec.positionals[1] ? spec.positionals[0] : `${spec.positionals[0]}..${spec.positionals[1]}`} positional argument(s), got ${positionals.length}`);
  for (const r of spec.required) if (!(r in options)) throw new UsageError(`"${command}" requires ${r}`);
  validate(command, options);
  const g = { json: global['--json'] === true, noColor: global['--no-color'] === true };
  if ('--run-dir' in global) g.runDir = global['--run-dir'];
  if ('--timeout' in global) g.timeoutMs = parseDuration(global['--timeout'], '--timeout');
  return { command, options, global: g, positionals };
}

function validate(command, o) {
  if ('--sdk' in o && !['8', '9', '10'].includes(o['--sdk'])) throw new UsageError('--sdk must be 8, 9 or 10');
  if ('--browser' in o && !BROWSERS.includes(o['--browser'])) throw new UsageError(`--browser must be one of ${BROWSERS.join(', ')}`);
  if ('--profile' in o && !(o['--profile'] in PROFILES)) throw new UsageError(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`);
  if ('--profiles' in o) {
    const v = o['--profiles'];
    const names = v === 'standard' ? STANDARD_PROFILES : v === 'all' ? Object.keys(PROFILES) : v.split(',');
    if (!names.length || names.length > 20 || new Set(names).size !== names.length || !names.every((p) => p in PROFILES)) throw new UsageError('--profiles must be standard, all, or a comma list of unique known profiles');
  }
  if ('--assert' in o) for (const rule of o['--assert']) if (!(rule in CHECKS)) throw new UsageError(`--assert ${rule} is not a known rule (${Object.keys(CHECKS).join(', ')})`);
  if ('--run-id' in o && !isRunId(o['--run-id'])) throw new UsageError('--run-id must be a run id (16 to 32 lowercase hex characters)');
  if ('--older-than' in o) o.olderThanMs = parseDuration(o['--older-than'], '--older-than');
}
