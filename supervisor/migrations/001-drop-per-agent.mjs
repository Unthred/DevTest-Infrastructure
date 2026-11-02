// Issue #153 / #148: limits.per_agent is replaced by limits.roles. A local per_agent overrides the shipped roles and would allow two
// implementers, so it is removed unless the homeowner also set limits.roles locally.
export const description = 'Remove the deprecated limits.per_agent from team.local.json so the shipped limits.roles apply';
export function migrate(local) {
  if (!local || typeof local !== 'object' || Array.isArray(local)) return local;
  const limits = local.limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) || !('per_agent' in limits) || 'roles' in limits) return local;
  const { per_agent: _dropped, ...rest } = limits;
  const out = { ...local };
  if (Object.keys(rest).length) out.limits = rest; else delete out.limits;
  return out;
}
