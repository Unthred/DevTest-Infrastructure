// Issue #1164: POST /direct, the dashboard's write for direct control: the switch (on or off) and Undo of one audited action. It follows the other
// writes (D-029: host, origin, the secret proof, a cooldown) and, like the breaker's Resume, needs a person's click: a script, or a process that
// descends from a supervised job, is refused, so the overseer cannot switch direct control back on or undo for itself. Undo only leaves a request;
// the next pass reverses the action (its checks run there) and writes the result to the trail.
import { proofValid, reserveCooldown, releaseCooldown } from './dashwrite.mjs';
import { writeSwitch, requestUndo } from './directstore.mjs';

export const DIRECT_COOLDOWN_MS = 1000;
const TEXT = 'text/plain; charset=utf-8';
const MAX_BODY = 1024;

export function directRoute({ root, source, allowedHost, originAllowed, now, store, wake, supervised }) {
  return async (req, res, send) => {
    const dir = source().inbox?.dir;
    if (!dir) return send(404, TEXT, 'the inbox is not configured. Nothing was changed.');
    if (req.headers.host !== allowedHost) return send(421, TEXT, 'unexpected host. Nothing was changed.');
    if (!originAllowed(req)) return send(403, TEXT, 'cross-origin request refused. Nothing was changed.');
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-user'] !== '?1' || supervised()) {
      return send(403, TEXT, 'this needs a person clicking the button. Nothing was changed.');
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
    if (!['switch', 'undo'].includes(form.action) || (form.action === 'switch' && !['on', 'off'].includes(form.value))) return send(400, TEXT, 'bad request');
    const t = now(), slot = reserveCooldown(root, 'direct', t, DIRECT_COOLDOWN_MS);
    if (!slot.ok) return send(303, TEXT, 'too soon', { location: '/supervisor?notice=direct-cooldown', 'retry-after': '1' });
    if (form.action === 'switch') writeSwitch(dir, form.value === 'on', t);
    else {
      const r = requestUndo(dir, form.id, t);
      if (!r.ok) { releaseCooldown(root, 'direct', t); return send(409, TEXT, r.reason); }
      try { wake(root, 'approve', source()); } catch { /* the schedule is the fallback */ }
    }
    store.invalidate();
    return send(303, TEXT, 'recorded', { location: '/supervisor' });
  };
}
