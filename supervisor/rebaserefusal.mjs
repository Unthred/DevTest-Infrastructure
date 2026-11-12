// Issue #1193: a guarded rebase push that is refused (a lost commit or change) fails the same way on every retry, because the agent is told
// to report the refusal and not to push another way. The CLI leaves a note in the worktree's git directory; the dispatcher reads it after the
// job so it can stop retrying that head and ask the homeowner once, instead of launching two more agent runs that end the same way.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FILE = 'rebase-refused.json';
const NOTICE = fs.readFileSync(new URL('./rebase-refused-notice.txt', import.meta.url), 'utf8').trim();
const gitDir = worktree => {
  const r = spawnSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout.trim() : null;
};

// Best effort: a failure to write the note only means the old retry behaviour.
export function recordRefusal(worktree, { oldHead, reason, message }) {
  try {
    const dir = gitDir(worktree);
    if (dir) fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ oldHead, reason, message: String(message).slice(0, 600) }), { mode: 0o600 });
  } catch { /* see above */ }
}

// Issue #1207: a rebase the agent cannot finish (conflicts that are not mechanical, a check it may not fix, a tool denied) used to be
// reported only in chat, so the planner ran the same prompt again and got the same stop. The agent now records it with rebase-stop.
export const STOPPED = 'agent-stop';
export const STOP_STEP = fs.readFileSync(new URL('./rebase-stop-step.txt', import.meta.url), 'utf8').trim();   // the prompt sentence that tells the agent to call it
export function recordStop(worktree, { oldHead, message }) {
  recordRefusal(worktree, { oldHead, reason: STOPPED, message });
}

// The refusal for exactly this fetched head, or null. A note for another head belongs to an earlier try and is ignored.
export function readRefusal(worktree, oldHead) {
  try {
    const dir = worktree ? gitDir(worktree) : null;
    const note = dir ? JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) : null;
    return note && note.oldHead === oldHead && typeof note.reason === 'string' ? note : null;
  } catch { return null; }
}

// What the post-condition says when no new head was pushed. Marks the job as refused so it is not run a second time.
export function noHeadDetail(job, p) {
  const note = readRefusal(job.worktree, p.baseHead);
  if (!note) return 'no new head was pushed: the branch is unchanged';
  job.rebaseRefused = note.reason;
  job.incompleteRetries = Math.max(job.incompleteRetries || 0, 1);   // the one automatic run again would end the same way
  return note.reason === STOPPED ? 'the agent reported that it cannot finish this rebase, so no new head was pushed; a retry gives the same result'
    : `the guarded push was refused (${note.reason}), so no new head was pushed; a retry gives the same result`;
}

// After a refused rebase: spend the head's rebase attempts so the planner stops, and ask the homeowner once, with the guard's own words.
export async function holdRefusedRebase(team, id, j, job) {
  if (!job.rebaseRefused) return;
  const note = readRefusal(job.worktree, j.head);
  const left = team.c.limits.max_fix_attempts;
  if ((team.s.rebaseAttempts[j.key] || 0) < left) team.s.rebaseAttempts[j.key] = left;
  team.save();
  const text = note ? note.message : `the guard refused (${job.rebaseRefused})`;
  const what = note?.reason === STOPPED ? 'could not be finished by the agent, which stopped and reported why' : 'was resolved locally but the guarded push refused it, so nothing was pushed';
  const body = NOTICE.replace('{what}', () => what).replace('{base}', () => j.base || 'main').replace('{head}', () => team.commitRef(j.head)).replace('{message}', () => text);
  await team.postNotice(j.pr, `rebase-refused job=${id}`, body);
  await team.gh.addLabel(j.pr, 'needs-homeowner');
}
