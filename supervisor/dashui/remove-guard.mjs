// Issue #1454: the DOM side of "a fixed card is removed only while the app bar shows what it guards, and a refusal says why". The
// rule itself is pure and lives in grid.mjs (removeVerdict, barRemoveVerdict); this file reads what it needs from the page and draws
// the one-line refusal beside the control, announced through a polite status region. A refusal is never a silent no operation.
import { BAR_KEY, FIXED, removeBarItem, sanitizeBar } from './appbar.mjs';
import { barRemoveVerdict, removeVerdict } from './grid.mjs';

export const span = (text, cls = '') => Object.assign(document.createElement('span'), { className: cls, textContent: text });

// The app bar items this viewer still shows (editable items only, in their saved order).
export const barShown = store => sanitizeBar(store.get(BAR_KEY), [...document.querySelectorAll('.statusbar > [data-bar]')].map(el => el.dataset.bar).filter(id => !FIXED.includes(id))).order;
// The cards removed from the Overview in this viewer's saved layout for a breakpoint (the bar must keep their item while they are gone).
const removedOnOverview = (store, bp) => {
  const saved = store.get(`dash.layout.overview.${bp}`);
  return saved && saved.v === 2 && Array.isArray(saved.hidden) ? saved.hidden : [];
};
export const cardVerdict = (store, card) => removeVerdict(card.dataset.card, card.hasAttribute('data-pin'), barShown(store), card.dataset.pinWhy);

const announce = (region, text) => {
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 30);
};

// The layout editor's refusals: one line beside the card's own control and one beside its row in the Cards picker.
export function createRefusals(grid, say, repaint) {
  let current = null;
  const clear = () => {
    current = null;
    for (const line of grid.querySelectorAll('.lay-why')) line.remove();
  };
  return {
    clear,
    show(card, text) {
      clear();
      current = { id: card.dataset.card, text };
      card.querySelector('.lay-hide')?.after(span(text, 'lay-why'));
      repaint();
      say(text);
    },
    mark(row, id) {
      if (current?.id === id) row.append(span(current.text, 'lay-why'));
    }
  };
}

// The app bar editor's refusals: an item cannot be removed while a card it guards is removed from the Overview.
export function createBarGuard(store, bar, bpNow) {
  let refused = null;
  const region = span('', 'lay-live');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  bar.append(region);
  return {
    // The next bar state: the item removed, or the same state when it is refused (the line is drawn by the next paint).
    remove(state, id) {
      const verdict = barRemoveVerdict(id, removedOnOverview(store, bpNow()));
      if (verdict.ok) return removeBarItem(state, id);
      refused = { id, text: verdict.reason };
      announce(region, verdict.reason);
      return state;
    },
    // Called while painting an item's controls: shows its refusal line once.
    note(id, controls) {
      if (refused?.id !== id) return;
      controls.append(span(refused.text, 'bar-why'));
      refused = null;
    }
  };
}
