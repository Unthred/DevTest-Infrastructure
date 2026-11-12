// Issue #110: POST /probe/<agent>, the dashboard's "Refresh allowance" button. Moved out of dashserver.mjs unchanged in behaviour (issue #1162, so the
// handler does not grow when the limit resets route is added). Same-origin form post only; it changes no mode, latch, job or repository.
import { SupervisorError } from './core.mjs';
import { proofValid, reserveCooldown, releaseCooldown } from './dashwrite.mjs';

export function probeRoute({ root, source, store, now, probe, registry, guard }) {
  const { allowedHost, originAllowed, refuseHost, refuseOrigin, tooLarge, badProof } = guard;
  return async (req, res, send, agent) => {
    if (req.headers.host !== allowedHost) return refuseHost(req, send);
    if (!originAllowed(req)) return refuseOrigin(req, send);
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return tooLarge(send); chunks.push(c); }
    if (!proofValid(root, new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('proof'))) return badProof(send);
    // Cooldown per agent, kept in the state root. An unknown agent is refused before it takes a slot.
    const at = now();
    if (!source().agents?.[agent]) return send(404, 'text/plain; charset=utf-8', 'unknown agent');
    const slot = reserveCooldown(root, `probe:${agent}`, at);
    if (!slot.ok) return send(429, 'text/plain; charset=utf-8', `too soon, try again at ${new Date(slot.retryAt).toISOString()}\n`, { 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - at) / 1000))) });
    try {
      const out = await probe({ root, registry, config: source(), agent, now: at });
      if (out.error === 'overage-risk' || out.error === 'busy') releaseCooldown(root, `probe:${agent}`, at);   // nothing was spent
      store.invalidate();   // issue #467: the page after the probe must show its reading
      return send(303, 'text/plain; charset=utf-8', out.ok ? 'refreshed\n' : 'no reading\n', { location: `/usage?probe=${out.ok ? 'ok' : 'failed'}` });
    } catch (error) {
      releaseCooldown(root, `probe:${agent}`, at);
      return send(error instanceof SupervisorError ? 404 : 500, 'text/plain; charset=utf-8', error instanceof SupervisorError ? 'unknown agent' : 'probe failed');
    }
  };
}
