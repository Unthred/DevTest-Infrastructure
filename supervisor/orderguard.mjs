// Issue #971 and #1238: the order guard. While a prompt that changes queue order or config is approved or running in the inbox lane, no new
// implement job is handed out, so the change applies before the next pick. The guard may delay work only for a bounded time and only for a
// prompt that can still run: a prompt that cannot start now (breaker halt, usage limit, unusable worktree), one older than twice the inbox
// time cap, one declared read only, and one whose hold was dropped to break a cycle are all ignored.
import * as inboxStore from './inbox.mjs';
import * as breaker from './breaker.mjs';
import { breakCycles } from './holdgraph.mjs';
import { redact } from './redact.mjs';

// Keywords cannot tell which prompt changes order or config ('Swap 940 and 935', 'Skip 935'), so a prompt is order sensitive unless it
// says in its `effect` field that it only reads or only reports.
export const orderSensitive = item => !inboxStore.PROMPT_EFFECTS.includes(item?.effect);

const minutes = ms => Math.round(ms / 60000);
const RUNNING = (capMs, what) => `waiting for a running inbox prompt that changes queue order or config${what}; new implement work starts when it ends, at the latest ${minutes(2 * capMs)} minutes after it started`;
const APPROVED = (title, capMs) => `waiting for an approved inbox prompt "${String(title).slice(0, 60)}" that changes queue order or config; new implement work starts after it has run, or when it is rejected or undone, or ${minutes(2 * capMs)} minutes after it was approved`;

// What stops an approved prompt from starting now, or null.
export function cannotStart(team, id) {
  const halt = breaker.blocks(team.s.breaker, team.c.breaker, { type: 'inbox', issue: null });
  if (halt) return { kind: 'breaker', why: `the circuit breaker halted new ${halt.cause === '@global' ? 'jobs' : 'inbox prompts'} (${halt.cause})`, halt };
  const agents = team.agents().map(([n]) => n);
  if (agents.length && agents.every(n => team.limitedOf(n).out)) return { kind: 'limit', why: 'every agent is at a usage limit', halt: null };
  if (team.worktreeUnusable('inbox', id)) return { kind: 'worktree', why: 'its worktree is unusable (a stale lease or a foreign directory)', halt: null };
  return null;
}

// Every approved, unstarted order sensitive prompt that is old enough to still count, with whether the guard ignores it and why.
export function approvedPrompts(team, capMs) {
  const dir = team.inboxDir(), now = team.clock.now(), out = [];
  if (!dir) return out;
  for (const st of inboxStore.approvedItems(dir, 'prompt')) {
    if (Object.values(team.s.jobs).some(j => j.inboxId === st.id)) continue;
    const l = inboxStore.loadItem(dir, st.id);
    if (!l.ok || !orderSensitive(l.item)) continue;
    const age = now - (st.decidedAt || now), blocked = cannotStart(team, st.id), dropped = !!team.s.holdDrops?.[`order-guard:${st.id}`];
    const ignored = dropped ? 'dropped to break a cycle of holds'
      : age >= 2 * capMs ? `older than twice the inbox time cap (${minutes(2 * capMs)} minutes)`
      : blocked ? `cannot start now: ${blocked.why}` : null;
    out.push({ id: st.id, title: l.item.title, since: st.decidedAt || now, ignored, blocked, dropped });
  }
  return out;
}

// The reason new implement work waits, or null.
export function orderGuardReason(team, capMs) {
  if (!team.inboxDir()) return null;
  const now = team.clock.now(), stale = 2 * capMs;
  for (const [id, j] of Object.entries(team.s.jobs)) if (j.kind === 'inbox' && !j.ingested && j.orderSensitive && now - (j.at || 0) < stale) return RUNNING(capMs, ` (job ${id.slice(0, 8)})`);
  // A job the fast lane started during this pass is held only in its item's status (adopt) until the next pass adopts it.
  for (const st of inboxStore.allStatuses(team.inboxDir())) if (st.state === 'running' && st.adopt?.rec?.kind === 'inbox' && !st.adopt.rec.ingested && !team.s.jobs[st.adopt.id] && now - (st.adopt.rec.at || 0) < stale) return RUNNING(capMs, '');
  const holder = approvedPrompts(team, capMs).find(p => !p.ignored);
  return holder ? APPROVED(holder.title, capMs) : null;
}

