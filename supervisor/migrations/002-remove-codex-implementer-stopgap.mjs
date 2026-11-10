// Issue #1123: the temporary cap only avoided slots being wasted before the
// planner checked startability. The corrected planner no longer needs it.
export const description = 'Remove the temporary Codex implementer cap from team.local.json';

export function migrate(local) {
  const limits = local?.limits;
  const providerRoles = limits?.provider_roles;
  const codex = providerRoles?.codex;
  if (!codex || typeof codex !== 'object' || Array.isArray(codex) || codex.implementer !== 1) return local;
  const next = structuredClone(local);
  delete next.limits.provider_roles.codex.implementer;
  if (!Object.keys(next.limits.provider_roles.codex).length) delete next.limits.provider_roles.codex;
  if (!Object.keys(next.limits.provider_roles).length) delete next.limits.provider_roles;
  if (!Object.keys(next.limits).length) delete next.limits;
  return next;
}
