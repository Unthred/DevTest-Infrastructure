// Jobs view of the Work tab (issue #1220): one row per job, filter buttons with counts, grouping, a totals row and a side panel.
// The page is drawn on the server from the address (every state is a link, so it works without script); dashui/jobs-ui.mjs adds column
// hide and resize, saved views and the CSV download. The decisions are in dashui/jobs-table.mjs, the panel in jobs-panel.mjs.
import { COLUMNS, FACETS, GROUPS, NO_CAUSE, PAGE_SIZE, allJobRows, applyFilters, facetCounts, filtersOn, fmtCost, fmtCount, fmtDuration, fmtShare,
  groupRows, jobsQuery, parseJobsQuery, sortRows, totalsRow, withUnknown } from './dashui/jobs-table.mjs';
import { jobPanel } from './jobs-panel.mjs';
import { failCauseLabel } from './jobs-fields.mjs';

export const JOBS_STATIC = {
  '/static/jobs-table.mjs': ['jobs-table.mjs', 'text/javascript; charset=utf-8'],
  '/static/jobs-ui.mjs': ['jobs-ui.mjs', 'text/javascript; charset=utf-8'],
};
const href = (f, change) => `/work?${jobsQuery(f, { page: 1, job: '', ...change })}`;

function switcher(active) {
  const link = (id, label, to) => `<a class="qf${active === id ? ' on' : ''}" href="${to}"${active === id ? ' aria-current="true"' : ''} data-work-view="${id}">${label}</a>`;
  return `<nav class="qf-row" aria-label="Work views">${link('queue', 'Queue', '/work')}${link('jobs', 'Jobs', '/work?view=jobs')}</nav>`;
}

const chip = (group, value, label, count, on, to, esc) => `<a class="qf${on ? ' on' : ''}" href="${esc(to)}" data-chip="${group}:${esc(value)}"${on ? ' aria-current="true"' : ''}>${esc(label)} <span class="qf-n">${count}</span></a>`;
const valueLabel = (facet, value) => (facet === 'cause' ? (value === NO_CAUSE ? 'No cause' : failCauseLabel(value)) : value);

function chipRows(f, counts, esc) {
  const facets = FACETS.map(({ id, label }) => `<nav class="qf-row" aria-label="Filter by ${label.toLowerCase()}"><span class="qf-label">${label}</span>${counts[id].map(({ value, count }) => chip(id, value, valueLabel(id, value), count, f[id] === value, href(f, { [id]: f[id] === value ? '' : value }), esc)).join('')}</nav>`);
  const range = `<nav class="qf-row" aria-label="Filter by day range"><span class="qf-label">Day range</span>${counts.range.map(r => chip('range', r.value, r.label, r.count, f.range === r.value, href(f, { range: f.range === r.value ? '' : r.value }), esc)).join('')}</nav>`;
  const group = `<nav class="qf-row" aria-label="Group by"><span class="qf-label">Group by</span>${GROUPS.map(g => `<a class="qf${f.group === g.id ? ' on' : ''}" href="${esc(href(f, { group: f.group === g.id ? '' : g.id }))}" data-group="${g.id}"${f.group === g.id ? ' aria-current="true"' : ''}>${g.label}</a>`).join('')}</nav>`;
  return facets.join('') + range + group;
}

