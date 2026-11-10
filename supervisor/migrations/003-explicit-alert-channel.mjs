// Issue #1144: there is no default alert channel any more. An install that never named one keeps the route it always
// had (the Unraid notify script) by naming it explicitly, so alerts are not refused after the upgrade.
export const description = 'Name the Unraid alert channel in team.local.json when no alert route is configured';

export function migrate(local) {
  if (local?.alerts !== undefined) return local;
  return { ...local, alerts: { channel: 'unraid' } };
}
