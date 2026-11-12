// Issue #1157: the routine actions on foreman_propose's published schema. Kept out of tools.mjs so that file's long lines do not grow; the
// inbox (foreman-mcp/inbox.mjs) is what accepts or refuses an item.
const ROUTINE_NAMES = ['extra_fix_round', 'close_superseded', 'resume_breaker'];
const DESCRIPTION = ' Routine actions: extra_fix_round with a PR number and an optional model (a configured worker) allows one more fix job past the fix limit '
  + 'and the churn stop; close_superseded with a PR or issue number and superseded_by (the superseding numbers) saves the branch and closes it; '
  + 'resume_breaker with a tripped breaker scope resumes it.';

export function withRoutineActions(tool) {
  if (tool.name !== 'foreman_propose') return tool;
  const props = tool.inputSchema.properties;
  const action = { ...props.action, enum: [...props.action.enum, ...ROUTINE_NAMES] };
  const target = { ...props.target, maxLength: 40, description: 'kind action: PR or issue number, 8-character job id, or (resume_breaker) breaker scope' };
  const model = { type: 'string', maxLength: 30, description: 'extra_fix_round: optional configured worker to write the round' };
  const supersededBy = { type: 'string', maxLength: 60, description: 'close_superseded: the superseding issue or PR numbers, for example "12, 13"' };
  const properties = { ...props, action, target, model, superseded_by: supersededBy };
  return { ...tool, description: tool.description + DESCRIPTION, inputSchema: { ...tool.inputSchema, properties } };
}
