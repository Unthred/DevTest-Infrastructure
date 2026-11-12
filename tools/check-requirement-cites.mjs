#!/usr/bin/env node
// Issue #1188: the author's last step before a push. Runs the same cite check the dispatcher gate runs, on the local branch.
// Usage: node tools/check-requirement-cites.mjs --body FILE [--issue FILE] [--base origin/main]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { citeProblemsMessage, citedPaths, requirementsCiteProblems } from '../supervisor/requirements-cites.mjs';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : null; };
const bodyFile = option('body');
if (!bodyFile) { console.error('usage: node tools/check-requirement-cites.mjs --body FILE [--issue FILE] [--base origin/main]'); process.exit(2); }

const base = option('base') || 'origin/main';
const body = fs.readFileSync(bodyFile, 'utf8');
const issueBody = option('issue') ? fs.readFileSync(option('issue'), 'utf8') : '';
const diff = execFileSync('git', ['diff', `${base}...HEAD`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const headFiles = new Map();
for (const path of citedPaths(body)) {
  try { headFiles.set(path, execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { headFiles.set(path, null); }
}
const problems = requirementsCiteProblems({ body, diff, headFiles, issueBody });
if (problems.length) { console.error(citeProblemsMessage(problems)); process.exit(1); }
console.log('requirements table cites match the pull request');
