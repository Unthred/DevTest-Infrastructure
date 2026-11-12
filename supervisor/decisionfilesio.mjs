// Issue #1229: reads the decision files from a directory or a git ref and carries out an approval. The decisions are in decisionfiles.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DECISIONS_DIR, INDEX_FILE, parseDecisionFiles, approveText, renderIndex, decisionName } from './decisionfiles.mjs';

// file path (docs/decisions/x.md) -> text, from a working directory. INDEX.md and the README are not decisions.
export function readDecisionDir(root) {
  const dir = path.join(root, DECISIONS_DIR);
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.md') && f !== 'INDEX.md' && f !== 'README.md') out.set(`${DECISIONS_DIR}/${f}`, fs.readFileSync(path.join(dir, f), 'utf8'));
  return out;
}

// The same map from a git ref ('' when the ref cannot be read, so an unreadable head adds no proposal).
export function readDecisionRef(repoPath, ref) {
  const out = new Map();
  const list = spawnSync('git', ['-C', repoPath, 'ls-tree', '--name-only', ref, `${DECISIONS_DIR}/`], { encoding: 'utf8', timeout: 30000 });
  if (list.status !== 0) return out;
  for (const file of list.stdout.split('\n').filter(f => f.endsWith('.md') && f !== INDEX_FILE && f !== `${DECISIONS_DIR}/README.md`)) {
    const shown = spawnSync('git', ['-C', repoPath, 'show', `${ref}:${file}`], { encoding: 'utf8', timeout: 30000 });
    if (shown.status === 0) out.set(file, shown.stdout);
  }
  return out;
}

export const indexIsCurrent = root => {
  const want = renderIndex(parseDecisionFiles(readDecisionDir(root)));
  const have = fs.existsSync(path.join(root, INDEX_FILE)) ? fs.readFileSync(path.join(root, INDEX_FILE), 'utf8') : '';
  return have === want;
};

export function writeIndex(root) {
  fs.mkdirSync(path.join(root, DECISIONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, INDEX_FILE), renderIndex(parseDecisionFiles(readDecisionDir(root))));
}

// Foreman's approval step: the repository owner's recorded approval (approvals = approvalsFrom(...)) assigns the next number once, writes
// it into the file and regenerates the index. A second call changes nothing. Refuses a name with no recorded approval.
export function approveDecisionFile(root, name, approvals) {
  const list = approvals.get(decisionName(name)) || [];
  if (!list.length) throw new Error(`no recorded homeowner approval for ${name} ("homeowner-approval: ${name}" by the repository owner)`);
  const file = `${DECISIONS_DIR}/${decisionName(name)}.md`;
  const files = readDecisionDir(root);
  if (!files.has(file)) throw new Error(`no decision file ${file}`);
  const legacy = fs.readFileSync(path.join(root, 'docs/DECISIONS.md'), 'utf8');
  const link = list[list.length - 1].url;
  const res = approveText(decisionName(name), files.get(file), parseDecisionFiles(files), legacy, link);
  if (res.changed) fs.writeFileSync(path.join(root, file), res.text);
  writeIndex(root);
  return { name: decisionName(name), number: res.number, changed: res.changed };
}

