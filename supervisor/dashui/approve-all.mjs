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
// A single Approve or Reject refreshes the page in place from app.js (the decided handler); Approve all refreshes once, after the last item.
export function bindApproveAll(postDecision) {
  const rows = () => [...document.querySelectorAll('[data-approvals] .approval-row')];
  const refreshNow = () => document.querySelector('.refresh-now')?.click();
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const post = f => postDecision(fetch.bind(window), f.action, new FormData(f));
  document.addEventListener('click', async e => {
    const btn = e.target.closest?.('[data-approve-all]');
    if (!btn) return;
    const forms = rows().filter(li => li.dataset.tier === 'click').map(li => li.querySelector('form:has([value=approve])')).filter(Boolean);
    btn.disabled = true;
    const r = await approveEach({ forms, wait, post });
    btn.textContent = summary(r);
    refreshNow();
  });
}
