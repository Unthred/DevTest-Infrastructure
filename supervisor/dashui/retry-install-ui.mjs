// Issue #1368: the control of the upgrade-blocked Needs you item. The button sends the named command upgrade.retry_install, which makes the next
// install skip its wait and starts one more attempt. The page never navigates: the answer shows where the form is, and on success the list is
// re-read in place. Pure parts first, no DOM; the DOM binding is at the end.

export const COMMAND_URL = '/api/v1/commands/upgrade.retry_install';

const newKey = () => `retry-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export const requestBody = key => JSON.stringify({ input: {}, idempotency_key: key });

// The reply of the command endpoint as { state, text }. Anything that is not its JSON is a failure with a reason, never a silent success.
export function settle(reply) {
  if (reply?.ok === true) return { state: 'done', text: 'Recorded. The next pass starts one more install attempt.' };
  return { state: 'failed', text: reply?.refusal_text || 'The dashboard did not say why; nothing was changed.' };
}

export async function send(fetchFn, { proof, key = newKey() }) {
  try {
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-foreman-proof': proof };
    const response = await fetchFn(COMMAND_URL, { method: 'POST', headers, body: requestBody(key), credentials: 'same-origin' });
    return settle(await response.json());
  } catch {
    return { state: 'failed', text: 'The dashboard could not be reached; nothing was changed.' };
  }
}

// ---- DOM side, bound once by inbox-ui.mjs.
export function bindRetryInstall(doc = document) {
  doc.addEventListener('submit', async event => {
    const form = event.target.closest?.('form.retry-install-form');
    if (!form) return;
    event.preventDefault();
    const status = form.querySelector('.retry-install-status');
    const button = form.querySelector('.retry-install-button');
    const show = (state, text) => { status.dataset.state = state; status.textContent = text; status.hidden = false; };
    button.disabled = true;
    show('working', 'Recording…');
    const result = await send(fetch.bind(window), { proof: form.elements.proof?.value ?? '' });
    show(result.state, result.text);
    if (result.state === 'done') doc.querySelector('.refresh-now')?.click();
    else button.disabled = false;
  });
}
