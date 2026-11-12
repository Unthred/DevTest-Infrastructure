// Issue #1122 requirement 3: before the fix, a second attempt on an already claimed prompt wrote "failed: the item is not an approved prompt"
// over the real status, so the finished job was never written back. This finds those false failures and has the caller re-derive the real
// outcome (done or failed, with the agent's summary) from the job itself. A real failure never carries this exact reason, so it is never touched.
import * as inboxStore from './inbox.mjs';
import { backfillFailures } from './inboxbackfill.mjs';

export const FALSE_FAILURE_REASON = 'the item is not an approved prompt';

// The job a false failure belongs to: the full id and its record, from the team state or from the adopt record the fast lane left in the status.
export function jobOfFalseFailure(st, jobs) {
  const prefix = String(st.job || st.adopt?.id || '').slice(0, 8);
  if (prefix.length < 8) return null;
  const id = Object.keys(jobs || {}).find(k => k.startsWith(prefix) && jobs[k]?.inboxId === st.id);
  if (id) return { id, rec: jobs[id] };
  if (st.adopt?.id?.startsWith(prefix) && st.adopt.rec?.inboxId === st.id) return { id: st.adopt.id, rec: st.adopt.rec };
  return null;
}

export const isFalseFailure = st => st?.kind === 'prompt' && st.state === 'failed' && st.reason === FALSE_FAILURE_REASON;

// Returns one report action per repair. `getJob` reads the live job; `ingest(id, rec, job)` writes the real outcome. A job that has not ended is left
// alone (its own ingestion will write the outcome), and a failure with no recorded job stays failed: it is not provably false.
export async function repairFalseFailures({ inboxDir, jobs, getJob, ingest, terminal }) {
  const repaired = [];
  for (const st of inboxStore.allStatuses(inboxDir)) {
    if (!isFalseFailure(st)) continue;
    const found = jobOfFalseFailure(st, jobs);
    if (!found) continue;
    const job = await getJob(found.id);
    if (!job || !terminal.has(job.status)) continue;
    ingest(found.id, found.rec, job);
    repaired.push({ type: 'inbox-status-repaired', result: `proposal ${st.id.slice(0, 8)}: false failure replaced by the job's real outcome` });
  }
  return repaired;
}

// The Team's wiring for the repair, so the Team itself only makes one call.
export async function repairInbox(team, dir, report, terminal) {
  const repaired = await repairFalseFailures({
    inboxDir: dir,
    jobs: team.s.jobs,
    getJob: id => team.jobs.get(id),
    ingest: (id, rec, job) => team.ingestInbox(id, rec, job),
    terminal,
  });
  (report.actions ||= []).push(...repaired);
  backfillFailures(inboxStore, dir, team.clock.now());   // issue #1154: a cause on every failure; read only prompts that changed nothing put right
}
