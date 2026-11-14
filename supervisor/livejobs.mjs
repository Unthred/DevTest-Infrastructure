// Live (not ended) jobs working on an issue or pull request number, as short ids. Shared by the park control and close_superseded.
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'stopped', 'waiting_on']);

export async function liveJobsFor(n, { jobs, records }) {
  const ids = Object.keys(records).filter(id => records[id].pr === n || records[id].issue === n);
  const live = [];
  for (const id of ids) { const job = await jobs.get(id).catch(() => null); if (job && !TERMINAL.has(job.status)) live.push(id.slice(0, 8)); }
  return live;
}
