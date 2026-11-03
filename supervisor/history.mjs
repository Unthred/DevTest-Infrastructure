// Retained history of Foreman (issue #362). Nothing here deletes history: old tick snapshots rotate into compressed monthly
// archives, merge and unblock overflow is appended to archive files, and a deduplicated, allowlisted timeline of everything the
// team did is kept from the first job. The tick WRITES these files; the dashboard only READS them. No function here calls GitHub or a
// model, except `githubBackfill`, which runs only from the explicit `history backfill` command with an injected gh runner.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { redact } from './redact.mjs';

export const HOT_WINDOW_MS = 35 * 86400000;       // snapshots older than this move to the archive; they are never deleted
export const GAP_MS = 3600000;                    // no tick snapshot for this long is a known gap
export const WARN_FREE_RATIO = 0.1;               // warn when the volume has less than 10% free
export const WARN_DAYS_LEFT = 180;                // warn when the archive growth would fill the free space within this many days
export const WARN_ARCHIVE_BYTES = 2 * 1024 ** 3;  // warn when the archive passes 2 GiB
const DAY = 86400000;

export const archiveDir = root => path.join(root, 'dashboard', 'archive');
const timelineFile = root => path.join(archiveDir(root), 'timeline.jsonl');
const snapshotArchive = (root, month) => path.join(archiveDir(root), `snapshots-${month}.jsonl.gz`);
const mergeArchiveFile = root => path.join(root, 'team', 'archive', 'merge-log.jsonl');
const unblockArchiveFile = root => path.join(root, 'team', 'archive', 'unblock-log.jsonl');
const monthOf = at => new Date(at).toISOString().slice(0, 7);

