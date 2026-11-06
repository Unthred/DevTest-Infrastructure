// Issue #755 (overseer prompt 1585b4b4): a cheap "has GitHub changed?" check at the start of a scheduled pass, and a cache of what the
// last full pass read, so an unchanged pass spends no GitHub reads on the planner.
//
// How it works
//   1. A handful of REST conditional requests (ETag / If-None-Match; a 304 is the unchanged answer and does not count against the rate
//      limit) cover what the planner reads: the issue list (issues, PRs, labels on them, comment counts, state, and the update time that every
//      comment, label, push, review and merge moves), the open PR list, the label list, the newest issue comments and the newest PR review
//      comments (an edited comment moves to the top of a list sorted by update time), each base branch tip (a push to main changes what is
//      mergeable), and for every open PR head the check runs and the commit statuses.
//   2. All unchanged, no error, the stored data fresh enough: the pass is a REPLAY. The very same pass runs (ingest, retries, breaker, allowance,
//      stuck-check timers, self-check, status record, the upgrade step) but its read-only GitHub calls are served from the data the last full
//      pass stored. Nothing local is skipped; only reads that a 304 has just proved identical are. Any GitHub write during the pass turns the
//      cache off for the rest of that pass.
//   3. Anything else (a 200, a missing or corrupt state file, an unexpected status, a connection failure, too many open PRs, an unknown
//      mergeability, the forced-full interval) means a full pass, exactly as before. A failure of this check is never a failure of the tick.
//   4. The baseline ETags are taken BEFORE the full pass reads anything, and stored only after the pass read everything without error, so a
//      change that lands during a pass can only make the next check say "changed", never hide.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CHANGE_CHECK_DEFAULTS = Object.freeze({ enabled: true, force_full_minutes: 30, max_open_prs: 40, timeout_seconds: 30 });
export function validateChangeCheck(c) {
  if (c === undefined) return;
  const ok = c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every(k => k in CHANGE_CHECK_DEFAULTS);
  if (!ok) throw new Error('invalid team config: change_check may set only enabled, force_full_minutes, max_open_prs and timeout_seconds');
  if ('enabled' in c && typeof c.enabled !== 'boolean') throw new Error('invalid team config: change_check.enabled');
  if ('force_full_minutes' in c && !(typeof c.force_full_minutes === 'number' && c.force_full_minutes >= 1 && c.force_full_minutes <= 1440)) throw new Error('invalid team config: change_check.force_full_minutes');
  if ('max_open_prs' in c && !(Number.isSafeInteger(c.max_open_prs) && c.max_open_prs >= 1 && c.max_open_prs <= 99)) throw new Error('invalid team config: change_check.max_open_prs');
  if ('timeout_seconds' in c && !(typeof c.timeout_seconds === 'number' && c.timeout_seconds >= 1 && c.timeout_seconds <= 300)) throw new Error('invalid team config: change_check.timeout_seconds');
}
export const changeCheckOf = config => ({ ...CHANGE_CHECK_DEFAULTS, ...(config?.change_check || {}) });

export const cacheFile = root => path.join(root, 'team', 'gh-cache.json');
const VERSION = 1, MAX_BYTES = 12 * 1024 * 1024, SHA = /^[0-9a-f]{40}$/, BRANCH = /^[\w][\w./-]{0,100}$/;

// ---- the state file --------------------------------------------------------------------------------------------------------------
// { v, repository, fullAt, etags: { key: etag }, heads: [sha], reads: { key: json }, memo: { files: { "n:sha": [paths] }, merged: { n: pull } } }
export function loadCache(root, repository) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8'));
    const plain = x => x && typeof x === 'object' && !Array.isArray(x);
    if (c?.v !== VERSION || c.repository !== repository || !Number.isFinite(c.fullAt) || !plain(c.etags) || !Array.isArray(c.heads) || !c.heads.every(h => SHA.test(h)) || !plain(c.reads) || !plain(c.memo) || !plain(c.memo.files) || !plain(c.memo.merged)) return null;
    if (!Object.values(c.etags).every(e => typeof e === 'string' && e.length > 0 && e.length < 300)) return null;
    return c;
  } catch { return null; }
}
// Only the memo (file lists by head, merged PRs) is usable from a state that is otherwise stale or untrusted; it is immutable by construction.
export const memoOf = c => ({ files: { ...(c?.memo?.files || {}) }, merged: { ...(c?.memo?.merged || {}) } });
export function saveCache(root, cache) {
  const text = JSON.stringify(cache);
  if (text.length > MAX_BYTES) return false;   // too big to be worth it: the next pass is a full one
  const file = cacheFile(root), temp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, file);
  return true;
}
export function dropCache(root) { try { fs.rmSync(cacheFile(root), { force: true }); } catch { /* best effort */ } }

