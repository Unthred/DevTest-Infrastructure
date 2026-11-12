// Issue #1163: the allowance refresh at the admission decision. Just before a planned job starts, a stale reading or one near the reserve is
// refreshed with the minimal probe (#110) and the job is judged again against the new reading. No job planned for an agent, no probe: there is no timer.
import { admits } from './budget.mjs';

// team.admissionProbe: { canProbe(providerId), run(due) -> allowance record | null }, set by the tick; absent in a dry run or under an upgrade hold.
// Returns a limit-like { out: true, reason } (what limitedOf returns) when the fresh reading no longer admits the job, otherwise null.
export async function refreshBeforeAdmission(team, act) {
  const probe = team.admissionProbe;
  if (!probe || !act.agent) return null;
  const provider = team.agents().find(([name]) => name === act.agent)?.[1]?.provider;
  const due = team.probesDue(probe.canProbe, new Set([act.agent])).find(d => d.agent === act.agent && d.provider === provider);
  if (!due) return null;
  team.noteProbe(act.agent, due);   // recorded whether or not the probe yields a reading, so a failing probe runs once per interval
  const record = await probe.run(due);
  if (!record) return null;
  team.usage.allowance = { ...(team.usage.allowance || {}), [provider]: record };
  team.modes = team.budgets();
  const verdict = admits(team.modes?.[act.agent], act.type, 0);
  return verdict.ok ? null : { out: true, reason: `fresh reading: ${verdict.why}` };
}
