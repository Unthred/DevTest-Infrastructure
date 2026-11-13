// Issue #1229: validate-project's check of docs/decisions: every file reads as a decision, no number is used twice, and the generated
// index matches the files. Returns findings in validate-project's { check, message } shape.
import fs from 'node:fs';
import path from 'node:path';
import { parseDecisionFiles, INDEX_FILE } from '../supervisor/decisionfiles.mjs';
import { readDecisionDir, indexIsCurrent } from '../supervisor/decisionfilesio.mjs';

export function decisionFileFindings(root) {
  const out = [];
  const add = message => out.push({ check: 'decision-files', message });
  const files = readDecisionDir(root);
  const parsed = parseDecisionFiles(files);
  for (const p of parsed) for (const m of p.problems) add(m);
  const seen = new Map();
  for (const p of parsed.filter(x => x.number)) seen.set(p.number, [...(seen.get(p.number) || []), p.name]);
  for (const [n, names] of seen) if (names.length > 1) add(`${n} is used by ${names.join(' and ')}`);
  const legacy = fs.existsSync(path.join(root, 'docs/DECISIONS.md')) ? fs.readFileSync(path.join(root, 'docs/DECISIONS.md'), 'utf8') : '';
  for (const p of parsed.filter(x => x.number)) if (new RegExp(`^## ${p.number} `, 'm').test(legacy)) add(`${p.name}: ${p.number} is already in docs/DECISIONS.md`);
  if (!indexIsCurrent(root)) add(`${INDEX_FILE} is not the generated index of the files; run node tools/decisions.mjs index`);
  return out;
}
