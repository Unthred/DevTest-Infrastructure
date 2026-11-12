// Issue #1154: foreman_inbox_failures. Every failed Inbox item with its cause, evidence and resolution, so the overseer can see what failed and
// resolve it (a new proposal with `resolves`). Read-only. The rows are single-line strings so the list is not cut by the text bound; if the
// bound is still reached, resolved rows are dropped first and the answer says how many were left out.
import { redact } from './redact.mjs';

const BUDGET = 22000;   // of the 24000-character answer bound, measured on the serialised answer
const clip = (text, max) => redact(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function failureRow(s) {
  const r = s.resolution;
  return {
    proposalId: s.id, shortId: s.id.slice(0, 8), title: s.title ? clip(s.title, 120) : null, kind: s.kind ?? null, jobId: s.job ?? null,
    cause: s.cause ?? null, evidence: clip(s.evidence || s.reason || s.result || 'no reason recorded', 200), failedAt: iso(s.updatedAt),
    resolution: r ? { type: String(r.type), ref: r.ref ? String(r.ref) : null, note: r.note ? clip(r.note, 200) : null, at: iso(r.at) } : null,
  };
}

export function inboxFailureTools({ inbox }) {
  return [{
    name: 'foreman_inbox_failures',
    description: 'Every failed Inbox item (proposal id and title, job id, cause, evidence line, resolution), unresolved first. Causes: time_cap, no_change, no_result, guard_refused, fault, allowance. An item stays in Needs you until it has a resolution. Record re-proposed or superseded with foreman_propose and `resolves` (the proposalId or shortId here); dropping or "done by other means" needs the homeowner on the dashboard. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: () => {
      const all = inbox.failureRows().map(failureRow);
      const ordered = [...all.filter(r => !r.resolution), ...all.filter(r => r.resolution)].map(r => JSON.stringify(r));
      let used = 0; const rows = [];
      for (const line of ordered) { const cost = JSON.stringify(line).length + 3; if (used + cost > BUDGET) break; used += cost; rows.push(line); }
      const unresolved = all.filter(r => !r.resolution).length;
      return { total: all.length, unresolved, rows, ...(rows.length < all.length ? { omitted: all.length - rows.length, note: 'resolved rows were left out to fit the answer' } : {}) };
    },
  }];
}
