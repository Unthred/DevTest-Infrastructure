// Issue #1248: the meta model, GET /api/v1/meta. It describes the contract itself: the loaded models, the shared state vocabulary,
// and the commands and events that loaded route modules export (empty when none do). It reads no job data, so no view is prepared.
export const name = 'meta';
export const path = 'meta';
export const schema = 'meta.schema.json';
export const usesView = false;

const STATES = [
  ['running', 'active', ['job', 'agent']],
  ['idle', 'waiting', ['agent']],
  ['queued', 'waiting', ['job']],
  ['approved', 'done', ['inbox_item']],
  ['waiting_for_approval', 'waiting', ['inbox_item']],   // the Inbox state the store calls pending
  ['waiting_for_homeowner', 'waiting', ['issue', 'job']],
  ['held', 'held', ['issue', 'job', 'agent']],
  ['parked', 'held', ['issue']],
  ['paused', 'held', ['agent', 'team']],
  ['stalled', 'failed', ['job']],
  ['blocked', 'held', ['issue', 'job']],
  ['failed', 'failed', ['job', 'action']],
  ['halted', 'failed', ['team']],
  ['refused', 'failed', ['action']],
  ['rejected', 'done', ['inbox_item']],
  ['stopped', 'off', ['job', 'team']],
  ['completed', 'done', ['job']],
  ['done', 'done', ['issue', 'change']],
  ['stale', 'unknown', ['view']],
  ['unknown', 'unknown', ['job', 'agent', 'issue', 'inbox_item', 'view']],
];

const fromRoutes = (routes, key) => routes.flatMap(r => (Array.isArray(r[key]) ? r[key] : []));

export function build(view, context) {
  return {
    contract: '1.0',
    core_version: context.coreVersion ?? null,
    models: context.models.map(({ name, path, schema }) => ({ name, path: `/api/v1/${path}`, schema })),
    states: STATES.map(([state, group, appliesTo]) => ({ state, group, applies_to: appliesTo })),
    commands: fromRoutes(context.routes ?? [], 'commands'),
    events: fromRoutes(context.routes ?? [], 'events'),
  };
}
