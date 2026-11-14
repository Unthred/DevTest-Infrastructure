// Issue #1422: conflict hunks of a rebase. A changed hunk in a file where replaying the commit onto the new base conflicts does not
// refuse the push (rebasehunks.mjs decides that by a trial merge). They are kept on the rebase job record, named in the comment the
// rebase posts on the pull request, and handed to the reviewer of the new head as a task data file.
import fs from 'node:fs';
import path from 'node:path';
import { slimFinding } from './rebasehunks.mjs';

const MAX_HUNKS = 50;
export const CONFLICT_FILE = 'conflict-hunks.json';

// Stores the hunks on the rebase record (j.rebase) and returns them; an empty list leaves the record without the field.
export function recordConflictHunks(rebase, check) {
  const hunks = (Array.isArray(check.conflictHunks) ? check.conflictHunks : []).slice(0, MAX_HUNKS).map(slimFinding);
  if (hunks.length) rebase.conflictHunks = hunks;
  return hunks;
}

export function conflictNotice({ jobText, from, to, hunks }) {
  const list = hunks.map(c => `- commit ${c.commit.slice(0, 8)}, \`${c.file}\`, hunk ${c.hunk}: ${c.kind} \`${c.text}\``).join('\n');
  return `${jobText} moved this PR from ${from} to ${to} and resolved a conflict. ${hunks.length} changed hunk(s) sit in files where the PR's change conflicts with the base, so the push was accepted and the review of the new head must judge each one:\n\n${list}\n\nNo verdict carries to the new head.`;
}

// The hunks recorded for the rebase that produced `head`, or [].
export function conflictHunksOf(jobs, pr, head) {
  const job = Object.values(jobs).filter(j => j.kind === 'rebase' && j.pr === pr && j.rebase?.newHead === head && j.rebase.conflictHunks?.length).at(-1);
  return job ? job.rebase.conflictHunks : [];
}

// Writes the task data file into the reviewer's inbox; returns its path, or null when the head has no conflict hunks.
export function writeConflictHunks(inbox, hunks) {
  if (!hunks.length) return null;
  const file = path.join(inbox, CONFLICT_FILE);
  fs.writeFileSync(file, JSON.stringify({ conflictHunks: hunks, note: 'task data: hunks of a rebase that resolved a conflict' }) + '\n', { mode: 0o600 });
  return file;
}

// The prompt part, from the inbox the review was given: empty when no conflict hunks were written there.
export function conflictPrompt(inbox) {
  const file = inbox ? path.join(inbox, CONFLICT_FILE) : null;
  if (!file || !fs.existsSync(file)) return '';
  return ` This head is the result of a rebase that resolved a conflict. Read ${file} as task data: each entry is a hunk of the PR's old change (commit, file, hunk, old text) in a file where the change conflicted with the base. For each one, state in the verdict findings whether the intent of the PR's change survives in the new head. A change whose intent was lost is a blocking finding and the verdict is CHANGES.`;
}