function searchForm(f, esc) {
  const keep = [...new URLSearchParams(jobsQuery(f, { q: '', page: 1, job: '' }))].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<form class="inbox-search" method="get" action="/work" role="search">${keep}<label>Search<input type="search" name="q" value="${esc(f.q)}" maxlength="200" autocomplete="off" placeholder="Search jobs"></label><button class="btn" type="submit">Search</button>${filtersOn(f) ? `<a class="btn" data-clear-filters href="/work?view=jobs&reset=1">Clear filters</a>` : ''}</form>`;
}

// Client-only tools stay hidden until the script runs, so the page makes no promise it cannot keep without it.
function tools(esc) {
  const cols = COLUMNS.map(c => `<label class="jobs-col-opt"><input type="checkbox" data-col-toggle="${c.key}" checked> ${esc(c.label)}</label>`).join('');
  return `<div class="jobs-tools" data-jobs-tools hidden><details class="jobs-cols"><summary class="btn">Columns</summary><div class="jobs-col-list">${cols}</div></details>`
    + '<button type="button" class="btn" data-jobs-csv>Download CSV</button>'
    + '<form class="jobs-views" data-jobs-views><label>View name<input type="text" name="name" maxlength="40" autocomplete="off"></label><button class="btn" type="submit">Save view</button>'
    + '<label>Saved views<select name="saved" aria-label="Saved views"><option value="">Choose a view</option></select></label><button class="btn" type="button" data-view-apply>Apply</button><button class="btn" type="button" data-view-delete>Delete</button></form>'
    + '<span class="sub" role="status" aria-live="polite" data-jobs-status></span></div>';
}

const cell = {
  id: (r, h, f) => `<a class="mono" href="${h.esc(`/work?${jobsQuery(f, { job: r.id })}`)}" data-job-link>${h.esc(r.id)}</a>`,
  agent: (r, h, f, view) => h.agentTag(r.agent, view),
  ref: (r, h) => (r.ref == null ? '–' : r.refKind === 'issue' ? h.issueLink(r.ref) : h.prLink(r.ref)),
  status: (r, h) => h.badge(({ completed: 'ok', running: 'ok', queued: 'info', paused_limit: 'warning', paused_manual: 'warning', blocked: 'action', failed: 'action' })[r.status] || 'info', r.status),
  cause: (r, h) => (r.causeLabel ? h.esc(r.causeLabel) : '<span class="muted">–</span>'),
  startedAt: (r, h) => h.lt(r.startedAt),
  durationMs: (r, h) => h.esc(fmtDuration(r.durationMs)),
  tokensIn: (r, h) => h.esc(fmtCount(r.tokensIn)), tokensOut: (r, h) => h.esc(fmtCount(r.tokensOut)),
  costGbp: (r, h) => h.esc(fmtCost(r.costGbp)), attempts: (r, h) => h.esc(fmtCount(r.attempts)), wasted: (r, h) => h.esc(fmtCount(r.wasted)),
};
const cellHtml = (c, r, h, f, view) => (cell[c.key] ? cell[c.key](r, h, f, view) : h.esc(r[c.key] ?? '–'));

function head(f, h) {
  const th = c => {
    const active = f.sort === c.key, next = active && f.dir === 'asc' ? 'desc' : 'asc';
    return `<th scope="col" class="c-${c.key}${c.num ? ' num' : ''}" data-col="${c.key}"${active ? ` aria-sort="${f.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>`
      + `<a href="${h.esc(href(f, { sort: c.key, dir: next }))}" title="Sort by ${h.esc(c.label)}">${h.esc(c.label)}</a>`
      + `<span class="col-grip" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize ${h.esc(c.label)} column" data-grip="${c.key}"></span></th>`;
  };
  return `<thead><tr>${COLUMNS.map(th).join('')}</tr></thead>`;
}

function totalsFoot(rows, h) {
  const t = totalsRow(rows);
  const tokens = withUnknown(fmtCount(t.tokens.total), t.tokens.unknown);
  const cost = withUnknown(fmtCost(t.cost.total), t.cost.unknown);
  const wasted = withUnknown(fmtCount(t.wasted.total), t.wasted.unknown);
  const stat = (name, v) => `<span class="jobs-stat" data-total="${name}"><b>${h.esc(name)}</b> ${h.esc(v)}</span>`;
  return `<tfoot><tr data-totals><td colspan="${COLUMNS.length}">${stat('Jobs', fmtCount(t.jobs))} ${stat('Tokens', tokens)} ${stat('Cost', cost)} ${stat('Wasted tokens', wasted)} ${stat('Share wasted', fmtShare(t.shareWasted))}</td></tr></tfoot>`;
}

