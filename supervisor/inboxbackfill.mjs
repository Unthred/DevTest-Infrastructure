// Issue #1154: items that failed before causes existed get a cause and evidence now, once. A read only prompt that only "changed nothing"
// was never a failure (requirement 1): it is put right, judged from the title and the agent's own summary, because the item file is gone.
import { isReadOnlyPrompt, legacyCause, NOTHING_CHANGED_WHY } from './inboxcause.mjs';

const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

export function backfillFailures(store, inboxDir, now) {
  const changed = [];
  for (const s of store.allStatuses(inboxDir)) {
    if (s.state !== 'failed' || s.cause) continue;
    const cause = legacyCause(s);
    const readOnlyNothing = s.kind === 'prompt' && cause === 'no_change' && /\bSTATUS:\s*nothing_changed\b/i.test(s.result || '') && isReadOnlyPrompt({ title: s.title || '' });
    if (readOnlyNothing) {
      store.finish(inboxDir, s.id, { state: 'done', reason: null, cause: null, evidence: null, correctedFrom: NOTHING_CHANGED_WHY }, now);
      changed.push({ id: s.id, to: 'done' });
    } else {
      store.finish(inboxDir, s.id, { cause, evidence: clip(s.reason || s.result || 'no reason recorded') }, now);
      changed.push({ id: s.id, to: cause });
    }
  }
  return changed;
}
