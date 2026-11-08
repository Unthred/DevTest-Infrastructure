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

// areas: Map area -> [refs]. Returns the areas at or above the limit.
export const fullAreas = (areas, limit) => new Map([...areas].filter(([, prs]) => prs.length >= limit));
// refs: readable names such as "PR 1038" (a started job without a pull request yet is "issue #1054").
export const holdText = (area, refs) => `held: ${refs.length} open PR${refs.length === 1 ? '' : 's'} in ${area} (${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ', ...' : ''})`;
