// Issue #951: a searchable index of every issue and pull request (open, closed, merged), kept in the dashboard directory and served to the
// read-only Foreman MCP tool foreman_issues, so an overseer without GitHub access can check whether an issue already exists.
// The planner's cache holds no bodies, so this is a separate file. It is filled by a bounded, incremental refresh at the end of a tick:
// each call asks GitHub for at most PAGE items updated after the stored cursor (oldest first), so the first runs page back through the
// history one page per tick and, once caught up, a tick fetches only what changed. Nothing here calls a model or writes outside the file.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';
import { redact } from './redact.mjs';

export const PAGE = 100;               // items per GitHub call
export const MAX_BODY = 12000;         // characters of one stored body
export const MAX_COMMENTS = 5;         // latest comments kept per item
export const MAX_COMMENT = 1500;       // characters of one stored comment
export const EXCERPT = 240;            // characters of the excerpt in a search result
export const MAX_ITEMS = 5000;         // the oldest-updated items are dropped past this
const EPOCH = '1970-01-01T00:00:00Z';

export const indexFile = root => path.join(root, 'dashboard', 'issue-index.json');
export function readIndex(root) {
  try { const v = JSON.parse(fs.readFileSync(indexFile(root), 'utf8')); return v && typeof v === 'object' && v.items ? v : null; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

// redact() scans at most 2000 characters, so longer text is redacted line by line (and long lines in pieces), never passed through unscanned.
export function redactText(value, max) {
  const out = [];
  let used = 0;
  for (const line of String(value ?? '').split('\n')) {
    for (let i = 0; i === 0 || i < line.length; i += 1500) {
      const piece = redact(line.slice(i, i + 1500), 1500);
      out.push(piece); used += piece.length + 1;
    }
    if (used > max) break;
  }
  const text = out.join('\n');
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

const login = a => (a && typeof a.login === 'string' ? redact(a.login, 60) : null);
const labelNames = ls => (ls || []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean).slice(0, 20).map(l => redact(l, 40));
const comments = cs => (Array.isArray(cs) ? cs : []).slice(-MAX_COMMENTS).map(c => ({ author: login(c.author), at: typeof c.createdAt === 'string' ? c.createdAt : null, body: redactText(c.body, MAX_COMMENT) }));

export function compactItem(kind, raw) {
  const state = kind === 'pr' ? (raw.mergedAt || String(raw.state).toUpperCase() === 'MERGED' ? 'MERGED' : String(raw.state || '').toUpperCase()) : String(raw.state || '').toUpperCase();
  const item = { kind, number: raw.number, title: redact(raw.title, 200), state, labels: labelNames(raw.labels),
    author: login(raw.author), createdAt: raw.createdAt ?? null, updatedAt: raw.updatedAt ?? null, closedAt: raw.closedAt ?? null,
    url: typeof raw.url === 'string' ? raw.url.slice(0, 200) : null, body: redactText(raw.body, MAX_BODY), comments: comments(raw.comments) };
  if (kind === 'pr') {
    const checks = (raw.statusCheckRollup || []).map(c => String(c.conclusion || c.state || c.status || '').toUpperCase()).filter(Boolean);
    Object.assign(item, { head: redact(raw.headRefName, 100), headRefOid: /^[0-9a-f]{40}$/.test(raw.headRefOid || '') ? raw.headRefOid : null, mergedAt: raw.mergedAt ?? null, isDraft: raw.isDraft === true,
      ci: !checks.length ? 'none' : checks.some(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(c)) ? 'failing' : checks.some(c => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', ''].includes(c)) ? 'pending' : 'passing',
      closes: (raw.closingIssuesReferences || []).map(r => r?.number).filter(n => Number.isSafeInteger(n) && n > 0).slice(0, 10) });
  }
  return item;
}

const key = i => `${i.kind}:${i.number}`;
const GH_ISSUE = 'number,title,state,body,labels,author,createdAt,updatedAt,closedAt,url,comments';
const GH_PR = 'number,title,state,body,labels,author,createdAt,updatedAt,closedAt,mergedAt,url,comments,headRefName,headRefOid,isDraft,statusCheckRollup,closingIssuesReferences';

// One bounded step: the next PAGE items of each kind updated at or after the stored cursor. `run(args)` is the gh runner (returns text).
// A page that is full advances the cursor to its newest time; a short page means caught up. Returns the new index (not written).
export function refreshIndex(prev, { run, repository, now = Date.now(), isStatusIssue = () => false }) {
  const index = { schema: 1, repository, items: { ...(prev?.items || {}) }, cursor: { ...(prev?.cursor || {}) }, caughtUp: { ...(prev?.caughtUp || {}) } };
  for (const kind of ['issue', 'pr']) {
    const since = index.cursor[kind] || EPOCH;
    const args = [kind === 'pr' ? 'pr' : 'issue', 'list', '--repo', repository, '--state', 'all', '--search', `updated:>=${since} sort:updated-asc`, '--limit', String(PAGE), '--json', kind === 'pr' ? GH_PR : GH_ISSUE];
    const page = JSON.parse(run(args) || '[]');
    if (!Array.isArray(page)) continue;
    let newest = since;
    for (const raw of page) {
      if (!Number.isSafeInteger(raw?.number) || (kind === 'issue' && isStatusIssue(raw))) continue;
      const item = compactItem(kind, raw);
      index.items[key(item)] = item;
      if (item.updatedAt && item.updatedAt > newest) newest = item.updatedAt;
    }
    // A full page whose items all share the cursor time cannot advance; step one second so the backfill never stalls.
    if (page.length >= PAGE && newest === since) newest = new Date(Date.parse(since) + 1000).toISOString().replace('.000Z', 'Z');
    index.cursor[kind] = newest;
    index.caughtUp[kind] = page.length < PAGE;
  }
  const all = Object.values(index.items);
  if (all.length > MAX_ITEMS) for (const i of all.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(0, all.length - MAX_ITEMS)) delete index.items[key(i)];
  index.refreshedAt = now;
  return index;
}

// Called by the tick, best effort; never throws. Skips the call when everything is caught up and `idle` says GitHub has not changed.
export function updateIndex(root, { run, repository, now = Date.now(), idle = false, isStatusIssue }) {
  try {
    const prev = readIndex(root);
    if (idle && prev?.caughtUp?.issue && prev?.caughtUp?.pr) return { skipped: true };
    const next = refreshIndex(prev, { run, repository, now, isStatusIssue });
    fs.mkdirSync(path.dirname(indexFile(root)), { recursive: true });
    atomicJson(indexFile(root), next);
    return { items: Object.keys(next.items).length, caughtUp: !!(next.caughtUp.issue && next.caughtUp.pr) };
  } catch (error) { return { error: `${error?.name || 'Error'}: ${redact(error?.message, 120)}` }; }
}

const toTime = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const word = s => String(s).toLowerCase();

// The query: kind (issue, pr, any), state (open, closed, all; for a PR "closed" includes merged, "merged" is also accepted), text (every word
// must appear in title or body), label, number, from/to (a range), author, updatedSince (ISO), and for pull requests head (substring), ci
// (passing, failing, pending, none), verdict (PASS, CHANGES, none) and issue (a linked issue number). `verdicts` maps "pr:head" to a verdict record.
export function searchIndex(index, q = {}, { verdicts = {}, limit = 20 } = {}) {
  if (!index) return { error: 'the issue index has not been built yet; it fills during Foreman ticks', items: [] };
  const lim = Math.min(50, Math.max(1, Math.trunc(Number(limit)) || 20));
  const state = word(q.state || 'all'), kind = word(q.kind || 'any');
  const words = String(q.text || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  const since = q.updatedSince ? toTime(q.updatedSince) : null;
  if (q.updatedSince && since === null) return { error: 'updatedSince must be an ISO date', items: [] };
  const verdictOf = i => { const v = verdicts[`${i.number}:${i.headRefOid}`]; return v?.verdict ? String(v.verdict).toUpperCase() : null; };
  const n = q.number != null ? Number(q.number) : null;
  const from = q.from != null ? Number(q.from) : null, to = q.to != null ? Number(q.to) : null;
  const rows = Object.values(index.items).filter(i => {
    if (kind !== 'any' && i.kind !== kind) return false;
    if (state === 'open' && i.state !== 'OPEN') return false;
    if (state === 'closed' && i.state !== 'CLOSED' && i.state !== 'MERGED') return false;
    if (state === 'merged' && i.state !== 'MERGED') return false;
    if (n !== null && i.number !== n) return false;
    if (from !== null && i.number < from) return false;
    if (to !== null && i.number > to) return false;
    if (q.label && !i.labels.some(l => word(l) === word(q.label))) return false;
    if (q.author && word(i.author || '') !== word(q.author)) return false;
    if (since !== null && !(toTime(i.updatedAt) >= since)) return false;
    if (q.head && !word(i.head || '').includes(word(q.head))) return false;
    if (q.ci && i.ci !== word(q.ci)) return false;
    if (q.issue != null && !(i.closes || []).includes(Number(q.issue))) return false;
    if (q.verdict) { const v = verdictOf(i); if (word(q.verdict) === 'none' ? v !== null : v !== String(q.verdict).toUpperCase()) return false; }
    if (words.length) { const hay = `${i.title}\n${i.body}`.toLowerCase(); if (!words.every(w => hay.includes(w))) return false; }
    return true;
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.number - a.number);
  const base = {
    coverage: { caughtUp: !!(index.caughtUp?.issue && index.caughtUp?.pr), refreshedAt: index.refreshedAt ? new Date(index.refreshedAt).toISOString() : null, itemsIndexed: Object.keys(index.items).length,
      note: index.caughtUp?.issue && index.caughtUp?.pr ? 'The index holds all issues and pull requests, as of the last refresh.' : 'The history is still being filled in (oldest first); older items may be missing.' } };
  const view = i => ({ kind: i.kind, number: i.number, title: i.title, state: i.state, labels: i.labels, updated: i.updatedAt, url: i.url, author: i.author,
    ...(i.kind === 'pr' ? { head: i.head, ci: i.ci, verdict: verdictOf(i), closes: i.closes } : {}) });
  if (n !== null && rows.length) {
    const hits = rows.map(i => ({ ...view(i), body: i.body, comments: i.comments }));
    return { ...base, matches: hits.length, items: hits };
  }
  const excerpt = i => { const flat = i.body.replace(/\s+/g, ' ').trim(); const at = words.length ? flat.toLowerCase().indexOf(words[0]) : -1; const s = at > 80 ? at - 80 : 0; return `${s ? '…' : ''}${flat.slice(s, s + EXCERPT)}${flat.length > s + EXCERPT ? '…' : ''}`; };
  return { ...base, matches: rows.length, shown: Math.min(lim, rows.length), items: rows.slice(0, lim).map(i => ({ ...view(i), excerpt: excerpt(i) })) };
}