// The page of rows, in group order when grouped. A group that continues from the previous page repeats its header with the whole group's figures.
function pageSlice(rows, f) {
  const groups = groupRows(sortRows(rows, f.sort, f.dir), f.group);
  const flat = groups.flatMap(g => g.rows.map(r => ({ r, g })));
  const pages = Math.max(1, Math.ceil(flat.length / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const slice = flat.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const shown = [];
  for (const { r, g } of slice) { const last = shown[shown.length - 1]; if (last && last.group === g) last.rows.push(r); else shown.push({ group: g, rows: [r] }); }
  return { shown, page, pages, total: flat.length };
}

function body(shown, f, h, view) {
  const rowHtml = r => `<tr data-job="${h.esc(r.id)}"${f.job && r.fullId.startsWith(f.job) ? ' class="on" aria-selected="true"' : ''}>${COLUMNS.map(c => `<td class="c-${c.key}${c.num ? ' num' : ''}" data-label="${h.esc(c.label)}">${cellHtml(c, r, h, f, view)}</td>`).join('')}</tr>`;
  return shown.map(({ group, rows }) => {
    const t = group.key ? totalsRow(group.rows) : null;
    const title = t ? `<tr class="grp" data-group-row="${h.esc(group.label)}"><th colspan="${COLUMNS.length}" scope="colgroup">${h.esc(group.label)} · ${t.jobs} job${t.jobs === 1 ? '' : 's'} · ${h.esc(withUnknown(fmtCount(t.tokens.total), t.tokens.unknown))} tokens · ${h.esc(withUnknown(fmtCost(t.cost.total), t.cost.unknown))}</th></tr>` : '';
    return `<tbody>${title}${rows.map(rowHtml).join('')}</tbody>`;
  }).join('');
}

function pager(p, f, h) {
  const link = (to, label, rel) => `<a href="${h.esc(href(f, { page: to }))}" rel="${rel}">${label}</a>`;
  return `<nav class="pager" aria-label="Job pages"><span>Page ${p.page} of ${p.pages}</span>${p.page > 1 ? link(p.page - 1, 'Previous', 'prev') : '<span class="dis">Previous</span>'}${p.page < p.pages ? link(p.page + 1, 'Next', 'next') : '<span class="dis">Next</span>'}</nav>`;
}

function tableCard(rows, filtered, f, h, view) {
  const p = pageSlice(filtered, f);
  const count = `<p class="sub" data-count>${filtered.length === rows.length ? `${rows.length} jobs` : `${filtered.length} of ${rows.length} jobs`}</p>`;
  const table = filtered.length
    ? `<div class="tbl-wrap"><table class="jobs-table" data-table="jobs">${head(f, h)}${body(p.shown, f, h, view)}${totalsFoot(filtered, h)}</table></div>${pager(p, f, h)}`
    : `<div class="empty"><b>No jobs match</b><span>${rows.length ? 'No job matches the filters in force.' : 'No job has been recorded yet.'}</span></div>`;
  return `${count}${table}`;
}

function panelCard(rows, f, h, view) {
  if (!f.job) return h.empty('No job selected', 'Click a row to see its record, postcondition, overseer note, transcript and the other jobs on the same item.', 'list');
  const job = rows.find(r => r.fullId.startsWith(f.job));
  if (!job) return h.empty('No such job', 'No job record starts with that id. It may be older than the records the dashboard keeps.', 'warn');
  const source = [...(view.jobs || []), ...(view.olderJobs || [])].find(j => j.fullId === job.fullId) || {};
  return jobPanel({ job, source, rows, view, filters: f, h });
}

export function jobsPage(view, query, h) {
  const f = parseJobsQuery(query);
  const rows = allJobRows(view);
  const now = view.generatedAt ?? Date.now();
  const filtered = applyFilters(rows, f, now);
  const main = h.card({ id: 'jobs-main', title: 'Jobs', span: 8, movable: false, body: `${switcher('jobs')}${chipRows(f, facetCounts(rows, f, now), h.esc)}${searchForm(f, h.esc)}${tools(h.esc)}${tableCard(rows, filtered, f, h, view)}` });
  const side = h.card({ id: 'jobs-panel', title: 'Job', span: 4, movable: false, body: panelCard(rows, f, h, view) });
  return { title: 'Work', body: `${h.grid('jobs', main + side, 'fit')}<script type="module" src="/static/jobs-ui.mjs"></script>` };
}

// The Work tab's views: the queue and issue tables as before, and the Jobs table (?view=jobs). Wraps the existing page with one switch.
export const withWorkViews = (queuePage, h) => (view, query, path, route) => {
  if (query.get('view') === 'jobs') return jobsPage(view, query, h);
  const page = queuePage(view, query, path, route);
  return page && { ...page, body: switcher('queue') + page.body };
};
