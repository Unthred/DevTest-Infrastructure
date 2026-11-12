// Issue #1155: a step only the homeowner can do (a merged PR's "Homeowner steps" section) stays in front of them from merge until it is done.
// The older open-PR item (issue #855) vanished on merge, so PR #1125's steps were never shown. These are the pure rules; the sync that reads
// GitHub and writes the state is pendingstepssync.mjs. A step has no expiry: only completion (detected, or marked on the dashboard) ends it.
import { approvalsFrom } from './decisions.mjs';
import { redact } from './redact.mjs';

export const WINDOW_DAYS = 30;                 // the backfill: merged PRs this recent are scanned
export const RERAISE_MS = 3 * 24 * 3600000;    // the agreed re-raise interval
export const MAX_STEPS = 10;
const DAY = 24 * 3600000;
const APP_STEP = /github[ _-]app|\bprivate key\b/i;   // the App, its key file or its offer line: all are seen as github_app configured
const DECISION_ID = /\bD-\d{3}\b/g;

// What a step unlocks is the PR's title: the feature the PR delivered.
export const featureOf = title => String(title || '').replace(/\s*\(#\d+\)\s*$/, '').trim().slice(0, 160);

export const newEntry = ({ title, steps, mergedAt }) => ({ title: featureOf(title), mergedAt, steps: steps.slice(0, MAX_STEPS).map(text => ({ text: String(text).slice(0, 300), done: false })), raisedAt: null });

// Step kinds Foreman can detect itself.
export const needsApp = text => APP_STEP.test(text);
export const decisionsIn = text => [...new Set(String(text).match(DECISION_ID) || [])];

// Marks every step Foreman can see is done. ctx: { appConfigured, registerApproved(id), commentApproved(pr, id) }. Returns true when any step changed.
export function detectDone(entry, pr, ctx, now) {
  let changed = false;
  for (const s of entry.steps) {
    if (s.done) continue;
    const ids = decisionsIn(s.text);
    const byApp = needsApp(s.text) && !ids.length && ctx.appConfigured;
    const byDecision = ids.length > 0 && ids.every(id => ctx.registerApproved(id) || ctx.commentApproved(pr, id));
    if (byApp || byDecision) { s.done = true; s.doneAt = now; s.doneBy = byApp ? 'github_app is configured' : 'the approval is recorded'; changed = true; }
  }
  return changed;
}

export function markDone(map, pr, index, now) {
  const s = map?.[pr]?.steps?.[index];
  if (!s || s.done) return false;
  Object.assign(s, { done: true, doneAt: now, doneBy: 'marked done on the dashboard' });
  return true;
}

// Outstanding steps, oldest PR first, each with its place among the PR's steps.
export function outstanding(map) {
  const out = [];
  for (const [n, e] of Object.entries(map || {})) {
    const total = e.steps?.length || 0;
    (e.steps || []).forEach((s, i) => { if (!s.done) out.push({ pr: Number(n), title: e.title, index: i, total, text: s.text, mergedAt: e.mergedAt }); });
  }
  return out.sort((a, b) => (a.mergedAt ?? 0) - (b.mergedAt ?? 0) || a.pr - b.pr || a.index - b.index);
}
export const stepLabel = o => `homeowner step ${o.index + 1} of ${o.total} of PR #${o.pr}`;

// The reason a refusal gives when the tool needs something only the homeowner can supply. kind: 'github_app'.
export function refusalNote(map, kind) {
  const hits = outstanding(map).filter(o => kind === 'github_app' && needsApp(o.text));
  if (!hits.length) return '';
  const first = hits[0], all = outstanding(map).filter(o => o.pr === first.pr && needsApp(o.text));
  const range = all.length > 1 ? `homeowner steps ${all[0].index + 1} to ${all[all.length - 1].index + 1} of ${first.total} of PR #${first.pr}` : stepLabel(first);
  return `needs the GitHub App, ${range} (${first.title})`;
}

// Re-raise: true when some outstanding step has not been raised for RERAISE_MS (or never).
export const reraiseDue = (map, now) => Object.values(map || {}).some(e => (e.steps || []).some(s => !s.done) && (!Number.isFinite(e.raisedAt) || now - e.raisedAt >= RERAISE_MS));
export const reraiseText = map => {
  const o = outstanding(map);
  return `${o.length} homeowner step${o.length === 1 ? ' is' : 's are'} still waiting: ${[...new Set(o.map(x => `PR #${x.pr} (${x.title})`))].slice(0, 5).join(', ')}. See Needs you on the dashboard.`.slice(0, 480);
};

export const withinWindow = (mergedAt, now) => Number.isFinite(mergedAt) && now - mergedAt <= WINDOW_DAYS * DAY;
export { approvalsFrom };

// Needs you items for the outstanding steps. No reference to a pull request is set: the PR is merged, and the list drops items whose PR is not open.
export function stepItems(map, repository) {
  return outstanding(map).map(o => ({
    id: `homeowner-step-${o.pr}-${o.index + 1}`, severity: 'action', ref: null, since: o.mergedAt,
    text: redact(`${stepLabel(o)} is waiting for you (unlocks: ${o.title}): ${o.text}`, 300),
    tried: `Merged PR #${o.pr} (${o.title}) lists this under "Homeowner steps" because it needs your credentials, an approval or a physical action. Foreman reminds you every 3 days and never expires the step.`,
    action: 'Do the step. Foreman marks it done itself when it sees the GitHub App configured or the approval recorded; otherwise press Mark done here.',
    links: [{ text: `PR #${o.pr}`, url: `https://github.com/${repository}/pull/${o.pr}` }], stepDone: { pr: o.pr, index: o.index },
  }));
}
