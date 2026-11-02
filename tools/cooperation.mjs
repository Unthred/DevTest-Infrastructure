#!/usr/bin/env node
// Cooperative-work checks for parallel agents (issue #9, D-011, D-018, D-023). Pure functions plus a small CLI.
// Usage: node tools/cooperation.mjs --branch B [--worktree PATH] [--files a,b | --base REF] [--others pulls.json]
//   pulls.json: [{ "number": 3, "headRefName": "codex/issue-4-x", "files": [{ "path": "a" }] }]  (gh pr list --json number,headRefName,files)
// Exit 0 = no conflict, 1 = findings, 2 = usage.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BRANCH_RE = /^([a-z][a-z0-9]*)\/issue-(\d+)-([a-z0-9][a-z0-9-]*)$/;
// Files only one open branch may change at a time. A second branch touching one waits for the first to merge.
export const EXCLUSIVE = [
  [/^supervisor\/migrations\//, 'migration'],
  [/^supervisor\/migrations\.mjs$/, 'migration'],
  [/^broker\//, 'secret handling'],
  [/^docs\/secrets\.md$/, 'secret handling'],
  [/(^|\/)\.env(\.|$)|\.(pem|key)$|(^|\/)secrets?\.(json|ya?ml|env)$/, 'secret material'],
  [/^docker\/images\.lock/, 'image lock'],
  [/^docs\/DECISIONS\.md$/, 'decision register'],
  [/^docs\/ai\/CURRENT_HANDOVER\.md$/, 'handover (main only, D-023)']
];

export function parseBranch(name) {
  const m = BRANCH_RE.exec(name || '');
  return m ? { agent: m[1], issue: Number(m[2]), slug: m[3] } : null;
}
export const worktreeName = (agent, issue) => `DevTest-Infrastructure-${agent}-${issue}`;
export const exclusiveKind = (file) => EXCLUSIVE.find(([re]) => re.test(file))?.[1] || null;

// Branch name and worktree directory must agree, so ownership is visible from the path.
export function checkIdentity(branch, worktree) {
  const out = [];
  const b = parseBranch(branch);
  if (!b) { out.push(`branch "${branch}" does not match <agent>/issue-<n>-<slug> (D-018)`); return out; }
  if (worktree) {
    const base = path.basename(worktree.replace(/\/+$/, ''));
    if (base !== worktreeName(b.agent, b.issue)) out.push(`worktree "${base}" must be ${worktreeName(b.agent, b.issue)} for branch ${branch} (one writer per worktree, D-011)`);
  }
  return out;
}

// others: [{ number, headRefName, files: [{path}|string] }]. Returns findings against the other open branches.
export function checkConflicts(branch, files, others) {
  const out = [];
  const mine = parseBranch(branch);
  for (const o of others || []) {
    if (o.headRefName === branch) continue;
    const theirs = parseBranch(o.headRefName);
    if (mine && theirs && mine.issue === theirs.issue) out.push(`issue #${mine.issue} is already owned by PR #${o.number} (${o.headRefName}); one owner per issue`);
    const their = new Set((o.files || []).map((f) => (typeof f === 'string' ? f : f.path)));
    for (const f of files) {
      const kind = exclusiveKind(f);
      if (kind && their.has(f)) out.push(`${f} (${kind}) is also changed by PR #${o.number} (${o.headRefName}); wait for it to merge, then rebase`);
    }
  }
  return out;
}

export function check({ branch, worktree, files = [], others = [] }) {
  return [...checkIdentity(branch, worktree), ...checkConflicts(branch, files, others)];
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) { console.error(`cooperation: bad argument ${argv[i]}`); return 2; }
    opt[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opt.branch) { console.error('cooperation: --branch is required'); return 2; }
  let files = [];
  if (opt.files !== undefined) files = opt.files.split(',').filter(Boolean);
  else if (opt.base) {
    const r = spawnSync('git', ['diff', '--name-only', '--no-renames', `${opt.base}...HEAD`], { encoding: 'utf8' });
    if (r.status !== 0) { console.error('cooperation: git diff failed; nothing was checked'); return 2; }
    files = r.stdout.split('\n').filter(Boolean);
  }
  let others = [];
  if (opt.others) {
    try { others = JSON.parse(fs.readFileSync(opt.others, 'utf8')); if (!Array.isArray(others)) throw new Error('not an array'); }
    catch (e) { console.error(`cooperation: cannot read --others: ${e.message}`); return 2; }
  }
  const findings = check({ branch: opt.branch, worktree: opt.worktree, files, others });
  for (const f of findings) console.error(`FAIL ${f}`);
  if (findings.length) return 1;
  console.log('cooperation: OK');
  return 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
