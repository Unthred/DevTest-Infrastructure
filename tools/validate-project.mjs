#!/usr/bin/env node
// Validates the DevTest Infrastructure project contract: required files, the decision register, the handover,
// agent entry points, machine-readable contracts, secrets, Docker-socket/privileged use and image pinning.
// Usage: node tools/validate-project.mjs [root]    Exit 0 = valid, 1 = findings, 2 = usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_FILES = [
  'README.md', 'AGENTS.md', 'CLAUDE.md',
  'docs/architecture.md', 'docs/DECISIONS.md', 'docs/cli-contract.md',
  'docs/agent-provider-contract.md', 'docs/acceptance-gates.md', 'docs/ai/CURRENT_HANDOVER.md',
  'contracts/cli.v1.json', 'contracts/provider-manifest.v1.schema.json', 'contracts/verdict.v1.schema.json'
];
const STATUSES = new Set(['homeowner-approved', 'agent-proposal', 'temporary-note']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TEXT_EXT = new Set(['.md', '.json', '.yml', '.yaml', '.sh', '.mjs', '.js', '.ts', '.cs', '.csproj', '.txt', '.toml', '.env', '']);

// Secret shapes. Test fixtures build these strings at run time so this file never contains one.
const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ['OpenBao/Vault token', /\b(?:hvs|hvb|s)\.[A-Za-z0-9]{24,}\b/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ['assigned credential', /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?(?!<|\$|\{|%|\*|REDACTED|changeme|example|your)[A-Za-z0-9/+_.=-]{12,}/i]
];

function walk(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(root, full, out);
    else out.push(full);
  }
  return out;
}
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');
const isText = (file) => TEXT_EXT.has(path.extname(file).toLowerCase()) || /^(Dockerfile|Makefile)/.test(path.basename(file));

function parseDecisions(text) {
  const entries = [];
  const re = /^## (D-\d{3}) — (.+)$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const body = text.slice(m.index + m[0].length, i + 1 < heads.length ? heads[i + 1].index : text.length);
    const field = (name) => (body.match(new RegExp(`^- ${name}: (.*)$`, 'm')) || [])[1]?.trim();
    entries.push({ id: m[1], title: m[2], status: field('Status'), date: field('Date'), source: field('Source'),
      decision: field('Decision'), rationale: field('Rationale'), rejected: field('Rejected'), superseded: field('Superseded-by') });
  });
  return entries;
}

