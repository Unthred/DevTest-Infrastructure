// Issue #1325: keeps the best 24 hours so far. The records live in <root>/dashboard/best-day.json next to the verdict and merge times they
// were worked out from, so they survive the trimming of job and review records. With nothing stored the history is built once from the
// verdict comments on GitHub (paged REST reads) and the merge entries of the timeline. After that the records are checked again only when
// a new verdict or merge entry reaches the timeline (refreshBestDay is called once per tick and does nothing otherwise). A stored record
// is replaced only by a window that beats it. The window arithmetic is in best-day.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { bestWindows, beatsApproval, beatsMerges } from './best-day.mjs';

export const MAX_PAGES = 400;
export const PAGE_SIZE = 100;
export const RETRY_MS = 600000;
export const KEEP_MS = 60 * 86400000;
const VERSION = 1;
// A Foreman verdict comment starts with this marker (team.mjs MARKER); a comment that only quotes it further down is not one.
const VERDICT_COMMENT = /^<!-- devtest-verdict v1 [^>]*?\bpr=(\d+)\b[^>]*?\bverdict=(PASS|CHANGES)\b/;

export const bestFile = root => path.join(root, 'dashboard', 'best-day.json');

export function readBest(root) {
  try {
    const stored = JSON.parse(fs.readFileSync(bestFile(root), 'utf8'));
    return stored && stored.version === VERSION ? stored : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeBest(root, stored) {
  const file = bestFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Comments as GitHub returns them ({ created_at, body }) to verdicts. Only a verdict comment counts.
export function verdictsOfComments(comments) {
  const out = [];
  for (const c of comments || []) {
    const found = VERDICT_COMMENT.exec(String(c?.body ?? ''));
    const at = Date.parse(c?.created_at);
    if (found && Number.isFinite(at)) out.push({ pr: Number(found[1]), at, verdict: found[2] });
  }
  return out;
}

// fetchPage(n, since) synchronously returns one page of repository issue comments, oldest first (since: an ISO time, only comments updated at
// or after it; undefined for all); a short page is the last. Throws when GitHub refuses a page. Verdicts are always the posted comments, never
// Foreman's state, which overwrites a second verdict on the same head and holds carried verdicts that were never posted.
export function readVerdictHistory(fetchPage, since) {
  const verdicts = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const comments = fetchPage(page, since);
    verdicts.push(...verdictsOfComments(comments));
    if (!Array.isArray(comments) || comments.length < PAGE_SIZE) return verdicts;
  }
  throw new Error(`verdict history is longer than ${MAX_PAGES} pages`);
}

const latest = (verdicts, floor = 0) => verdicts.reduce((m, v) => Math.max(m, v.at), floor);
const sameVerdict = (a, b) => a.pr === b.pr && a.at === b.at && a.verdict === b.verdict;
const timelineMerges = entries => entries.filter(e => e.kind === 'merge' && Number.isSafeInteger(e.pr)).map(e => ({ pr: e.pr, at: e.at }));

function dedupeMerges(merges) {
  const byPr = new Map();
  for (const m of merges) if (!byPr.has(m.pr) || m.at < byPr.get(m.pr).at) byPr.set(m.pr, m);
  return [...byPr.values()].sort((a, b) => a.at - b.at);
}

// The stored records, each replaced only by a window that beats it.
function keepBest(previous, ledger) {
  const found = bestWindows(ledger);
  return {
    approval: found.approval && beatsApproval(found.approval, previous?.approval) ? found.approval : (previous?.approval ?? null),
    merges: found.merges && beatsMerges(found.merges, previous?.merges) ? found.merges : (previous?.merges ?? null),
  };
}

function settle(stored, now, previous) {
  const floor = now - KEEP_MS;
  const ledger = { verdicts: stored.verdicts.filter(v => v.at >= floor), merges: dedupeMerges(stored.merges.filter(m => m.at >= floor)) };
  return { ...stored, ...ledger, records: keepBest(previous?.records, ledger), updatedAt: now };
}

// What the tick calls. timeline is the retained timeline entries; fetchPage reads GitHub when nothing is stored, and then only the comments newer than the last one taken in when the timeline holds a new verdict or merge.
// Returns 'built', 'updated', 'unchanged', 'waiting' (a failed build is not retried yet) or 'failed'.
export function refreshBestDay({ root, now, timeline, fetchPage }) {
  const stored = readBest(root);
  if (!stored?.built) return rebuild({ root, now, timeline, fetchPage, previous: stored });
  const fresh = timeline.filter(e => (e.kind === 'verdict' || e.kind === 'merge') && e.at > stored.through);
  if (!fresh.length) return 'unchanged';
  // The timeline only says that something happened; the verdict counts come from the posted comments newer than the last one taken in.
  const taken = stored.commentsThrough ?? 0;
  let posted;
  try {
    posted = readVerdictHistory(fetchPage, new Date(taken).toISOString()).filter(v => v.at > taken);
  } catch {
    return 'failed';
  }
  const known = new Set(stored.merges.map(m => m.pr));
  const merges = timelineMerges(fresh).filter(m => !known.has(m.pr));
  const added = posted.filter(v => !stored.verdicts.some(w => sameVerdict(v, w)));
  writeBest(root, settle({ ...stored, through: Math.max(...fresh.map(e => e.at)), commentsThrough: latest(posted, taken),
    verdicts: [...stored.verdicts, ...added], merges: [...stored.merges, ...merges] }, now, stored));
  return 'updated';
}

function rebuild({ root, now, timeline, fetchPage, previous }) {
  if (previous?.retryAfter > now) return 'waiting';
  try {
    const verdicts = readVerdictHistory(fetchPage);
    writeBest(root, settle({ version: VERSION, built: true, through: now, commentsThrough: latest(verdicts), verdicts, merges: timelineMerges(timeline), records: previous?.records }, now, previous));
    return 'built';
  } catch {
    // Keep what was stored; a failed read must never blank a record. Try again after a pause, not on every tick.
    writeBest(root, { version: VERSION, built: false, retryAfter: now + RETRY_MS, verdicts: [], merges: [], records: previous?.records ?? { approval: null, merges: null } });
    return 'failed';
  }
}
