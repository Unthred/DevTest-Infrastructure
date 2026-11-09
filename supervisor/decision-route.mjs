import { recordDecisionAction } from './decision-request.mjs';
import { proofValid, reserveCooldown, releaseCooldown, INBOX_COOLDOWN_MS } from './dashwrite.mjs';

export async function handleDecision({
  req, send, root, source, allowedHost, originAllowed, refuseWith, refuseHost,
  refuseOrigin, tooLarge, badProof, now, wake, invalidate,
}) {
  if (!source().inbox?.dir) return refuseWith(send, 404, 'Inbox not configured', 'The inbox is not configured.');
  if (req.headers.host !== allowedHost) return refuseHost(req, send);
  if (!originAllowed(req)) return refuseOrigin(req, send);
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1024) return tooLarge(send); chunks.push(c); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (!proofValid(root, form.get('proof'))) return badProof(send);
  const t = now();
  const slot = reserveCooldown(root, 'decision', t, INBOX_COOLDOWN_MS);
  if (!slot.ok) return send(429, 'text/plain; charset=utf-8', 'too soon');
  try {
    const r = recordDecisionAction({ dir: source().inbox.dir, action: form.get('action'), target: form.get('target'), reason: form.get('reason'), now: t });
    invalidate();
    try { wake(root, 'approve', source()); } catch { /* schedule remains the fallback */ }
    return send(303, 'text/plain; charset=utf-8', 'recorded', { location: `/?notice=decision-${r.id.slice(0, 8)}` });
  } catch (error) {
    releaseCooldown(root, 'decision', t);
    return send(409, 'text/plain; charset=utf-8', String(error?.message || error).slice(0, 300));
  }
}