// ---- one conditional request -----------------------------------------------------------------------------------------------------
const stripWeak = e => String(e || '').replace(/^W\//, '').trim();
// Parse `gh api -i` output: status line, headers, blank line, body. gh exits non-zero for a 304 (and any 4xx/5xx) but still prints the head.
export function parseProbe(stdout) {
  const text = String(stdout || ''), m = /^HTTP\/[\d.]+ (\d{3})/.exec(text);
  if (!m) return { status: 0 };
  const split = text.search(/\r?\n\r?\n/), head = split < 0 ? text : text.slice(0, split), body = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1];
  return { status: Number(m[1]), etag: etag ? stripWeak(etag) : null, body };
}
// The default runner: the gh CLI (it holds the credential; this process never sees it), asynchronously so the probes run side by side.
export function ghProbeRunner({ timeoutMs = 30000 } = {}) {
  return (url, etag) => new Promise(resolve => {
    const args = ['api', '-i', '--method', 'GET', ...(etag ? ['-H', `If-None-Match: W/${etag}`] : []), url];
    let out = '', done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child; try { child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { return resolve({ status: 0, error: String(error?.code || error?.message || 'spawn failed') }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ status: 0, error: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > 16 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ status: 0, error: 'response too large' }); } });
    child.stderr.on('data', () => {});
    child.on('error', error => finish({ status: 0, error: String(error?.code || error?.message || 'spawn failed') }));
    child.on('close', () => finish(parseProbe(out)));
  });
}

// ---- the check ---------------------------------------------------------------------------------------------------------------------
export function endpoints(repo, heads, bases) {
  const e = {
    issues: `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100`,
    pulls: `repos/${repo}/pulls?state=open&per_page=100`,
    labels: `repos/${repo}/labels?per_page=100`,
    'issue-comments': `repos/${repo}/issues/comments?sort=updated&direction=desc&per_page=5`,
    'review-comments': `repos/${repo}/pulls/comments?sort=updated&direction=desc&per_page=5`,
  };
  for (const b of bases) e[`ref:${b}`] = `repos/${repo}/git/ref/heads/${b}`;
  for (const h of heads) { e[`runs:${h}`] = `repos/${repo}/commits/${h}/check-runs?per_page=100`; e[`status:${h}`] = `repos/${repo}/commits/${h}/status`; }
  return e;
}
const STATIC_KEYS = ['issues', 'pulls', 'labels', 'issue-comments', 'review-comments'];
const short = s => String(s).replace(/^(runs|status):([0-9a-f]{7})[0-9a-f]*$/, '$1:$2');

