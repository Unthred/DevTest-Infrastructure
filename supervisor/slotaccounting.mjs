// Pure slot accounting used by the planner. An Inbox job may be live before its
// job record is adopted into state, so its Inbox status is authoritative then.
export function activeSlotUse({ active, records, roles, roleOfType, inboxStatuses = [] }) {
  const inboxIds = new Set(inboxStatuses
    .filter(status => status?.state === 'running' && status.adopt?.rec?.kind === 'inbox' && status.adopt.id)
    .map(status => status.adopt.id));
  const occupying = active.filter(job => job.status !== 'paused_limit');
  const used = Object.fromEntries(roles.map(role => [role, 0]));
  const usedBy = {};
  let total = 0;
  for (const job of occupying) {
    const kind = records[job.id]?.kind ?? (inboxIds.has(job.id) ? 'inbox' : undefined);
    const role = roleOfType(kind);
    used[role]++;
    const providerRole = `${job.provider}:${role}`;
    usedBy[providerRole] = (usedBy[providerRole] || 0) + 1;
    if (role !== 'inbox') total++;
  }
  return { occupying, used, usedBy, total };
}

// The planner records this before allocating a slot, rather than leaving a
// later launch-time check to waste a slot for work that cannot start.
export function unavailableStart(agent, action, limit) {
  if (!limit?.out) return null;
  const reason = String(limit.reason || 'usage limit').slice(0, 200);
  if (limit.parked) return `${action.type} held: ${agent} is parked after an ${reason}`;   // issue #1179: a parked agent is not out of allowance
  return `${action.type} held: ${agent} is out of allowance (${reason})`;
}
