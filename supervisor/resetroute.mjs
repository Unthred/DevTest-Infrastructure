// Issue #1162: POST /resets, the homeowner's edits to the limit reset records: add, edit, used, delete. Same protection as every dashboard write
// (D-029): host, origin, access proof and a cooldown. `guard` carries the server's own refusal helpers so this route cannot disagree with the others.
// Marking a reset used also asks for an allowance refresh, as the Refresh allowance button does, so the hold lifts on the next tick.
import { proofValid, reserveCooldown, releaseCooldown, INBOX_COOLDOWN_MS } from './dashwrite.mjs';
import { addRecord, editRecord, markUsed, deleteRecord } from './resetrecords.mjs';

const MAX_BODY = 2048;
const ACTIONS = ['add', 'edit', 'used', 'delete'];
const BACK = '/usage#c-limit-resets';

export function resetsRoute({ root, source, store, wake, now, probe, registry, guard }) {
  const { allowedHost, originAllowed, refuseHost, refuseOrigin, tooLarge, badProof, refuseWith, esc } = guard;
  const apply = (action, form, agentNames, t) => {
    const id = form.get('id') || '';
    if (action === 'add') return addRecord(root, Object.fromEntries(form), agentNames, t);
    if (!/^[a-f0-9]{8}$/.test(id)) return { ok: false, reason: 'unknown reset' };
    if (action === 'edit') return editRecord(root, id, Object.fromEntries(form), agentNames);
    return action === 'used' ? markUsed(root, id, t) : deleteRecord(root, id);
  };
  // Best effort: a refused or failed refresh never undoes the mark, because the next tick reads the provider again anyway.
  const refresh = async (agent, t) => {
    const slot = reserveCooldown(root, `probe:${agent}`, t);
    if (!slot.ok) return;
    try {
      const out = await probe({ root, registry, config: source(), agent, now: t });
      if (!out.ok) releaseCooldown(root, `probe:${agent}`, t);
    } catch {
      releaseCooldown(root, `probe:${agent}`, t);
    }
  };
  return async (req, res, send) => {
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
    if (!proofValid(root, form.get('proof'))) return badProof(send);
    const action = form.get('action') || '';
    if (!ACTIONS.includes(action)) return send(400, 'text/plain; charset=utf-8', 'bad request');
    const t = now();
    const slot = reserveCooldown(root, 'resets', t, INBOX_COOLDOWN_MS);
    if (!slot.ok) return send(303, 'text/plain; charset=utf-8', 'too soon', { location: BACK, 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000))) });
    const r = apply(action, form, Object.keys(source().agents || {}), t);
    if (!r.ok) {
      releaseCooldown(root, 'resets', t);
      return refuseWith(send, 409, 'Nothing was changed', esc(r.reason), '<p><a href="/usage#c-limit-resets">Back to the Limit resets card</a></p>');
    }
    if (action === 'used') {
      await refresh(r.previous.agent, t);
      try { wake(root, 'approve', source()); } catch { /* the schedule is the fallback */ }
    }
    store.invalidate();
    return send(303, 'text/plain; charset=utf-8', 'recorded', { location: BACK });
  };
}

