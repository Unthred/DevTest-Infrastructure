// Issue #1257: the audit model, GET /api/v1/audit. The command audit trail newest first (at most 200 entries) and the counts of the last 24
// hours. direct_control is null until the switch for direct commands exists. It reads the audit file in the state root and writes nothing.
import { readEntries, SUMMARY_WINDOW_SECONDS } from '../audit.mjs';

export const name = 'audit';
export const path = 'audit';
export const schema = 'audit.schema.json';
export const usesView = false;

export const MAX_ENTRIES_SHOWN = 200;

// available turns false by itself once the undo time has passed, though the stored flag is only cleared by an undo.
const undoOf = (undo, now) => (undo ? { ...undo, available: undo.available && !undo.undone_by && Date.parse(undo.until) > now } : null);

export function build(_view, context) {
  const entries = readEntries(context.root);
  const since = context.now - SUMMARY_WINDOW_SECONDS * 1000;
  const recent = entries.filter(entry => Date.parse(entry.at) >= since);
  const count = test => recent.filter(test).length;
  return {
    direct_control: null,
    summary: {
      window_seconds: SUMMARY_WINDOW_SECONDS,
      applied: count(entry => entry.outcome === 'applied'),
      refused: count(entry => entry.outcome === 'refused'),
      undone: count(entry => entry.undo?.undone_by),
    },
    entries: entries.slice(-MAX_ENTRIES_SHOWN).reverse().map(entry => ({ ...entry, undo: undoOf(entry.undo, context.now) })),
  };
}
