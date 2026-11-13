// Issue #1177: rows of the PR "Requirements check" table marked After install can only be checked once the change runs on Tower.
// They are recorded when the PR is reviewed; once the PR has merged and installed, each row is one Needs you item until it is marked done.
import { SupervisorError } from './core.mjs';
import { homeownerSteps } from './homeownersteps.mjs';
import { afterInstallRows } from './requirements-table.mjs';


const MAX_ROWS = 10;

// Records the rows of a PR description under its number. A row already marked done keeps its mark.
export function recordAfterInstall(steps, pr, head, body, at) {
  const rows = afterInstallRows(body).slice(0, MAX_ROWS).map(r => ({ requirement: r.requirement.slice(0, 300), evidence: r.evidence.slice(0, 300) }));
  if (!rows.length) { delete steps[pr]; return; }
  const done = new Set(steps[pr]?.done || []);
  steps[pr] = { head, rows, at, done: rows.map(r => r.requirement).filter(r => done.has(r)) };
}

export function markAfterInstallDone(steps, pr) {
  const entry = steps[pr];
  if (!entry) return false;
  entry.done = entry.rows.map(r => r.requirement);
  return true;
}

// Pure: Needs you items for merged and installed PRs with After install rows not yet done.
export function afterInstallItems({ steps = {}, merged = [], installed = new Set(), name = n => `PR #${n}`, url = () => null }) {
  const mergedPrs = new Set(merged.map(m => m.pr));
  const items = [];
  for (const [n, entry] of Object.entries(steps)) {
    const pr = Number(n);
    if (!mergedPrs.has(pr) || !installed.has(pr)) continue;
    const open = (entry.rows || []).filter(r => !(entry.done || []).includes(r.requirement));
    if (!open.length) continue;
    items.push({
      id: `after-install-${pr}`,
      text: `${name(pr)} is installed on Tower; ${open.length} check${open.length === 1 ? '' : 's'} can only be made now: ${open.slice(0, 3).map(r => r.requirement).join('; ')}`,
      ref: { kind: 'pull', n: pr },
      tried: 'The pull request marked these rows After install because they need the change running on Tower. Foreman cannot make them before the install.',
      action: `Make the check (${open.slice(0, 3).map(r => r.evidence).join('; ')}), then run: ai-agent --supervisor team after-install-done ${pr}`,
      links: url(pr) ? [{ text: name(pr), url: url(pr) }] : []
    });
  }
  return items;
}

// Both the PR description's "Homeowner steps" (issue #855) and its After install rows are recorded when the PR is reviewed.
export function recordPrSteps(s, pr, head, body, at) {
  const steps = homeownerSteps(body);
  if (steps.length) s.homeownerSteps[pr] = { head, steps: steps.slice(0, 10), at }; else delete s.homeownerSteps[pr];
  recordAfterInstall(s.afterInstallSteps ||= {}, pr, head, body, at);
}

// Throws when the PR has no After install rows recorded, so the homeowner is told instead of the command silently doing nothing.
export function markDone(s, pr) {
  if (!markAfterInstallDone(s.afterInstallSteps ||= {}, pr)) throw new SupervisorError(`pull request #${pr} has no After install checks recorded`);
}
