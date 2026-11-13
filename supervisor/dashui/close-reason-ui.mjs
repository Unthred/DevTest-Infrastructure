// Issue #1306: the control of the closed-noreason Needs you item. A reason typed in the box is sent as the named command work_item.close_reason
// for every issue the item lists. The page never navigates: the answer shows where the form is, and on success the list is re-read in place
// (the same refresh the decision cards use), so the item is gone on the next draw. Pure parts first, no DOM; the DOM binding is at the end.

export const COMMAND_URL = '/api/v1/commands/work_item.close_reason';
export const MIN_REASON = 10;

const newKey = () => `close-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export function requestBody({ issues, reason, key }) {
  return JSON.stringify({ input: { issues }, reason, idempotency_key: key });
}

// A short reason is refused here with the same words the server uses, so the box answers at once; the server checks again.
export function shortReasonText(reason) {
  return String(reason ?? '').trim().length >= MIN_REASON ? null : `The reason needs at least ${MIN_REASON} characters. Nothing was changed.`;
}

// The reply of the command endpoint as { state, text }. Anything that is not its JSON is a failure with a reason, never a silent success.
export function settle(reply) {
  if (reply?.ok === true) return { state: 'done', text: 'Recorded. A comment with the reason was posted on each issue.' };
  const text = reply?.refusal_text || 'The dashboard did not say why; nothing was changed.';
  return { state: 'failed', text };
}

export async function send(fetchFn, { issues, reason, proof, key = newKey() }) {
  try {
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-foreman-proof': proof };
    const response = await fetchFn(COMMAND_URL, { method: 'POST', headers, body: requestBody({ issues, reason, key }), credentials: 'same-origin' });
    return settle(await response.json());
  } catch {
    return { state: 'failed', text: 'The dashboard could not be reached; nothing was changed.' };
  }
}

// ---- DOM side, bound once by inbox-ui.mjs.
export function bindCloseReason(doc = document) {
  doc.addEventListener('submit', async event => {
    const form = event.target.closest?.('form.close-reason-form');
    if (!form) return;
    event.preventDefault();
    const status = form.querySelector('.close-reason-status');
    const button = form.querySelector('.close-reason-button');
    const show = (state, text) => { status.dataset.state = state; status.textContent = text; status.hidden = false; };
    const reason = form.elements.reason.value;
    const short = shortReasonText(reason);
    if (short) return show('failed', short);
    button.disabled = true;
    show('working', 'Recording…');
    const result = await send(fetch.bind(window), { issues: form.dataset.issues, reason, proof: form.elements.proof?.value ?? '' });
    show(result.state, result.text);
    if (result.state === 'done') doc.querySelector('.refresh-now')?.click();
    else button.disabled = false;
  });
}
