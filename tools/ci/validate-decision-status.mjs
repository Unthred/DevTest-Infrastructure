#!/usr/bin/env node
// Issue #303: an agent may add decisions only as agent-proposal; a change to or from homeowner-approved needs a verifiable homeowner approval.
// Usage: node tools/ci/validate-decision-status.mjs <base-ref> <head-ref> [approvals.json]
// approvals.json: [{ login, body, url, id }] PR/issue comments, fetched by the workflow; OWNER is the repository owner's login.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decisionViolations, approvalsFrom } from '../../supervisor/decisions.mjs';
import { decisionFileViolations, addedLegacyEntries } from '../../supervisor/decisionfiles.mjs';
import { readDecisionRef } from '../../supervisor/decisionfilesio.mjs';

const [base, head, file] = process.argv.slice(2);
if (!base || !head) { console.error('usage: validate-decision-status.mjs <base-ref> <head-ref> [approvals.json]'); process.exit(2); }
const show = ref => { const r = spawnSync('git', ['show', `${ref}:docs/DECISIONS.md`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
const b = show(base), h = show(head);
if (b === null || h === null) { console.error('FAIL: cannot read docs/DECISIONS.md at both refs; the register was not checked'); process.exit(1); }
let comments = [];
if (file) { try { comments = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.error('FAIL: approvals file unreadable; treated as no approval'); } }
const approvals = approvalsFrom(comments, process.env.REPO_OWNER || '');
const bad = decisionViolations(b, h, approvals);
// Issue #1229: the register is frozen (a new decision is a file), and each decision file is checked like a register entry.
for (const id of addedLegacyEntries(b, h)) bad.push(`${id} is added to the frozen docs/DECISIONS.md; propose a decision as docs/decisions/<issue>-<slug>.md with no number`);
bad.push(...decisionFileViolations(readDecisionRef('.', base), readDecisionRef('.', head), approvals));
if (bad.length) { for (const x of bad) console.error(`FAIL: ${x}`); process.exit(1); }
console.log('OK: validate-decision-status');
