// Issue #1448: the about model, GET /api/v1/about. Which version of Foreman is installed and running, when it was installed, and what each
// recent install changed in plain sentences. Joins the install records (team/upgrades.jsonl) to the issue index file, which keeps the
// issue bodies the dashboard view drops. Nothing is fetched from GitHub by a request and nothing is written.
import { installs } from '../../installs.mjs';
import { readUpgrades } from '../../suphealth.mjs';
import { readMcpInstall } from '../../mcpinstall.mjs';
import { readIndex } from '../../issueindex.mjs';
import { describeChange } from '../aboutwords.mjs';

export const name = 'about';
export const path = 'about';
export const schema = 'about.schema.json';
export const usesView = false;

export const DAYS = 7;
export const MAX_INSTALLS = 100;
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const NO_COMMIT = { commit: null, short: null };
const commit = sha => (sha ? { commit: sha, short: sha.slice(0, 7) } : null);

// One entry per from-to pair that really moved the version: a retry, an MCP copy or a dashboard restart of the same commit is not one.
function versionsOf(records) {
  const byPair = new Map();
  for (const r of records) {
    // A rollback undoes that install: the pair is dropped, and a later install of the same pair starts afresh.
    if (['rolled_back', 'rollback_failed'].includes(r.result) && r.from && r.to) byPair.delete(`${r.from}>${r.to}`);
    if (!['upgraded', 'verified'].includes(r.result) || !r.to || !r.from || r.from === r.to || !Number.isFinite(r.at)) continue;
    const pair = byPair.get(`${r.from}>${r.to}`) ?? { to: r.to, installedAt: null, verifiedAt: null, prs: new Set() };
    if (r.result === 'upgraded') pair.installedAt ??= r.at;
    else pair.verifiedAt ??= r.at;
    for (const n of r.prs) pair.prs.add(n);
    byPair.set(`${r.from}>${r.to}`, pair);
  }
  return [...byPair.values()].map(v => ({ ...v, at: v.installedAt ?? v.verifiedAt })).sort((a, b) => b.at - a.at);
}

function changesOf(prs, items) {
  return [...prs].sort((a, b) => a - b).map(number => {
    const pr = items[`pr:${number}`];
    const issue = items[`issue:${pr?.closes?.[0]}`];
    return describeChange(number, pr, issue);
  });
}

function holdOf(state) {
  if (state.latch) return { kind: 'latch', since: state.latch.at, reason: state.latch.reason };
  if (state.refusal) return { kind: 'refused', since: state.refusal.at, reason: state.refusal.reason };
  return null;
}

export function build(_view, context) {
  const state = installs(context.root, { now: context.now, procRoot: context.procRoot ?? '/proc' });
  const versions = versionsOf(readUpgrades(context.root));
  const items = readIndex(context.root)?.items ?? {};
  const current = versions.find(v => v.to === state.installed);
  const recent = versions.filter(v => v.at >= context.now - DAYS * 86400000).slice(0, MAX_INSTALLS);
  return {
    installed: { ...(commit(state.installed) ?? NO_COMMIT), installed_at: iso(current?.installedAt), verified_at: iso(current?.verifiedAt) },
    main: commit(state.main),
    behind: state.behind,
    hold: holdOf(state),
    mcp_version: readMcpInstall(context.root, state.installed)?.installed ?? null,
    processes: state.processes.map(p => ({ role: p.role, pid: p.pid, version: p.version, matches_installed: p.matchesInstalled })),
    installs: recent.map((v, n) => ({ at: iso(v.at), ...commit(v.to), current: n === 0, changes: changesOf(v.prs, items) })),
  };
}
