// Issue #1240: what the dashboard shows of a split of a stuck pull request: one Needs you card per stuck PR (Approve split / Reject split while
// the split waits for the homeowner) and the parking facts on the PR page. Pure: reads the saved record only.
import { redact } from './redact.mjs';
import { STANDING_OPTIONS } from './splitstuck-draft.mjs';

const recordOf = (state, n) => state?.stuckSplits?.[n] ?? null;
const STATUS = {
  planning: 'a read-only planning job is drafting the split',
  proposed: 'a split is proposed and waits for the homeowner',
  rejected: 'the split was rejected; the PR stays parked',
  failed: 'no usable split could be drafted',
  filed: 'the split is approved and filed; waiting for the items to merge',
  closed: 'closed as superseded after the items merged',
};
const itemsOf = rec => (rec.items || []).map((x, i) => ({ title: x.title, files: x.files, number: rec.filed?.[i] ?? null }));

// Facts for the PR page and the card, or null when the PR was never stuck.
export function splitFacts(state, n) {
  const rec = recordOf(state, n);
  if (!rec) return null;
  return { code: rec.status, status: STATUS[rec.status] ?? rec.status, parked: rec.parked === true, parkError: rec.parkError ?? null, reason: rec.reason, error: rec.error ?? null,
    closeBlocked: rec.closeBlocked ?? null, items: itemsOf(rec) };
}

const list = f => f.items.map((x, i) => `${i + 1}. ${x.number ? `#${x.number} ` : ''}${x.title} (${x.files.join(', ')})`).join('; ');
const parkedText = f => `Parked: ${f.reason}${f.parked ? '' : f.parkError ? ` (not parked yet: ${f.parkError})` : ' (parking in progress)'}.`;

// The card text for each state of a split; `homeowner: false` marks a card that asks for nothing (it is a notice).
function cardFor(f, name) {
  const tail = ` Standing options: ${STANDING_OPTIONS}.`;
  if (f.code === 'proposed') return { text: `${name} is parked and a split into ${f.items.length} items is proposed`, tried: `${parkedText(f)} Proposed items: ${list(f)}. Nothing is filed until you approve.`,
    action: 'Approve split files these items and links them to the PR. Reject split files nothing and leaves the PR parked.' };
  if (f.code === 'filed') return { text: `${name} is parked until its ${f.items.length} split items have merged`, homeowner: !!f.closeBlocked,
    tried: `${parkedText(f)} Items: ${list(f)}. Foreman closes the PR as superseded after every item has merged and keeps its branch.${f.closeBlocked ? ` ${f.closeBlocked}.` : ''}`,
    action: f.closeBlocked ? 'Grant the GitHub App Contents write (a homeowner step), then close the PR as superseded.' : 'Nothing to decide now; the items are queued.' };
  if (f.code === 'planning') return { text: `${name} is parked; a split into smaller items is being drafted`, homeowner: false, tried: `${parkedText(f)} A read-only planning job reads the issue, the diff, the verdicts and the open PR file lists.`, action: 'Nothing to decide yet.' };
  return { text: `${name} is parked and ${f.code === 'rejected' ? 'its split was rejected' : 'no usable split could be drafted'}`,
    tried: `${parkedText(f)}${f.error ? ` Draft refused: ${f.error}.` : ''}${tail}`, action: `Decide which: ${STANDING_OPTIONS}.` };
}

// The attention list for the stuck PRs: their other cards (fix limit, needs-homeowner, CI) give way to the one split card. `open` is the set of open PR numbers.
export function withStuckSplits(attention, { state, names, open, repo }) {
  const stuck = Object.keys(state?.stuckSplits || {}).map(Number).filter(n => open.has(n) && recordOf(state, n).status !== 'closed');
  if (!stuck.length) return attention;
  const held = new Set(stuck);
  const kept = attention.filter(a => !(a.ref?.kind === 'pull' && held.has(a.ref.n) && /^(fixlimit|churn|homeowner-pr|ci|escalating)-/.test(a.id)));
  for (const n of stuck) {
    const f = splitFacts(state, n), card = cardFor(f, names.pr(n).text), id = `${f.code === 'proposed' ? 'split-stuck' : 'split-wait'}-${n}`;
    kept.push({ id, text: redact(card.text, 300), ref: { kind: 'pull', n }, tried: redact(card.tried, 600), action: redact(card.action, 300), severity: card.homeowner === false ? 'info' : 'action',
      ...(card.homeowner === false ? { homeowner: false } : {}), links: [{ text: names.pr(n).text, url: `https://github.com/${repo}/pull/${n}` }] });
  }
  return kept;
}

// The parked reason and the new items as rows of the PR page's facts list. `esc` and `issueLink` come from the renderer.
export function splitFactsHtml(f, { esc, issueLink }) {
  if (!f) return '';
  const items = f.items.length ? `<dt>Split items</dt><dd>${f.items.map(x => `${x.number ? `${issueLink(x.number)} ` : ''}${esc(x.title)}`).join('<br>')}</dd>` : '';
  const blocked = f.closeBlocked ? `<dt>Closing</dt><dd>${esc(f.closeBlocked)}</dd>` : '';
  return `<dt>Parked</dt><dd>${f.parked ? 'yes' : 'not yet'}: ${esc(f.reason)}</dd><dt>Split</dt><dd>${esc(f.status)}${f.error ? ` (${esc(f.error)})` : ''}</dd>${items}${blocked}`;
}