// Returns { replay, reason, baseline, probes }.
//   replay   true only when every endpoint answered 304 against a usable stored state that is fresh enough
//   baseline { etags, heads } to store with the next full pass (null when any probe failed or the PR list cannot be covered)
export async function checkForChanges({ repository, prev, config, run, now = Date.now(), cap = 6 }) {
  const cfg = { ...CHANGE_CHECK_DEFAULTS, ...(config || {}) };
  const out = { replay: false, reason: '', baseline: null, probes: 0, changed: [] };
  if (!cfg.enabled) { out.reason = 'change check is off'; return out; }
  const usable = !!prev && prev.repository === repository;
  const etags = usable ? prev.etags : {};
  let calls = 0;
  const probe = async (key, url) => {
    calls++;
    let r; try { r = await run(url, etags[key] || null); } catch (error) { r = { status: 0, error: String(error?.message || error).slice(0, 80) }; }
    return { key, ...r };
  };
  const pool = async (items, fn) => { const res = []; let i = 0; await Promise.all(Array.from({ length: Math.min(cap, items.length) }, async () => { while (i < items.length) { const n = i++; res[n] = await fn(items[n]); } })); return res; };
  const results = new Map(), failures = [];
  const take = r => {
    results.set(r.key, r);
    if (r.status === 304) { if (!etags[r.key]) failures.push(`${short(r.key)}: 304 without a stored ETag`); }
    else if (r.status === 200) { if (!r.etag) failures.push(`${short(r.key)}: no ETag in the answer`); else if (r.etag !== etags[r.key]) out.changed.push(short(r.key)); }
    else failures.push(`${short(r.key)}: ${r.status ? `HTTP ${r.status}` : r.error || 'no answer'}`);
  };
  // 1. everything that does not depend on the PR heads, the base branches of the stored PRs included
  const storedPulls = usable ? prev.reads['listPulls|[]'] : null;
  const bases = [...new Set(['main', ...(Array.isArray(storedPulls) ? storedPulls.map(p => p?.baseRefName) : [])].filter(b => typeof b === 'string' && BRANCH.test(b)))].sort();
  const first = endpoints(repository, [], bases);
  (await pool(Object.entries(first), ([k, u]) => probe(k, u))).forEach(take);
  // 2. the heads: from the new PR list when it changed, else the stored ones
  let heads = usable ? prev.heads : [];
  const pulls = results.get('pulls');
  if (pulls?.status === 200) {
    try {
      const list = JSON.parse(pulls.body);
      if (!Array.isArray(list)) throw new Error('not a list');
      if (list.length >= 100) failures.push('more than 99 open PRs: the list is paged');
      heads = [...new Set(list.map(p => p?.head?.sha))];
      if (!heads.every(h => SHA.test(h))) throw new Error('bad head');
    } catch { failures.push('pulls: unreadable answer'); heads = []; }
  }
  if (heads.length > cfg.max_open_prs) failures.push(`more than ${cfg.max_open_prs} open PRs to check`);
  if (!failures.length) {
    const second = endpoints(repository, heads, []);
    for (const k of STATIC_KEYS) delete second[k];
    (await pool(Object.entries(second), ([k, u]) => probe(k, u))).forEach(take);
  }
  out.probes = calls;
  if (failures.length) { out.reason = `check could not be completed (${failures.slice(0, 3).join('; ')}): full pass`; return out; }
  // Every probe answered. The baseline is what they answered now (taken before the full pass reads anything).
  const next = {};
  for (const [k, r] of results) next[k] = r.status === 200 ? r.etag : etags[k];
  out.baseline = { etags: next, heads };
  if (!usable) { out.reason = prev ? 'stored state is for another repository: full pass' : 'no usable stored state: full pass'; return out; }
  if (out.changed.length) { out.reason = `changed: ${out.changed.slice(0, 6).join(', ')}${out.changed.length > 6 ? ` and ${out.changed.length - 6} more` : ''}: full pass`; return out; }
  if (now - prev.fullAt >= cfg.force_full_minutes * 60000) { out.reason = `forced full pass (last full pass over ${cfg.force_full_minutes} min ago)`; return out; }
  if (now < prev.fullAt) { out.reason = 'stored state is dated in the future: full pass'; return out; }
  // GitHub computes mergeability lazily, with no change to anything watched above: an unknown stored value cannot be trusted.
  if (Array.isArray(storedPulls) && storedPulls.some(p => String(p?.mergeable).toUpperCase() === 'UNKNOWN' || String(p?.mergeStateStatus).toUpperCase() === 'UNKNOWN')) { out.reason = 'a stored PR has unknown mergeability: full pass'; return out; }
  if (!Array.isArray(storedPulls) || !Array.isArray(prev.reads['listIssues|[]'])) { out.reason = 'stored data is incomplete: full pass'; return out; }
  out.replay = true; out.reason = `unchanged (${calls} conditional requests)`;
  return out;
}

// ---- the client wrapper ----------------------------------------------------------------------------------------------------------
const READS = new Set(['listPulls', 'listIssues', 'listMergedPulls', 'listClosedPulls', 'listLabels', 'prComments', 'issueComments', 'getIssue', 'issueAuthorAssociation', 'getComment']);
const WRITES = new Set(['comment', 'createIssue', 'updateIssueBody', 'pinIssue', 'addLabel', 'removeLabel', 'rerunRun', 'merge', 'board']);
const keyOf = (name, args) => `${name}|${JSON.stringify(args)}`;

