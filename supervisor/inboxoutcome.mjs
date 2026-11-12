// Issue #1122: the status patch that records what an inbox job really did. Pure apart from reading the agent's summary file and the job transcript.
// Issue #1154: every failure carries a cause from a fixed list with its evidence; a read only prompt that changed nothing is done;
// a job that changed settings and ended before restoring them, or that spent most of its cap polling, is recorded on the status.
import fs from 'node:fs';
import path from 'node:path';
import * as robust from './robust.mjs';
import { reportNote } from './inboxreport.mjs';
import { loadItem } from './inbox.mjs';
import { judgeEnd, isReadOnlyPrompt } from './inboxcause.mjs';
import { changedLimits } from './inboxconfig.mjs';
import { pollingOf, pollingNote } from './inboxpolling.mjs';

// Done clears `reason` and `cause` (null), so a status repaired from an earlier false failure no longer shows the stale failure.
// `item` (or `inboxDir`, to load it) is the approved prompt for the read only test, `limits` the live team limits, `root` the state root (for the transcript).
export function inboxEndPatch({ id, j, job, teamDir, capMs, item = null, inboxDir = null, limits = null, root = null }) {
  let summary = '';
  if (job.status === 'completed') {
    try { summary = fs.readFileSync(path.join(teamDir, 'inbox', String(j.ticket || 'none'), 'inbox-result.txt'), 'utf8'); } catch { /* checked by the post-condition */ }
  }
  // Issue #995 part 4: a prompt that did not achieve its task ends failed, with the agent's own summary shown in the Inbox.
  const stopped = j.capStopped ? `stopped after the ${Math.round(capMs / 60000)}-minute inbox time cap (limits.inbox_max_minutes)` : `the job ended ${job.status}`;
  const outcome = job.status === 'completed' ? robust.inboxOutcome(summary) : { ok: false, why: stopped };
  const approved = item || (inboxDir && j.inboxId ? loadItem(inboxDir, j.inboxId).item : null);   // the item file is still there until this end makes it final
  const verdict = judgeEnd({ job, capStopped: !!j.capStopped, outcome, readOnly: !!approved && isReadOnlyPrompt(approved) });
  const result = verdict.ok ? summary.trim() : `${outcome.why}${summary.trim() ? `. Agent summary: ${summary.trim()}` : '; it left no summary'}`;
  // Issue #1147: the named report is checked for every ending (completed, failed, cancelled, cap-stopped);
  // a job that did not finish is the likeliest to leave a half-written report.
  const polling = root ? pollingOf({ root, jobId: id, capMs }) : null;
  const notes = [reportNote(j), polling ? pollingNote(polling) : ''].filter(Boolean);
  const changes = j.limitsBefore && limits ? changedLimits(j.limitsBefore, limits) : [];
  return {
    state: verdict.ok ? 'done' : 'failed', job: id.slice(0, 8),
    reason: verdict.ok ? null : outcome.why, cause: verdict.cause, evidence: verdict.ok ? null : verdict.evidence,
    result: [result, ...notes].join('\n'),
    polling, configChanges: changes.length ? changes : null,
  };
}
