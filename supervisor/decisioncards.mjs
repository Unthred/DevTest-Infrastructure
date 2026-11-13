// Issue #1156: puts the decision card (reason, clear condition, routine controls) on every Needs you item of a built view.
// The card is the item's `card`; the item's own `decision` text (what to do by hand) is untouched.
// Issue #1185: a control whose click is recorded and not yet applied is listed in `card.pending`, so the card shows it as working after any
// refresh or reload, not only until the page's script forgets it.
import { decisionCard } from './decisiontable.mjs';
import { appConfigured } from './appidentity.mjs';
import { allStatuses } from './inbox.mjs';
import { LIVE } from './decisionclick.mjs';

const PARKED = 'parked';
const parkedNumbers = cache => new Set([...(cache?.pulls || []), ...(cache?.issues || [])].filter(x => x.labels?.includes(PARKED)).map(x => x.number));

// card id -> the actions already clicked and waiting for the tick.
export function pendingClicks(inboxDir) {
  const out = new Map();
  if (!inboxDir) return out;
  for (const s of allStatuses(inboxDir)) {
    if (!LIVE.has(s.state) || !s.click?.card) continue;
    out.set(s.click.card, [...(out.get(s.click.card) || []), s.click.action]);
  }
  return out;
}

export function withDecisionCards(view, config, cache) {
  if (!view?.panels?.needsYou) return view;
  const ctx = { parked: parkedNumbers(cache), appConfigured: appConfigured(config) };
  const pending = pendingClicks(config?.inbox?.dir);
  view.panels.needsYou = view.panels.needsYou.map(a => {
    const card = decisionCard(a, ctx);
    return { ...a, card: pending.has(a.id) && !card.error ? { ...card, pending: pending.get(a.id) } : card };
  });
  return view;
}
