// Issue #1154: the Needs you lines for the Inbox: failed items (until resolved) and settings an Inbox job changed and did not restore.
// Pure: reads statuses through the inbox module passed in and the live team limits.
import { stillChanged } from './inboxconfig.mjs';
import { CAUSE_LABEL, legacyCause } from './inboxcause.mjs';
import { redactLong } from './redact.mjs';

const noun = kind => (kind === 'prompt' ? 'job' : kind === 'action' ? 'action' : 'item');

export function inboxAttention(store, inboxDir, limits) {
  const lines = [];
  for (const f of store.failedCards(inboxDir)) {
    const cause = CAUSE_LABEL[f.cause] || CAUSE_LABEL[legacyCause({ kind: f.kind, reason: f.why })];
    lines.push({
      id: `inboxfail-${f.id}`, inboxId: f.id, inboxKind: f.kind, ref: null, severity: 'action', since: f.since, resolvable: 'failure',
      text: `An overseer ${noun(f.kind)} failed${f.job ? ` (job ${f.job})` : ''}. Cause: ${cause}. ${f.why}`,
      action: `${f.job ? `Look at it with ai-supervisor status ${f.job}. ` : ''}It stays here until it has a resolution: the overseer re-proposes or supersedes it (foreman_propose with resolves), or you mark it done by other means or dropped, with a note.`,
    });
  }
  for (const s of store.allStatuses(inboxDir)) {
    if (!s.configChanges || s.configAck) continue;
    const now = stillChanged(s.configChanges, limits);
    if (!now.length) continue;
    const list = now.map(c => `${c.key} is ${c.now === null ? 'unset' : c.now} (was ${c.was === null ? 'unset' : c.was})`).join(', ');
    lines.push({
      id: `inboxconfig-${s.id}`, inboxId: s.id, inboxKind: s.kind, ref: null, severity: 'action', since: s.updatedAt ?? null, resolvable: 'setting',
      text: redactLong(`An overseer job (job ${s.job || 'unknown'}) ended without restoring a setting it changed: ${list}.`, 400, ' [cut]'),
      action: 'Restore the value, or keep it on purpose and say so with a note; this line leaves when the value is back or you keep it.',
    });
  }
  return lines;
}
