// Issue #1338: what the dashboard shows of a split of a stuck pull request. One Needs you card per stuck pull request, in the entry that fits
// its state. Pure: reads the saved record only.
import { redact } from './redact.mjs';

export const STANDING_OPTIONS = 'wait for another agent to be able to review (allowance reset), change the approach, or fix it by hand';
const HIDDEN = /^(fixlimit|churn|homeowner-pr|ci|escalating)-/;
const AFTER_PARK = ['rejected', 'failed', 'filed'];

const itemsOf = rec => (rec.items || []).map((x, i) => ({ title: x.title, files: x.files, number: rec.filed?.[i] ?? null }));
const list = items => items.map((x, i) => `${i + 1}. ${x.number ? `#${x.number} ` : ''}${x.title} (${x.files.join(', ')})`).join('; ');

function parkedText(rec) {
  const state = rec.parked ? '' : rec.parkError ? ` (not parked yet: ${rec.parkError})` : ' (parking in progress)';
  return `Parked: ${rec.reason}${state}.`;
}

// The text of each state. The entry id selects the decision-table row, so the controls and the clears text fit the state.
function cardFor(rec, name) {
  const items = itemsOf(rec);
  const parked = parkedText(rec);
  if (rec.status === 'proposed') {
    return { entry: 'split-stuck', text: `${name} is parked and a split into ${items.length} items is proposed`,
      tried: `${parked} Proposed items: ${list(items)}. Nothing is filed until you approve.`,
      action: 'Approve split files these items and links them to the PR. Reject split files nothing and leaves the PR parked.' };
  }
  if (rec.status === 'filed') {
    return { entry: 'split-wait', text: `${name} is parked; its ${items.length} split items are filed`,
      tried: `${parked} Items: ${list(items)}. The PR stays parked, with its branch kept, until the close as superseded item lands.`,
      action: 'Nothing to decide now; the items are queued. Unpark only returns the PR to the planner.' };
  }
  if (rec.status === 'planning') {
    return { entry: 'split-plan', homeowner: false, text: `${name} is parked; a split into smaller items is being drafted`,
      tried: `${parked} A read-only planning job reads the issue, the diff, the findings and the open PR file lists.`, action: 'Nothing to decide yet.' };
  }
  const why = rec.status === 'rejected' ? 'its split was rejected' : 'no usable split could be drafted';
  return { entry: 'split-parked', text: `${name} is parked and ${why}`,
    tried: `${parked}${rec.error ? ` Draft refused: ${rec.error}.` : ''} Standing options: ${STANDING_OPTIONS}.`,
    action: `Decide which: ${STANDING_OPTIONS}. Unpark returns the PR to the planner.` };
}

// Whether this record still owns a card: its PR is open and, once the split is decided, still carries the parked label.
function shows(rec, n, { open, labels }) {
  if (!open.has(n)) return false;
  const known = labels?.get(n);
  return !(AFTER_PARK.includes(rec.status) && known && !known.includes('parked'));
}

// The attention list for the stuck PRs: their other cards (fix limit, needs-homeowner, CI) give way to the one split card.
export function withStuckSplits(attention, { state, names, open, repo, labels = null }) {
  const records = state?.stuckSplits || {};
  const stuck = Object.keys(records).map(Number).filter(n => shows(records[n], n, { open, labels }));
  if (!stuck.length) return attention;
  const held = new Set(stuck);
  const kept = attention.filter(a => !(a.ref?.kind === 'pull' && held.has(a.ref.n) && HIDDEN.test(a.id)));
  for (const n of stuck) {
    const card = cardFor(records[n], names.pr(n).text);
    const quiet = card.homeowner === false;
    kept.push({
      id: `${card.entry}-${n}`, text: redact(card.text, 300), ref: { kind: 'pull', n }, tried: redact(card.tried, 600), action: redact(card.action, 300),
      severity: quiet ? 'info' : 'action', ...(quiet ? { homeowner: false } : {}),
      links: [{ text: names.pr(n).text, url: `https://github.com/${repo}/pull/${n}` }]
    });
  }
  return kept;
}
