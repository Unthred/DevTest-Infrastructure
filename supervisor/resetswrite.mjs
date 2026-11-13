// Issue #1159: POST /limit-resets, the dashboard's write for the limit-reset records (add, edit, use, unuse, delete). It follows the other
// dashboard writes (D-029): host, origin, the secret proof and a short cooldown. It changes only the records in Foreman state; it starts,
// stops and alters no work. Refusals are plain text with the same status codes as the other writes.
import { proofValid, reserveCooldown, releaseCooldown } from './dashwrite.mjs';
import { recordRefusedOrigin } from './hostvalue.mjs';
import { applyReset, readResets } from './limitresets.mjs';
import { refreshAllowance } from './resetrefresh.mjs';

export const RESETS_COOLDOWN_MS = 1000;
const ACTIONS = ['add', 'edit', 'use', 'unuse', 'delete'];
const MAX_BODY = 2048;
const TEXT = 'text/plain; charset=utf-8';

export function limitResetsRoute({ root, source, allowedHost, originAllowed, now, store, probe, registry, wake }) {
  return async (req, res, send) => {
    if (req.headers.host !== allowedHost) return send(421, TEXT, 'unexpected host. Nothing was changed.');
    if (!originAllowed(req)) {
      try { recordRefusedOrigin(root, req.headers.origin); } catch { /* observation only */ }
      return send(403, TEXT, 'cross-origin request refused. Nothing was changed.');
    }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return send(413, TEXT, 'the request was too large. Nothing was changed.');
      chunks.push(c);
    }
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    if (!proofValid(root, form.proof)) return send(403, TEXT, 'missing or wrong access proof; reload the page and try again. Nothing was changed.');
    if (!ACTIONS.includes(form.action)) return send(400, TEXT, 'bad request');
    const t = now();
    const slot = reserveCooldown(root, 'limit-resets', t, RESETS_COOLDOWN_MS);
    if (!slot.ok) return send(303, TEXT, 'too soon', { location: '/usage?notice=limit-resets-cooldown', 'retry-after': '1' });
    const agent = readResets(root).find(r => r.id === form.id)?.agent;
    const out = applyReset(root, form.action, form, { agents: Object.keys(source().agents || {}), now: t });
    if (!out.ok) { releaseCooldown(root, 'limit-resets', t); return send(400, TEXT, out.reason); }   // a refused write spent nothing
    if (form.action === 'use' && agent) await refreshAllowance({ root, source, probe, registry, wake, agent, now: t });   // issue #1162: the hold lifts on the next tick
    store.invalidate();   // the page after the write must show it
    return send(303, TEXT, 'recorded', { location: '/usage' });
  };
}
