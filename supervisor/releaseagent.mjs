// Issue #1179: the approved release of an agent parked after an infrastructure fault. A refusal is an error, so the inbox item ends 'failed'
// with the reason and nothing changes. `flow` is the team's FaultFlow.
const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
export function releaseAgentApproved(agent, flow) {
  const rec = flow.release(agent, 'homeowner');
  if (!rec) throw new Error(`${agent} is not parked; nothing to release`);
  return `${agent} released from its park (${rec.cause}, job ${rec.job || 'unnamed'}, parked since ${when(rec.since)} UTC)`;
}
