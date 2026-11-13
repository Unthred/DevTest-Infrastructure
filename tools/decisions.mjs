#!/usr/bin/env node
// Issue #1229: the decision files. `index` regenerates docs/decisions/INDEX.md; `index --check` fails when it is stale;
// `approve <name> <comments.json>` is Foreman's approval step: it assigns the next D number once (REPO_OWNER names the approver).
// Usage: node tools/decisions.mjs index [--check] | approve <name> <comments.json>   (run from the repository root)
import fs from 'node:fs';
import { approvalsFrom } from '../supervisor/decisions.mjs';
import { writeIndex, indexIsCurrent, approveDecisionFile } from '../supervisor/decisionfilesio.mjs';

const [cmd, a, b] = process.argv.slice(2);
const root = process.cwd();
try {
  if (cmd === 'index' && a === '--check') {
    if (!indexIsCurrent(root)) { console.error('FAIL: docs/decisions/INDEX.md is stale; run node tools/decisions.mjs index'); process.exit(1); }
    console.log('OK: decision index is current');
  } else if (cmd === 'index' && !a) {
    writeIndex(root); console.log('wrote docs/decisions/INDEX.md');
  } else if (cmd === 'approve' && a && b) {
    const approvals = approvalsFrom(JSON.parse(fs.readFileSync(b, 'utf8')), process.env.REPO_OWNER || '');
    const r = approveDecisionFile(root, a, approvals);
    console.log(`${r.name}: ${r.number}${r.changed ? ' (assigned)' : ' (already assigned)'}`);
  } else { console.error('usage: decisions.mjs index [--check] | approve <name> <comments.json>'); process.exit(2); }
} catch (e) { console.error(`FAIL: ${e.message}`); process.exit(1); }
