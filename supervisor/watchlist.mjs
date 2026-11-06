// Watch a change from start to installed (issue #430). The list is stored by Foreman under <state root>/dashboard/watchlist.json, so
// phone and desktop show the same list. A watch is identified by the issue and the pull request, never by a head: a new head, a rebase
// or an issue becoming a pull request keeps the watch. Watching only changes what is followed: it starts, stops and alters no work.
// The dashboard server writes the list (watch, unwatch, pin) after the usual request checks; the tick advances it (merge commit,
// install, alerts, clearing). Pure functions plus two small file helpers; no GitHub, no model, no network.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';

export const MAX_WATCHED = 40;
export const CLEAR_AFTER_INSTALL_MS = 30 * 60000;     // "shortly after it is installed"
export const STEPS = [['implement', 'Implement'], ['ci', 'CI'], ['review', 'Review'], ['fix', 'Fix'], ['merged', 'Merged'], ['installed', 'Installed'], ['verified', 'Verified']];
export const ACTIONS = ['watch', 'unwatch', 'pin', 'unpin'];
const SHA40 = /^[0-9a-f]{40}$/;
const sha7 = s => String(s || '').slice(0, 7);

// ---- storage
const fileOf = root => path.join(root, 'dashboard', 'watchlist.json');
export function readWatchlist(root) {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'));
    return { items: (Array.isArray(v?.items) ? v.items : []).filter(i => i && ['issue', 'pr'].includes(i.kind) && Number.isSafeInteger(i.number) && i.number > 0).slice(0, MAX_WATCHED) };
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return { items: [] }; throw error; }
}
// Read, change, write in one synchronous step, so the server and the tick cannot undo each other's items within a process.
export function updateWatchlist(root, change) {
  const list = readWatchlist(root), next = change(list.items);
  if (next === list.items) return list;
  fs.mkdirSync(path.dirname(fileOf(root)), { recursive: true, mode: 0o700 });
  atomicJson(fileOf(root), { items: next.slice(0, MAX_WATCHED) });
  return { items: next };
}
export const watchId = (kind, number) => `${kind === 'pr' ? 'p' : 'i'}${number}`;
// The only mutation a request can make. Returns { ok, reason? }.
export function applyAction(root, { kind, number, action, now }) {
  if (!['issue', 'pr'].includes(kind) || !Number.isSafeInteger(number) || number < 1 || !ACTIONS.includes(action)) return { ok: false, reason: 'bad request' };
  const id = watchId(kind, number);
  let full = false;
  updateWatchlist(root, items => {
    const have = items.find(i => i.id === id);
    if (action === 'watch') {
      if (have) return items;
      if (items.length >= MAX_WATCHED) { full = true; return items; }
      return [...items, { id, kind, number, addedAt: now, pinned: false, issue: kind === 'issue' ? number : null, pr: kind === 'pr' ? number : null }];
    }
    if (!have) return items;
    if (action === 'unwatch') return items.filter(i => i.id !== id);
    return items.map(i => (i.id === id ? { ...i, pinned: action === 'pin' } : i));
  });
  return full ? { ok: false, reason: `at most ${MAX_WATCHED} items can be watched` } : { ok: true };
}

