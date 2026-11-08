// Issue #1054: work areas. Foreman limits the open unmerged pull requests per area and never runs two writing jobs on overlapping
// files. An area is an `area:<name>` (or `area/<name>`) label when the issue has one, otherwise the top-level path the work touches
// (supervisor/, dashboard/, docs/ ...; a file in the repository root is area "(root)"). Pure: no I/O.
export const AREA_LIMIT_DEFAULT = 3;
export const AREA_LIMIT_MAX = 100;
export const ROOT_AREA = '(root)';

export const areaLimitOf = L => (Number.isSafeInteger(L?.max_open_prs_per_area) && L.max_open_prs_per_area >= 1 ? L.max_open_prs_per_area : AREA_LIMIT_DEFAULT);
export function validateAreaLimit(L) {
  if ('max_open_prs_per_area' in (L || {}) && !(Number.isSafeInteger(L.max_open_prs_per_area) && L.max_open_prs_per_area >= 1 && L.max_open_prs_per_area <= AREA_LIMIT_MAX)) return 'invalid team limit: max_open_prs_per_area';
  return null;
}

export const areaOfPath = f => { const s = String(f || '').replace(/^\.?\//, ''), i = s.indexOf('/'); return i > 0 ? s.slice(0, i) : ROOT_AREA; };

// The area named by a label, if any. Labels are strings or { name }.
export function areaFromLabels(labels) {
  for (const l of Array.isArray(labels) ? labels : []) {
    const m = /^area[:/]\s*([A-Za-z0-9][\w.-]{0,40})$/.exec(String(typeof l === 'string' ? l : l?.name || '').trim());
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// The area holding most of the files (ties: alphabetical, so the answer never depends on list order). null when there are none.
export function primaryArea(files) {
  const n = new Map();
  for (const f of files || []) { const a = areaOfPath(f); n.set(a, (n.get(a) || 0) + 1); }
  return [...n].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
}
export const areaOfWork = (labels, files) => areaFromLabels(labels) ?? primaryArea(files);

// Every code area the files touch, sorted. tests/ and root files are secondary: they count only when nothing else is touched, so a PR
// with one supervisor file and two tests files is a supervisor PR (it counts in each code area it changes).
const SECONDARY = new Set(['tests', ROOT_AREA]);
export function codeAreas(files) {
  const all = [...new Set((files || []).map(areaOfPath))], code = all.filter(a => !SECONDARY.has(a));
  return (code.length ? code : all).sort();
}
export const areasOfWork = (labels, files) => { const l = areaFromLabels(labels); return l ? [l] : codeAreas(files); };
// A bare file name (team.mjs, AGENTS.md) does not say which directory it lives in, so it chooses no area.
export const pathedFiles = files => [...(files || [])].filter(f => String(f).includes('/'));
export const baseName = k => String(k).slice(String(k).lastIndexOf('/') + 1);

// Issue #1054, the week report: rebase jobs per merged pull request since the 8 Nov 2026 baseline (37 blocked rebase jobs for about 30
// stuck pull requests, about 1.2 per pull request). Null until the report is due, 7 days after the baseline date.
export const REBASE_BASELINE = { at: Date.parse('2026-11-08T00:00:00Z'), rebaseJobs: 37, pullRequests: 30, perPullRequest: 1.2 };
export function rebaseReport(state, now, baseline = REBASE_BASELINE) {
  if (!(now >= baseline.at + 7 * 86400000)) return null;
  const merged = (state?.mergeLog || []).filter(m => Number.isFinite(m.mergedAt) && m.mergedAt >= baseline.at);
  const rebases = Object.values(state?.jobs || {}).filter(j => j.kind === 'rebase' && Number.isFinite(j.at) && j.at >= baseline.at).length;
  const per = merged.length ? Math.round((rebases / merged.length) * 10) / 10 : null;
  return { rebases, merged: merged.length, perPullRequest: per, baseline: baseline.perPullRequest,
    text: `Issue #1054 week report: ${rebases} rebase job${rebases === 1 ? '' : 's'} for ${merged.length} merged pull request${merged.length === 1 ? '' : 's'} since 8 Nov 2026 (${per === null ? 'no merges yet' : `${per} per merged PR`}); the 8 Nov baseline was ${baseline.rebaseJobs} blocked rebase jobs for about ${baseline.pullRequests} stuck PRs (about ${baseline.perPullRequest} per PR).` };
}

// areas: Map area -> [refs]. Returns the areas at or above the limit.
export const fullAreas = (areas, limit) => new Map([...areas].filter(([, prs]) => prs.length >= limit));
// refs: readable names such as "PR 1038" (a started job without a pull request yet is "issue #1054").
export const holdText = (area, refs) => `held: ${refs.length} open PR${refs.length === 1 ? '' : 's'} in ${area} (${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ', ...' : ''})`;
