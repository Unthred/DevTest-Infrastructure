// Issue #1158: the strong tier of the inbox. Three decisions only the homeowner may take, each tied to the exact pull request head the card showed:
// merge, approve a decision proposal, and record a review verdict. The tier is a property of the action NAME, never of anything the request
// carries, so no proposal and no form field can lower it. Pure: no I/O.
const SHA = /^[0-9a-f]{40}$/;

// Fixed text for the card (`will`): it says what really happens, no more and no less. `verb` names the downstream gate the action changes.
export const STRONG_ACTIONS = {
  merge_pr: {
    target: 'pr', noun: 'pull request',
    will: 'Merge this pull request into main with a merge commit, only if its head is still the one shown here (GitHub refuses otherwise). '
      + 'This merges it now; it is recorded as a homeowner override with who, when, why and the head.',
  },
  approve_decision: {
    target: 'pr', noun: 'pull request',
    will: 'Post the comment "homeowner-approval: D-NNN" on this pull request from the homeowner account, for the one decision proposal it adds to the register. '
      + 'That is the approval CI requires before the entry may read homeowner-approved; it does not edit the register, '
      + 'so the entry\'s Status line is still set on the branch with its Source linking the comment.',
  },
  verdict_pass: {
    target: 'pr', noun: 'pull request',
    will: 'Record a homeowner PASS verdict for the head shown here, in the store the review gate reads. '
      + 'The head counts as reviewed and the merge step may merge it once checks are green. It replaces any earlier verdict at this head, which is archived. '
      + 'Like any PASS it carries across a clean rebase that leaves the patch identical (D-025), so it can then apply to the rebased head.',
  },
  verdict_changes: {
    target: 'pr', noun: 'pull request',
    will: 'Record a homeowner CHANGES verdict for the head shown here, in the store the review gate reads. '
      + 'The fix loop then treats the head as rejected. It replaces any earlier verdict at this head, which is archived.',
  },
};
export const isStrongAction = action => Object.hasOwn(STRONG_ACTIONS, String(action));

// What the homeowner's approval request must carry for a strong action: the number typed, the head the card showed, and the head the dashboard
// holds now. Returns null when it is confirmed, else the refusal text (a sentence safe to show).
export function confirmRefusal(item, confirm) {
  if (!confirm || typeof confirm !== 'object') return 'This is a strong action: type the pull request number and approve it from its card.';
  if (confirm.tier !== undefined && confirm.tier !== 'strong') return 'This is a strong action; its confirmation tier cannot be lowered.';
  if (String(confirm.typed ?? '').trim() !== String(item.target)) return `The number you typed does not match pull request ${item.target}; nothing was approved.`;
  if (!SHA.test(String(confirm.shownHead ?? ''))) return 'The card did not show a head to act on, so nothing was approved. Reload the page.';
  if (!SHA.test(String(confirm.liveHead ?? ''))) return `The current head of pull request ${item.target} cannot be read, so nothing was approved.`;
  if (confirm.shownHead !== confirm.liveHead) return `Pull request ${item.target} has a new head since this card was shown (${confirm.shownHead.slice(0, 7)} then, ${confirm.liveHead.slice(0, 7)} now); reload the page and check it again.`;
  return null;
}

// Cards of strong actions get the head of their pull request from the last fetched pull requests; null when it is not open there.
export const withHeads = (cards, pulls) => cards.map(c => (isStrongAction(c.action) ? { ...c, head: (pulls || []).find(p => String(p.number) === c.target)?.headRefOid ?? null } : c));

// The head the dashboard holds now for an inbox card, from a built view; null when the card or its pull request is not in it.
export const liveHeadOf = (view, id) => (view?.panels?.needsYou || []).find(a => a.inbox?.id === id)?.inbox?.head ?? null;
