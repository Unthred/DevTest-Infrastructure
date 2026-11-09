// Issue #1121: for every open issue, who will implement it, by which rule and rank, and exactly what it waits on.
// explainIssue is a pure decision over plain data; collectAssignments reads the Team and feeds it. Nothing here starts, moves or
// changes work: it only makes the planner's current behaviour visible (who gets unassigned work is the V2 admission redesign).
import { MODE_LABEL } from './budget.mjs';
import { reserveOut } from './capacityteam.mjs';
import { redact } from './dashdata.mjs';

// Wait kinds that mean the issue is not stuck: it is running, has its PR, or starts on this tick.
export const MOVING_KINDS = new Set(['running', 'pr-open', 'next']);
const RULE_TEXT = {
  listed: (a, r, of) => `listed in agents.${a}.issues (position ${r} of ${of})`,
  queued: (a, r, of) => `queued for ${a} by the unblock list (position ${r} of ${of})`,
  unlisted: (a, r, of) => `in no agent's issue list: open issues are taken in number order by the first agent with a free slot (position ${r} of ${of})`
};

const clock = (until, zone) => (Number.isFinite(until) ? new Intl.DateTimeFormat('en-GB', { timeZone: zone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(until)).replace(',', '') : null);
const at = (until, zone) => (clock(until, zone) ? ` until ${clock(until, zone)}` : '');

// i = { number, zone, running, prText, exclusion: { kind, text } | null, startedEarlier, owner: { agent, rule, rank, of } | null,
//       agents: [{ name, canImplement, model, out: { kind, text, until } | null, busy, hold }], planned: { agent, reassignedFrom } | null, capText }
// Returns { number, agent, model, rule, rank, of, wait: { kind, text, until }, fault }. `fault` is a sentence when the issue has no
// implementer and no stated reason; it is never left silent.
export function explainIssue(i) {
  const named = i.owner?.agent ? i.agents.find(a => a.name === i.owner.agent) : null;
  const free = i.agents.filter(a => a.canImplement && !a.out), ready = free.find(a => !a.busy && !a.hold) || free[0];
  const chosen = i.planned ? i.agents.find(a => a.name === i.planned.agent) : named || ready || null;
  const agent = chosen?.name ?? null, rule = i.owner ? RULE_TEXT[i.owner.rule](i.owner.agent || 'any agent', i.owner.rank, i.owner.of) : 'no rule assigns it';
  const base = { number: i.number, agent, model: chosen?.model ?? null, rule: i.planned?.reassignedFrom ? `${rule}; reassigned from ${i.planned.reassignedFrom} for allowance` : rule, rank: i.owner?.rank ?? null, of: i.owner?.of ?? null };
  const wait = waitOf(i, chosen);
  return { ...base, wait, fault: !agent && !wait ? 'open issue with no implementer and no stated reason' : null };
}

function waitOf(i, chosen) {
  const w = (kind, text, until = null) => ({ kind, text, until });
  if (i.exclusion) {
    const dependency = ['prerequisite', 'waiting_on'].includes(i.exclusion.kind);
    return w(i.exclusion.kind === 'label' ? 'homeowner' : dependency ? 'dependency' : 'excluded', i.exclusion.text);
  }
  if (i.running) return w('running', 'being implemented now');
  if (i.prText) return w('pr-open', i.prText);
  if (i.startedEarlier) return w('started-earlier', 'started earlier; no PR yet');
  if (i.planned) return w('next', `starts on the next tick on ${i.planned.agent}`);
  if (!chosen) return allOut(i);
  if (chosen.out) return w(chosen.out.kind, `${chosen.name} ${chosen.out.text}${at(chosen.out.until, i.zone)}`, chosen.out.until ?? null);
  if (i.capText) return w('cap', i.capText);
  if (chosen.hold) return w('held', `${chosen.name} is held: ${chosen.hold}`);
  if (chosen.busy) return w('busy', `ready; ${chosen.name} is busy with a running job`);
  return w('not-admitted', `ready; not admitted yet: ${chosen.name} has no planned start this tick (limits, a lease or a free slot may hold it)`);
}

// No agent can take an unlisted issue: say why for each one, or return null so the caller reports the fault.
function allOut(i) {
  const out = i.agents.filter(a => a.canImplement && a.out);
  if (!out.length) return null;
  const first = out[0].out;
  return { kind: first.kind, text: out.map(a => `${a.name} ${a.out.text}${at(a.out.until, i.zone)}`).join('; '), until: out.map(a => a.out.until).filter(Number.isFinite).sort((x, y) => x - y)[0] ?? null };
}

// The agent's own reason for not taking implement work now: paused or reviews-only mode, the reserve, or a usage limit.
function outOf(team, agent) {
  const m = team.modes?.[agent];
  if (m && m.mode !== 'normal') {
    const reserve = m.rule === 'high-water';
    return { kind: m.mode === 'waiting' ? 'agent-paused' : reserve ? 'reserve' : 'allowance', text: `is ${MODE_LABEL[m.mode] || m.mode} (${String(m.reason || '').slice(0, 160)})`, until: m.until ?? null };
  }
  const held = reserveOut(m);
  if (held) return { kind: 'reserve', text: held.why, until: held.until ?? null };
  const l = team.limitedOf?.(agent);
  return l?.out ? { kind: 'allowance', text: `is at its usage limit (${String(l.reason || 'usage limit').slice(0, 160)})`, until: l.until ?? null } : null;
}

// Where an issue sits in the planner's order: its owner's hand list, the unblock queue, or the unlisted pool in number order.
function ownerOf(team, number, unlisted) {
  for (const [agent, a] of team.agents()) {
    const k = (a.issues || []).indexOf(number);
    if (k >= 0) return { agent, rule: 'listed', rank: k + 1, of: a.issues.length };
  }
  for (const [agent] of team.agents()) {
    const q = team.s.unblock?.queued?.[agent] || [], k = q.indexOf(number);
    if (k >= 0) return { agent, rule: 'queued', rank: k + 1, of: q.length };
  }
  const k = unlisted.indexOf(number);
  return k >= 0 ? { agent: null, rule: 'unlisted', rank: k + 1, of: unlisted.length } : null;
}

// One explanation per open, undelivered issue. `ctx` = { cache, plan, states, activeJobs }; read-only on the team.
export function collectAssignments(team, { cache, plan, states, activeJobs }) {
  const prs = cache.pulls || [], issues = cache.issues || [], byNo = new Map(issues.map(x => [x.number, x]));
  const open = issues.filter(x => x.state === 'OPEN' && !team.delivered?.has(x.number)).sort((x, y) => x.number - y.number);
  const unlisted = team.unlisted ? team.unlisted() : [];
  const capText = team.pauseText(prs, issues);
  const model = agent => { try { return team.modelFor({ agent, key: 'wb:implement' }, 'implement', {}, true).model ?? null; } catch { return null; } };
  const agents = team.agents().map(([name]) => ({ name, canImplement: true, model: model(name), out: outOf(team, name), busy: !['idle', 'blocked'].includes(states[name]?.state), hold: team.held?.[name]?.implement || null }));
  return open.map(issue => {
    const n = issue.number, re = new RegExp(`/issue-${n}(\\D|$)`);
    const pr = prs.find(p => re.test(p.headRefName)), act = plan.find(x => x.type === 'implement' && x.issue === n);
    return explainIssue({ number: n, zone: team.timeZone, agents, capText,
      exclusion: team.exclusion(n, byNo, prs),
      running: activeJobs.some(j => ['implement', 'continue'].includes(j.kind) && j.issue === n),
      prText: pr ? `PR #${pr.number} is open` : null,
      startedEarlier: !!team.s.implemented?.[n],
      owner: ownerOf(team, n, unlisted),
      planned: act ? { agent: act.agent, reassignedFrom: act.reassignedFrom || null } : null });
  });
}

// The idle line for an agent with nothing planned: names the rule that leaves it idle, from the explanations of the open issues.
export function idleRuleText(agent, listedCount, assignments) {
  const mine = assignments.filter(a => a.agent === agent && !MOVING_KINDS.has(a.wait?.kind));
  const own = assignments.filter(a => a.rank != null && a.rule.includes(`agents.${agent}.issues`)).length;
  if (mine.length) return `rule: ${mine[0].rule}; #${mine[0].number} waits (${mine[0].wait.kind}): ${mine[0].wait.text}`;
  const pool = assignments.filter(a => a.rule.startsWith('in no agent') && !MOVING_KINDS.has(a.wait?.kind));
  if (pool.length) return `rule: unlisted issues go to the first agent with a free slot; ${pool.length} open (${pool.slice(0, 3).map(a => `#${a.number} to ${a.agent || 'no agent'}`).join(', ')}), ${agent} waits for its turn`;
  return `rule: agents.${agent}.issues lists ${listedCount} issue${listedCount === 1 ? '' : 's'}, ${own} still open; no open issue is assigned to ${agent} by any rule`;
}

// The view's share of the explanations: `assignments` (names and text redacted), `assignmentFaults`, and each issue row with its
// explanation; a row with no other reason shows the wait (or the fault) as its status so the Issues table never shows a blank.
export function assignmentFields(extra, assignments, names) {
  const rows = (assignments || []).map(a => ({ ...a, name: redact(names.issue(a.number).text, 300), rule: redact(a.rule, 300), wait: a.wait && { ...a.wait, text: redact(a.wait.text, 300) } }));
  const by = new Map(rows.map(r => [r.number, r]));
  const status = r => (r?.fault ? `FAULT: ${r.fault}` : r?.wait ? `${r.agent || 'no agent'}: ${r.wait.text}` : null);
  const issues = extra.issues.map(i => ({ ...i, assignment: by.get(i.number) ?? null, reason: i.reason || status(by.get(i.number)) }));
  return { ...extra, assignments: rows, assignmentFaults: rows.filter(r => r.fault).map(r => ({ issue: r.number, fault: r.fault })), issues };
}
