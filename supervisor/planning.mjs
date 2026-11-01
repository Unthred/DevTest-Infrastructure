// One definition of what the planner is told (issue #121): the tick, `team status`, `team tick --dry-run` and the dashboard all
// build their allowance inputs here, so none of them can plan from a different allowance than the others did.
// Pure apart from `readRegister`; the caller supplies jobs, the cached probes, snapshots and parsed job events.
import { spawnSync } from 'node:child_process';
import { latestAllowance } from './dashdata.mjs';
import { outOfAllowance } from './interim.mjs';
import { weeklyUtilization } from './models.mjs';
import { weeklyAtOf } from './team.mjs';

// jobs: job records. probes: the tick cache's model-free allowance probes. events: [{ job, kind }] (the usage_limit evidence).
// hadLimit(id) may replace the events lookup (the tick reads a job's events only when asked).
// Returns the Team constructor inputs that depend on allowance: { allowances, allowanceOf, limitedOf, usage }.
export function planningInputs({ config, jobs, probes = {}, snapshots = [], events = [], hadLimit = null, now = Date.now() }) {
  const allowances = latestAllowance(jobs, probes);
  const providerOf = agent => config.agents[agent].provider;
  const allowanceOf = agent => weeklyUtilization(allowances[providerOf(agent)]);
  const limitedJobs = new Set(events.filter(e => e.kind === 'usage_limit').map(e => e.job));
  // Whether an agent is out of allowance, from provider-reported records and its latest supervised job only.
  const limited = {};
  const limitedOf = agent => (limited[agent] ??= outOfAllowance({ provider: providerOf(agent), jobs, allowance: allowances[providerOf(agent)] ?? null,
    weeklyAt: weeklyAtOf(config), now, hadLimit: hadLimit || (id => limitedJobs.has(id)) }));
  return { allowances, allowanceOf, limitedOf, usage: { allowance: allowances, jobs, snapshots } };
}

// The decision register that counts is the one merged into main, not a working copy. Returns '' when it cannot be read.
export function readRegister(config) {
  const shown = spawnSync('git', ['-C', config.repo_path, 'show', 'origin/main:docs/DECISIONS.md'], { encoding: 'utf8', timeout: 30000 });
  return shown.status === 0 ? shown.stdout : '';
}