// The holds of this pass as graph edges (see holdgraph.mjs). The order guard makes implement picks wait for each prompt; a prompt that a
// halt stops waits for the halt to end, which for a halt of implement jobs needs an implement job to succeed, so it waits for the picks.
export function holdEdges(team, capMs) {
  const edges = [];
  for (const p of approvedPrompts(team, capMs)) {
    if (p.ignored && !p.blocked) continue;   // aged out or dropped: it holds nothing
    const h = p.blocked?.halt, clearedByImplement = (h?.types || []).includes('implement');
    // The guard ignores a blocked prompt, so its edge is `latent`: it counts for cycle detection (the guard applies it the moment the
    // prompt could start) but is never reported as a hold that is lasting.
    if (!p.dropped && (!p.blocked || clearedByImplement)) edges.push({ id: `order-guard:${p.id}`, waiter: 'implement-picks', waitsFor: `prompt:${p.id}`, priority: 1, latent: !!p.ignored, text: `new implement picks wait for the approved prompt "${String(p.title).slice(0, 60)}"` });
    if (p.blocked) {
      const id = p.blocked.kind === 'breaker' ? `breaker:${h.cause}:${p.id}` : `${p.blocked.kind}:${p.id}`;
      edges.push({ id, waiter: `prompt:${p.id}`, waitsFor: h && clearedByImplement ? 'implement-picks' : 'homeowner', priority: 3,
        text: `the prompt "${String(p.title).slice(0, 60)}" waits for ${p.blocked.why}${clearedByImplement ? ', which ends when an implement job succeeds' : ''}` });
    }
  }
  return edges;
}

export const LONG_HOLD_MS = 30 * 60000;
// Each hold kind has its own owner and the control that clears it.
const OWNER = {
  'order-guard': { owner: 'overseer', control: 'reject or undo the prompt on its Inbox card' },
  breaker: { owner: 'homeowner', control: 'Resume on the Breaker card, or ai-supervisor team breaker resume' },
  limit: { owner: 'nobody to act, it ends when an agent usage limit resets', control: 'wait for the reset, or reject or undo the prompt on its Inbox card' },
  worktree: { owner: 'overseer', control: 'repair or remove the unusable worktree named on the job, or reject or undo the prompt on its Inbox card' },
};

// Each pass: find holds that wait for each other and drop the lowest priority hold of each cycle (it is remembered in s.holdDrops so the guard
// ignores that prompt and the Needs you item stays while the prompt is waiting); remember when each hold was first seen, for the 30 minute owner item.
export function checkHolds(team, capMs, report) {
  const now = team.clock.now(), s = team.s;
  s.holdDrops ||= {}; s.holdSeen ||= {};
  const waiting = new Set(approvedPrompts(team, capMs).map(p => p.id));
  for (const [key, d] of Object.entries(s.holdDrops)) if (!waiting.has(d.prompt)) delete s.holdDrops[key];   // the prompt ran, was undone or aged out
  const edges = holdEdges(team, capMs), { dropped, cycles } = breakCycles(edges);
  dropped.forEach((drop, i) => {
    s.holdDrops[drop.id] = { at: now, prompt: drop.waitsFor.replace(/^prompt:/, ''), dropped: drop.id, holds: cycles[i].map(h => ({ id: h.id, text: h.text })) };
    (report.holdCycles ||= []).push({ dropped: drop.id, holds: cycles[i].map(h => h.id) });
  });
  const live = new Set(edges.filter(h => !h.latent && !dropped.some(d => d.id === h.id)).map(h => h.id));
  for (const id of Object.keys(s.holdSeen)) if (!live.has(id)) delete s.holdSeen[id];
  for (const h of edges) if (live.has(h.id) && !h.latent) s.holdSeen[h.id] ||= { since: now, text: h.text };
  if (dropped.length) team.save();
}

// Needs you items: one per dropped cycle (action severity, naming both holds) and one per hold that has lasted more than 30 minutes, with its owner and its control.
export function holdItems(team) {
  const now = team.clock.now(), out = [];
  for (const d of Object.values(team.s.holdDrops || {})) {
    out.push({ id: `hold-cycle-${String(d.prompt).slice(0, 8)}`, since: d.at, severity: 'action', ref: null,
      text: redact(`Two holds waited for each other: ${d.holds.map(h => h.text).join(' AND ')}. Foreman dropped the lowest priority hold (${d.dropped}) so work can start.`, 600),
      action: 'Nothing is stopped now. Check why the prompt cannot start, then resume the breaker or undo the prompt.' });
  }
  for (const [id, h] of Object.entries(team.s.holdSeen || {})) {
    if (now - h.since < LONG_HOLD_MS) continue;
    const o = OWNER[id.split(':')[0]] || { owner: 'homeowner', control: 'resolve the hold' };
    out.push({ id: `stalled-hold-${id.replace(/[^a-z0-9]+/gi, '-')}`, since: h.since, severity: 'warning', ref: null,
      text: redact(`Held for ${Math.round((now - h.since) / 60000)} minutes: ${h.text}. Owner: ${o.owner}.`, 600), action: `Clear it with: ${o.control}.` });
  }
  return out;
}
