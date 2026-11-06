// Needs you (overseer job 211f3615): one rule, applied to every pass against live state.
//   An item is listed only when the homeowner must act and Foreman cannot proceed without them.
//   - Stale: an item whose pull request is no longer open, or whose issue is no longer open, is dropped (the lists are re-read every pass).
//   - Information: an item that asks for nothing (Foreman waits for allowance or a rebase by itself) moves to the notices.
//   - Duplicates: causes on one pull request or issue merge into one item that counts its causes and keeps each as history.
//   - Order: what blocks the most other work first, then the oldest.
// Pure: no I/O. The caller supplies the attention items and the lists it already holds.
import { redact } from './redact.mjs';

// Lower is more specific: the primary cause of a merged item is the lowest-ranked one present.
const RANK = ['breaker', 'fixlimit', 'reviewlimit', 'reviewrefused', 'noreviewer-refused', 'noreviewer', 'selfcheck', 'homeowner-pr', 'decision-proposal', 'stalled', 'job', 'homeowner', 'split', 'prclosed', 'rebase-lost', 'stale-mark', 'ci'];
const rankOf = id => { const i = RANK.findIndex(p => id === p || id.startsWith(p + '-')); return i < 0 ? RANK.length : i; };
// Items about the whole system block everything: they sort ahead of any single pull request or issue.
const SYSTEM_BLOCKS = 1e6;
const refKey = ref => (ref && ref.kind && Number.isSafeInteger(ref.n) ? `${ref.kind}:${ref.n}` : null);

// A stall item lists PRs; Foreman progresses by itself unless a reason says the homeowner must act.
export const needsHomeowner = item => item.homeowner !== false;

export function consolidateNeedsYou(attention, { cache = {}, now = Date.now() } = {}) {
  const pulls = Array.isArray(cache.pulls) ? cache.pulls : null, issues = Array.isArray(cache.issues) && cache.issues.length ? cache.issues : null;
  const openPr = pulls ? new Set(pulls.map(p => p.number)) : null;
  const issueState = issues ? new Map(issues.map(i => [i.number, i])) : null;
  const dropped = [], notices = [], live = [];
  for (const a of attention) {
    if (a.severity !== 'action') continue;
    const k = refKey(a.ref);
    if (k && a.ref.kind === 'pull' && openPr && !openPr.has(a.ref.n)) { dropped.push({ id: a.id, why: 'the pull request is no longer open' }); continue; }
    if (k && a.ref.kind === 'issue' && issueState?.has(a.ref.n) && (issueState.get(a.ref.n).state !== 'OPEN')) { dropped.push({ id: a.id, why: 'the issue is no longer open' }); continue; }
    if (!needsHomeowner(a)) { notices.push({ ...a, severity: 'info' }); continue; }
    live.push(a);
  }
  const groups = new Map(), out = [];
  for (const a of live) {
    const k = refKey(a.ref);
    if (!k) { out.push({ ...a, causes: [cause(a)], count: 1, blocks: SYSTEM_BLOCKS * (/^(inbox|decision|dashboard|drift)/.test(a.id) ? 0 : 1) }); continue; }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const dependants = n => (issues || []).filter(i => i.state === 'OPEN' && (i.prerequisites || []).includes(n)).length;
  for (const [k, list] of groups) {
    list.sort((x, y) => rankOf(x.id) - rankOf(y.id));
    const [primary, ...rest] = list, causes = list.map(cause);
    const actions = [...new Set(list.map(x => x.action).filter(Boolean))];
    const since = list.map(x => x.since).filter(Number.isFinite).sort((p, q) => p - q)[0] ?? null;
    out.push({ ...primary, text: redact(list.length > 1 ? `${primary.text} (${list.length} causes)` : primary.text, 400),
      action: actions.length > 1 ? redact(`${actions[0]} Also open: ${actions.slice(1).map(s => s.replace(/\s+/g, ' ').slice(0, 120)).join(' | ')}`, 600) : primary.action,
      links: [...new Map(list.flatMap(x => x.links || []).map(l => [l.url, l])).values()].slice(0, 6),
      causes, count: list.length, since, blocks: dependants(primary.ref.n) });
    void rest;
  }
  // Most blocking first, then oldest (unknown age last), then number for a stable order.
  out.sort((a, b) => b.blocks - a.blocks || (a.since ?? Infinity) - (b.since ?? Infinity) || (a.ref?.n ?? 0) - (b.ref?.n ?? 0) || a.id.localeCompare(b.id));
  void now;
  return { needsYou: out, notices, dropped };
}
const cause = a => ({ id: a.id, text: redact(a.text, 300), ...(a.action ? { action: redact(a.action, 300) } : {}), ...(Number.isFinite(a.since) ? { since: a.since } : {}) });

// The one count. Every surface (status bar, health card, MCP status, drill-down title, status issue) reads this.
export const needsYouCount = view => (Array.isArray(view?.panels?.needsYou) ? view.panels.needsYou.length : Number.isSafeInteger(view?.health?.count) ? view.health.count : 0);
