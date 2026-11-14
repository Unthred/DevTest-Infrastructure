// Issue #1451: the about model, GET /api/v1/about. The installed version, when it was installed, whether anything holds upgrades, and
// what each install of the last 7 days brought, in the words of the work items (titles from Foreman's own cache). A request reads the
// install records and the cache only: nothing is fetched from GitHub and nothing is written.
import fs from 'node:fs';
import nodePath from 'node:path';
import { readCache, readVersion } from '../../dashdata.mjs';
import { readSelfUpgrade } from '../../suphealth.mjs';
import { processVersions } from '../../installs.mjs';

export const name = 'about';
export const path = 'about';
export const schema = 'about.schema.json';
export const usesView = false;

export const WINDOW_MS = 7 * 24 * 3600000;
export const INSTALLS_MAX = 100;
const SHA = /^[0-9a-f]{40}$/;
// Only these records move the installed version; a retry, an MCP copy or a dashboard restart of the same commit is not a version.
const VERSION_RESULTS = new Set(['upgraded', 'verified']);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Every readable record, oldest first. A damaged line is skipped and the rest are served (unlike readUpgrades, nothing is cut at 500:
// 7 days of installs hold more records than that).
function readRecords(root) {
  let text;
  try { text = fs.readFileSync(nodePath.join(root, 'team', 'upgrades.jsonl'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line);
      if (r && typeof r.result === 'string' && Number.isFinite(r.at)) out.push(r);
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return out.sort((a, b) => a.at - b.at);
}

// One entry per change of version: the 'upgraded' record starts it, the 'verified' record of the same commit completes it.
export function versionsOf(records) {
  const versions = [];
  for (const r of records) {
    if (!VERSION_RESULTS.has(r.result) || !SHA.test(r.to || '') || r.from === r.to) continue;
    let v = versions.at(-1);
    if (!v || v.to !== r.to) { v = { to: r.to, at: r.at, verifiedAt: null, result: r.result, prs: [] }; versions.push(v); }
    if (r.result === 'verified') { v.verifiedAt = r.at; v.result = 'verified'; }
    for (const n of Array.isArray(r.prs) ? r.prs : []) if (Number.isSafeInteger(n) && n > 0 && !v.prs.includes(n)) v.prs.push(n);
  }
  return versions;
}

function titles(cache) {
  const list = value => (Array.isArray(value) ? value : []);
  const byNumber = items => new Map(list(items).filter(i => Number.isSafeInteger(i?.number)).map(i => [i.number, i]));
  const merged = byNumber(cache?.merged), open = byNumber(cache?.pulls), issues = byNumber(cache?.issues);
  const text = value => (typeof value === 'string' ? value : null);
  return n => {
    const m = merged.get(n), o = open.get(n);
    const issueNumber = m?.issue ?? o?.closingIssuesReferences?.[0]?.number ?? null;
    return {
      number: n,
      title: text(m?.title ?? o?.title),
      issue: Number.isSafeInteger(issueNumber) ? { number: issueNumber, title: text(issues.get(issueNumber)?.title) } : null,
    };
  };
}

function holdOf(root) {
  const su = readSelfUpgrade(root);
  if (su.latch) return { kind: 'latch', reason: su.latch.reason, at: iso(su.latch.at) };
  let refusal = null;
  try { refusal = JSON.parse(fs.readFileSync(nodePath.join(root, 'team', 'self-upgrade.json'), 'utf8'))?.refusal; } catch { /* no state */ }
  if (refusal && SHA.test(refusal.to || '')) return { kind: 'refusal', reason: String(refusal.reason || 'no reason recorded').slice(0, 300), at: iso(refusal.at) };
  return null;
}

export function build(_view, context) {
  const versions = versionsOf(readRecords(context.root));
  const ver = readVersion(context.root, { now: context.now });
  const installed = ver?.installed && SHA.test(ver.installed) ? ver.installed : null;
  const mine = installed ? versions.findLast(v => v.to === installed) : null;
  const pull = titles(readCache(context.root));
  const recent = versions.filter(v => v.at >= context.now - WINDOW_MS).reverse().slice(0, INSTALLS_MAX);
  return {
    installed,
    installed_short: installed ? installed.slice(0, 7) : null,
    installed_at: iso(mine?.at),
    verified_at: iso(mine?.verifiedAt),
    main: ver?.main && SHA.test(ver.main) ? ver.main : null,
    commits_behind: Number.isSafeInteger(ver?.behind) ? ver.behind : null,
    hold: holdOf(context.root),
    mcp_version: ver?.mcp?.installed ?? null,
    processes: processVersions('/proc', { currentSha: installed }).map(p => ({ role: p.role, version: p.version, runs_installed: installed ? p.version === installed : null })),
    installs: recent.map((v, n) => ({ at: iso(v.at), commit: v.to.slice(0, 7), result: v.result, current: n === 0, pull_requests: v.prs.map(pull) })),
  };
}
