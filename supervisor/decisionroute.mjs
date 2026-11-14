// Issue #1156: POST /decision, one click on a decision card's routine control. Same protection as the inbox decision (D-029: host, origin, access
// proof, cooldown). The card is looked up in the current view and its target taken from it; a card that has cleared, or a control it does not
// offer, changes nothing and the page says so. A click leaves an already-approved inbox item; the next tick applies it once through the existing
// action pipeline. `guard` carries the dashboard server's own refusal helpers so this route cannot disagree with the others about them.
// Issue #1185: the script asks for JSON and gets done, failed or cleared for that card (decisionreply.mjs); without script it is a form post
// that returns to the card's anchor.
import { proofValid, reserveCooldown, releaseCooldown, INBOX_COOLDOWN_MS } from './dashwrite.mjs';
import { resolveClick, recordClick } from './decisionclick.mjs';
import { wantsJson, jsonSend, backTo, doneReply, refusalReply } from './decisionreply.mjs';

const MAX_BODY = 1024;

export function decisionRoute({ root, source, cachedView, store, wake, now, guard }) {
  const { allowedHost, originAllowed, refuseHost, refuseOrigin, tooLarge, badProof, refuseWith, esc } = guard;
  return async (req, res, rawSend) => {
    const json = wantsJson(req);
    const send = json ? jsonSend(rawSend) : rawSend;
    if (!source().inbox?.dir) return refuseWith(send, 404, 'Inbox not configured', 'The inbox is not configured.');
    if (req.headers.host !== allowedHost) return refuseHost(req, send);
    if (!originAllowed(req)) return refuseOrigin(req, send);
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return tooLarge(send);
      chunks.push(c);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const back = backTo(form.get('back'), form.get('from') || '');
    if (!proofValid(root, form.get('proof'))) return badProof(send);
    const t = now();
    const slot = reserveCooldown(root, 'inbox', t, INBOX_COOLDOWN_MS);
    if (!slot.ok) {
      const wait = String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000)));
      const location = back.startsWith('/inbox') ? back : `/?notice=inbox-cooldown${back.slice(1)}`;   // issue #1477: the Inbox page has no notice, so it returns to itself
      return send(303, 'text/plain; charset=utf-8', 'too soon', { location, 'retry-after': wait });
    }
    const prepared = await cachedView({ root, config: source(), now: t, configError: source.invalid, timeline: false, allTime: false });
    const found = resolveClick(prepared.view, { card: form.get('card') || '', control: form.get('control') || '', supersededBy: form.get('superseded_by') || '' });
    const r = found.ok ? recordClick(source().inbox.dir, found, t) : found;
    if (!r.ok) {
      releaseCooldown(root, 'inbox', t);
      if (json) { const reply = refusalReply(r); return rawSend(reply.status, 'application/json; charset=utf-8', JSON.stringify(reply.body)); }
      return refuseWith(send, r.status, 'Nothing was changed', esc(r.text), `<p><a href="${esc(back)}">Back to the dashboard</a></p>`);
    }
    store.invalidate();
    try { wake(root, 'approve', source()); } catch { /* the schedule is the fallback */ }
    if (json) { const reply = doneReply(found.control); return rawSend(reply.status, 'application/json; charset=utf-8', JSON.stringify(reply.body)); }
    return send(303, 'text/plain; charset=utf-8', 'recorded', { location: back });
  };
}