// mode 'replay': serve READS from `cache.reads` while no write has happened; mode 'record': pass through and store the FIRST answer of
// each read; mode 'memo': pass through (immutable lookups only come from the memo). The memo applies in every mode: a file list for a PR
// at a given head, and a PR GitHub says is merged, cannot change.
export function cachedGithub(gh, { mode, cache = null }) {
  const reads = {}, memo = memoOf(cache), stats = { served: 0, passed: 0, memoHits: 0, writes: 0, failed: 0 };
  let live = mode === 'replay', heads = {};
  const wrapped = { ...gh };
  const noteHeads = list => { heads = {}; if (Array.isArray(list)) for (const p of list) if (Number.isSafeInteger(p?.number) && SHA.test(p?.headRefOid)) heads[p.number] = p.headRefOid; };
  if (live) noteHeads(cache.reads['listPulls|[]']);
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  for (const name of READS) {
    if (typeof gh[name] !== 'function') continue;
    wrapped[name] = async (...args) => {
      const key = keyOf(name, args);
      if (live && key in cache.reads) { stats.served++; return clone(cache.reads[key]); }
      stats.passed++;
      let v; try { v = await gh[name](...args); } catch (error) { stats.failed++; throw error; }
      if (name === 'listPulls') noteHeads(v);
      if (mode === 'record' && !(key in reads)) { try { reads[key] = clone(v === undefined ? null : v); } catch { stats.failed++; } }
      return v;
    };
  }
  if (typeof gh.listPullFiles === 'function') wrapped.listPullFiles = async n => {
    const head = heads[n], mk = head ? `${n}:${head}` : null;
    if (mk && memo.files[mk]) { stats.memoHits++; return clone(memo.files[mk]); }
    stats.passed++;
    let v; try { v = await gh.listPullFiles(n); } catch (error) { stats.failed++; throw error; }
    if (mk && Array.isArray(v)) memo.files[mk] = clone(v);
    return v;
  };
  if (typeof gh.getMergedPull === 'function') wrapped.getMergedPull = async n => {
    const key = String(n);
    if (memo.merged[key]) { stats.memoHits++; return clone(memo.merged[key]); }
    stats.passed++;
    let v; try { v = await gh.getMergedPull(n); } catch (error) { stats.failed++; throw error; }
    if (v && String(v.state).toUpperCase() === 'MERGED') memo.merged[key] = clone(v);
    return v;
  };
  for (const name of WRITES) {
    if (typeof gh[name] !== 'function') continue;
    wrapped[name] = async (...args) => { stats.writes++; live = false; return gh[name](...args); };   // after a write, GitHub is no longer what the 304s proved
  }
  return { gh: wrapped, stats, reads, memo, openHeads: () => ({ ...heads }) };
}

// The cache to store after a full pass that read everything without error. Returns null when nothing may be stored.
export function buildCache({ repository, baseline, wrapper, now }) {
  if (!baseline || !wrapper || wrapper.stats.failed > 0) return null;
  const reads = wrapper.reads;
  if (!Array.isArray(reads['listPulls|[]']) || !Array.isArray(reads['listIssues|[]'])) return null;
  // The baseline heads must be the heads of the PR list this pass read, or the stored check state would not describe the stored data.
  const readHeads = [...new Set(reads['listPulls|[]'].map(p => p?.headRefOid))].sort(), baseHeads = [...baseline.heads].sort();
  if (readHeads.length !== baseHeads.length || readHeads.some((h, i) => h !== baseHeads[i])) return null;
  const files = {}, open = wrapper.openHeads();
  for (const [n, h] of Object.entries(open)) if (wrapper.memo.files[`${n}:${h}`]) files[`${n}:${h}`] = wrapper.memo.files[`${n}:${h}`];
  const merged = Object.fromEntries(Object.entries(wrapper.memo.merged).slice(-500));
  return { v: VERSION, repository, fullAt: now, etags: baseline.etags, heads: baseline.heads, reads, memo: { files, merged } };
}