// ---- resolving the change an item follows
const issueOfBranch = b => { const n = Number(/\/issue-(\d+)(\D|$)/.exec(b || '')?.[1]); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const issueOfPull = p => p?.closingIssuesReferences?.[0]?.number ?? issueOfBranch(p?.headRefName);
// Inputs are the tick cache (pulls, merged, issues) and the Foreman state (mergeLog). An item for an issue follows the newest pull request
// for that issue (so an issue that becomes a PR, or is re-opened as a newer PR, keeps its watch); an item for a PR keeps that PR.
export function resolve(item, { pulls = [], merged = [], mergeLog = [] }) {
  let pr = item.kind === 'pr' ? item.number : null, issue = item.kind === 'issue' ? item.number : (item.issue ?? null);
  if (item.kind === 'issue') {
    const nums = [...pulls.filter(p => issueOfPull(p) === item.number).map(p => p.number), ...merged.filter(m => m.issue === item.number).map(m => m.number), ...mergeLog.filter(m => m.issue === item.number).map(m => m.pr)].filter(Number.isSafeInteger);
    pr = nums.length ? Math.max(...nums) : (item.pr ?? null);
  }
  if (pr !== null && issue === null) issue = issueOfPull(pulls.find(p => p.number === pr)) ?? merged.find(m => m.number === pr)?.issue ?? mergeLog.find(m => m.pr === pr)?.issue ?? null;
  return { pr, issue };
}

// ---- steps, the sentence and the history
const fmt = ms => { if (!Number.isFinite(ms) || ms < 0) return 'an unknown time'; const m = Math.floor(ms / 60000); return m < 1 ? 'under a minute' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };
const upper = s => String(s || '').toUpperCase();
// facts: { issue: {state, needsHomeowner}|null, pr: {number, status:'open'|'draft'|'merged'|'closed', checks:'green'|'red'|'pending'|null, verdict, head, fixRounds, needsHomeowner}|null, lastEventAt }
export function needsReason(item, f) {
  if (item.installedAt) return null;
  if (f.pr?.needsHomeowner) return `PR #${f.pr.number} is labelled needs-homeowner`;
  if (f.issue?.needsHomeowner && !f.pr) return `issue #${f.issue.number} is labelled needs-homeowner`;
  return null;
}
export function describeWatch(item, f, now) {
  const pr = f.pr, merged = pr?.status === 'merged' || !!item.mergedAt, hasPr = !!pr;
  const pass = upper(pr?.verdict) === 'PASS', changes = upper(pr?.verdict) === 'CHANGES', green = pr?.checks === 'green', red = pr?.checks === 'red';
  const st = {};
  st.implement = hasPr || merged ? 'done' : f.issue?.state === 'CLOSED' ? 'blocked' : 'active';
  st.ci = merged ? 'done' : !hasPr ? 'pending' : green ? 'done' : red ? 'blocked' : 'active';
  st.review = merged ? 'done' : !hasPr ? 'pending' : pass ? 'done' : changes ? 'blocked' : red ? 'pending' : 'active';
  st.fix = !hasPr ? 'pending' : (changes || red) && !merged ? 'active' : (pr.fixRounds || 0) > 0 ? 'done' : merged || (pass && green) ? 'skipped' : 'pending';
  st.merged = merged ? 'done' : pass && green ? 'active' : 'pending';
  st.installed = item.installedAt ? 'done' : merged ? 'active' : 'pending';
  st.verified = item.verifiedAt ? 'done' : item.installedAt ? 'active' : 'pending';
  const steps = STEPS.map(([key, label]) => ({ key, label, status: st[key] }));
  const cur = steps.find(s => !['done', 'skipped'].includes(s.status)) || null;
  const head = pr && pr.status !== 'merged' ? pr.head : null, headText = head ? `head ${sha7(head)}` : hasPr ? `PR #${pr.number}` : 'no pull request yet';
  const needs = needsReason(item, f);
  let blocker;
  if (!cur) blocker = null;
  else if (cur.key === 'implement') blocker = f.issue?.state === 'CLOSED' ? 'the issue was closed with no merged pull request' : 'no pull request has been opened';
  else if (cur.key === 'ci') blocker = red ? 'CI is red' : 'CI is still running';
  else if (cur.key === 'review') blocker = changes ? 'the reviewer asked for changes' : pr.status === 'draft' ? 'the pull request is still a draft' : 'no review of this head yet';
  else if (cur.key === 'fix') blocker = changes ? 'the reviewer asked for changes' : 'CI is red';
  else if (cur.key === 'merged') blocker = 'review and CI passed; waiting to be merged';
  else if (cur.key === 'installed') blocker = item.mergeSha ? 'merged; the install has not reached the merge commit' : 'merged; the merge commit is not known yet, so the install cannot be confirmed';
  else blocker = 'installed; waiting for a clean live tick on the installed version';
  if (needs) blocker = `needs the homeowner: ${needs}`;
  const phase = cur ? `${cur.key}:${head || ''}:${needs ? 'needs' : blocker}` : 'done';
  const since = item.phase?.key === phase && Number.isFinite(item.phase.since) ? item.phase.since : (Number.isFinite(f.lastEventAt) ? Math.max(f.lastEventAt, item.addedAt || 0) : item.addedAt);
  const sentence = !cur ? `Installed and verified${item.installedSha ? ` at ${sha7(item.installedSha)}` : ''}.`
    : `Stuck at ${cur.label}${Number.isFinite(since) ? ` for ${fmt(now - since)}` : ''}: ${headText}, ${blocker}.`;
  return { steps, current: cur?.key ?? null, sentence, phase, since: Number.isFinite(since) ? since : null, needs, done: !cur };
}

// history[step] = [{ at, text }], newest last. `pr.jobs` rows: { kind, status, agent, startedAt }; `pr.verdicts` rows: { verdict, reviewer, head, at, carry? }.
export function historyOf(item, f, jobs = []) {
  const h = Object.fromEntries(STEPS.map(([k]) => [k, []]));
  const add = (k, at, text) => { if (Number.isFinite(at)) h[k].push({ at, text }); };
  const stepOf = kind => (/rebase|fix/.test(kind) ? 'fix' : kind === 'review' ? 'review' : /implement|continue/.test(kind) ? 'implement' : null);
  for (const j of jobs) { const k = stepOf(String(j.kind || '')); if (k) add(k, j.startedAt, `${j.agent ? `${j.agent}: ` : ''}${/rebase/.test(j.kind) ? 'rebase' : j.kind} job ${j.status}`); }
  for (const v of f.pr?.verdicts || []) add('review', v.at, `${v.reviewer || 'reviewer'}: ${v.verdict} at ${sha7(v.fullHead || v.head)}${v.carry ? ' (carried over a clean rebase)' : ''}`);
  if (f.pr?.mergedAt || item.mergedAt) add('merged', f.pr?.mergedAt ?? item.mergedAt, `PR #${f.pr?.number ?? item.pr} merged`);
  if (item.installedAt) add('installed', item.installedAt, `installed version ${sha7(item.installedSha)} contains the merge`);
  if (item.verifiedAt) add('verified', item.verifiedAt, 'a live tick ran cleanly on the installed version');
  for (const k of Object.keys(h)) h[k].sort((a, b) => a.at - b.at);
  return h;
}

// ---- the tick: advance the stored list. Everything outside the file is injected so tests need no git, no GitHub and no clock.
const toMs = v => (Number.isFinite(v) ? v : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
// `factsFor(item, { pr, issue })` supplies the facts for describeWatch. `alert(text)` rejects when delivery fails; the alert is then retried next tick.
export async function advanceWatchlist({ root, cache = {}, state = {}, now, installed = null, running = null, isAncestor = () => false, tickOk = true, alert, factsFor, title = n => `#${n}` }) {
  const { items } = readWatchlist(root), patches = new Map(), removed = new Set(), sent = [];
  for (const item of items) {
    const { pr, issue } = resolve(item, { pulls: cache.pulls, merged: cache.merged, mergeLog: state.mergeLog });
    const patch = { pr: pr ?? item.pr ?? null, issue: issue ?? item.issue ?? null };
    const m = (cache.merged || []).find(x => x.number === pr), log = (state.mergeLog || []).find(x => x.pr === pr);
    const mergedAt = toMs(log?.mergedAt) ?? toMs(m?.mergedAt) ?? item.mergedAt ?? null;
    if (mergedAt) patch.mergedAt = mergedAt;
    patch.mergeSha = SHA40.test(m?.mergeSha || '') ? m.mergeSha : item.mergeSha;
    const view = { ...item, ...patch };
    if (!view.installedAt && SHA40.test(view.mergeSha || '') && SHA40.test(installed || '') && (installed === view.mergeSha || isAncestor(view.mergeSha, installed))) { patch.installedAt = now; patch.installedSha = installed; view.installedAt = now; view.installedSha = installed; }
    if (view.installedAt && !view.verifiedAt && tickOk && running && running === view.installedSha) { patch.verifiedAt = now; view.verifiedAt = now; }
    const f = factsFor(view, { pr, issue }), d = describeWatch(view, f, now);
    if (d.current) patch.phase = view.phase?.key === d.phase ? view.phase : { key: d.phase, since: d.since ?? now };
    // Alerts: exactly once per event, and only when the delivery succeeded (a failed one is retried by the next tick).
    const alerts = { ...(item.alerts || {}) };
    if (view.installedAt && !alerts.done) { try { await alert(`Watched change installed: ${title(view.issue ?? view.pr, f)} is merged and installed (${sha7(view.installedSha)}).`); alerts.done = now; sent.push('done'); } catch { /* retried */ } }
    // Issue #634: the other final state. The issue was closed and no pull request merged for it: nothing more will happen, so say so once.
    if (!view.installedAt && !view.mergedAt && f.issue?.state === 'CLOSED' && !f.pr && !alerts.final) { try { await alert(`Watched change ended: ${title(view.issue ?? view.pr, f)} was closed with no merged pull request.`); alerts.final = now; sent.push('final'); } catch { /* retried */ } }
    if (d.needs) { if (alerts.needs?.reason !== d.needs) { try { await alert(`Needs the homeowner: watched change ${title(view.issue ?? view.pr, f)} has stopped: ${d.needs}.`); alerts.needs = { reason: d.needs, at: now }; sent.push('needs'); } catch { /* retried */ } } }
    else delete alerts.needs;
    patch.alerts = alerts;
    patches.set(item.id, patch);
    if (view.installedAt && alerts.done && !item.pinned && now - view.installedAt >= CLEAR_AFTER_INSTALL_MS) removed.add(item.id);
  }
  updateWatchlist(root, current => current.filter(i => !removed.has(i.id)).map(i => {
    const p = patches.get(i.id); if (!p) return i;
    const next = { ...i, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) };
    if (!p.phase) delete next.phase;
    return next;
  }));
  return { sent, cleared: [...removed] };
}

// Facts for describeWatch from what the tick holds: the GitHub cache and the Foreman state (the dashboard builds the same facts from its view).
export function factsFromCache({ cache = {}, state = {}, now, checksOf }) {
  const sum = (obj, n) => Object.entries(obj || {}).filter(([k]) => k.split(':')[0] === String(n)).reduce((s, [, c]) => s + (Number(c) || 0), 0);
  return (item, { pr, issue }) => {
    const pull = pr !== null ? (cache.pulls || []).find(p => p.number === pr) : null;
    const merged = pr !== null && ((cache.merged || []).some(m => m.number === pr) || (state.mergeLog || []).some(m => m.pr === pr));
    const iss = issue !== null ? (cache.issues || []).find(i => i.number === issue) : null;
    const vs = pull ? state.verdicts?.[`${pr}:${pull.headRefOid}`] : null;
    return { issue: issue !== null ? { number: issue, state: iss?.state || 'OPEN', needsHomeowner: (iss?.labels || []).includes('needs-homeowner') } : null,
      pr: pr !== null && (pull || merged) ? { number: pr, status: merged ? 'merged' : pull.isDraft ? 'draft' : 'open', checks: pull && checksOf ? checksOf(pull, now) : null, verdict: vs?.verdict ?? null, head: pull?.headRefOid ?? null, fixRounds: sum(state.fixAttempts, pr), needsHomeowner: (pull?.labels || []).includes('needs-homeowner'), verdicts: [] } : null,
      lastEventAt: null };
  };
}
