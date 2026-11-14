// Issue #1375: the two GitHub calls of the CI rerun, for githubClient. Arguments go as an array to gh (no shell); the run id is shape-checked first.
import { SupervisorError } from './core.mjs';

export const ciRerunCalls = (repo, gh, json) => ({
  // Only the failed jobs of a run are rerun. Not retried: the response may be lost after GitHub accepted it, and the head is rerun once.
  rerunFailedJobs: async runId => {
    if (!/^\d+$/.test(String(runId))) throw new SupervisorError('invalid run id');
    gh(['run', 'rerun', String(runId), '--failed', '--repo', repo], undefined, { retry: false });
  },
  // The one read of main's CI status per tick: the check runs of main's newest commit.
  mainCheckRuns: async () => json(['api', '--method', 'GET', `repos/${repo}/commits/main/check-runs`, '-f', 'per_page=100'])?.check_runs || [],
});
