// Issue #1257: the three Inbox decisions as named commands. Each calls the store's own decide or undo and changes nothing else about them.
// The store's sentence for a refusal is kept as the refusal text; the code is a stable word chosen from it.
import { allStatuses, decide, undo, UNDO_MS } from '../../inbox.mjs';
import { stateName } from '../models/inbox.mjs';

const INPUT = [{ name: 'id', type: 'string', required: true }];
const MODELS = ['inbox', 'overview', 'appbar'];
const iso = ms => new Date(ms).toISOString();

const REFUSALS = {
  'inbox.approve': ['ambiguous_id', 'unknown_item', 'wrong_state', 'item_changed'],
  'inbox.reject': ['ambiguous_id', 'unknown_item', 'wrong_state'],
  'inbox.undo_decision': ['ambiguous_id', 'unknown_item', 'undo_window_passed', 'already_acted_on', 'busy_try_again'],
};

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const refusalCodeOf = (command, reason) => {
  if (/changed after it was picked up/.test(reason)) return 'item_changed';
  if (/undo window/.test(reason)) return 'undo_window_passed';
  if (/being acted on/.test(reason)) return 'busy_try_again';
  if (/cannot be undone|already pending/.test(reason)) return 'already_acted_on';
  if (/unknown item/.test(reason)) return 'unknown_item';
  return command === 'inbox.undo_decision' ? 'already_acted_on' : 'wrong_state';
};

// The 8 character id or the full one; a short id that two items share is refused rather than guessed.
function resolveId(dir, given) {
  if (!/^([a-f0-9]{8}|[a-f0-9]{32})$/.test(given)) return refusal('unknown_item', 'An inbox id is 8 or 32 lowercase hexadecimal characters.');
  const hits = allStatuses(dir).filter(status => status.id.startsWith(given));
  if (hits.length > 1) return refusal('ambiguous_id', 'More than one inbox item starts with that id; use the full id.');
  if (!hits.length) return refusal('unknown_item', 'No inbox item has that id.');
  return { status: hits[0] };
}

const condition = status => {
  const state = stateName(status?.state);
  return { state, attention: state === 'waiting_for_approval' ? 'homeowner' : 'none', reason_code: null, reason_text: null, since: null };
};
const targetOf = status => ({
  kind: 'inbox_item', key: status.id.slice(0, 8), label: `Inbox item ${status.id.slice(0, 8)}`, title: status.title ?? null, source: null, project: null, url: null,
});
const stateOf = (dir, id) => allStatuses(dir).find(status => status.id === id);

function run(command, decision) {
  return (input, context) => {
    const dir = context.inboxDir;
    if (!dir) return refusal('unknown_item', 'The inbox is not configured.');
    const found = resolveId(dir, input.id);
    if (!found.status) return found;
    const { status } = found;
    const before = condition(status);
    const result = decision ? decide(dir, status.id, decision, context.now) : undo(dir, status.id, context.now);
    if (!result.ok) return refusal(refusalCodeOf(command, result.reason), result.reason);
    const after = stateOf(dir, status.id);
    const base = { outcome: 'applied', target: targetOf(after ?? status), before, after: condition(after), models: MODELS };
    if (!decision) return { ...base, undo: null };
    if (decision === 'approve') context.wake?.('approve');
    return { ...base, undo: { command: 'inbox.undo_decision', input: { id: status.id.slice(0, 8) }, until: iso(result.undoUntil ?? context.now + UNDO_MS) } };
  };
}

const define = (name, tier, decision, undoCommand) => ({
  name, tier, reason_required: false, reversible: Boolean(decision), undo_command: undoCommand, inputs: INPUT, refusals: REFUSALS[name], run: run(name, decision),
});

export const commands = [
  define('inbox.approve', 'person_only', 'approve', 'inbox.undo_decision'),
  define('inbox.reject', 'person_only', 'reject', 'inbox.undo_decision'),
  define('inbox.undo_decision', 'person_only', null, null),
];
