// Issue #1103: dependency gating for every lane. Pure functions only: no I/O, no clock, no GitHub.
// The MCP parser is the single source of truth because both proposal and planning paths use it.
export { DEPENDS_ON_EXAMPLE, dependencyRefusal, parseDependsOn } from '../foreman-mcp/dependency-parser.mjs';
import { parseDependsOn } from '../foreman-mcp/dependency-parser.mjs';

export const PREREQUISITE_STATES = ['open', 'merged_not_installed', 'installed', 'closed_not_planned', 'unknown'];
// Kept in step with foreman-mcp/dependencyview.mjs (the MCP server cannot import from here); a test compares the two.
export const STATE_TEXT = {
  open: 'still open',
  merged_not_installed: 'merged but not installed yet',
  installed: 'installed',
  closed_not_planned: 'closed as not planned',
  unknown: 'status unknown'
};

// The state of one prerequisite. `facts` are looked up by the caller:
//   issue: { state: 'OPEN'|'CLOSED', stateReason } or null; pr: { state: 'OPEN'|'MERGED'|'CLOSED', mergeSha } or null;
//   installedSha: the installed version or null; isAncestor(a, b): whether commit a is in b.
export function prerequisiteState({ issue = null, pr = null, installedSha = null, isAncestor = () => false } = {}) {
  if (pr && String(pr.state).toUpperCase() === 'OPEN') return 'open';
  if (pr && String(pr.state).toUpperCase() === 'CLOSED') return 'closed_not_planned';
  const merged = pr && String(pr.state).toUpperCase() === 'MERGED';
  if (!issue && !merged) return 'unknown';
  if (issue && String(issue.state).toUpperCase() === 'OPEN') return 'open';
  if (issue && !merged) {
    const reason = String(issue.stateReason || '').toUpperCase().replace(/[\s-]/g, '_');
    if (reason === 'NOT_PLANNED' || reason === 'DUPLICATE') return 'closed_not_planned';
    return 'unknown';   // closed as completed, but no merged pull request is known, so nothing proves it is installed
  }
  if (issue && ['NOT_PLANNED', 'DUPLICATE'].includes(String(issue.stateReason || '').toUpperCase())) return 'closed_not_planned';
  const sha = /^[0-9a-f]{40}$/.test(pr.mergeSha || '') ? pr.mergeSha : null;
  if (!sha || !/^[0-9a-f]{40}$/.test(installedSha || '')) return 'unknown';
  let inside = false;
  try { inside = sha === installedSha || isAncestor(sha, installedSha) === true; } catch { return 'unknown'; }
  return inside ? 'installed' : 'merged_not_installed';
}

// Issue #1118: closed as completed with no pull request linked to it, so nothing can ever prove it is installed (a failed lookup is not this).
function closedWithoutPull({ issue = null, pr = null } = {}) {
  if (pr || !issue || String(issue.state).toUpperCase() !== 'CLOSED') return false;
  return !(issue.closedByPullRequestsReferences || []).length;
}

// Dependency cycles among the given { number -> [prerequisite numbers] }. Each cycle is listed once, as its sorted members.
export function findCycles(graph) {
  const cycles = new Map(), done = new Set();
  const walk = (n, path) => {
    const at = path.indexOf(n);
    if (at >= 0) { const members = path.slice(at).sort((a, b) => a - b); cycles.set(members.join(','), members); return; }
    if (done.has(n)) return;
    for (const d of graph.get(n) || []) walk(d, [...path, n]);
    done.add(n);
  };
  for (const n of [...graph.keys()].sort((a, b) => a - b)) walk(n, []);
  return [...cycles.values()];
}

// The whole picture. `issues` are the open issues ({ number, body }); `lookup(n)` returns the facts for prerequisiteState.
// Returns a Map: issue number -> { dependsOn: [{ number, state }], malformed, cycle, met, reasons }, and the cycles found.
export function evaluateDependencies({ issues, lookup, installedSha, isAncestor }) {
  const parsed = new Map(issues.map(i => [i.number, parseDependsOn(i.body, i.number)]));
  const graph = new Map([...parsed].filter(([, p]) => p.numbers.length).map(([n, p]) => [n, p.numbers.filter(d => parsed.has(d))]));
  const cycles = findCycles(graph), inCycle = new Map();
  for (const c of cycles) for (const n of c) inCycle.set(n, c);
  const out = new Map();
  for (const [number, p] of parsed) {
    const dependsOn = p.numbers.map(d => {
      const facts = lookup(d), state = prerequisiteState({ ...facts, installedSha, isAncestor });
      return { number: d, state, ...(state === 'unknown' && closedWithoutPull(facts) ? { unlinked: true } : {}) };
    });
    const cycle = inCycle.get(number) || null;
    const reasons = [];
    if (p.malformed) reasons.push(`malformed Depends on line: ${p.malformed}`);
    if (cycle) reasons.push(`dependency cycle ${cycle.map(n => `#${n}`).join(' -> ')}`);
    for (const d of dependsOn) if (d.state !== 'installed') reasons.push(`#${d.number} ${STATE_TEXT[d.state]}`);
    out.set(number, { dependsOn, malformed: p.malformed, line: p.line, cycle, met: reasons.length === 0, reasons });
  }
  return { byIssue: out, cycles };
}

export const waitText = entry => `waiting for ${entry.reasons.join('; ')}`;
