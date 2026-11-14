// Issue #1255: the Inbox read model, GET /api/v1/inbox. Built from every status record the Inbox store keeps (not only the waiting ones)
// and the cards it already makes for waiting items. It gives the counts a client puts on filter buttons, a page of items of one stable
// shape whatever their state, and a cursor. It reads the folder named by context.config.inbox.dir and writes nothing.
import { allStatuses, pendingCards, UNDO_MS, ACTIONS } from '../../inbox.mjs';
import { redactLong } from '../../redact.mjs';
import { reasonCodeOf } from '../inbox-reasons.mjs';
import { referenceText } from '../../../foreman-mcp/inbox-reference.mjs';
import { filterOf, pageOf, countBy, sortItems } from '../inbox-query.mjs';

export const name = 'inbox';
export const path = 'inbox';
export const schema = 'inbox.schema.json';
export const usesView = false;

const NOT_BUILT = { code: 'not_built', text: 'This control is not built yet.' };
const LABEL = { pr: 'Pull request', issue: 'Issue', job: 'Job' };
const WAITING = 'waiting_for_approval';
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const clip = (text, max) => redactLong(String(text ?? '').replace(/\s+/g, ' '), max, ' [cut]').trim();

// The store's name for a state, to the contract's: pending waits for approval and posting is running. No other name changes.
export const stateName = stored => {
  if (stored === 'pending') return WAITING;
  if (stored === 'posting') return 'running';
  return typeof stored === 'string' && stored ? stored : 'unknown';
};
const attentionOf = state => (state === WAITING ? 'homeowner' : state === 'failed' ? 'fault' : 'none');

function actionOf(command, id, known) {
  const enabled = known.has(command);
  return {
    command, input: { id }, enabled, tier: 'person_only', reversible: null,
    refusal_code: enabled ? null : NOT_BUILT.code, refusal_text: enabled ? null : NOT_BUILT.text,
  };
}
const ACTIONS_OF = { [WAITING]: ['inbox.approve', 'inbox.reject', 'inbox.park'], failed: ['inbox.requeue', 'inbox.dismiss'] };
const actionsOf = (state, id, known) => (ACTIONS_OF[state] || []).map(command => actionOf(command, id, known));

// A ref only for an action item that names a pull request, issue or job. The waiting card's text starts with the action name (the store
// writes it as "<action> <target>"), and its target field holds the target.
function targetOf(card) {
  const action = String(card?.text ?? '').split(/\s/)[0];
  const spec = card?.kind === 'action' && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!spec || !LABEL[spec.target] || !card.target) return null;
  const key = String(card.target);
  return { kind: spec.target, key, label: `${LABEL[spec.target]} ${key}`, title: null, source: null, project: null, url: null };
}

function itemOf(status, card, now, known) {
  const state = stateName(status.state);
  const failedOrRefused = state === 'failed' || state === 'refused';
  const reason = failedOrRefused && status.reason ? clip(status.reason, 400) : null;
  const kept = card && !card.broken ? card : null;
  const decided = Number.isFinite(status.decidedAt) ? status.decidedAt : null;
  const undoable = decided !== null && ['approved', 'rejected'].includes(state) && now - decided <= UNDO_MS && now >= decided;
  const kind = status.kind ?? 'unknown';
  return {
    id: status.id.slice(0, 8),
    full_id: status.id,
    number: status.number ?? null,   // issue #1414: the card number people use ("C142")
    reference: referenceText(status.number, status.issue),
    kind,
    state,
    attention: attentionOf(state),
    title: clip(status.title ?? card?.title, 200) || 'An inbox item that cannot be shown',
    why: kept?.why ?? null,
    will_text: kept?.will ?? null,
    body_text: kept?.text ?? null,
    proposed_by: kind === 'host_value' ? 'foreman' : 'overseer',
    created_at: iso(status.createdAt),
    decided_at: iso(decided),
    undo_until: undoable ? iso(decided + UNDO_MS) : null,
    result_text: status.result ? clip(status.result, 400) : null,
    reason_code: failedOrRefused ? reasonCodeOf(status.reason, { state, kind }) : null,
    reason_text: reason,
    target: targetOf(kept),
    job_id: /^[a-f0-9]{8}$/.test(status.job || '') ? status.job : null,
    parked: false,
    actions: actionsOf(state, status.id.slice(0, 8), known),
  };
}

const commandsOf = routes => new Set((routes || []).flatMap(r => (Array.isArray(r.commands) ? r.commands : [])).map(c => c?.name ?? c?.command ?? c));

export function build(_view, context) {
  const dir = context.config?.inbox?.dir ?? null;
  const known = commandsOf(context.routes);
  const cards = dir ? new Map(pendingCards(dir).map(card => [card.id, card])) : new Map();
  const items = (dir ? allStatuses(dir) : []).map(status => itemOf(status, cards.get(status.id), context.now, known));
  const matched = items.filter(filterOf(context.query));
  const page = pageOf(sortItems(matched, context.query.sort), context.query);
  return {
    facets: { state: countBy(items, 'state'), kind: countBy(items, 'kind') },
    page: { total: items.length, matched: matched.length, returned: page.items.length, next_cursor: page.next },
    items: page.items,
  };
}
