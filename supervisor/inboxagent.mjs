// Issue #1127: select a fast-lane writer without hiding an allowance refusal behind the generic no-agent message.
// Pure data in, data out: Team supplies its configured agents and the external slot and allowance decisions.
export function chooseInboxAgent({ agents, limitedOf, providerSlotFull, usedBy, modes, admits }) {
  let allowanceRefusal = null;
  for (const [name, agent] of agents) {
    if (limitedOf(name).out || providerSlotFull(agent.provider, 'inbox', usedBy)) continue;
    const admission = modes?.[name] ? admits(modes[name], 'implement', 0) : { ok: true };
    if (!admission.ok) {
      allowanceRefusal ||= admission.why;
      continue;
    }
    return { agent: name, allowanceRefusal: null };
  }
  return { agent: null, allowanceRefusal };
}