function checkSchema(value, schema, defs, where, errors) {
  if (schema.$ref) return checkSchema(value, defs[schema.$ref.replace('#/$defs/', '')], defs, where, errors);
  if ('const' in schema && value !== schema.const) errors.push(`${where}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (schema.type === 'string') {
    if (typeof value !== 'string') return errors.push(`${where}: must be a string`);
    if (schema.minLength && value.length < schema.minLength) errors.push(`${where}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: does not match ${schema.pattern}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return errors.push(`${where}: must be an array`);
    if (schema.items) value.forEach((v, i) => checkSchema(v, schema.items, defs, `${where}[${i}]`, errors));
  } else if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return errors.push(`${where}: must be an object`);
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${where}: missing required "${key}"`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key]) checkSchema(v, schema.properties[key], defs, `${where}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${where}: unknown field "${key}"`);
    }
  }
}

export function validate(root) {
  const findings = [];
  const add = (check, message) => findings.push({ check, message });

  for (const f of REQUIRED_FILES) if (!fs.existsSync(path.join(root, f))) add('required-files', `missing ${f}`);
  const has = (f) => fs.existsSync(path.join(root, f));

  // Decision register
  if (has('docs/DECISIONS.md')) {
    const entries = parseDecisions(read(root, 'docs/DECISIONS.md'));
    if (entries.length === 0) add('decisions', 'no decision entries found');
    const ids = new Set();
    for (const e of entries) {
      if (ids.has(e.id)) add('decisions', `duplicate id ${e.id}`);
      ids.add(e.id);
      if (!STATUSES.has(e.status)) add('decisions', `${e.id}: invalid status "${e.status}"`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) add('decisions', `${e.id}: date must be YYYY-MM-DD`);
      for (const k of ['source', 'decision', 'rationale', 'rejected', 'superseded']) if (!e[k]) add('decisions', `${e.id}: missing ${k}`);
      if (e.status === 'homeowner-approved' && e.source && /^(?:none|n\/a|agent)/i.test(e.source)) add('decisions', `${e.id}: homeowner-approved needs a real source`);
    }
    for (const e of entries) {
      if (e.superseded && !/^none$/i.test(e.superseded) && !ids.has(e.superseded.split(/[\s,]/)[0])) add('decisions', `${e.id}: Superseded-by "${e.superseded}" does not exist`);
    }
    const nums = entries.map((e) => Number(e.id.slice(2)));
    if (nums.some((n, i) => i > 0 && n !== nums[i - 1] + 1)) add('decisions', 'ids must be consecutive and in order');
  }

  // Handover
  if (has('docs/ai/CURRENT_HANDOVER.md')) {
    const text = read(root, 'docs/ai/CURRENT_HANDOVER.md');
    if (!/docs\/DECISIONS\.md|\.\.\/DECISIONS\.md/.test(text.split('\n').slice(0, 15).join('\n'))) add('handover', 'must link the decision register within the first 15 lines');
    for (const state of ['implemented in source', 'CI/review passed', 'deployed', 'verified working']) {
      if (!text.toLowerCase().includes(state.toLowerCase())) add('handover', `completion state "${state}" not reported`);
    }
    for (const h of ['Blockers', 'Next actions']) if (!new RegExp(`^## ${h}`, 'm').test(text)) add('handover', `missing "## ${h}" section`);
    // A raw HTML document (for example a service error page pasted from command output) does not belong in the handover.
    const html = text.split('\n').findIndex((l) => /^\s*<(?:!doctype\s+html|html|\/html|head|body)\b/i.test(l));
    if (html !== -1) add('handover', `contains a raw HTML document at line ${html + 1}; remove pasted command output`);
  }

  // Entry points
  if (has('CLAUDE.md') && read(root, 'CLAUDE.md').split('\n').find((l) => l.trim()) !== '@AGENTS.md') add('entrypoints', 'CLAUDE.md must contain @AGENTS.md as its first line');
  if (has('AGENTS.md')) {
    const text = read(root, 'AGENTS.md');
    for (const [needle, why] of [['docs/DECISIONS.md', 'decision register'], ['docs/ai/CURRENT_HANDOVER.md', 'canonical handover'], ['One writer per worktree', 'worktree rule'],
      ['OpenBao', 'secrets rule'], ['Docker socket', 'Docker socket rule'], ['Opposite-agent review', 'review rule'], ['dev-test', 'single CLI'], ['No AI attribution', 'attribution rule'], ['D-023', 'main-only handover rule']]) {
      if (!text.includes(needle)) add('entrypoints', `AGENTS.md must state the ${why} ("${needle}")`);
    }
  }

  // Contracts
  let cli = null;
  if (has('contracts/cli.v1.json')) {
    try { cli = JSON.parse(read(root, 'contracts/cli.v1.json')); } catch (e) { add('contracts', `cli.v1.json is not valid JSON: ${e.message}`); }
  }
  if (cli) {
    const codes = (cli.exit_codes || []).map((c) => c.code);
    if (new Set(codes).size !== codes.length) add('contracts', 'duplicate exit code in cli.v1.json');
    if (!codes.includes(0)) add('contracts', 'exit code 0 missing');
    if (has('docs/cli-contract.md')) {
      const doc = read(root, 'docs/cli-contract.md');
      const section = doc.split(/^## Exit codes$/m)[1]?.split(/^## /m)[0] || '';
      const docCodes = [...section.matchAll(/^\| (\d+) \| (\w+) \|/gm)].map((m) => `${m[1]}:${m[2]}`);
      const jsonCodes = (cli.exit_codes || []).map((c) => `${c.code}:${c.name}`);
      if (docCodes.join() !== jsonCodes.join()) add('contracts', `docs/cli-contract.md exit codes (${docCodes.join(' ')}) differ from cli.v1.json (${jsonCodes.join(' ')})`);
    }
  }
  if (has('contracts/provider-manifest.v1.schema.json')) {
    let schema = null;
    try { schema = JSON.parse(read(root, 'contracts/provider-manifest.v1.schema.json')); } catch (e) { add('contracts', `provider schema is not valid JSON: ${e.message}`); }
    if (schema) {
      const dir = path.join(root, 'contracts/examples');
      const examples = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.provider.json')) : [];
      if (examples.length === 0) add('contracts', 'no provider examples');
      for (const f of examples) {
        const errors = [];
        try { checkSchema(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), schema, schema.$defs || {}, f, errors); } catch (e) { errors.push(`${f}: ${e.message}`); }
        for (const err of errors) add('contracts', `example ${err}`);
      }
    }
  }

  // Repository-wide scans
  const prose = (file) => file.endsWith('.md');
  const prohibition = /\b(never|no|not|forbid|forbidden|prohibit|prohibited|without|reject|rejects|refuse|refused|must not|don't|do not)\b/i;
  for (const file of walk(root)) {
    if (!isText(file)) continue;
    const name = rel(root, file);
    if (name === 'tools/validate-project.mjs') continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const at = `${name}:${i + 1}`;
      for (const [label, re] of SECRET_PATTERNS) if (re.test(line)) add('secrets', `${at}: possible ${label}`);
      for (const [needle, label] of [[/docker\.sock/, 'Docker socket'], [/--privileged\b|privileged:\s*true/, 'privileged container']]) {
        if (needle.test(line) && !(prose(file) && prohibition.test(line))) add('docker-safety', `${at}: ${label} reference outside a prohibition`);
      }
      // Image references: Dockerfile FROM lines and YAML image: keys only (not source code that happens to contain "from").
      const base = path.basename(file);
      const ext = path.extname(file).toLowerCase();
      let ref;
      if (/^Dockerfile/.test(base)) ref = (line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i) || [])[1];
      else if (ext === '.yml' || ext === '.yaml') ref = (line.match(/^\s*(?:-\s*)?image:\s*["']?([^\s"']+)/) || [])[1];
      if (ref && ref.toLowerCase() !== 'scratch' && !/@sha256:[0-9a-f]{64}$/.test(ref) && !ref.startsWith('$') && !/^[A-Za-z_][\w-]*$/.test(ref)) add('image-pinning', `${at}: image "${ref}" is not pinned by digest`);
    });
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (!fs.existsSync(root)) { console.error(`validate-project: no such directory: ${root}`); process.exit(2); }
  const findings = validate(root);
  for (const f of findings) console.error(`FAIL [${f.check}] ${f.message}`);
  if (findings.length) { console.error(`${findings.length} finding(s)`); process.exit(1); }
  console.log('validate-project: OK');
}
