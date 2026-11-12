// Issue #1156: puts the decision card (reason, clear condition, routine controls) on every Needs you item of a built view.
// The card is the item's `card`; the item's own `decision` text (what to do by hand) is untouched.
import { decisionCard } from './decisiontable.mjs';
import { appConfigured } from './appidentity.mjs';

const PARKED = 'parked';
const parkedNumbers = cache => new Set([...(cache?.pulls || []), ...(cache?.issues || [])].filter(x => x.labels?.includes(PARKED)).map(x => x.number));

export function withDecisionCards(view, config, cache) {
  if (!view?.panels?.needsYou) return view;
  const ctx = { parked: parkedNumbers(cache), appConfigured: appConfigured(config) };
  view.panels.needsYou = view.panels.needsYou.map(a => ({ ...a, card: decisionCard(a, ctx) }));
  return view;
}
