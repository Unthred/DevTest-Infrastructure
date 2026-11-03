// Issue #406: a wake pass (job end, install) reuses the GitHub list reads the last tick made, when they are fresh, instead of
// reading again. Every normal tick records its list reads; any write through the client (merge, comment, label, issue) drops them,
// so a pass never plans from a view the previous tick has already changed. Reads that are not lists are always made.
import fs from 'node:fs';
import path from 'node:path';

export const READ_TTL_MS = 3 * 60 * 1000;
const LISTS = ['listPulls', 'listIssues', 'listMergedPulls'];
const READS = new Set([...LISTS, 'listLabels', 'getMergedPull', 'listCheckRuns', 'listPullFiles', 'getPull', 'getIssue', 'issueAuthorAssociation', 'issueComments', 'hasComment', 'findIssueByMarker']);
const file = root => path.join(root, 'team', 'reads.json');
const load = root => { try { const s = JSON.parse(fs.readFileSync(file(root), 'utf8')); return s && typeof s === 'object' && s.lists && typeof s.lists === 'object' ? s : { lists: {} }; } catch { return { lists: {} }; } };
function save(root, s) {
  try { fs.mkdirSync(path.dirname(file(root)), { recursive: true, mode: 0o700 }); const tmp = `${file(root)}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, file(root)); } catch { /* best effort */ }
}
const drop = root => { try { fs.rmSync(file(root), { force: true }); } catch { /* best effort */ } };

// reuse: true for a wake pass. stats counts the list reads served from the record and made against GitHub.
export function cachedReads(gh, { root, reuse = false, now = () => Date.now(), stats = { reused: 0, fetched: 0 } }) {
  const wrapped = { ...gh };
  for (const name of LISTS) {
    if (typeof gh[name] !== 'function') continue;
    wrapped[name] = async (...args) => {
      if (reuse) {
        const e = load(root).lists[name];
        if (e && Number.isFinite(e.at) && now() - e.at >= 0 && now() - e.at <= READ_TTL_MS) { stats.reused++; return e.value; }
      }
      const value = await gh[name](...args); stats.fetched++;
      const s = load(root); s.lists[name] = { at: now(), value }; save(root, s);
      return value;
    };
  }
  for (const [name, fn] of Object.entries(gh)) {
    if (typeof fn !== 'function' || READS.has(name)) continue;
    wrapped[name] = async (...args) => { drop(root); return fn(...args); };   // a write: the recorded view is stale from here on
  }
  wrapped.readStats = stats;
  return wrapped;
}
