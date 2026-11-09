// Approve all and the live badge for the "Waiting for approval" dropdown (issue #1101). Approve all posts each Click tier item to /inbox
// one after another through the same postDecision the single Approve uses (the server allows one decision a second, so there is a pause
// between them). Strong tier rows carry no Approve form, so they cannot be reached from here.

export const PAUSE_MS = 1100;

// forms: the Approve forms to submit; post(form) -> {ok, reason}; wait(ms). Stops at the first refusal that is not "already decided".
export async function approveEach({ forms, post, wait, onEach = () => {} }) {
  const out = { approved: 0, skipped: 0, failed: null };
  for (const [i, form] of forms.entries()) {
    if (i) await wait(PAUSE_MS);
    const r = await post(form);
    onEach(form, r);
    if (r.ok) out.approved++;
    else if (/already (approved|rejected|running|posting|done|failed|refused)/.test(r.reason || '')) out.skipped++;
    else { out.failed = r.reason; break; }
  }
  return out;
}

export const summary = r => `Approved ${r.approved}${r.skipped ? `, ${r.skipped} already decided` : ''}${r.failed ? `. Stopped: ${r.failed}` : ''}`;

// post(url, params) is the page's postDecision, passed in by inbox-ui.mjs so this file has no import cycle.
export function bindApproveAll(postDecision) {
  const panel = () => document.querySelector('[data-approvals]');
  const rows = () => [...document.querySelectorAll('[data-approvals] .approval-row')];
  const refreshNow = () => document.querySelector('.refresh-now')?.click();
  document.addEventListener('click', async e => {
    const btn = e.target.closest?.('[data-approve-all]'); if (!btn) return;
    const forms = rows().filter(li => li.dataset.tier === 'click').map(li => li.querySelector('form:has([value=approve])')).filter(Boolean);
    btn.disabled = true;
    const r = await approveEach({ forms, wait: ms => new Promise(res => setTimeout(res, ms)), post: f => postDecision(fetch.bind(window), f.action, new FormData(f)) });
    btn.textContent = summary(r);
    refreshNow();
  });
  // A row whose outcome the Inbox handler has shown leaves the list a moment later and the badge follows; a refresh then confirms from the server.
  if (typeof MutationObserver === 'undefined') return;   // a test double of the page has none
  new MutationObserver(() => {
    for (const li of rows()) if (li.querySelector('.inbox-outcome:not([hidden])')) setTimeout(() => { li.remove(); const b = panel()?.querySelector('[data-approvals-count]'); if (b) b.textContent = String(rows().length); refreshNow(); }, 1500);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
}