const atomicWrite = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data, { mode: 0o600 }); fs.renameSync(temp, file);
};
const parseLines = text => { const out = []; for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; } } return out; };
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
const readGz = file => { try { return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };

// ---- tick snapshots: rotate into compressed monthly archives, losslessly and idempotently
// Writes the archive first, then returns; the caller rewrites the hot file. A crash between the two leaves a duplicate that readers drop by `at`.
export function archiveSnapshots(root, snaps) {
  const byMonth = new Map();
  for (const s of snaps) { const m = monthOf(s.at); (byMonth.get(m) || byMonth.set(m, []).get(m)).push(s); }
  for (const [month, list] of byMonth) {
    const file = snapshotArchive(root, month);
    const merged = new Map(parseLines(readGz(file)).map(s => [s.at, s]));
    for (const s of list) merged.set(s.at, s);
    atomicWrite(file, zlib.gzipSync([...merged.values()].sort((a, b) => a.at - b.at).map(s => JSON.stringify(s)).join('\n') + '\n'));
  }
}
export function readArchivedSnapshots(root) {
  let names = []; try { names = fs.readdirSync(archiveDir(root)).filter(n => /^snapshots-\d{4}-\d{2}\.jsonl\.gz$/.test(n)).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const out = new Map();
  for (const n of names) for (const s of parseLines(readGz(path.join(archiveDir(root), n)))) if (Number.isFinite(s?.at)) out.set(s.at, s);
  return [...out.values()].sort((a, b) => a.at - b.at);
}
// Archive plus hot file, deduplicated by time. `hot` is the already-read hot file.
export const allSnapshots = (root, hot) => { const m = new Map(readArchivedSnapshots(root).map(s => [s.at, s])); for (const s of hot) m.set(s.at, s); return [...m.values()].sort((a, b) => a.at - b.at); };

// ---- overflow of capped state lists: appended, never dropped
export function archiveOverflow(root, which, entries) {
  if (!entries?.length) return;
  const file = which === 'merge' ? mergeArchiveFile(root) : unblockArchiveFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
}

// ---- the timeline: allowlisted fields only, redacted free text, deduplicated by id
export const KINDS = ['job', 'verdict', 'merge', 'rebase', 'unblock', 'migration'];
export const SOURCES = ['live', 'job-record', 'github'];
const int = v => (Number.isSafeInteger(v) && v > 0 ? v : undefined);
const word = (v, max = 40) => (typeof v === 'string' && /^[A-Za-z0-9 _.:/-]+$/.test(v) ? v.slice(0, max) : undefined);
export function sanitizeEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !Number.isFinite(e.at) || e.at <= 0 || !KINDS.includes(e.kind)) return null;
  const out = { id: redact(e.id, 120), at: Math.floor(e.at), kind: e.kind, source: SOURCES.includes(e.source) ? e.source : 'live' };
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  set('event', word(e.event)); set('agent', word(e.agent, 32)); set('jobKind', word(e.jobKind, 24));
  set('job', typeof e.job === 'string' && /^[a-f0-9]{32}$/.test(e.job) ? e.job : undefined);
  set('issue', int(e.issue)); set('pr', int(e.pr));
  set('head', typeof e.head === 'string' && /^[0-9a-f]{7,40}$/.test(e.head) ? e.head.slice(0, 7) : undefined);
  set('verdict', e.verdict === 'PASS' || e.verdict === 'CHANGES' ? e.verdict : undefined);
  set('reviewer', word(e.reviewer, 32));
  set('detail', typeof e.detail === 'string' && e.detail ? redact(e.detail, 200) : undefined);
  return out;
}
export function readTimeline(root) {
  const out = new Map();
  for (const e of parseLines(readText(timelineFile(root)))) { const s = sanitizeEntry(e); if (s && !out.has(s.id)) out.set(s.id, s); }
  return [...out.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}
// Appends only entries whose id is not yet there. Returns how many were new.
export function appendTimeline(root, entries) {
  const clean = []; const seen = new Set();
  for (const e of entries) { const s = sanitizeEntry(e); if (s && !seen.has(s.id)) { seen.add(s.id); clean.push(s); } }
  if (!clean.length) return 0;
  const known = new Set(readTimeline(root).map(e => e.id));
  const fresh = clean.filter(e => !known.has(e.id));
  if (!fresh.length) return 0;
  fs.mkdirSync(archiveDir(root), { recursive: true, mode: 0o700 });
  fs.appendFileSync(timelineFile(root), fresh.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  return fresh.length;
}

const EVENT_KINDS = new Set(['created', 'started', 'completed', 'usage_limit', 'manual_pause', 'manual_stop', 'recovered', 'incomplete', 'retry_exhausted', 'transient_rate_limit', 'blocked', 'crash', 'auth_error', 'approval_required', 'issue_closed', 'stale_handover']);
// Everything the live records hold now, as timeline entries. Run by every tick and by `history backfill`, so a record that later
// expires from its source (a verdict, a capped merge log) is already kept.
export function collectEntries({ config, root, jobs, events, state, incidents = [] }) {
  const out = [], agentOf = j => Object.entries(config?.agents || {}).find(([, a]) => a.provider === j.provider)?.[0] || j.provider;
  const byId = new Map((jobs || []).filter(j => j && typeof j.id === 'string').map(j => [j.id, j]));
  const kindOf = j => state?.jobs?.[j.id]?.kind || j.kind;
  const refs = j => { const rec = state?.jobs?.[j.id]; const k = kindOf(j); const impl = ['implement', 'continue'].includes(k); return impl ? { issue: rec?.issue ?? j.issue } : { pr: rec?.pr ?? j.issue }; };
  const withEvent = new Set();
  for (const e of events || []) {
    const j = byId.get(e.job); if (!j || !EVENT_KINDS.has(e.kind)) continue;
    if (e.kind === 'created') withEvent.add(j.id);
    out.push({ id: `ev:${j.id}:${e.kind}:${e.at}`, at: e.at, kind: 'job', event: e.kind, agent: agentOf(j), jobKind: kindOf(j), job: j.id, ...refs(j) });
  }
  // A job whose events file is missing is still known from its record: never invented beyond the record's own creation time.
  for (const j of byId.values()) if (!withEvent.has(j.id) && Number.isFinite(j.createdAt)) out.push({ id: `rec:${j.id}:created`, at: j.createdAt, kind: 'job', event: 'created', agent: agentOf(j), jobKind: kindOf(j), job: j.id, source: 'job-record', ...refs(j) });
  for (const [key, v] of Object.entries(state?.verdicts || {})) { const e = verdictEntry(key, v); if (e) out.push(e); }
  for (const [stage, store] of [['secondOpinion', state?.secondOpinions], ['exception', state?.exceptionReviews]]) for (const [key, v] of Object.entries(store || {})) { const e = verdictEntry(key, v, stage); if (e) out.push(e); }
  const merges = [...(state?.mergeLog || []), ...(root ? parseLines(readText(mergeArchiveFile(root))) : [])];
  for (const m of merges) out.push(mergeEntry(m));
  for (const [id, tj] of Object.entries(state?.jobs || {})) if (tj.kind === 'rebase' && tj.rebase && Number.isFinite(tj.at)) out.push({ id: `rebase:${id}`, at: tj.at, kind: 'rebase', job: id, pr: tj.pr, head: tj.rebase.newHead, detail: `${tj.rebase.commits?.length ?? 0} commit(s)${tj.rebase.lost?.length ? `, ${tj.rebase.lost.length} lost` : ''}` });
  const unblocks = [...(state?.unblock?.log || []), ...(root ? parseLines(readText(unblockArchiveFile(root))) : [])];
  for (const u of unblocks) if (Number.isFinite(u.at)) out.push({ id: `unblock:${u.at}:${u.tk}:${u.target}`, at: u.at, kind: 'unblock', ...(u.tk === 'issue' ? { issue: u.target } : { pr: u.target }), detail: `${u.what}: ${u.result}` });
  for (const i of incidents) if (i?.kind === 'migration' && Number.isFinite(i.at)) out.push({ id: `migration:${i.number}:${i.at}`, at: i.at, kind: 'migration', event: i.result, detail: `${String(i.number).padStart(3, '0')}-${i.name}` });
  return out;
}
export const VERDICT_STAGES = { secondOpinion: 'second opinion', exception: 'review exception' };
export function verdictEntry(key, v, stage) {
  const [pr, head] = String(key).split(':');
  return v && Number.isFinite(v.at) ? { id: stage ? `verdict:${stage}:${key}` : `verdict:${key}`, ...(stage ? { detail: VERDICT_STAGES[stage] } : {}), at: v.at, kind: 'verdict', pr: Number(pr), head, verdict: v.verdict, reviewer: v.reviewer, job: v.job } : null;
}
export const mergeEntry = m => ({ id: `merge:${m.pr}`, at: m.mergedAt, kind: 'merge', pr: m.pr, issue: m.issue ?? undefined, agent: m.agent ?? undefined, reviewer: m.reviewer ?? undefined });

// Called from the tick. Best effort for the caller; returns the number of new entries.
export const recordTimeline = (root, inputs) => appendTimeline(root, collectEntries({ ...inputs, root }));
// Called where a verdict is about to be deleted, so the review outcome stays in the timeline.
export function archiveVerdict(root, key, v, stage) { const e = verdictEntry(key, v, stage); return e ? appendTimeline(root, [e]) : 0; }

// Backfill from GitHub: merged pull requests only. Never overwrites an entry that is already there (same id), and ids match the live
// merge entries, so the same merge is never listed twice.
export function githubBackfill(root, gh, repository) {
  const args = ['pr', 'list', '--repo', repository, '--state', 'merged', '--limit', '1000', '--json', 'number,mergedAt,headRefName,closingIssuesReferences'];
  const prs = JSON.parse(gh(args) || '[]'); const entries = [];
  for (const p of Array.isArray(prs) ? prs : []) {
    const at = Date.parse(p.mergedAt); if (!Number.isSafeInteger(p.number) || !Number.isFinite(at)) continue;
    const issue = p.closingIssuesReferences?.[0]?.number ?? Number(/\/issue-(\d+)(\D|$)/.exec(p.headRefName || '')?.[1]);
    entries.push({ ...mergeEntry({ pr: p.number, mergedAt: at, issue: Number.isSafeInteger(issue) ? issue : undefined }), source: 'github' });
  }
  return { seen: entries.length, added: appendTimeline(root, entries) };
}

// ---- known gaps: only what the stored data shows. Missing data is reported, never filled in.
export function computeGaps(timeline, snapshots, now = Date.now()) {
  const gaps = [];
  const ticks = [...new Set((snapshots || []).map(s => s.at))].sort((a, b) => a - b);
  const first = timeline.length ? timeline[0].at : null;
  if (first !== null && ticks.length && ticks[0] - first > GAP_MS) gaps.push({ from: first, to: ticks[0], reason: 'No tick-level data was retained before this time.' });
  else if (first !== null && !ticks.length) gaps.push({ from: first, to: now, reason: 'No tick-level data is stored.' });
  for (let i = 1; i < ticks.length; i++) if (ticks[i] - ticks[i - 1] > GAP_MS) gaps.push({ from: ticks[i - 1], to: ticks[i], reason: 'No tick was recorded in this period.' });
  if (ticks.length && now - ticks.at(-1) > GAP_MS * 3) gaps.push({ from: ticks.at(-1), to: now, reason: 'No tick was recorded since the last one.' });
  return gaps;
}

// ---- storage: size of everything kept, growth per day, and a warning before it becomes a problem. Never deletes.
const dirBytes = dir => { let n = 0; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size; } } catch (error) { if (error.code !== 'ENOENT') throw error; } return n; };
export function storageReport(root, { now = Date.now(), timeline = readTimeline(root), statfs = p => fs.statfsSync(p) } = {}) {
  const parts = { archive: dirBytes(archiveDir(root)), snapshots: 0, teamArchive: dirBytes(path.join(root, 'team', 'archive')), events: dirBytes(path.join(root, 'events')), jobs: dirBytes(path.join(root, 'jobs')), reconcileLog: 0 };
  try { parts.snapshots = fs.statSync(path.join(root, 'dashboard', 'snapshots.jsonl')).size; } catch { /* none yet */ }
  for (const n of ['reconcile.log', 'reconcile.log.archive.gz']) try { parts.reconcileLog += fs.statSync(path.join(root, n)).size; } catch { /* none */ }
  const used = Object.values(parts).reduce((a, b) => a + b, 0);
  const since = timeline.length ? timeline[0].at : null;
  const days = since === null ? 0 : Math.max(1, (now - since) / DAY);
  const perDay = since === null ? null : used / days;
  let free = null, total = null; try { const s = statfs(root); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch { /* unreadable: say unknown */ }
  const warnings = [];
  if (free !== null && total && free / total < WARN_FREE_RATIO) warnings.push(`Only ${(free / total * 100).toFixed(0)}% of the volume holding the history is free.`);
  if (perDay && free !== null && free / perDay < WARN_DAYS_LEFT) warnings.push(`At ${Math.round(perDay / 1024)} KiB per day the free space lasts about ${Math.floor(free / perDay)} days.`);
  if (parts.archive > WARN_ARCHIVE_BYTES) warnings.push(`The history archive passed ${(WARN_ARCHIVE_BYTES / 1024 ** 3).toFixed(0)} GiB.`);
  return { used, parts, since, perDay, free, total, daysLeft: perDay && free !== null ? Math.floor(free / perDay) : null, warnings };
}

// ---- display: filtering, text and links. Pure; used by the dashboard and the tests.
export const EVENT_TEXT = { created: 'job queued', started: 'job started', completed: 'job finished', usage_limit: 'paused on usage limit', manual_pause: 'paused by hand', manual_stop: 'stopped by hand', recovered: 'job recovered', incomplete: 'ended without its post-condition', retry_exhausted: 'blocked: retries exhausted', transient_rate_limit: 'paused on transient rate limit', blocked: 'blocked', crash: 'worker crashed', auth_error: 'authentication error', approval_required: 'approval required', issue_closed: 'issue closed', stale_handover: 'stale handover' };
export function entryText(e) {
  const ref = e.pr ? `PR #${e.pr}` : e.issue ? `issue #${e.issue}` : '';
  const who = e.agent ? `${e.agent}: ` : '';
  let t;
  if (e.kind === 'job') t = `${who}${e.jobKind || 'job'} ${ref}: ${EVENT_TEXT[e.event] || e.event || 'event'}`;
  else if (e.kind === 'verdict') t = `${e.reviewer || 'reviewer'}: ${e.verdict} on ${ref}${e.head ? ` at ${e.head}` : ''}`;
  else if (e.kind === 'merge') t = `merged ${ref}${e.agent ? ` (${e.agent})` : ''}${e.reviewer ? `, reviewed by ${e.reviewer}` : ''}`;
  else if (e.kind === 'rebase') t = `rebase of ${ref}${e.head ? ` to ${e.head}` : ''}${e.detail ? `: ${e.detail}` : ''}`;
  else if (e.kind === 'unblock') t = `Foreman unblocked ${ref}: ${e.detail || ''}`;
  else t = `config migration ${e.detail || ''} ${e.event || ''}`;
  return redact(t.replace(/\s+/g, ' ').trim(), 300);
}
export const entryLink = (e, repository) => {
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
  if (e.pr) return { url: `https://github.com/${repository}/pull/${e.pr}`, text: `PR #${e.pr}` };
  if (e.issue) return { url: `https://github.com/${repository}/issues/${e.issue}`, text: `issue #${e.issue}` };
  return null;
};
// Server-side filters from the URL: kind, agent, ref (issue or PR number), from/to (YYYY-MM-DD, UTC), source.
export function filterTimeline(timeline, f = {}) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(f.from || '') ? Date.parse(`${f.from}T00:00:00Z`) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(f.to || '') ? Date.parse(`${f.to}T00:00:00Z`) + DAY : null;
  const ref = /^#?(\d{1,9})$/.exec(f.ref || '')?.[1];
  return timeline.filter(e => (!f.kind || e.kind === f.kind) && (!f.agent || e.agent === f.agent) && (!f.source || e.source === f.source)
    && (from === null || e.at >= from) && (to === null || e.at < to) && (!ref || e.pr === Number(ref) || e.issue === Number(ref)));
}
