// Issue #1223: a resume check that throws on every tick for 3 ticks is a Needs you item naming the job and the message.
// The worker (drive) records each failure on the job record (gateerror.mjs); each tick counts the ticks that saw a new failure.
export const FAILING_TICKS = 3;

// state.resumeChecks: { [jobId]: { message, ticks, since, lastTickAt } }. A tick counts for a job only when its check failed since the
// previous tick; a job whose check did not fail since then, or that is no longer paused, is dropped. Returns the rows to report.
export function tallyResumeChecks(state, paused, now) {
  const prev = state.resumeChecks || {}, next = {}, rows = [];
  for (const job of paused) {
    const c = job.resumeCheck, old = prev[job.id];
    if (!c || !Number.isFinite(c.lastAt)) continue;
    if (old && c.lastAt <= old.lastTickAt) continue;   // no new failure since the last tick: the run of failing ticks ends
    const same = old && old.message === c.message;
    const ticks = same ? old.ticks + 1 : 1;
    const ref = Number.isSafeInteger(job.issue) ? job.issue : null;
    next[job.id] = { job: job.id, ref, message: c.message, ticks, since: same ? old.since : c.firstAt, lastTickAt: now };
    rows.push(next[job.id]);
  }
  state.resumeChecks = next;
  return rows;
}

// The Needs you items for jobs whose check has failed on FAILING_TICKS ticks in a row.
export function resumeCheckItems(state) {
  return Object.values(state.resumeChecks || {}).filter(r => r.ticks >= FAILING_TICKS).map(r => ({
    id: `resume-check-${r.job.slice(0, 8)}`, ref: null, since: r.since,
    text: `The resume check of paused job ${r.job.slice(0, 8)} has failed on ${r.ticks} ticks in a row: ${r.message}`,
    action: `Read the job (ai-supervisor status ${r.job}); the job is not resumed while its check throws.` }));
}

// One tick's pass over the paused jobs: reads each paused job's record and tallies the ones whose resume check threw since the last tick.
// The rows are listed in the tick report (`resumeChecks`) with the message, so the tick record says why a paused job has not resumed.
export async function checkResumeChecks(team, report) {
  const paused = [];
  for (const a of await team.jobs.listActive()) {
    if (a.status !== 'paused_limit') continue;
    const job = await team.jobs.get(a.id);
    if (job) paused.push(job);
  }
  const rows = tallyResumeChecks(team.s, paused, team.clock.now());
  if (rows.length) report.resumeChecks = rows.slice(0, 10).map(r => ({
      job: r.job.slice(0, 8), ref: r.ref, message: r.message, ticks: r.ticks }));
}
