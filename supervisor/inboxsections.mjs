// Inbox sections (issue #976). Pure: each item the dashboard already lists is assigned to one of three sections by a rule that is
// shown with it, and carries one recommended action with a line saying why. Nothing here changes state or decides anything.
//   decide  "Decide now": it blocks other work (blocks > 0), risks harm (breaker, upgrade, storage, merge/verdict gates), or a refusal/failure
//           the overseer or Foreman cannot get past alone.
//   wait    "Can wait": a decision is needed but nothing is blocked.
//   auto    "Handled automatically": on the agreed safe list (issue drafts under the daily limit); shown for information.
export const SECTIONS = [
  { id: 'decide', label: 'Decide now', rule: 'Blocks other work or risks harm.' },
  { id: 'wait', label: 'Can wait', rule: 'A decision is needed, but nothing is blocked.' },
  { id: 'auto', label: 'Handled automatically', rule: 'On the agreed safe list; shown for information.' }
];
const HARM = /^(breaker|fixlimit|reviewlimit|reviewrefused|noreviewer|selfcheck|homeowner-pr|decision-proposal|stalled|upgrade|storage|drift|migration|tick-failed|alert-failed|rebase-lost|inboxfail|inboxrefused)/;
const clean = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const first = t => clean(t).split(/(?<=[.!?])\s/)[0].slice(0, 200);

// auto: { limit, posted } when issue drafts post without a click; the pending draft items then belong to "Handled automatically".
export function classifyItem(item, { auto = null } = {}) {
  const id = String(item.id || ''), blocks = Number.isFinite(item.blocks) ? item.blocks : 0;
  const inboxKind = item.inboxKind || item.inbox?.kind || null;
  if (item.inbox && inboxKind === 'issue_draft' && auto && auto.limit > 0 && auto.posted < auto.limit)
    return { section: 'auto', rule: `Issue drafts post without a click up to ${auto.limit} a day (${auto.posted} of ${auto.limit} posted today).`,
      recommend: { action: 'none', label: 'No action needed', why: 'It posts on the next tick; Reject it now if it should not be posted.' } };
  if (item.inbox) {
    const broken = !!item.inbox.broken || /cannot be shown/.test(item.text || '');
    const draft = inboxKind === 'issue_draft';
    return { section: 'wait', rule: draft ? 'An issue draft over the daily auto-post limit waits for a click.' : 'An overseer proposal always needs a click; nothing is blocked while it waits.',
      recommend: broken ? { action: 'reject', label: 'Reject', why: 'The item cannot be shown or verified; the overseer can propose it again.' }
        : { action: 'approve', label: 'Approve', why: draft ? 'The draft passed the secret and attribution checks; approving posts it as an issue.' : 'It passed the same checks as every proposal; approving starts one supervised job that cannot merge.' } };
  }
  const section = blocks > 0 || HARM.test(id) || id.startsWith('job') ? 'decide' : 'wait';
  const rule = blocks > 0 ? `Blocks ${blocks} other ${blocks === 1 ? 'item' : 'items'}.` : section === 'decide' ? 'Risks harm or needs a person to get past a stop.' : 'A decision is needed, but nothing is blocked.';
  return { section, rule, recommend: recommendFor(id, item) };
}
function recommendFor(id, item) {
  const act = first(item.action || item.decision);
  if (id.startsWith('stale-mark')) return { action: 'reopen', label: 'Reopen for implementation', why: 'The issue is open but marked implemented with no pull request, so Foreman will never start it again.' };
  if (id.startsWith('homeowner-pr') || id.startsWith('decision-proposal')) return { action: 'review', label: 'Review and decide', why: act || 'A merge or decision is yours; the typed-number confirmation stays.' };
  if (id.startsWith('breaker')) return { action: 'review', label: 'Check, then resume', why: act || 'Foreman stopped new work of this type to limit wasted usage.' };
  return { action: 'review', label: act ? act.replace(/\.$/, '') : 'Open and decide', why: act || 'Foreman cannot continue without you.' };
}

// Items in, sections out. Order inside a section keeps the incoming order (blocking first, then oldest).
export function buildInbox(items, { auto = null } = {}) {
  const tagged = items.map(it => ({ ...it, ...classifyItem(it, { auto }) }));
  const sections = SECTIONS.map(s => { const list = tagged.filter(t => t.section === s.id); return { ...s, count: list.length, ids: list.map(t => t.id) }; });
  return { items: tagged, sections, total: tagged.length, autoPost: auto && auto.limit > 0 ? { posted: auto.posted, limit: auto.limit } : null };
}
// Counts that need a homeowner: auto items are information, so the badge counts the first two sections only.
export const actionCount = inbox => inbox.sections.filter(s => s.id !== 'auto').reduce((n, s) => n + s.count, 0);
