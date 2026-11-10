// Issue #1122: the status patch that records what an inbox job really did. Pure apart from reading the agent's summary file.
import fs from 'node:fs';
import path from 'node:path';
import * as robust from './robust.mjs';

// Done clears `reason` (null), so a status repaired from an earlier false failure no longer shows the stale failure text.
export function inboxEndPatch({ id, j, job, teamDir, capMs }) {
  let summary = '';
  if (job.status === 'completed') {
    try { summary = fs.readFileSync(path.join(teamDir, 'inbox', String(j.ticket || 'none'), 'inbox-result.txt'), 'utf8'); } catch { /* checked by the post-condition */ }
  }
  // Issue #995 part 4: a prompt that did not achieve its task ends failed, with the agent's own summary shown in the Inbox.
  const stopped = j.capStopped ? `stopped after the ${Math.round(capMs / 60000)}-minute inbox time cap (limits.inbox_max_minutes)` : `the job ended ${job.status}`;
  const outcome = job.status === 'completed' ? robust.inboxOutcome(summary) : { ok: false, why: stopped };
  const result = outcome.ok ? summary.trim() : `${outcome.why}${summary.trim() ? `. Agent summary: ${summary.trim()}` : '; it left no summary'}`;
  return { state: outcome.ok ? 'done' : 'failed', job: id.slice(0, 8), reason: outcome.ok ? null : outcome.why, result };
}
