// Issue #1185: what POST /decision answers when the page's script asks for JSON. Pure. Three shapes, so a card can say what happened:
//   done    { ok:true,  outcome:'done',    message }  the click was recorded; the next tick applies it
//   failed  { ok:false, outcome:'failed',  reason }   nothing changed; the reason is shown on that card
//   cleared { ok:false, outcome:'cleared', reason }   the card is already gone; nothing changed
// Without script the same route still answers with a redirect back to the card's anchor.
const ANCHOR = /^[A-Za-z0-9_-]{1,100}$/;

const TOO_SOON = 'That was too soon after the last decision; wait a second and press it again.';

export const wantsJson = req => /application\/json/.test(req.headers.accept || '');

// The page to return to without script: the card's own anchor, so the tab and card are the same. Anything unexpected falls back to the top.
// Issue #1477: a post from the Inbox page also names `from`, that page with its filter, and returns there at the card's row.
const INBOX_FROM = /^\/inbox(\?[A-Za-z0-9%=&+._~*,:-]{0,300})?$/;
export function backTo(anchor, from = '') {
  const hash = ANCHOR.test(anchor || '') ? `#${anchor}` : '';
  if (INBOX_FROM.test(from || '')) return from + hash;
  return hash ? `/${hash}` : '/';
}

export const doneReply = control => ({
  status: 200,
  body: { ok: true, outcome: 'done', message: `${control.label} recorded. Foreman applies it on the next pass.` },
});
export const failedReply = (status, reason) => ({ status, body: { ok: false, outcome: 'failed', reason: String(reason) } });
export const clearedReply = reason => ({ status: 409, body: { ok: false, outcome: 'cleared', reason: String(reason) } });
export const refusalReply = r => (r.cleared ? clearedReply(r.text) : failedReply(r.status, r.text));

const plainOf = html => String(html).replace(/<h1>[^]*?<\/h1>/, '').replace(/<p><a href[^]*$/, '').replace(/<[^>]*>/g, ' ')
  .replace(/&#(\d+);/g, (m, c) => String.fromCharCode(Number(c))).replace(/\s+/g, ' ').trim().slice(0, 300);

// Wraps the server's send so every refusal the shared guards make (host, origin, proof, size, cooldown) is a failed reply, never an HTML page
// or a redirect that the script would take for success.
export function jsonSend(rawSend) {
  const JSON_TYPE = 'application/json; charset=utf-8';
  return (code, type, body, headers = {}) => {
    if (code === 303 && /inbox-cooldown/.test(headers.location || '')) {
      const body = failedReply(429, TOO_SOON).body;
      return rawSend(429, JSON_TYPE, JSON.stringify(body), { 'retry-after': headers['retry-after'] });
    }
    if (code >= 400) return rawSend(code, JSON_TYPE, JSON.stringify(failedReply(code, type.startsWith('text/html') ? plainOf(body) : body).body));
    return rawSend(code, type, body, headers);
  };
}
