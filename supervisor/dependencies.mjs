// Issue #1103: dependency gating for every lane. Pure functions only: no I/O, no clock, no GitHub.
// The one dependency source is a single line in the issue body: `Depends on: #N, #M`. A prerequisite is met only when it is
// installed: its issue closed as completed, its pull request merged, and that merge commit in the installed version.
// Only code outside fences counts. Anything after the colon must be a comma-separated list of #N.

// `Depends on:` with the colon, optionally bold or bulleted. Without the colon a line is prose and is not a dependency source.
const LINE = /^[ \t]*(?:[-*>][ \t]+)?\**depends[ \t]+on\**[ \t]*:\**[ \t]*(.*?)[ \t]*$/i;
const MID_LINE = /\bdepends[ \t]+on[ \t]*:\**[ \t]*#\d+.*/i;
const LIST =/^#\d+(?:[ \t]*,[ \t]*#\d+)*$/;

export const PREREQUISITE_STATES = ['open', 'merged_not_installed', 'installed', 'closed_not_planned', 'unknown'];
// Kept in step with foreman-mcp/dependencyview.mjs (the MCP server cannot import from here); a test compares the two.
export const STATE_TEXT = {
  open: 'still open',
  merged_not_installed: 'merged but not installed yet',
  installed: 'installed',
  closed_not_planned: 'closed as not planned',
  unknown: 'status unknown'
};

const withoutCode = body => String(body || '').replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));

// { numbers, malformed, line }. No line: no prerequisites. More than one line, a line that is not a #N list, or an issue naming
// itself is malformed; Foreman never guesses what was meant.
export function parseDependsOn(body, self = null) {
  const lines = withoutCode(body).split('\n').filter(l => LINE.test(l));
  if (!lines.length) {
    // Issue #1182: "V2 item 27. Depends on: #1156" is a declaration written mid-sentence. Reading it as "no prerequisites" launched jobs
    // that stopped on the open prerequisite, so it fails closed: held as malformed until the line stands alone.
    const inline = MID_LINE.exec(withoutCode(body));
    if (inline) return { numbers: [], malformed: 'the Depends on line must stand on its own line, not inside a sentence', line: inline[0].trim() };
    return { numbers: [], malformed: null, line: null };
  }
  const line = lines[0].trim();
  if (lines.length > 1) return { numbers: [], malformed: 'more than one Depends on line', line };
  const rest = (LINE.exec(lines[0])?.[1] ?? '').replace(/\*+$/, '').trim();
  if (!LIST.test(rest)) return { numbers: [], malformed: 'the Depends on line must be a comma-separated list such as "Depends on: #12, #15"', line };
  const numbers = [...new Set([...rest.matchAll(/#(\d+)/g)].map(m => Number(m[1])))];
  if (!numbers.every(Number.isSafeInteger) || numbers.some(n => n < 1)) return { numbers: [], malformed: 'an issue number is out of range', line };
  if (self != null && numbers.includes(self)) return { numbers: [], malformed: 'an issue cannot depend on itself', line };
  return { numbers, malformed: null, line };
}

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
    out.set(number, { dependsOn, malformed: p.malformed, cycle, met: reasons.length === 0, reasons });
  }
  return { byIssue: out, cycles };
}

export const waitText = entry => `waiting for ${entry.reasons.join('; ')}`;
