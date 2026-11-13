// A decision card's control, sent in the background (issue #1185). The card's form still works without script (a post and a redirect back to the
// card's anchor). With script the click is posted as JSON and the card shows the result where it is: working, then done, failed with the reason,
// or already cleared. The page never navigates, so its scroll, open section and focus stay. The refresh in place (refresh.mjs) is reused to
// re-read the list from the server; this file adds no second refresh. Pure parts first, no DOM; the DOM binding is at the end.

export const WORKING = 'Working…';
const SETTLED = new Set(['done', 'failed', 'cleared']);

// The reply is the route's JSON (supervisor/decisionreply.mjs). Anything else is a failure with a reason, never a silent success.
export function settle(reply) {
  if (reply?.ok === true) return { state: 'done', text: reply.message || 'Recorded. Foreman applies it on the next pass.' };
  const state = SETTLED.has(reply?.outcome) && reply.outcome !== 'done' ? reply.outcome : 'failed';
  return { state, text: reply?.reason || 'The dashboard did not say why; nothing was changed.' };
}

// ui: { working(), show(state, text), unlock(), moveFocus() }. The order is the same code the tests run: controls off at once (a second click
// cannot send twice), then the answer, then only the matching change on the card.
export async function runCardAction({ post, ui }) {
  ui.working();
  const { state, text } = settle(await post());
  ui.show(state, text);
  if (state === 'failed') ui.unlock();   // a failed press can be tried again
  else ui.moveFocus();                   // the card is done with: focus goes to the next one
  return state;
}

// The element focus moves to when the card at `index` is done: the next card, else the list heading. `cards` are the list's card elements.
export const focusTargetAfter = (cards, index, heading) => cards[index + 1] || heading;

// The address keeps the open section: #approvals while the "Waiting for approval" list is open; a link to a card inside it opens it first.
export const SECTION = 'approvals';
export function nextHash({ open, hash }, insideId) {
  if (open) return !hash || hash === `#${SECTION}` ? `#${SECTION}` : hash;
  return hash === `#${SECTION}` || (hash && insideId(hash.slice(1))) ? '' : hash;
}

// ---- DOM side. Bound once by inbox-ui.mjs (postDecision is passed in so this file has no import cycle).
export function bindDecisionCards(postDecision) {
  const doc = document, $ = (s, r = doc) => r.querySelector(s);
  const cardOf = form => form.closest('.decision-card');
  const listOf = form => form.closest('ul');
  const show = (card, state, text) => {
    const s = $('.decision-status', card);
    if (!s) return;
    s.dataset.state = state;
    s.textContent = text;
    s.hidden = false;
  };
  const heading = form => {
    const d = form.closest('details');
    const h = d ? $('summary', d) : $('#h-needs');
    if (h && !h.hasAttribute('tabindex') && h.tagName !== 'SUMMARY') h.setAttribute('tabindex', '-1');   // a heading takes focus only when asked
    return h;
  };
  const focusNext = form => {
    const list = listOf(form), item = form.closest('li');
    const items = list ? [...list.children] : [], target = focusTargetAfter(items, items.indexOf(item), heading(form));
    const el = target && target.tagName === 'LI' ? ($('.decision-control', target) || target) : target;
    if (el && !el.matches('button, a, summary, input')) el.setAttribute('tabindex', '-1');
    el?.focus({ preventScroll: false });
  };

  doc.addEventListener('submit', e => {
    const form = e.target.closest?.('form.decision-form'); if (!form) return;
    e.preventDefault();
    const card = cardOf(form), buttons = [...card.querySelectorAll('.decision-control')], pressed = $('.decision-control', form), was = pressed.textContent;
    runCardAction({
      post: () => postDecision(fetch.bind(window), form.action, new FormData(form)),
      ui: {
        working: () => { for (const b of buttons) b.disabled = true; pressed.textContent = WORKING; show(card, 'working', `${was}: working…`); },
        show: (state, text) => { show(card, state, `${state === 'done' ? 'Done' : state === 'cleared' ? 'Already cleared' : 'Not done'}: ${text}`); },
        unlock: () => { for (const b of buttons) b.disabled = false; pressed.textContent = was; },
        moveFocus: () => { for (const b of buttons) b.disabled = true; pressed.textContent = was; focusNext(form); },
      },
    }).then(state => { if (state === 'done') $('.refresh-now')?.click(); });   // the list is re-read in place from the server's record
  });

  bindSectionAddress(doc);
}

// Open section in the address (a fragment, so a reload or a shared link returns to it).
function bindSectionAddress(doc) {
  const section = () => doc.getElementById(SECTION);
  const inside = id => !!section()?.contains(doc.getElementById(id));
  const reveal = () => {
    const hash = location.hash || '';
    const t = hash.length > 1 ? doc.getElementById(decodeURIComponent(hash.slice(1))) : null;
    const d = t?.closest?.('details'); if (!d || d.open) return;
    d.open = true; t.scrollIntoView?.();
  };
  doc.addEventListener('toggle', e => {
    if (e.target !== section()) return;
    const hash = nextHash({ open: e.target.open, hash: location.hash }, inside);
    if (hash !== location.hash) history.replaceState(history.state, '', location.pathname + location.search + hash);
  }, true);
  addEventListener('hashchange', reveal);
  reveal();
}
