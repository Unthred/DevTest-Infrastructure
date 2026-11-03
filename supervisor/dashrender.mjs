// HTML for the team dashboard v2 (issue #54): one server-rendered page per URL, charts as inline SVG, tables sorted, filtered and
// paginated on the server from the URL (so every state is bookmarkable and works without script). One small same-origin script
// (dashui/app.js) adds the countdown, theme, legend toggles, chart expand and card layout. Every dynamic value goes through esc().
import { ACTIVITY_FILTERS, DEFAULT_PAGE_SIZE, DEFAULT_RANGE, PAGE_SIZES, RANGES, SEVERITIES, activityFilters, collapseIdle, countText, filterActivity, formatLocal, inRange, limitsOf, pillLinks, localStamps, tmark, tableState, trail, versionStatus } from './dashui/logic.mjs';
import { resultSeverity, tickLine } from './suphealth.mjs';
import { entryLink, entryText, filterTimeline } from './history.mjs';
import { DEFAULT_SINCE, SECTIONS, SINCE_RANGES } from './since.mjs';
import { fmtElapsed, renderEntries, renderTotals, totals } from './dashui/watch.mjs';

import { agentLine } from './agentline.mjs';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const utc = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown');
// Every time on the page is a <time>: UTC text for no-script and for tests, rewritten in the viewer's zone by dashui/app.js.
// Times inside plain text (warnings, allowance notes) travel as a marker and become <time data-local> at render time.
export const escT = text => localStamps(esc(text), lt);
// SVG text cannot hold <time>: the script rewrites any [data-lms] element from its template (data-tpl, "{t}" = the time).
const lms = (ms, tpl, timeOnly) => `data-lms="${ms}" data-tpl="${esc(tpl)}"${timeOnly ? ' data-tonly' : ''}`;
export const lt = ms => (Number.isFinite(ms) ? `<time class="lt" datetime="${new Date(ms).toISOString()}" data-local>${esc(utc(ms))}</time>` : 'unknown');
export const dur = ms => { if (!Number.isFinite(ms) || ms < 0) return 'unknown'; const m = Math.floor(ms / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };
const ago = (ms, now) => (Number.isFinite(ms) ? `${dur(now - ms)} ago` : 'never');
const inFuture = (ms, now) => (Number.isFinite(ms) ? (ms > now ? `in ${dur(ms - now)}` : `${dur(now - ms)} ago`) : 'unknown');
const pct = f => (Number.isFinite(f) ? `${Math.round(f * 100)}%` : 'unknown');
const num = n => (Number.isFinite(n) ? n.toLocaleString('en-GB') : 'unknown');
const dec1 = n => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString('en-GB') : '–');
const sha7 = s => esc(String(s || '').slice(0, 7));
const AGENT_COLOUR = { claude: 'var(--claude)', codex: 'var(--codex)' };
const EXTRA_COLOURS = ['var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
const colourOf = (name, i = 0) => AGENT_COLOUR[name] || EXTRA_COLOURS[i % EXTRA_COLOURS.length];

// ---- routes
export const NAV = [
  ['overview', '/', 'Overview', 'grid'], ['agents', '/agents', 'Agents', 'users'], ['work', '/work', 'Work', 'list'], ['activity', '/activity', 'Activity', 'pulse'],
  ['usage', '/usage', 'Usage & cost', 'chart'], ['reviews', '/reviews', 'Reviews', 'review'], ['supervisor', '/supervisor', 'Supervisor', 'shield'], ['system', '/system', 'System', 'gear']
];
export function matchRoute(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  const fixed = Object.fromEntries(NAV.map(([page, href]) => [href, page]));
  if (fixed[p]) return { page: fixed[p] };
  let m;
  if ((m = /^\/agents\/([A-Za-z0-9_-]{1,40})$/.exec(p))) return { page: 'agent', id: m[1] };
  if ((m = /^\/work\/pr\/(\d{1,9})$/.exec(p))) return { page: 'pr', id: Number(m[1]) };
  if ((m = /^\/work\/issue\/(\d{1,9})$/.exec(p))) return { page: 'issue', id: Number(m[1]) };
  if ((m = /^\/work\/job\/([A-Za-z0-9_-]{1,40})$/.exec(p))) return { page: 'job', id: m[1] };
  if ((m = /^\/jobs\/([a-f0-9]{32})$/.exec(p))) return { page: 'watch', id: m[1] };
  if (p === '/activity/timeline') return { page: 'timeline' };
  if (p === '/supervisor/ticks') return { page: 'ticks' };
  if (p === '/supervisor/upgrades') return { page: 'upgrades' };
  return null;
}
const parentOf = page => ({ agent: 'agents', pr: 'work', issue: 'work', job: 'work', watch: 'work', ticks: 'supervisor', upgrades: 'supervisor', timeline: 'activity' })[page] || page;

// ---- icons: authored for this project (24x24, 2px stroke); no third-party icon set is bundled
const ICONS = {
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>', warn: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v5M12 17.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>', check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-4 3-6 6.5-6s6 2 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .7 3.2 2.600 3.500 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.500 6h.01M3.500 12h.01M3.500 18h.01"/>', pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>', review: '<path d="M4 4h16v12H8l-4 4z"/><path d="m9 10 2 2 4-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.900 4.900l2.100 2.100M17 17l2.100 2.100M4.900 19.100 7 17M17 7l2.100-2.100"/>',
  moon: '<path d="M20 14.500A8 8 0 0 1 9.500 4 8 8 0 1 0 20 14.500z"/>', expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', sort: '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>', drag: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', play: '<path d="m8 5 11 7-11 7z"/>', pause: '<path d="M8 5v14M16 5v14"/>', refresh: '<path d="M20 11a8 8 0 1 0-2.300 5.700M20 4v7h-7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"/>', stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  tag: '<path d="M3 12V3h9l9 9-9 9z"/><path d="M7.500 7.500h.01"/>', copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"/>',
  shield: '<path d="M12 3 4 6v6c0 4.500 3.400 7.700 8 9 4.600-1.300 8-4.500 8-9V6z"/><path d="m9 12 2 2 4-4"/>', zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', resize: '<path d="M20 12v8h-8M20 20 12 12"/>', rail: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', back: '<path d="m15 6-6 6 6 6"/>'
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" viewBox="0 0 24 24"><use href="#i-${esc(name)}"/></svg>`;
const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${Object.entries(ICONS).map(([n, d]) => `<symbol id="i-${n}" viewBox="0 0 24 24">${d}</symbol>`).join('')}</defs></svg>`;

const sev = level => SEVERITIES[level] || SEVERITIES.info;
export const badge = (level, text, extra = '', html = false) => `<span class="badge sev-${esc(level)} ${extra}">${icon(sev(level).icon)}${html ? text : esc(text ?? sev(level).label)}</span>`;
const stateSev = { running: 'ok', idle: 'info', paused: 'warning', blocked: 'action', unknown: 'warning' };
const stateBadge = s => badge(stateSev[s] || 'info', ({ running: 'Running', idle: 'Idle', paused: 'Paused', blocked: 'Blocked', unknown: 'Unknown' })[s] || s);
const checksBadge = c => (c === 'green' ? badge('ok', 'CI green') : c === 'red' ? badge('action', 'CI failing') : c === 'pending' ? badge('info', 'CI running') : c ? badge('info', 'No CI') : '<span class="muted">–</span>');
const verdictBadge = v => (v === 'PASS' ? badge('ok', 'PASS') : v === 'CHANGES' ? badge('warning', 'CHANGES') : '<span class="muted">none</span>');
const agentTag = (name, view) => (name ? `<a href="/agents/${esc(encodeURIComponent(name))}"><span class="agent-dot" style="background:${colourOf(name, Object.keys(view.usage || {}).indexOf(name))}"></span>${esc(name)}</a>` : '<span class="muted">–</span>');
// Names come from the shared formatter (naming.mjs) through view.refs, set once per render; a title cut short shows in full on hover.
let REFS = { issue: {}, pr: {}, job: {} };
const named = (href, ref, fallback) => `<a href="${esc(href)}"${ref && ref.full !== ref.text ? ` title="${esc(ref.full)}"` : ''}>${esc(ref ? ref.text : fallback)}</a>`;
const prLink = n => named(`/work/pr/${Number(n)}`, REFS.pr[Number(n)], `PR #${Number(n)}`);
const issueLink = n => named(`/work/issue/${Number(n)}`, REFS.issue[Number(n)], `#${Number(n)}`);
const jobPath = id => `/work/job/${encodeURIComponent(String(id).slice(0, 8))}`;
const jobLink = id => named(jobPath(id), REFS.job[String(id).slice(0, 8)], `job ${String(id).slice(0, 8)}`);
const jobIdCell = (full, what = 'job ID') => `${jobLink(full)}${full ? copyBtn(full, what) : ''}`;
const refOf = r => (r ? (r.kind === 'pull' ? prLink(r.n) : issueLink(r.n)) : '');
const ext = (url, text) => `<a href="${esc(url)}">${esc(text)}</a>`;
// ---- copy buttons (issue #72): the text to copy is in data-copy; dashui/app.js does the copying and shows "Copied".
// Hidden until the script runs, because without script a button that does nothing is worse than none.
export const copyBtn = (text, what, { label = '', cls = '' } = {}) => `<button type="button" class="copy ${label ? 'btn' : 'tbtn'} ${cls}" data-copy="${esc(text)}" aria-label="Copy ${esc(what)}" title="Copy ${esc(what)}" hidden>${icon('copy')}${label ? `<span data-copy-label>${esc(label)}</span>` : ''}</button>`;
const overseerBtn = text => copyBtn(text, 'a plain-text summary for the overseer', { label: 'Copy for overseer', cls: 'overseer' });
// One "Copy all" button for a list: the items' own copy texts, in the order shown, one blank-line-separated block each.
export const copyAllText = items => items.map(a => a.overseer).filter(Boolean).join('\n\n---\n\n');
const copyAllBtn = (items, what) => { const t = copyAllText(items); return t && items.length > 1 ? `<div class="acts">${copyBtn(t, `all ${what}`, { label: 'Copy all', cls: 'copyall' })}</div>` : ''; };
const cmdBlock = command => `<div class="cmdrow"><code class="cmd mono">${esc(command)}</code>${copyBtn(command, 'command')}</div>`;
const idCopy = (shown, full, what) => `<span class="mono">${esc(shown)}</span>${full ? copyBtn(full, what) : ''}`;
const shaCopy = (sha, what = 'commit ID') => (sha ? idCopy(String(sha).slice(0, 7), sha, what) : '<span class="muted">–</span>');
const errCopy = text => (text ? `<span class="err">${esc(text)}</span>${copyBtn(text, 'error message')}` : '');
// A long text is cut with an ellipsis by CSS and shown in full on hover or tap (issue #204).
const trunc = text => `<span class="trunc" tabindex="0" title="${esc(text)}">${esc(text)}</span>`;
const watchLink = (id, text) => `<a class="btn watch-link" href="/jobs/${esc(id)}">${icon('play')}${esc(text)}</a>`;
const jobRef = (j, view) => (['implement', 'continue'].includes(j.kind) ? issueLink(j.ref) : prLink(j.ref));

// ---- empty / error states
const empty = (title, hint, ic = 'info') => `<div class="empty">${icon(ic)}<b>${esc(title)}</b><span>${esc(hint)}</span></div>`;

// ---- tables: server-side sort, filter, pagination, footer. State lives in the URL, namespaced by table id.
const withQuery = (path, query, set) => {
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(set)) { if (v === null || v === undefined || v === '') q.delete(k); else q.set(k, String(v)); }
  const s = q.toString(); return s ? `${path}?${s}` : path;
};
export function table({ id, path, query, cols, rows, searchKeys = [], totals = {}, noun = 'rows', emptyState }) {
  const q = (k, d) => query.get(`${id}.${k}`) ?? d;
  const sortKey = cols.some(c => c.key === q('sort') && c.sortable !== false) ? q('sort') : null;
  const st = tableState(rows, { sort: sortKey, dir: q('dir') === 'desc' ? 'desc' : 'asc', q: q('q', ''), page: Number(q('page', 1)), pageSize: Number(q('size', DEFAULT_PAGE_SIZE)), searchKeys, totals });
  const dir = q('dir') === 'desc' ? 'desc' : 'asc';
  const href = set => esc(withQuery(path, query, Object.fromEntries(Object.entries(set).map(([k, v]) => [`${id}.${k}`, v]))));
  const head = cols.map(c => {
    if (c.sortable === false) return `<th scope="col"${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`;
    const active = sortKey === c.key, next = active && dir === 'asc' ? 'desc' : 'asc';
    return `<th scope="col"${c.num ? ' class="num"' : ''}${active ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}><a href="${href({ sort: c.key, dir: next, page: 1 })}" title="Sort by ${esc(c.label)}">${esc(c.label)}${icon(active ? (dir === 'asc' ? 'up' : 'down') : 'sort')}</a></th>`;
  }).join('');
  const expandable = cols.some(c => c.more);
  const body = st.rows.map(r => `<tr${expandable ? ' tabindex="0"' : ''}>${cols.map(c => `<td data-label="${esc(c.label)}" class="${c.num ? 'num ' : ''}${c.more ? 'more' : ''}">${c.html ? c.html(r) : esc(r[c.key] ?? '–')}</td>`).join('')}</tr>`).join('');
  const foot = Object.keys(totals).length ? `<tfoot><tr>${cols.map((c, i) => {
    const op = totals[c.key]; let v = '';
    if (op === 'sum') v = c.fmt ? c.fmt(st.footer[c.key]) : num(st.footer[c.key]); else if (op === 'avg') v = `avg ${c.fmt ? c.fmt(st.footer[c.key]) : dec1(st.footer[c.key])}`; else if (op === 'count') v = countText(st.footer[c.key], st.all, noun);
    return `<td data-label="${esc(c.label)}"${c.num ? ' class="num"' : ''}>${i === 0 && !op ? 'Total' : esc(v)}</td>`;
  }).join('')}</tr></tfoot>` : '';
  const needle = q('q', '');
  const bar = `<form class="tbar" method="get" action="${esc(path)}" role="search">${[...query].filter(([k]) => !k.startsWith(`${id}.`)).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${sortKey ? `<input type="hidden" name="${id}.sort" value="${esc(sortKey)}"><input type="hidden" name="${id}.dir" value="${dir}">` : ''}
<label class="sr"><span class="muted">Filter ${esc(noun)}</span> <input type="search" name="${id}.q" value="${esc(needle)}" placeholder="Filter ${esc(noun)}" aria-label="Filter ${esc(noun)}"></label>
<label><span class="muted">Per page</span> <select name="${id}.size" aria-label="Rows per page">${PAGE_SIZES.map(s => `<option${s === st.pageSize ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
<span data-tclear>${needle ? `<a class="btn" href="${href({ q: null, page: 1 })}">Clear</a>` : ''}</span></form>`;
  const pager = `<nav class="pager" aria-label="${esc(noun)} pages">${st.total ? `<span>${st.from}–${st.to} of ${st.total}</span>` : ''}<span class="count" data-count>${esc(countText(st.total, st.all, noun))}</span>
${st.page > 1 ? `<a href="${href({ page: st.page - 1 })}" rel="prev">Previous</a>` : '<span class="dis">Previous</span>'}<span class="cur" aria-current="page">Page ${st.page} of ${st.pages}</span>
${st.page < st.pages ? `<a href="${href({ page: st.page + 1 })}" rel="next">Next</a>` : '<span class="dis">Next</span>'}</nav>`;
  if (!rows.length) return emptyState || empty(`No ${noun} yet`, 'Nothing has been recorded.');
  // data-tregion: the script replaces [data-tdata] (and the Clear slot) in place when a control or link of this table is used (issue #61).
  return `<div class="tregion" data-tregion="${esc(id)}">${bar}<div data-tdata><div class="tbl-wrap"><table data-table="${esc(id)}"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}">${esc(`No ${noun} match the filter.`)}</td></tr>`}</tbody>${foot}</table></div>${pager}</div></div>`;
}

// ---- charts: inline SVG, hover tooltips (<title>), per-series toggles (script), colours per agent
const fmtAxisTime = (t, range) => new Date(t).toISOString().slice(range === '24h' ? 11 : range === 'all' ? 0 : 5, range === '24h' ? 16 : 10);
function legend(items) {
  return `<div class="legend" role="group" aria-label="Series">${items.map(s => `<button type="button" aria-pressed="true" data-series="${esc(s.key)}"${s.marker ? ' data-marker="true"' : ''}><i style="background:${s.colour}"></i>${esc(s.label)}</button>`).join('')}</div>`;
}
function lineChart({ series, resets = [], expected = [], now, range, title }) {
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return empty('No allowance history in this range', 'The chart fills in as ticks record what the providers report.', 'chart');
  const W = 900, H = 320, L = 44, B = 28, T = 12, R = 14;
  const t1 = now, t0 = Number.isFinite(RANGES[range]) ? now - RANGES[range] : Math.min(...pts.map(p => p.at));
  const x = t => L + ((t - t0) / (t1 - t0)) * (W - L - R), y = v => T + (1 - Math.min(1, Math.max(0, v))) * (H - T - B);
  let g = [0, 0.25, 0.5, 0.75, 1].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v * 100}%</text>`).join('');
  for (let i = 0; i <= 4; i++) { const t = t0 + ((t1 - t0) * i) / 4; g += `<text x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" class="ax" ${lms(Math.round(t), '{t}', range === '24h')}>${esc(fmtAxisTime(t, range))}</text>`; }
  for (const r of resets.filter(r => r.at >= t0)) g += `<line x1="${x(r.at)}" x2="${x(r.at)}" y1="${T}" y2="${H - B}" class="reset" data-series="reset"><title ${lms(r.at, `${r.window} window reset {t}`)}>${esc(r.window)} window reset ${esc(utc(r.at))}</title></line>`;
  const shownExpected = expected.filter(r => r.at >= t0 && r.at <= t1);
  for (const r of shownExpected) g += `<line x1="${x(r.at).toFixed(1)}" x2="${x(r.at).toFixed(1)}" y1="${T}" y2="${H - B}" class="reset expected" data-series="expected"><title ${lms(r.at, `${r.window} window expected to reset {t}: the reading before it has expired`)}>${esc(r.window)} window expected to reset ${esc(utc(r.at))}: the reading before it has expired</title></line>`;
  for (const s of series) {
    if (!s.points.length) continue;
    // a gap (reading expired, then a new one) splits the line: nothing is drawn across the time no reading was current
    const segments = s.points.reduce((acc, p) => { if (p.gap || !acc.length) acc.push([]); acc.at(-1).push(p); return acc; }, []);
    g += `<g data-series="${esc(s.key)}">${segments.map(seg => `<polyline fill="none" stroke="${s.colour}" stroke-width="2.5" stroke-linejoin="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} points="${seg.map(p => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>`).join('')}`
      + s.points.filter((_, i, a) => a.length < 60 || i % Math.ceil(a.length / 60) === 0).map(p => `<circle class="pt" tabindex="0" cx="${x(p.at).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="5" fill="${s.colour}"><title ${lms(p.at, `${s.label}: ${pct(p.v)} at {t}`)}>${esc(s.label)}: ${pct(p.v)} at ${esc(utc(p.at))}</title></circle>`).join('') + '</g>';
  }
  const items = [...series.filter(s => s.points.length).map(s => ({ key: s.key, label: s.label, colour: s.colour })), ...(resets.length ? [{ key: 'reset', label: 'Window reset', colour: 'var(--action)', marker: true }] : []), ...(shownExpected.length ? [{ key: 'expected', label: 'Expected reset (reading expired)', colour: 'var(--mut)', marker: true }] : [])];
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg>${legend(items)}</figure>`;
}
function stackedChart({ days, title, range, now }) {
  const names = Object.keys(days).filter(d => inRange(Date.parse(`${d}T12:00:00Z`) + 12 * 3600000, now, range)).sort();
  if (!names.length) return empty('No jobs in this range', 'Job counts appear here once the team has run work.', 'chart');
  const keys = [...new Set(names.flatMap(d => Object.keys(days[d])))].sort();
  const cols = keys.map((k, i) => ({ key: k, label: k, colour: colourOf(k.split('/')[0] === 'review' ? 'codex' : null, i) }));
  const palette = ['var(--codex)', 'var(--claude)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
  cols.forEach((c, i) => { c.colour = palette[i % palette.length]; });
  const W = 900, H = 320, L = 44, B = 28, T = 12, slot = (W - L - 14) / names.length, bw = Math.min(54, slot - 8);
  const max = Math.max(...names.map(d => Object.values(days[d]).reduce((a, b) => a + b, 0)), 1);
  let g = [0, 0.5, 1].map(v => `<line x1="${L}" x2="${W - 14}" y1="${T + (1 - v) * (H - T - B)}" y2="${T + (1 - v) * (H - T - B)}" class="gridline"/><text x="${L - 6}" y="${T + (1 - v) * (H - T - B) + 4}" text-anchor="end" class="ax">${Math.round(max * v)}</text>`).join('');
  names.forEach((d, i) => {
    const x0 = L + 4 + i * slot + (slot - bw) / 2; let acc = 0;
    cols.forEach(c => { const n = days[d][c.key] || 0; if (!n) return; const h = (n / max) * (H - T - B); acc += h; g += `<rect data-series="${esc(c.key)}" x="${x0.toFixed(1)}" y="${(H - B - acc).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${c.colour}"><title>${esc(d)}: ${n} × ${esc(c.key)}</title></rect>`; });
    g += `<text x="${(x0 + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="ax">${esc(d.slice(5))}</text>`;
  });
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg>${legend(cols)}</figure>`;
}
function barChart({ rows, title, emptyTitle }) {
  const known = rows.filter(r => Number.isFinite(r.value));
  if (!known.length || known.every(r => r.value === 0)) return empty(emptyTitle || 'No data yet', 'This chart fills in as work completes.', 'chart');
  const max = Math.max(...known.map(r => r.value), 1), W = 900, rowH = 30, H = rows.length * rowH + 10, L = 190;
  const g = rows.map((r, i) => `<text x="${L - 8}" y="${i * rowH + 20}" text-anchor="end" class="ax">${esc(r.label)}</text>` + (Number.isFinite(r.value)
    ? `<g data-series="${esc(r.series || r.label)}"><rect x="${L}" y="${i * rowH + 6}" width="${Math.max(3, (r.value / max) * (W - L - 90)).toFixed(1)}" height="18" rx="3" fill="${r.colour || 'var(--codex)'}"><title>${esc(r.label)}: ${esc(r.text ?? num(r.value))}</title></rect><text x="${L + Math.max(3, (r.value / max) * (W - L - 90)) + 6}" y="${i * rowH + 20}" class="ax">${esc(r.text ?? num(r.value))}</text></g>`
    : `<text x="${L}" y="${i * rowH + 20}" class="ax">unknown</text>`)).join('');
  const seen = new Map(rows.filter(r => Number.isFinite(r.value)).map(r => [r.series || r.label, r]));
  const items = [...seen.entries()].filter(([, r]) => r.series).map(([key, r]) => ({ key, label: key, colour: r.colour }));
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg>${items.length ? legend(items) : ''}</figure>`;
}
function sparkline(values, colour = 'var(--codex)') {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const max = Math.max(...v, 1e-9), W = 120, H = 28;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${colour}" stroke-width="2" points="${v.map((n, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(H - 2 - (n / max) * (H - 4)).toFixed(1)}`).join(' ')}"/></svg>`;
}
const rangeSelector = (path, query, range) => `<div class="ranges" role="group" aria-label="Time range">${Object.keys(RANGES).map(r => `<a href="${esc(withQuery(path, query, { range: r }))}"${r === range ? ' aria-current="true"' : ''}>${r}</a>`).join('')}</div>`;

// chart data from the view, filtered to the selected range
function allowanceSeries(view, range) {
  const out = [];
  for (const [agent, g] of Object.entries(view.graphs.allowance)) Object.entries(g.series).forEach(([win, pts], i) => {
    out.push({ key: `${agent} ${win}`, label: `${agent} ${win}`, colour: colourOf(agent, out.length), dash: i % 2 ? '6 4' : '', points: pts.filter(p => inRange(p.at, view.generatedAt, range)) });
  });
  return out;
}
const allResets = (view, range) => Object.values(view.graphs.allowance).flatMap(g => g.resets).filter(r => inRange(r.at, view.generatedAt, range));
const allExpected = view => Object.entries(view.graphs.allowance).flatMap(([agent, g]) => (g.expected || []).map(r => ({ ...r, window: `${agent} ${r.window}` })));

// ---- card shell
const EDGES = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
function card({ id, title, span = 6, body, href, tools = '', cls = '', movable = true, expandable = false, type = 'info' }) {
  if (expandable) { type = 'chart'; cls = `${cls} chart-card`; }
  const lim = limitsOf(type);
  const handles = movable ? EDGES.filter(e => !(lim.vlock && /[ns]/.test(e) && e.length === 1)).map(e => `<span class="resize wide-only rz-${e}" data-edge="${e}" aria-hidden="true"></span>`).join('') : '';
  return `<section class="card ${cls}" data-card="${esc(id)}" data-type="${esc(type)}" data-span="${span}" style="--span:${span}" id="c-${esc(id)}" aria-labelledby="h-${esc(id)}"><header>${movable ? `<span class="tbtn" data-handle title="Drag to move" aria-hidden="true">${icon('drag')}</span>` : ''}<h2 id="h-${esc(id)}">${esc(title)}</h2>
<span class="tools">${tools}<button class="tbtn" type="button" data-collapse aria-expanded="true" aria-label="Collapse ${esc(title)}" title="Collapse or expand (or double-click the header)" hidden>${icon('down')}</button>${expandable ? `<button class="tbtn" type="button" data-expand aria-label="Expand ${esc(title)}" title="Expand">${icon('expand')}</button>` : ''}${movable ? `<button class="tbtn" type="button" data-move="-1" aria-label="Move ${esc(title)} earlier" title="Move earlier">${icon('up')}</button><button class="tbtn" type="button" data-move="1" aria-label="Move ${esc(title)} later" title="Move later">${icon('down')}</button>` : ''}${href ? `<a class="tbtn" href="${esc(href)}" aria-label="Details: ${esc(title)}" title="Details">${icon('link')}</a>` : ''}</span></header>${body}${movable ? `${handles}<span class="resize wide-only rz-key" tabindex="0" role="slider" aria-label="Resize ${esc(title)} (arrow keys: left and right for width${lim.vlock ? '' : ', up and down for height'})" aria-valuemin="${lim.minSpan}" aria-valuemax="${lim.maxSpan}" aria-valuenow="${span}">${icon('resize')}</span>` : ''}</section>`;
}
const grid = (layout, cards, cls = '') => `<div class="cards ${cls}" data-layout="${esc(layout)}">${cards}</div>`;
const kpi = ({ id, label, value, href, spark = '', span = 2 }) => `<a class="card kpi" data-card="${esc(id)}" data-type="kpi" data-span="${span}" style="--span:${span}" href="${esc(href)}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div><div class="spark-slot">${spark}</div></a>`;

// ---- the four panels (Overview top) and the status bar
function nowPanel(view) {
  const now = view.generatedAt;
  const slots = `<div class="sub slots">${(view.slots || []).map(x => `<div>${esc(x.text)}${x.capacity > 1 ? ` (${x.held.length} of ${x.capacity})` : ''}</div>`).join('')}${(view.capNotes || []).map(n => `<div class="cap-note">Held down: ${esc(n)}</div>`).join('')}${Object.entries(view.budget || {}).filter(([, b]) => b.known).map(([n, b]) => `<div class="rate-note">${esc(n)}: ${Number.isFinite(b.ratePerHour) ? `${(b.ratePerHour * 100).toFixed(2)}% of the week per hour, ` : ''}projected ${Number.isFinite(b.projected) ? `${Math.round(b.projected * 100)}%` : 'unknown'} at reset</div>`).join('')}</div>`;
  // Issue #213: one card per running or paused job (role, model, item, elapsed); an agent with none gets one idle/blocked/unknown card.
  const jobItem = (a, j) => {
    const level = j.paused ? 'warning' : 'info', role = j.role === 'reviewer' ? 'Reviewer' : 'Implementer';
    const when = j.paused ? `paused (${esc(j.lastEvent)})${j.nextAttemptAt ? `, retry ${esc(inFuture(j.nextAttemptAt, now))}` : ''}`+ (j.resumeWait ? `; ${esc(j.resumeWait)}` : '') : `elapsed ${esc(dur(j.elapsedMs))}`;
    return `<li class="sev-${level}" data-job-card="${esc(j.id)}"><div class="t">${agentTag(a.name, view)} ${badge('info', role)} ${stateBadge(j.paused ? 'paused' : 'running')}</div><div>${j.model ? `${esc(j.model)} · ` : ''}${j.name ? `${esc(j.name)} · ` : ''}${jobLink(j.id)} · attempt ${Number(j.attempts)} · ${when}${j.fullId ? ` · ${watchLink(j.fullId, j.paused ? 'Transcript' : 'Watch live')}` : ''}</div></li>`;
  };
  return `${slots}<ul class="panel-list">${view.agents.map(a => {
    if (a.jobs?.length) return a.jobs.map(j => jobItem(a, j)).join('');
    const j = a.job, level = stateSev[a.state] || 'info';
    const what = j ? `${jobLink(j.id)} · attempt ${Number(j.attempts)} · ${a.state === 'paused' ? `paused (${esc(j.lastEvent)})${j.nextAttemptAt ? `, retry ${esc(inFuture(j.nextAttemptAt, now))}` : ''}` : `elapsed ${esc(dur(j.elapsedMs))}`}${j.fullId ? ` · ${watchLink(j.fullId, a.state === 'running' ? 'Watch live' : 'Transcript')}` : ''}`
      : `<span>Idle: ${a.idleReason ? esc(a.idleReason.text) : 'nothing to do'}</span> ${(a.idleReason?.links || []).map(l => ext(l.url, l.text)).join(' ')}`;
    return `<li class="sev-${level}"><div class="t">${agentTag(a.name, view)} ${stateBadge(a.state)}</div><div>${what}</div></li>`;
  }).join('')}</ul>`;
}
// Allowance mode and weekly projection for one agent (issue #56).
function budgetBlock(view, name) {
  const b = view.budget?.[name];
  if (!b) return '';
  const sev = { normal: 'ok', reviews_only: 'warning', waiting: 'action' }[b.mode] || 'info', now = view.generatedAt;
  const proj = b.known ? `Weekly ${pct(b.used)} used, projected <b>${pct(b.projected)}</b> at reset (${esc(inFuture(b.resetsAt, now))}; rate from the ${esc(b.rateSource)})${b.runsOutAt && b.runsOutAt < b.resetsAt ? `; runs out ${esc(inFuture(b.runsOutAt, now))}` : ''}` : 'Weekly use unknown';
  return `<div class="budget" data-mode="${esc(b.mode)}"><p>${badge(sev, b.label)}${b.mode !== 'normal' && b.until ? ` <span class="sub">until ${lt(b.until)}</span>` : ''}</p><p class="sub">${proj}</p>${b.reason ? `<p class="sub">Why: ${esc(b.reason)}</p>` : ''}${Object.entries(b.held || {}).map(([t, w]) => `<p class="sub">Held back (${esc(t)}): ${esc(w)}</p>`).join('')}</div>`;
}
// Issue #156: the estimated finish with its basis on hover; waits Foreman knows about get their own time.
const estFor = (view, kind, ref) => view.estimates?.items?.[`${kind}:${ref}`] || null;
function estHtml(e, tz = 'UTC') {
  if (!e) return '';
  const tip = (e.basis || []).join('\n');
  return `<div class="sub est" data-est="${esc(e.status)}" title="${esc(tip)}">${icon('clock')} ${esc(e.text)} <span class="tzl">(${esc(tz)})</span>${(e.waits || []).map(w => ` <span class="est-wait" data-wait="${esc(w.kind)}">${esc(w.text)}</span>`).join('')}</div>`;
}
const globalWaitsHtml = view => (view.estimates?.waits || []).map(w => `<p class="sub est-wait" data-wait="${esc(w.kind)}">${icon('clock')} ${esc(w.text)} <span class="tzl">(${esc(view.tz || 'UTC')})</span></p>`).join('');
// Issue #76: when nothing is planned, say why. Counts link to the Work lists, filtered.
function nextWhyHtml(view) {
  const w = view.panels.nextWhy; if (!w) return '';
  const li = [];
  for (const b of w.busy) li.push(`<li>${agentTag(b.agent, view)} is busy: ${esc(b.job)}</li>`);
  for (const p of w.paused) li.push(`<li>${agentTag(p.agent, view)} is paused${p.job ? `: ${esc(p.job)}` : ''}${p.resumeAt ? `, resumes about ${lt(p.resumeAt)}` : ''}</li>`);
  if (w.blocked) li.push(`<li><a href="/work?issues.show=blocked">${w.blocked} queued item${w.blocked === 1 ? '' : 's'} blocked by dependencies</a></li>`);
  if (w.waitingReview) li.push(`<li><a href="/work?prs.show=awaiting-review">${w.waitingReview} waiting for review</a></li>`);
  return `<div class="why" data-why><p class="sub">Nothing is planned because:</p>${li.length ? `<ul class="panel-list">${li.join('')}</ul>` : '<p class="sub">no agent has work waiting.</p>'}</div>`;
}
function nextPanel(view) {
  const now = view.generatedAt, plan = view.panels.next;
  const when = view.nextTickAt ? `<p class="sub">${icon('clock')} Next tick <b data-countdown="${view.nextTickAt}">${esc(inFuture(view.nextTickAt, now))}</b></p>` : '<p class="sub">No tick is scheduled: the team loop is off or has never run.</p>';
  return `${when}${globalWaitsHtml(view)}${plan.length ? '' : nextWhyHtml(view)}${plan.length ? `<ul class="panel-list">${plan.map(p => `<li class="sev-info"><div class="t">${agentTag(p.agent, view)}: ${esc(p.type === 'cifix' ? 'fix CI' : p.type)}</div><div>${['implement', 'continue'].includes(p.type) ? issueLink(p.ref) : prLink(p.ref)}</div>${estHtml(estFor(view, ['implement', 'continue'].includes(p.type) ? 'issue' : 'pr', p.ref), view.tz)}${p.reassignedFrom ? `<div class="sub">${esc(p.why || `reassigned for allowance from ${p.reassignedFrom}`)}</div>` : ''}</li>`).join('')}</ul>` : empty('Nothing planned', 'The next tick has no work to start.', 'check')}`;
}
function needsPanel(view) {
  const items = view.panels.needsYou;
  return items.length ? `${copyAllBtn(items, 'Needs you items')}<ul class="panel-list">${items.map(a => `<li class="sev-action" id="att-${esc(a.id)}"><div class="t">${badge('action')} ${escT(a.text)} ${refOf(a.ref)}</div>${a.tried ? `<div class="sub">Tried: ${esc(a.tried)}</div>` : ''}<div class="sub">Decision: ${esc(a.decision)}</div>${(a.links || []).length ? `<div class="sub">${a.links.map(l => (l.url.startsWith('/') ? `<a href="${esc(l.url)}">${esc(l.text)}</a>` : ext(l.url, l.text))).join(' · ')}</div>` : ''}${a.command ? cmdBlock(a.command) : ''}${a.watch ? `<div class="acts">${watchLink(a.watch, 'Replay transcript')}</div>` : ''}${a.overseer ? `<div class="acts">${overseerBtn(a.overseer)}</div>` : ''}</li>`).join('')}</ul>`
    : empty('Nothing needs you', 'No homeowner decision or failed work is waiting.', 'check');
}
// Issue #414: parked or staged work, quieter than Needs you: what it waits for and who or what ends the wait.
function laterPanel(view) {
  const items = view.panels.later || [];
  return items.length ? `<ul class="panel-list">${items.map(a => `<li class="sev-info" id="later-${esc(a.number)}"><div class="t">${ext(a.url, a.name)}</div><div class="sub">Waits: ${esc(a.waits)}</div><div class="sub">Ends: ${esc(a.ends)}</div></li>`).join('')}</ul>` : empty('Nothing later', 'No parked or staged work is waiting.', 'check');
}
function warningsPanel(view) {
  const unknown = view.agents.filter(a => a.state === 'unknown');
  const items = unknown.length ? [...view.panels.warnings, { severity: 'warning', text: `${unknown.length} agent record${unknown.length === 1 ? '' : 's'} could not be read or have an unknown state: running count is unknown` }] : view.panels.warnings;
  return items.length ? `${copyAllBtn(items, 'warnings')}<ul class="panel-list">${items.map(a => `<li class="sev-${esc(a.severity)}"><div class="t">${badge(a.severity)} ${escT(a.text)} ${refOf(a.ref)}</div>${a.overseer ? `<div class="acts">${overseerBtn(a.overseer)}</div>` : ''}</li>`).join('')}</ul>` : empty('No warnings', 'No stalls, stale data or version drift.', 'check');
}
// Issue #76: each agent's own state and reason, from the same sentence `team status` prints (agentline.mjs).
const TIME_MARK = /\u0001(\d+)\u0002/g;
const agentStat = view => `<div class="stat agent-lines" aria-label="Agents"><ul>${view.agents.map(a => `<li data-agent="${esc(a.name)}" data-state="${esc(a.state)}">${stateBadge(a.state)} <span><b>${esc(a.name)}</b>: ${esc(agentLine(a, ms => `\u0001${ms}\u0002`)).replace(TIME_MARK, (_, ms) => lt(Number(ms)))}</span></li>`).join('')}</ul></div>`;
function statusBar(view, route, head = '') {
  const now = view.generatedAt, t = view.tick, fr = view.freshness, v = view.version;
  const tickBadge = !t ? badge('action', 'No tick yet') : badge(t.status === 'ok' ? 'ok' : t.status === 'error' ? 'action' : 'info', `Tick ${t.status}`);
  const L = pillLinks({ health: view.health, attention: view.attention, version: v }), vs = versionStatus(v);
  const pill = (href, inner, why) => `<a class="pill" href="${esc(href)}" title="${esc(why)}">${inner}</a>`;
  return `<header class="statusbar" role="banner"><div class="brand">${icon('pulse')} DevTest team</div>${head}
${['paused', 'running'].includes(view.health.state) ? '' : `<div class="stat" title="Overall health">${pill(L.health, badge(view.health.severity, view.health.label, 'big'), 'Overall health: open what explains it')}</div>`}
${agentStat(view)}
<div class="stat"><span class="k">Last tick</span>${pill(L.tick, tickBadge, 'Open the last tick and its error')}<span>${t ? esc(ago(t.at, now)) : ''}</span></div>
<div class="stat"><span class="k">Next</span>${view.nextTickAt ? `<b data-countdown="${view.nextTickAt}">${esc(inFuture(view.nextTickAt, now))}</b>` : '<span class="muted">none</span>'}</div>
<div class="stat"><span class="k">Data</span>${pill(L.data, badge(fr.level, fr.label), 'Data freshness follows the last tick')}</div>
<div class="stat"><span class="k">Team loop</span>${pill(L.team, view.teamEnabled ? badge('ok', 'Enabled') : badge('info', 'Disabled'), 'Open the dispatcher facts')}</div>
<div class="stat"><span class="k">Version</span>${pill(vs.href, badge(vs.level, escT(vs.label), '', true), 'Open the version health card')}</div>
<button class="theme" id="theme" type="button" aria-label="Switch between light and dark theme" title="Theme">${icon('moon')}</button></header>
<nav class="nav" id="nav" aria-label="Pages"><button type="button" class="dock-handle wide-only" data-dock-handle aria-label="Dock the navigation: arrow keys move it to a screen edge, Home resets it" title="Drag to a screen edge to dock the navigation, or use the arrow keys">${icon('drag')}</button>${NAV.map(([page, href, label, ic]) => `<a href="${href}"${route.page === page || parentOf(route.page) === page ? ' aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></a>`).join('')}<button class="nav-collapse wide-only" type="button" data-nav-collapse aria-pressed="false" title="Collapse or expand the navigation rail">${icon('rail')}<span>Collapse</span></button></nav>`;
}

// ---- "Since you were last here" (issue #253): the range lives in the URL (?since=), Mark as read is a same-origin form POST.
function sincePanel(view, query) {
  const sv = view.since, now = view.generatedAt;
  const range = Object.hasOwn(SINCE_RANGES, query.get('since')) ? query.get('since') : DEFAULT_SINCE, r = sv.ranges[range];
  const picker = `<div class="ranges" role="group" aria-label="Summary range">${Object.entries(SINCE_RANGES).map(([k, label]) => `<a href="${esc(withQuery('/', query, { since: k === DEFAULT_SINCE ? null : k }))}"${k === range ? ' aria-current="true"' : ''}>${esc(label)}</a>`).join('')}</div>`;
  const when = sv.lastSeen === null ? 'never marked as read' : lt(sv.lastSeen);
  const total = SECTIONS.slice(0, 5).reduce((n, [k]) => n + r[k].length, 0);
  const item = i => `<li>${i.url ? `<a href="${esc(i.url)}">${esc(i.text)}</a>` : esc(i.text)}${Number.isFinite(i.at) ? ` <span class="muted">${esc(ago(i.at, now))}</span>` : ''}</li>`;
  const sections = SECTIONS.map(([k, label]) => `<div class="since-sec"><h3>${esc(label)} <span class="muted">(${r[k].length})</span></h3>${r[k].length ? `<ul class="since-list">${r[k].slice(0, 30).map(item).join('')}${r[k].length > 30 ? `<li class="muted">and ${r[k].length - 30} more</li>` : ''}</ul>` : '<p class="muted">None</p>'}</div>`).join('');
  const body = `<div class="since-head"><span>Last marked as read: ${when}. Showing ${esc(r.label.toLowerCase())}, from ${lt(r.from)}${r.fallback ? ' (you have not marked anything as read yet, so this is the last 24 h)' : ''}.</span>${copyBtn(r.text, 'the summary', { label: 'Copy summary' })}<form method="post" action="/mark-read" class="since-mark"><input type="hidden" name="at" value="${esc(now)}"><button class="btn" type="submit">Mark as read</button></form></div>
<p class="since-tokens">Tokens used: <b>${r.tokens === null ? 'unknown' : esc(num(r.tokens))}</b> <span class="muted">across ${r.tokenJobs} job${r.tokenJobs === 1 ? '' : 's'}</span></p>${total || r.needsYou.length ? '' : '<p class="muted">Nothing has happened in this range.</p>'}<div class="since-grid">${sections}</div>`;
  return card({ id: 'since', title: 'Since you were last here', span: 12, tools: picker, body, cls: 'panel since', type: 'panel' });
}

// ---- pages
const agentCols = view => ({ agent: { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) } });
function overview(view, query) {
  const range = Object.hasOwn(RANGES, query.get('range')) ? query.get('range') : DEFAULT_RANGE;
  const now = view.generatedAt;
  const open = view.prs.filter(p => ['open', 'draft'].includes(p.status)), active = view.agents.reduce((n, a) => n + (a.jobs || []).filter(j => !j.paused).length, 0), available = view.agents.filter(a => a.state === 'idle').length;
  const tokens = Object.values(view.usage).reduce((s, u) => s + u.totalTokens, 0);
  const daily = Object.values(view.graphs.jobsPerDay).map(d => Object.values(d).reduce((a, b) => a + b, 0));
  const verdicts = view.verdicts;
  const warnCount = view.panels.warnings.length + (view.agents.some(a => a.state === 'unknown') ? 1 : 0);
  const panels = [
    card({ id: 'now', title: 'Now', span: 3, body: nowPanel(view), href: '/agents', cls: 'panel', type: 'panel' }),
    card({ id: 'next', title: 'Next', span: 3, body: nextPanel(view), href: '/work', cls: 'panel', type: 'panel' }),
    card({ id: 'needs', title: `Needs you${view.panels.needsYou.length ? ` (${view.panels.needsYou.length})` : ''}`, span: 3, body: needsPanel(view), href: '/work', cls: 'panel', type: 'panel' }),
    card({ id: 'later', title: `Later${(view.panels.later || []).length ? ` (${view.panels.later.length})` : ''}`, span: 3, body: laterPanel(view), href: '/work', cls: 'panel', type: 'panel' }),
    card({ id: 'warnings', title: `Warnings${warnCount ? ` (${warnCount})` : ''}`, span: 3, body: warningsPanel(view), href: '/system', cls: 'panel', type: 'panel' })
  ].join('');
  const kpis = [
    kpi({ id: 'k-active', label: 'Jobs running', value: view.agents.some(a => a.state === 'unknown') ? `? / ${view.capacity ?? view.agents.length}` : `${active} / ${view.capacity ?? view.agents.length}`, href: '/agents' }),
    kpi({ id: 'k-avail', label: 'Agents available', value: view.agents.some(a => a.state === 'unknown') ? '?' : `${available} / ${view.agents.length}`, href: '/agents' }),
    kpi({ id: 'k-prs', label: 'Open pull requests', value: String(open.length), href: '/work', spark: sparkline(daily) }),
    kpi({ id: 'k-queue', label: 'Queued items', value: String(Object.values(view.queues).reduce((s, q) => s + q.length, 0)), href: '/work' }),
    kpi({ id: 'k-reviews', label: 'Reviews recorded', value: String(verdicts.length), href: '/reviews' }),
    kpi({ id: 'k-tokens', label: 'Tokens recorded', value: tokens ? num(tokens) : 'unknown', href: '/usage' }),
    kpi({ id: 'k-fresh', label: 'Data age', value: view.freshness.ageMs === null ? 'none' : dur(view.freshness.ageMs), href: '/system' })
  ].join('');
  const charts = [
    card({ id: 'c-allow', title: `Allowance used (${range})`, span: 6, href: '/usage', expandable: true, tools: rangeSelector('/', query, range), body: lineChart({ series: allowanceSeries(view, range), resets: allResets(view, range), expected: allExpected(view), now, range, title: 'allowance used over time' }), cls: 'chart-card', type: 'chart' }),
    card({ id: 'c-jobs', title: `Jobs per day (${range})`, span: 6, href: '/activity', expandable: true, body: stackedChart({ days: view.graphs.jobsPerDay, title: 'jobs per day', range, now }), cls: 'chart-card', type: 'chart' })
  ].join('');
  return { title: 'Overview', body: `<div class="toolrow"><button class="btn" type="button" data-reset-layout>Reset layout</button></div>${grid('overview', sincePanel(view, query) + panels + kpis + charts)}`, bodyClass: 'overview' };
}

function agentsPage(view, query, path) {
  const cards = view.agents.map(a => {
    const q = view.queues[a.name] || [];
    return card({ id: `a-${a.name}`, title: a.name, span: 6, href: `/agents/${encodeURIComponent(a.name)}`, movable: true, body: `<p>${stateBadge(a.state)} <span class="sub">${esc(a.provider)} · last activity ${esc(ago(a.lastActivityAt, view.generatedAt))}</span></p>${nowPanel({ ...view, agents: [a] })}${budgetBlock(view, a.name)}<p class="sub">${q.length} queued · <a href="/agents/${encodeURIComponent(a.name)}">Job history and queue</a></p>` });
  }).join('');
  return { title: 'Agents', body: grid('agents', cards) };
}
function jobCols(view, { agent = true } = {}) {
  return [
    { key: 'id', label: 'Job', html: r => jobIdCell(r.fullId) + (r.hasTranscript ? ` <a href="/jobs/${esc(r.fullId)}">${r.status === 'running' ? 'watch' : 'transcript'}</a>` : '') },
    ...(agent ? [{ key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) }] : []),
    { key: 'desc', label: 'What happened', html: r => trunc(r.desc) },
    { key: 'kind', label: 'Kind' }, { key: 'ref', label: 'Ref', num: true, html: r => (r.ref ? jobRef(r, view) : '–') },
    { key: 'status', label: 'Status', html: r => badge(({ completed: 'ok', running: 'ok', queued: 'info', paused_limit: 'warning', paused_manual: 'warning', blocked: 'action', failed: 'action' })[r.status] || 'info', r.status) },
    { key: 'model', label: 'Model', html: r => esc(r.model || 'default'), more: true }, { key: 'effort', label: 'Effort', html: r => esc(r.effort || 'default'), more: true },
    { key: 'reassignedFrom', label: 'Reassigned from', html: r => (r.reassignedFrom ? `<span title="${esc(r.reassignReason)}">${esc(r.reassignedFrom)}</span>` : '–'), more: true },
    { key: 'attempts', label: 'Attempts', num: true, more: true, totals: 'avg' }, { key: 'startedAt', label: 'Started', num: true, html: r => lt(r.startedAt), more: true },
    { key: 'elapsedMs', label: 'Elapsed', num: true, html: r => esc(dur(r.elapsedMs)), more: true },
    { key: 'tokens', label: 'Tokens', num: true, html: r => esc(num(r.tokens)), more: true, total: 'sum' }
  ];
}
const jobTotals = { id: 'count', attempts: 'avg', tokens: 'sum' };
function agentDetail(view, query, path, route) {
  const a = view.agents.find(x => x.name === route.id);
  if (!a) return null;
  const q = view.queues[a.name] || [], jobs = view.jobs.filter(j => j.agent === a.name);
  const queueRows = q.map(i => ({ ...i, next: i.next ? 'next' : '' }));
  const cur = a.job ? card({ id: 'cur', title: 'Current job', span: 12, movable: false, body: nowPanel({ ...view, agents: [a] }) }) : card({ id: 'cur', title: 'Current job', span: 12, movable: false, body: nowPanel({ ...view, agents: [a] }) });
  const queue = card({ id: 'queue', title: `Queue (${q.length})`, span: 12, movable: false, body: table({ id: 'q', path, query, noun: 'queue items', rows: queueRows, searchKeys: ['title', 'reason', 'type'],
    cols: [{ key: 'next', label: 'Next', html: r => (r.next ? badge('info', 'Next') : '') }, { key: 'type', label: 'Type' }, { key: 'ref', label: 'Item', num: true, html: r => (r.type === 'issue' ? issueLink(r.ref) : prLink(r.ref)) }, { key: 'est', label: 'Est. finish', html: r => { const e = r.type === 'review' ? null : estFor(view, r.type === 'issue' ? 'issue' : 'pr', r.ref); return e ? `<span title="${esc((e.basis || []).join('\n'))}" data-est="${esc(e.status)}">${esc(e.text)}</span>` : ''; } }, { key: 'reason', label: 'Reason', more: true }],
    totals: { next: 'count' }, emptyState: empty('Queue is empty', 'No work is waiting for this agent.', 'check') }) });
  const hist = card({ id: 'hist', title: `Job history (${jobs.length})`, span: 12, movable: false, body: table({ id: 'jobs', path, query, noun: 'jobs', rows: jobs, searchKeys: ['id', 'kind', 'status', 'branch', 'desc'], cols: jobCols(view, { agent: false }).map(c => ({ ...c, total: undefined })), totals: jobTotals,
    emptyState: empty('No jobs yet', 'This agent has not run a job.', 'list') }) });
  return { title: `Agent ${a.name}`, crumbs: [['/agents', 'Agents'], [null, a.name]], body: grid('agent', cur + queue + hist, 'fit') };
}

// One job, named by the shared formatter (issue #147): the page every job reference links to.
function jobDetail(view, query, path, route) {
  // The 8-character id in a link, or the full id. Older jobs beyond the table's newest 300 have a page too; two jobs sharing a prefix get a chooser.
  const all = [...(view.jobs || []), ...(view.olderJobs || [])];
  const hits = all.filter(x => x.fullId === route.id || (route.id.length >= 4 && String(x.fullId || x.id).startsWith(route.id)));
  const exact = hits.filter(x => x.fullId === route.id);
  if (!hits.length) return null;
  if (!exact.length && hits.length > 1) {
    const list = hits.map(x => `<li><a href="/work/job/${esc(encodeURIComponent(x.fullId))}">${esc(x.fullId)}</a> ${esc(x.kind)} ${esc(x.status)}</li>`).join('');
    return { title: `Job ${route.id}`, crumbs: [['/work', 'Work'], [null, `Job ${route.id}`]], body: grid('job', card({ id: 'facts', title: 'More than one job starts with this id', span: 12, movable: false, body: `<ul class="panel-list">${list}</ul>` }), 'fit') };
  }
  const j = exact[0] || hits[0];
  const ref = REFS.job[j.id];
  const subject = j.ref ? (['implement', 'continue'].includes(j.kind) ? issueLink(j.ref) : prLink(j.ref)) : '–';
  const facts = card({ id: 'facts', title: j.full || j.name, span: 12, movable: false, body: `<dl class="kv"><dt>Job</dt><dd>${idCopy(j.id, j.fullId, 'job ID')}</dd><dt>Agent</dt><dd>${agentTag(j.agent, view)}</dd><dt>Type</dt><dd>${esc(j.kind)}</dd><dt>Work</dt><dd>${subject}</dd>
<dt>Status</dt><dd>${esc(j.status)}</dd><dt>Attempts</dt><dd>${Number(j.attempts)}</dd><dt>Model</dt><dd>${esc(j.model || 'default')}</dd><dt>Started</dt><dd>${lt(j.startedAt)}</dd><dt>Elapsed</dt><dd>${esc(dur(j.elapsedMs))}</dd><dt>Tokens</dt><dd>${esc(num(j.tokens))}</dd></dl>${j.overseer ? `<div class="acts">${overseerBtn(j.overseer)}</div>` : ''}` });
  return { title: ref ? ref.text : j.name, crumbs: [['/work', 'Work'], [null, ref ? ref.text : j.name]], body: grid('job', facts, 'fit') };
}
const showChip = (path, query, key, value, text) => (query.get(key) === value ? `<p class="chips"><span class="chip on">${esc(text)}</span> <a class="btn" href="${esc(withQuery(path, query, { [key]: null }))}">Show all</a></p>` : '');
function workPage(view, query, path) {
  const queues = Object.entries(view.queues).map(([name, items]) => card({ id: `wq-${name}`, title: `Queue: ${name}`, span: 6, movable: true, type: 'queue', body: items.length ? `<ul class="panel-list">${items.slice(0, 8).map(i => `<li class="sev-${i.next ? 'info' : 'ok'}"><div class="t">${i.next ? badge('info', 'Next') + ' ' : ''}${i.type === 'issue' ? issueLink(i.ref) : prLink(i.ref)}</div><div class="sub">${esc(i.reason)}</div>${i.type === 'review' ? '' : estHtml(estFor(view, i.type === 'issue' ? 'issue' : 'pr', i.ref), view.tz)}</li>`).join('')}</ul>${items.length > 8 ? `<p class="sub">+${items.length - 8} more on <a href="/agents/${encodeURIComponent(name)}">the agent page</a></p>` : ''}` : empty('Queue is empty', 'Nothing is waiting for this agent.', 'check') })).join('');
  const issues = card({ id: 'issues', title: 'Issues', span: 12, movable: false, body: showChip(path, query, 'issues.show', 'blocked', 'Showing only open issues blocked by dependencies') + table({ id: 'issues', path, query, noun: 'issues', rows: view.issues.filter(i => query.get('issues.show') !== 'blocked' || (i.state === 'OPEN' && i.blockedBy.length)).map(i => ({ ...i, blockers: i.blockedBy.length, need: i.needsHomeowner ? 'yes' : '' })), searchKeys: ['name', 'title', 'agent', 'number', 'state', 'reason'],
    cols: [{ key: 'number', label: 'Issue', num: true, html: r => issueLink(r.number) }, { key: 'state', label: 'State' }, { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) },
      { key: 'blockers', label: 'Blockers', num: true, html: r => (r.blockedBy.length ? r.blockedBy.map(issueLink).join(', ') : '–') }, { key: 'reason', label: 'Status', more: true }],
    totals: { number: 'count', blockers: 'sum' }, emptyState: empty('No issues cached', 'The first tick fills the cache.', 'list') }) });
  const prs = card({ id: 'prs', title: 'Pull requests', span: 12, movable: false, body: showChip(path, query, 'prs.show', 'awaiting-review', 'Showing only pull requests waiting for review') + table({ id: 'prs', path, query, noun: 'pull requests', rows: view.prs.filter(p => query.get('prs.show') !== 'awaiting-review' || p.awaitingReview), searchKeys: ['name', 'title', 'agent', 'status', 'number', 'verdict'],
    cols: [{ key: 'number', label: 'Pull request', num: true, html: r => prLink(r.number) }, { key: 'agent', label: 'Author', html: r => agentTag(r.agent, view) }, { key: 'status', label: 'State' },
      { key: 'checks', label: 'CI', html: r => checksBadge(r.checks) }, { key: 'verdict', label: 'Verdict', html: r => verdictBadge(r.verdict) }, { key: 'reviewRounds', label: 'Review rounds', num: true, more: true },
      { key: 'fixRounds', label: 'Fix rounds', num: true, more: true }, { key: 'rebaseRounds', label: 'Rebase rounds', num: true, more: true }, { key: 'tokens', label: 'Tokens', num: true, html: r => esc(num(r.tokens)), more: true }],
    totals: { number: 'count', reviewRounds: 'avg', fixRounds: 'avg', tokens: 'sum' }, emptyState: empty('No pull requests yet', 'Pull requests appear once an agent opens one.', 'list') }) });
  const ex = view.excluded || [];
  const excluded = card({ id: 'excluded', title: `Excluded issues (${ex.length})`, span: 12, movable: false, body: ex.length ? `<ul class="panel-list">${ex.map(e => `<li class="sev-${e.kind === 'pr-closed' ? 'action' : 'info'}"><div class="t">${issueLink(e.number)}</div><div class="sub">${esc(e.reason)}</div></li>`).join('')}</ul>` : empty('Nothing is excluded', 'Every open issue is eligible.', 'check') });
  return { title: 'Work', body: `${grid('work', queues, 'fit')}<div class="cards fit">${issues}${excluded}${prs}</div>` };
}
function prDetail(view, query, path, route) {
  const p = view.prs.find(x => x.number === route.id);
  if (!p) return null;
  const facts = card({ id: 'facts', title: p.full || p.name, span: 12, movable: false, body: `<dl class="kv"><dt>State</dt><dd>${esc(p.status)}</dd><dt>Author</dt><dd>${agentTag(p.agent, view)}</dd><dt>CI</dt><dd>${checksBadge(p.checks)}</dd><dt>Latest verdict</dt><dd>${verdictBadge(p.verdict)}</dd>${p.carry ? `<dt>Carried verdict</dt><dd>${esc(`${String(p.carry.oldHead).slice(0, 7)} → ${String(p.carry.newHead).slice(0, 7)}`)}${p.carry.valid ? '' : ' (record does not match this head)'}<br>${esc(`no conflict resolved: ${p.carry.evidence.resolvedConflicts === false ? 'yes' : 'not shown'}; patch unchanged: ${p.carry.evidence.patchUnchanged === true ? 'yes' : 'not shown'}; CI: ${p.carry.evidence.ci || 'unknown'}`)}</dd>` : ''}
<dt>Rounds</dt><dd>${p.reviewRounds} review · ${p.fixRounds} fix · ${p.rebaseRounds} rebase</dd><dt>Tokens</dt><dd>${esc(num(p.tokens))}</dd><dt>On GitHub</dt><dd>${ext(p.url, p.name || `PR #${p.number}`)}</dd></dl>` });
  const tl = card({ id: 'tl', title: 'Timeline', span: 6, movable: false, body: p.timeline.length ? `<ol class="tl">${p.timeline.map(r => `<li><b>${lt(r.at)}</b><br>${esc(r.text)}</li>`).join('')}</ol>` : empty('No events recorded', 'Review, fix and merge events appear here.', 'clock') });
  const vh = card({ id: 'vh', title: 'Verdict history', span: 6, movable: false, body: p.verdicts.length ? p.verdicts.map(v => `<h3>${verdictBadge(v.verdict)} ${esc(v.reviewer)}${v.model ? ` <span class="sub">(${esc(v.model)})</span>` : ''} at ${v.fullHead ? shaCopy(v.fullHead) : `<span class="mono">${sha7(v.head)}</span>`} <span class="sub">${lt(v.at)}</span></h3>${v.findings.length ? `<ul>${v.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="sub">No findings recorded.</p>'}${v.followUpIssue ? `<p class="sub">Follow-up: ${issueLink(v.followUpIssue)}</p>` : ''}`).join('') : empty('No verdicts yet', 'The opposite agent has not reviewed this pull request.', 'review') });
  const jobs = card({ id: 'pj', title: 'Jobs on this PR', span: 12, movable: false, body: table({ id: 'jobs', path, query, noun: 'jobs', rows: p.jobs, searchKeys: ['id', 'kind', 'status', 'agent'], cols: jobCols(view).map(c => ({ ...c, total: undefined })), totals: jobTotals, emptyState: empty('No jobs recorded', 'Jobs that reviewed or fixed this PR show here.', 'list') }) });
  return { title: p.name || `PR #${p.number}`, crumbs: [['/work', 'Work'], [null, p.name || `PR #${p.number}`]], body: grid('pr', facts + tl + vh + jobs, 'fit') };
}
function issueDetail(view, query, path, route) {
  const i = view.issues.find(x => x.number === route.id);
  if (!i) return null;
  const dependents = view.issues.filter(o => o.dependsOn.includes(i.number));
  const deps = i.dependsOn.length ? `<ul class="panel-list">${i.dependsOn.map(d => { const di = view.issues.find(x => x.number === d); const blocked = i.blockedBy.includes(d); return `<li class="sev-${blocked ? 'warning' : 'ok'}"><div class="t">${blocked ? badge('warning', 'Blocking') : badge('ok', 'Done')} ${issueLink(d)}</div></li>`; }).join('')}</ul>` : empty('No prerequisites', 'This issue does not wait on another one.', 'check');
  const facts = card({ id: 'facts', title: i.name || `#${i.number}`, span: 12, movable: false, body: `<dl class="kv"><dt>State</dt><dd>${esc(i.state)}</dd><dt>Assigned to</dt><dd>${agentTag(i.agent, view)}</dd><dt>Status</dt><dd>${esc(i.reason || '–')}</dd>
<dt>Needs homeowner</dt><dd>${i.needsHomeowner ? badge('action', 'Yes') : 'No'}</dd><dt>On GitHub</dt><dd>${ext(i.url, i.name || `#${i.number}`)}</dd></dl>` });
  return { title: i.name || `#${i.number}`, crumbs: [['/work', 'Work'], [null, i.name || `#${i.number}`]], body: grid('issue', facts + card({ id: 'deps', title: 'Dependencies and blockers', span: 6, movable: false, body: deps })
    + card({ id: 'dependents', title: 'Waiting on this issue', span: 6, movable: false, body: dependents.length ? `<ul class="panel-list">${dependents.map(d => `<li class="sev-info"><div class="t">${issueLink(d.number)}</div></li>`).join('')}</ul>` : empty('Nothing waits on it', 'No cached issue lists this one as a prerequisite.', 'check') }), 'fit') };
}

// Issue #362: the whole retained history, from the first job. Read from files only (no GitHub, no model); every field was allowlisted
// and redacted when it was archived, and the text shown is rebuilt from those fields. Filters are plain GET parameters.
const KIND_LABEL = { job: 'Job', verdict: 'Review', merge: 'Merge', rebase: 'Rebase', unblock: 'Unblock', migration: 'Migration' };
const SOURCE_LABEL = { live: 'recorded live', 'job-record': 'from the job record', github: 'backfilled from GitHub' };
const mib = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${Math.max(0, Math.round(n / 1024))} KiB`);
function storageCard(view) {
  const h = view.history, st = h?.storage; if (!st) return '';
  const warn = st.warnings.length ? `<ul class="panel-list">${st.warnings.map(w => `<li class="sev-warning"><div class="t">${esc(w)}</div></li>`).join('')}</ul>` : '';
  return card({ id: 'hist-storage', title: 'History storage', span: 12, movable: false, body: `${warn}<dl class="kv"><dt>Used</dt><dd>${esc(mib(st.used))} (archive ${esc(mib(st.parts.archive))}, recent ticks ${esc(mib(st.parts.snapshots))}, events ${esc(mib(st.parts.events))}, job records ${esc(mib(st.parts.jobs))})</dd><dt>Growth</dt><dd>${st.perDay === null ? 'unknown (no history yet)' : `about ${esc(mib(st.perDay))} per day`}</dd><dt>Free on the volume</dt><dd>${st.free === null ? 'unknown' : `${esc(mib(st.free))}${st.daysLeft !== null ? `, about ${st.daysLeft} days at this rate` : ''}`}</dd></dl><p class="sub">Foreman never deletes history by itself.</p>` });
}
function timelinePage(view, query, path) {
  const h = view.history; const crumbs = [['/activity', 'Activity'], [null, 'Timeline']];
  if (!h) return { title: 'Activity timeline', crumbs, body: grid('activity', card({ id: 'tl', title: 'Activity timeline', span: 12, movable: false, body: empty('History is not loaded', 'The timeline could not be read.', 'pulse') })) };
  const f = Object.fromEntries(['kind', 'agent', 'ref', 'from', 'to', 'source'].map(k => [k, (query.get(k) || '').slice(0, 40)]));
  const shown = filterTimeline(h.timeline, f);
  const rows = shown.map(e => { const l = entryLink(e, view.repository); return { at: e.at, kind: KIND_LABEL[e.kind] || e.kind, agent: e.agent || '', text: entryText(e), link: l, source: SOURCE_LABEL[e.source] || e.source }; });
  const agents = [...new Set(h.timeline.map(e => e.agent).filter(Boolean))].sort();
  const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const form = `<form class="tbl-bar" method="get" action="${esc(path)}" aria-label="Timeline filters"><label>Type <select name="kind">${opt('', f.kind, 'All')}${Object.entries(KIND_LABEL).map(([k, v]) => opt(k, f.kind, v)).join('')}</select></label> <label>Agent <select name="agent">${opt('', f.agent, 'All')}${agents.map(a => opt(a, f.agent, a)).join('')}</select></label> <label>Issue or PR <input name="ref" value="${esc(f.ref)}" size="6" inputmode="numeric"></label> <label>From <input type="date" name="from" value="${esc(f.from)}"></label> <label>To <input type="date" name="to" value="${esc(f.to)}"></label> <button type="submit" class="btn">Filter</button> <a class="btn" href="${esc(path)}">Clear</a></form>`;
  const first = h.timeline[0]?.at;
  const gaps = h.gaps || [];
  const gapBody = gaps.length ? `<p class="sub">Foreman shows only what it stored; these periods have no stored tick-level data and are not filled in.</p><ul class="panel-list">${gaps.slice(-50).reverse().map(g => `<li class="sev-info"><div class="t">${lt(g.from)} to ${lt(g.to)}: ${esc(g.reason)}</div></li>`).join('')}</ul>${gaps.length > 50 ? `<p class="sub">${gaps.length - 50} older gaps not listed.</p>` : ''}` : empty('No known gaps', 'Every period since the first record has tick data.', 'check');
  const tbl = table({ id: 'tl', path, query, noun: 'events', rows, searchKeys: ['text'],
    cols: [{ key: 'at', label: 'When', num: true, html: r => lt(r.at) }, { key: 'kind', label: 'Type', html: r => esc(r.kind) }, { key: 'agent', label: 'Agent', html: r => esc(r.agent || '–') }, { key: 'text', label: 'What', html: r => trunc(r.text) }, { key: 'source', label: 'Source', html: r => esc(r.source) }, { key: 'link', label: 'On GitHub', sortable: false, html: r => (r.link ? ext(r.link.url, r.link.text) : '') }],
    totals: { text: 'count' }, emptyState: empty('No activity matches', 'Nothing in the retained history matches these filters.', 'pulse') });
  return { title: 'Activity timeline', crumbs, body: grid('activity', storageCard(view) + card({ id: 'tl-gaps', title: `Known gaps (${gaps.length})`, span: 12, movable: false, body: gapBody })
    + card({ id: 'tl', title: `Activity timeline${first ? ` since ${utc(first)}` : ''} (${shown.length} of ${h.timeline.length})`, span: 12, movable: false, body: form + tbl })) };
}
// Issue #76: idle ticks collapse into one row (expand with act.open=<time>, no script needed); filter chips by agent, outcome and job
// kind combine and live in the URL (act.agent, act.outcome, act.kind). Collapsing happens before filtering, so a busy tick that a
// filter hides still separates two idle runs.
function activityChips(view, rows, query, path) {
  const groups = [['agent', 'Agent', r => r.agent], ['outcome', 'Outcome', r => r.outcome], ['kind', 'Job kind', r => r.jobKind]];
  return `<div class="chipbar" role="group" aria-label="Activity filters">${groups.map(([key, label, get]) => {
    const values = [...new Set(rows.map(get).filter(Boolean))].sort(), on = query.get(`act.${key}`);
    if (on && !values.includes(on)) values.push(on);
    return `<div class="chipgroup"><span class="k">${label}</span> ${values.map(v => `<a class="chip${on === v ? ' on' : ''}" href="${esc(withQuery(path, query, { [`act.${key}`]: on === v ? null : v, 'act.page': null, 'act.open': null }))}" aria-pressed="${on === v}">${esc(v)}</a>`).join(' ')}</div>`;
  }).join('')}${ACTIVITY_FILTERS.some(k => query.get(`act.${k}`)) ? `<a class="btn" href="${esc(withQuery(path, query, { 'act.agent': null, 'act.outcome': null, 'act.kind': null, 'act.page': null }))}">Clear filters</a>` : ''}</div>`;
}
function activityPage(view, query, path) {
  const grouped = query.get('group') === 'issue';
  const toggle = `<p class="sub"><a href="/activity/timeline">Full activity timeline since the first job</a> · View: ${grouped ? `<a href="${esc(withQuery(path, query, { group: null }))}">Timeline</a> · <b>Group by issue</b>` : `<b>Timeline</b> · <a href="${esc(withQuery(path, query, { group: 'issue' }))}">Group by issue</a>`}</p>`;
  if (grouped) {
    const tls = view.issueTimelines || [];
    const body = tls.length ? tls.map(t => `<section class="issue-story"><h3>${named(`/work/issue/${t.number}`, { text: t.name, full: t.full }, `#${t.number}`)}</h3><ol class="tl">${t.events.map(e => `<li><b>${lt(e.at)}</b><br>${trunc(e.text)}${e.link ? ` <a href="${esc(e.link.url)}">job page</a>` : ''}</li>`).join('')}</ol></section>`).join('') : empty('No activity yet', 'Issue timelines appear after the first job.', 'pulse');
    return { title: 'Activity by issue', crumbs: [['/activity', 'Activity'], [null, 'By issue']], body: grid('activity', card({ id: 'act', title: `Issues (${tls.length})`, span: 12, movable: false, body: toggle + body })) };
  }
  const collapsed = collapseIdle(view.activity.map(r => ({ ...r })));
  const open = Number(query.get('act.open'));
  const rows = filterActivity(collapsed, activityFilters(query)).flatMap(r => (r.kind === 'idle-run' && r.at === open ? [r, ...r.ticks.map(t => ({ ...t, child: true }))] : [r]));
  const what = r => {
    if (r.kind !== 'idle-run') return `${r.child ? '<span class="muted">↳</span> ' : ''}${esc(r.text)}`;
    const o = r.at === open;
    return `${r.count} idle ticks, ${lt(r.from)} to ${lt(r.to)} <a class="btn" href="${esc(withQuery(path, query, { 'act.open': o ? null : r.at }))}" aria-expanded="${o}">${o ? 'Hide' : 'Show'}</a>`;
  };
  const cols = [{ key: 'at', label: 'When', num: true, html: r => lt(r.at) }, { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) },
    { key: 'jobKind', label: 'Job kind', html: r => esc(r.jobKind || '–') }, { key: 'outcome', label: 'Outcome', html: r => esc(r.outcome || '–') },
    { key: 'durationMs', label: 'Duration', num: true, html: r => esc(Number.isFinite(r.durationMs) ? dur(r.durationMs) : '–') },
    { key: 'tokens', label: 'Tokens', num: true, html: r => esc(Number.isFinite(r.tokens) ? num(r.tokens) : '–') },
    { key: 'text', label: 'What', html: what }, { key: 'link', label: 'Link', sortable: false, html: r => (r.link ? ext(r.link.url, r.link.text) : '') + (r.transcript ? ` <a href="/jobs/${esc(r.transcript)}">transcript</a>` : '') }];
  const body = toggle + activityChips(view, collapsed, query, path) + table({ id: 'act', path, query, noun: 'events', rows, searchKeys: ['text', 'agent', 'outcome', 'jobKind'], cols, totals: { text: 'count', tokens: 'sum' }, emptyState: empty('No activity yet', 'Events appear after the first tick.', 'pulse') });
  return { title: 'Activity', body: grid('activity', card({ id: 'act', title: `Recent activity (${rows.filter(r => !r.child).length} rows from ${view.activity.length} events)`, span: 12, movable: false, body })) };
}
// One agent's allowance card (issue #75): the last known reading with its age; an expired window (reset time passed) is
// marked and never shown as current; a limit pause says when it resets and on what basis.
const SOURCE = { job: 'reported to a supervised job', probe: 'refreshed by a minimal probe run (no repository, no tools)', 'session-log': 'read from the local Codex session log (no model call)' };
function allowanceBody(u, now, name = '') {
  const l = u.limit;
  const refresh = u.canProbe && name ? `<form method="post" action="/probe/${encodeURIComponent(name)}" class="probe-form"><button type="submit" class="tbtn" title="Run one minimal probe to read the current allowance (no repository, no tools)">Refresh allowance</button></form>` : '';
  const limit = l ? `<p class="limit">${badge('action', 'Paused on a usage limit')} ${l.limiting ? `${esc(l.limiting)}. ` : ''}${l.resetsAt ? `resets <b>${lt(l.resetsAt)}</b> (${esc(inFuture(l.resetsAt, now))}; ${esc(l.basis)})` : 'reset time not reported by the provider'}${l.retryAt ? `. The supervisor retries ${esc(inFuture(l.retryAt, now))}.` : '.'}</p>` : '';
  if (!u.windows.length) return `${limit}<p>Allowance: <b>unknown</b></p>${refresh}${empty('No allowance reported', 'The provider has never reported a limit window to the supervisor.', 'info')}`;
  const used = w => (Number.isFinite(w.utilization) ? `<div class="bar${w.expired ? ' expired' : ''}" role="img" aria-label="${pct(w.utilization)} used${w.expired ? ', expired' : ''}"><b style="width:${Math.min(100, w.utilization * 100)}%"></b></div> ${pct(w.utilization)}${w.expired ? ' <span class="muted">(expired)</span>' : ''}` : 'unknown');
  const resets = w => (!w.resetsAt ? 'unknown' : w.expired ? `reset ${esc(dur(now - w.resetsAt))} ago; current use unknown` : esc(inFuture(w.resetsAt, now)));
  const rows = u.windows.map(w => `<tr${w.expired ? ' class="expired"' : ''}><td>${esc(w.label)}</td><td>${used(w)}</td><td>${resets(w)}</td></tr>`).join('');
  const note = u.allExpired ? `<p class="sub">${badge('warning', 'Expired')} Every window in this reading has reset since; current use is unknown until the provider reports again.</p>` : '';
  return `${limit}<table><thead><tr><th>Window</th><th>Used</th><th>Resets</th></tr></thead><tbody>${rows}</tbody></table>${note}<p class="sub">Last reading ${esc(ago(u.observedAt, now))} (${lt(u.observedAt)}), ${esc(SOURCE[u.source] || 'reported by the provider')}.</p>${refresh}`;
}
function usagePage(view, query, path) {
  const range = Object.hasOwn(RANGES, query.get('range')) ? query.get('range') : DEFAULT_RANGE, now = view.generatedAt;
  const win = Object.entries(view.usage).map(([name, u]) => card({ id: `u-${name}`, title: `Allowance: ${name}`, span: 6, movable: true, body: budgetBlock(view, name) + allowanceBody(u, now, name) })).join('');
  const chart = card({ id: 'u-chart', title: `Allowance used over time (${range})`, span: 12, expandable: true, tools: rangeSelector(path, query, range), movable: true, body: lineChart({ series: allowanceSeries(view, range), resets: allResets(view, range), expected: allExpected(view), now, range, title: 'allowance used over time' }) });
  const toks = view.graphs.tokensPerPr.slice(-12).map(m => ({ label: `PR #${m.pr}${m.agent ? ' ' + m.agent : ''}`, value: m.tokens, series: m.agent || 'unknown', colour: colourOf(m.agent) }));
  const tokChart = card({ id: 'u-tok', title: 'Tokens per merged PR', span: 12, expandable: true, movable: true, body: barChart({ rows: toks, title: 'tokens per merged PR', emptyTitle: 'No merged PR has recorded tokens' }) });
  const usd = n => (Number.isFinite(n) ? `$${(Math.round(n * 100) / 100).toFixed(2)}` : '–');
  const ucols = [jobCols(view)[0], jobCols(view)[1], jobCols(view)[2], jobCols(view)[3], jobCols(view)[4],
    { key: 'inTokens', label: 'Input tokens', num: true, html: r => esc(num(r.inTokens)) }, { key: 'outTokens', label: 'Output tokens', num: true, html: r => esc(num(r.outTokens)) },
    { key: 'cost', label: 'CLI cost estimate*', num: true, html: r => esc(usd(r.cost)), fmt: usd, more: true }];
  const table_ = card({ id: 'u-jobs', title: 'Tokens per job', span: 12, movable: false, body: table({ id: 'jobs', path, query, noun: 'jobs', rows: view.jobs, searchKeys: ['id', 'agent', 'kind', 'status'], totals: { id: 'count', inTokens: 'sum', outTokens: 'sum', cost: 'sum' }, cols: ucols,
    emptyState: empty('No jobs recorded', 'Token counts appear after a job finishes.', 'chart') }) + '<p class="sub">*Token counts and the CLI cost estimate are what the CLI reported, not billing. Subscription use is not billed per token.</p>' });
  const mcols = [{ key: 'kind', label: 'Job type' }, { key: 'model', label: 'Model' }, { key: 'effort', label: 'Effort' }, { key: 'jobs', label: 'Jobs', num: true },
    { key: 'inTokens', label: 'Input tokens', num: true, html: r => esc(num(r.inTokens)) }, { key: 'outTokens', label: 'Output tokens', num: true, html: r => esc(num(r.outTokens)) },
    { key: 'cost', label: 'CLI cost estimate*', num: true, html: r => esc(usd(r.cost)), fmt: usd }];
  const byModel = card({ id: 'u-models', title: 'Tokens per job type and model', span: 12, movable: false, body: table({ id: 'models', path, query, noun: 'groups', rows: view.modelUsage || [], searchKeys: ['kind', 'model', 'effort'], totals: { jobs: 'sum', inTokens: 'sum', outTokens: 'sum', cost: 'sum' }, cols: mcols,
    emptyState: empty('No model usage recorded', 'Token counts appear per job type and model after jobs finish.', 'chart') }) });
  const fs_ = view.failedSpend || { jobs: 0, rows: [] };
  const fcols = [{ key: 'name', label: 'Job' }, { key: 'status', label: 'Status' }, { key: 'attempts', label: 'Attempts', num: true },
    { key: 'tokens', label: 'Tokens', num: true, html: x => esc(num(x.tokens)) }, { key: 'cost', label: 'CLI cost estimate*', num: true, html: x => esc(usd(x.cost)), fmt: usd }];
  const failed = card({ id: 'u-failed', title: `Failed attempts: ${fs_.jobs} job${fs_.jobs === 1 ? '' : 's'}, ${fs_.tokens == null ? 'unknown' : num(fs_.tokens)} tokens, ${usd(fs_.cost)}`, span: 12, movable: false, body: table({ id: 'failed', path, query, noun: 'failed jobs', rows: fs_.rows, searchKeys: ['name', 'kind', 'status'], totals: { attempts: 'sum', tokens: 'sum', cost: 'sum' }, cols: fcols,
    emptyState: empty('No failed attempts', 'Jobs that ended failed or blocked, with the tokens and cost they used, are listed here.', 'chart') }) });
  return { title: 'Usage & cost', body: `<div class="toolrow"><button class="btn" type="button" data-reset-layout>Reset layout</button></div>${grid('usage', win + chart + tokChart + byModel + failed + table_)}` };
}
function reviewsPage(view, query, path) {
  const range = Object.hasOwn(RANGES, query.get('range')) ? query.get('range') : DEFAULT_RANGE;
  const verdictRows = Object.entries(view.graphs.verdicts).flatMap(([a, v]) => [{ label: `${a} PASS`, value: v.PASS, series: `${a} PASS`, colour: 'var(--s3)' }, { label: `${a} CHANGES`, value: v.CHANGES, series: `${a} CHANGES`, colour: 'var(--claude)' }]);
  const merges = view.graphs.merges.slice(-12).map(m => ({ label: `PR #${m.pr}${m.agent ? ' ' + m.agent : ''}`, value: m.hours, text: Number.isFinite(m.hours) ? `${dec1(m.hours)} h` : null, series: m.agent || 'unknown', colour: colourOf(m.agent) }));
  const v = card({ id: 'r-v', title: 'Verdicts per agent', span: 6, expandable: true, body: barChart({ rows: verdictRows, title: 'review verdicts', emptyTitle: 'No verdicts recorded' }) });
  const m = card({ id: 'r-m', title: 'Issue start to merge (hours)', span: 6, expandable: true, body: barChart({ rows: merges, title: 'time from issue start to merge', emptyTitle: 'No merges recorded' }) });
  const rows = view.verdicts.map(r => ({ ...r, findingCount: r.findings.length }));
  const t = card({ id: 'r-t', title: 'Verdict history', span: 12, movable: false, body: table({ id: 'rev', path, query, noun: 'verdicts', rows, searchKeys: ['pr', 'reviewer', 'verdict', 'head'], totals: { pr: 'count', findingCount: 'avg' },
    cols: [{ key: 'pr', label: 'PR', num: true, html: r => prLink(r.pr) }, { key: 'reviewer', label: 'Reviewer', html: r => agentTag(r.reviewer, view) }, { key: 'model', label: 'Model', html: r => (r.model ? esc(r.model) : '<span class="muted">unknown</span>') }, { key: 'verdict', label: 'Verdict', html: r => verdictBadge(r.verdict) }, { key: 'head', label: 'Head', html: r => (r.fullHead ? shaCopy(r.fullHead) : `<span class="mono">${sha7(r.head)}</span>`), more: true },
      { key: 'findingCount', label: 'Findings', num: true }, { key: 'at', label: 'When', num: true, html: r => lt(r.at), more: true }], emptyState: empty('No reviews yet', 'Verdicts appear after the first review.', 'review') }) });
  return { title: 'Reviews', body: grid('reviews', v + m + t) };
}
function systemPage(view) {
  const t = view.tick, v = view.version, now = view.generatedAt;
  const facts = card({ id: 'sys', title: 'Dispatcher', span: 6, movable: false, body: `<dl class="kv"><dt>Repository</dt><dd>${esc(view.repository)}</dd><dt>Team loop</dt><dd>${view.teamEnabled ? badge('ok', 'Enabled') : badge('info', 'Disabled')}</dd>
<dt>Health</dt><dd>${badge(view.health.severity, view.health.label)}</dd><dt>Last tick</dt><dd>${t ? `${badge(t.status === 'ok' ? 'ok' : 'action', t.status)} ${lt(t.at)} (${esc(ago(t.at, now))})` : badge('action', 'none recorded')}</dd>
<dt>Last good tick</dt><dd>${t?.lastOkAt ? esc(ago(t.lastOkAt, now)) : 'never'}</dd>${t?.error ? `<dt>Error</dt><dd>${errCopy(t.error)}</dd>` : ''}<dt>Next tick</dt><dd>${view.nextTickAt ? `<b data-countdown="${view.nextTickAt}">${esc(inFuture(view.nextTickAt, now))}</b>` : 'none'}</dd>
<dt>Data freshness</dt><dd>${badge(view.freshness.level, view.freshness.label)} GitHub data cached ${esc(ago(view.cacheFetchedAt, now))}</dd><dt>Page built</dt><dd>${lt(now)}</dd></dl>` });
  const ver = card({ id: 'ver', title: 'Version', span: 6, movable: false, body: v ? `<dl class="kv"><dt>Installed</dt><dd>${shaCopy(v.installed)}</dd><dt>Main</dt><dd>${shaCopy(v.main)}</dd><dt>State</dt><dd>${(vs => badge(vs.level, escT(vs.label), '', true))(versionStatus(v))}</dd><dt>Last upgrade result</dt><dd>${esc(v.result)}</dd></dl><p class="sub"><a href="/supervisor">Supervisor health</a> · <a href="/supervisor/upgrades">Upgrade history</a></p>` : empty('No version record', 'The self-upgrade step has not recorded anything yet.', 'info') });
  const all = card({ id: 'all', title: 'All attention items', span: 12, movable: false, body: view.attention.length ? `<ul class="panel-list">${view.attention.map(a => `<li class="sev-${esc(a.severity)}" id="att-${esc(a.id)}"><div class="t">${badge(a.severity)} ${escT(a.text)} ${refOf(a.ref)}</div></li>`).join('')}</ul>` : empty('All clear', 'Nothing needs attention.', 'check') });
  return { title: 'System', body: grid('system', facts + ver + all) };
}

// ---- Supervisor area (issue #72): health cards with drill-downs, tick history, upgrade history
const list = (items, cls = '') => (items.length ? `<ul class="mini ${cls}">${items.join('')}</ul>` : '<span class="muted">none</span>');
const tickRef = a => (a.type === 'implement' || a.type === 'continue' ? (a.issue ? issueLink(a.issue) : `#${Number(a.ref)}`) : a.pr ? prLink(a.pr) : `#${Number(a.ref)}`);
function tickDetail(t) {
  return `<dl class="kv"><dt>Verdicts ingested</dt><dd>${list(t.ingested.map(i => `<li>${verdictBadge(i.verdict)} ${i.pr ? prLink(i.pr) : ''} ${i.job ? jobIdCell(i.job) : ''}</li>`))}</dd>
<dt>Actions</dt><dd>${list(t.actions.map(a => `<li>${esc(a.agent)} ${esc(a.type === 'cifix' ? 'fix CI' : a.type)} ${tickRef(a)}</li>`))}</dd>
<dt>Skipped</dt><dd>${t.note ? `<span class="muted">${esc(t.note)}</span>` : list(t.skipped.map(s => `<li><b>${esc(s.what)}</b>: ${errCopy(s.reason)}</li>`))}</dd>
<dt>Self-upgrade</dt><dd>${esc(t.selfUpgrade || '–')}</dd><dt>Leases released</dt><dd>${t.released}</dd>${t.rc !== null ? `<dt>Exit code</dt><dd>rc=${Number(t.rc)}</dd>` : ''}
<dt>Warnings</dt><dd>${list((t.warnings || []).map(w => `<li>${errCopy(w)}</li>`), 'warns')}</dd>
<dt>Errors</dt><dd>${list(t.errors.map(e => `<li>${errCopy(e)}</li>`), 'errs')}</dd></dl><div class="acts">${copyBtn(tickLine(t), 'this log excerpt', { label: 'Copy log lines' })}</div>`;
}
const tickStatusBadge = s => badge(({ ok: 'ok', partial: 'warning', skipped: 'info', empty: 'warning', error: 'action' })[s] || 'info', ({ ok: 'OK', partial: 'Partial', skipped: 'Skipped', empty: 'No result', error: 'Error' })[s] || s);
function healthBody(c, view) {
  const now = view.generatedAt;
  const notes = c.notes.length ? `<ul class="mini notes">${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  let dl = '';
  if (c.id === 'version') {
    const u = c.lastUpgrade;
    dl = `<dt>Installed</dt><dd>${shaCopy(c.installed)}${c.installedAt ? ` <span class="sub">since ${lt(c.installedAt)}</span>` : ''}</dd><dt>origin/main</dt><dd>${shaCopy(c.origin)}</dd>
<dt>Upgrade step</dt><dd>${esc(c.step || 'not reported')}</dd>
<dt>Last install</dt><dd>${c.install ? `${badge(c.install.severity, c.install.result)}${c.install.sha ? ` ${shaCopy(c.install.sha)}` : ''}${c.install.at ? ` <span class="sub">${esc(ago(c.install.at, now))}</span>` : ''}${c.install.reason ? `<br>${errCopy(c.install.reason)}` : ''}` : '<span class="muted">no record</span>'}</dd>
<dt>Next attempt</dt><dd>${c.install?.nextAttemptAt ? lt(c.install.nextAttemptAt) : '<span class="muted">none scheduled</span>'}</dd>
<dt>Last upgrade</dt><dd>${u ? `${badge(resultSeverity(u.result), u.result)} ${shaCopy(u.from)} → ${shaCopy(u.to)} <span class="sub">${esc(ago(u.at, now))}</span>${u.reason ? `<br>${errCopy(u.reason)}` : ''}` : '<span class="muted">no record</span>'}</dd>
<dt>Pre-check latched</dt><dd>${list(c.prechecked.map(p => `<li>${shaCopy(p.sha)} since ${lt(p.at)}${p.isMain ? ` ${badge('warning', 'is origin/main')}` : ''}</li>`))}</dd>
${c.latch ? `<dt>Rollback latch</dt><dd>${badge('action', 'Set')} ${errCopy(c.latch.reason)}</dd>` : ''}${c.pending ? `<dt>Pending</dt><dd>${shaCopy(c.pending.to)} awaiting a live tick</dd>` : ''}`;
  } else if (c.id === 'tick') {
    const t = c.tick;
    dl = t ? `<dt>When</dt><dd>${lt(t.at)} <span class="sub">(${esc(ago(t.at, now))}${c.stale ? ', more than two intervals' : ''})</span></dd><dt>Status</dt><dd>${tickStatusBadge(t.status)}</dd>
<dt>Verdicts ingested</dt><dd>${t.ingested.length}</dd><dt>Actions</dt><dd>${list(t.actions.map(a => `<li>${esc(a.agent)} ${esc(a.type === 'cifix' ? 'fix CI' : a.type)} ${tickRef(a)}</li>`))}</dd>
<dt>Skipped</dt><dd>${t.note ? esc(t.note) : list(t.skipped.map(s => `<li><b>${esc(s.what)}</b>: ${errCopy(s.reason)}</li>`))}</dd>` : '';
  } else if (c.id === 'leases') {
    const odd = c.leases.filter(l => l.state !== 'active');
    dl = `<dt>Held</dt><dd>${c.leases.length} job(s)</dd><dt>Needs recovery</dt><dd>${odd.length ? list(odd.map(l => `<li>${badge(l.state === 'stale' ? 'action' : 'warning', l.state === 'stale' ? 'Stale' : 'Held')} job ${idCopy(l.job.slice(0, 8), l.job, 'job ID')} ${esc(l.reason)}${l.command ? cmdBlock(l.command) : ''}</li>`)) : '<span class="muted">none</span>'}</dd>`;
  } else if (c.id === 'errors') {
    dl = `<dt>Count</dt><dd>${c.count}</dd><dt>Since</dt><dd>${c.since ? lt(c.since) : 'the start of the log'}</dd>
<dt>Latest</dt><dd>${c.latest ? `<span class="sub">${lt(c.latest.at)}</span><br>${errCopy(c.latest.text)}` : '<span class="muted">none</span>'}</dd>`;
  } else if (c.id === 'drift') {
    dl = `<dt>Local main</dt><dd>${shaCopy(c.local)}</dd><dt>origin/main</dt><dd>${shaCopy(c.origin)}${c.fetchedAt ? ` <span class="sub">fetched ${esc(ago(c.fetchedAt, now))}</span>` : ''}</dd><dt>Checked out</dt><dd>${esc(c.head || 'unknown')}</dd>`;
  }
  return `<p class="hc-sum">${badge(c.severity)} <b>${esc(c.summary)}</b></p>${notes}${dl ? `<dl class="kv">${dl}</dl>` : ''}<div class="acts">${overseerBtn(c.overseer)}</div>`;
}
const DRILL = { version: '/supervisor/upgrades', tick: '/supervisor/ticks', leases: '/supervisor#h-leases-table', errors: '/supervisor/ticks?ticks.q=error' };
function supervisorPage(view, query, path) {
  const s = view.supervisor;
  const cards = s.cards.map(c => card({ id: `h-${c.id}`, title: c.title, span: c.id === 'version' || c.id === 'tick' ? 6 : 4, href: DRILL[c.id], cls: `health hc-${c.severity}`, body: healthBody(c, view) })).join('');
  const lc = s.cards.find(c => c.id === 'leases');
  const leases = card({ id: 'h-leases-table', title: `Leases (${lc.leases.length})`, span: 12, movable: false, body: table({ id: 'leases', path, query, noun: 'leases', rows: lc.leases, searchKeys: ['job', 'agent', 'kind', 'status', 'state', 'reason'],
    cols: [{ key: 'job', label: 'Job', html: r => jobIdCell(r.job) }, { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) }, { key: 'kind', label: 'Kind' }, { key: 'ref', label: 'Ref', num: true, html: r => (r.ref ? (['implement', 'continue'].includes(r.kind) ? issueLink(r.ref) : prLink(r.ref)) : '–') },
      { key: 'ageMs', label: 'Age', num: true, html: r => esc(dur(r.ageMs)) }, { key: 'state', label: 'State', html: r => badge(r.state === 'stale' ? 'action' : r.state === 'held' ? 'warning' : 'ok', r.state) }, { key: 'status', label: 'Job status', more: true },
      { key: 'reason', label: 'Why', more: true, html: r => `${esc(r.reason)}${r.command ? cmdBlock(r.command) : ''}` }],
    totals: { job: 'count' }, emptyState: empty('No lease held', 'Leases appear while a supervised job owns an issue or worktree.', 'check') }) });
  const recent = s.ticks.slice(-5).reverse();
  const ticks = card({ id: 'h-recent', title: 'Recent ticks', span: 12, movable: false, href: '/supervisor/ticks', body: recent.length ? `<ul class="panel-list">${recent.map(t => `<li class="sev-${({ ok: 'ok', partial: 'warning', error: 'action' })[t.status] || 'info'}"><div class="t">${tickStatusBadge(t.status)} ${lt(t.at)} <span class="sub">${esc(ago(t.at, view.generatedAt))}</span></div><div class="sub">${t.ingested.length} verdict(s), ${t.actions.length} action(s), ${t.skipped.length} skipped${t.errors.length ? `, ${t.errors.length} error(s)` : ''}${t.selfUpgrade ? `, self-upgrade ${esc(t.selfUpgrade)}` : ''}</div></li>`).join('')}</ul><p class="sub"><a href="/supervisor/ticks">Full tick history</a> · <a href="/supervisor/upgrades">Upgrade history</a></p>`
    : empty('No tick in the reconcile log', 'The reconcile cron writes one entry every five minutes.', 'clock') });
  return { title: 'Supervisor', body: `${grid('supervisor', cards)}<div class="cards stacked">${ticks}${leases}</div>` };
}
function ticksPage(view, query, path) {
  // A row expands through the URL (ticks.open=<time>), like the rest of the table state: bookmarkable, works without script,
  // and nothing hidden is laid out (a closed <details> is still measured by the layout audit).
  const open = Number(query.get('ticks.open'));
  const rows = view.supervisor.ticks.slice().reverse().map((t, i) => ({ ...t, n: i, nIngested: t.ingested.length, nActions: t.actions.length, nSkipped: t.skipped.length, nErrors: t.errors.length, flags: t.errors.length ? 'error' : '',
    text: [...t.actions.map(a => `${a.agent} ${a.type} ${a.ref}`), ...t.skipped.map(s => `${s.what} ${s.reason}`), ...t.errors, t.note || ''].join(' ') }));
  return { title: 'Tick history', crumbs: [['/supervisor', 'Supervisor'], [null, 'Tick history']], body: grid('ticks', card({ id: 't-all', title: `Ticks in the reconcile log (${rows.length})`, span: 12, movable: false, body: table({ id: 'ticks', path, query, noun: 'ticks', rows, searchKeys: ['status', 'selfUpgrade', 'flags', 'text'],
    cols: [{ key: 'at', label: 'When', num: true, html: r => lt(r.at) }, { key: 'status', label: 'Status', html: r => tickStatusBadge(r.status) }, { key: 'nIngested', label: 'Verdicts', num: true }, { key: 'nActions', label: 'Actions', num: true },
      { key: 'nSkipped', label: 'Skipped', num: true }, { key: 'nErrors', label: 'Errors', num: true }, { key: 'selfUpgrade', label: 'Self-upgrade', more: true },
      { key: 'detail', label: 'Detail', sortable: false, html: r => (r.at === open && Number.isFinite(r.at)
        ? `<a class="btn" href="${esc(withQuery(path, query, { 'ticks.open': null }))}" aria-expanded="true">Hide</a><div class="tick-detail" id="tick-${r.at}">${tickDetail(r)}</div>`
        : Number.isFinite(r.at) ? `<a class="btn" href="${esc(withQuery(path, query, { 'ticks.open': r.at }))}#tick-${r.at}" aria-expanded="false">Show</a>` : '–') }],
    totals: { at: 'count', nActions: 'sum', nSkipped: 'sum', nErrors: 'sum' }, emptyState: empty('No tick in the reconcile log', 'The reconcile cron writes one entry every five minutes.', 'clock') }) })) };
}
function upgradesPage(view, query, path) {
  const rows = view.supervisor.upgrades.slice().reverse().map(u => ({ ...u, prText: u.prs.join(' '), checkText: Object.entries(u.checks).map(([k, v]) => `${k} ${v}`).join(', ') }));
  return { title: 'Upgrade history', crumbs: [['/supervisor', 'Supervisor'], [null, 'Upgrade history']], body: grid('upgrades', card({ id: 'u-all', title: `Self-upgrade records (${rows.length})`, span: 12, movable: false, body: table({ id: 'upg', path, query, noun: 'records', rows, searchKeys: ['result', 'reason', 'from', 'to', 'prText'],
    cols: [{ key: 'at', label: 'When', num: true, html: r => lt(r.at) }, { key: 'result', label: 'Result', html: r => badge(resultSeverity(r.result), r.result) }, { key: 'from', label: 'From', html: r => shaCopy(r.from) }, { key: 'to', label: 'To', html: r => shaCopy(r.to) },
      { key: 'prText', label: 'PRs', html: r => (r.prs.length ? r.prs.map(prLink).join(', ') : '–') }, { key: 'reason', label: 'Reason', html: r => (r.reason ? errCopy(r.reason) : '–') }, { key: 'checkText', label: 'Checks', more: true }],
    totals: { at: 'count' }, emptyState: empty('No self-upgrade record', 'Records appear in team/upgrades.jsonl when the supervisor upgrades itself.', 'info') }) })) };
}
// Watch a job (issue #123): the transcript so far is rendered here; for a running job watch.js streams the rest.
function watchPage(view, query, path, route) {
  const t = route.transcript, job = route.job;
  if (!job && !t?.entries?.length) return null;
  const row = view.jobs.find(j => j.fullId === route.id);
  const live = !!job && ['queued', 'running'].includes(job.status);
  const entries = t?.entries || [], last = entries.at(-1)?.seq || 0, started = job?.createdAt ?? row?.startedAt;
  const elapsed = Number.isFinite(started) ? (live ? route.runningNow : (job?.updatedAt || started)) - started : null;
  const meta = row ? `${esc(row.agent)} · ${esc(row.kind)} ${row.ref ? jobRef(row, view) : ''} · ${esc(row.status)}` : esc(job?.status || 'unknown');
  const head = `<p class="sub">${meta}</p><p class="watch-stats"><span class="badge sev-${live ? 'ok' : 'info'}" data-state>${live ? 'Live' : `Finished (${esc(job?.status || 'ended')})`}</span> Elapsed <b data-elapsed>${Number.isFinite(elapsed) ? esc(fmtElapsed(elapsed)) : 'unknown'}</b> · <span data-totals>${esc(renderTotals(totals(entries)))}</span></p>`;
  const none = entries.length ? '' : `<p class="sub">${live ? 'Waiting for the first output…' : 'No transcript is stored for this job (it ran before transcripts existed, or it is older than 7 days).'}</p>`;
  const seed = entries.map(e => ({ kind: e.kind, tokens: e.tokens, evidence: e.evidence ? 1 : 0 }));
  const panel = `<section class="card watch" data-watch data-job="${esc(route.id)}" data-live="${live}" data-last="${last}" data-started="${Number.isFinite(started) ? started : ''}" data-seed="${esc(JSON.stringify(seed))}"><div class="card-body">${head}${none}<div class="tr-log" role="log" aria-live="polite">${renderEntries(entries)}</div><p class="sub">Read-only. Known secret shapes and OpenBao paths are redacted before storage, but redaction is pattern-based and cannot catch every secret (for example a bare password in prose); transcripts are kept 7 days.</p></div></section>`;
  return { title: `Job ${route.id.slice(0, 8)}`, crumbs: [['/work', 'Work'], [null, `Job ${route.id.slice(0, 8)}`]], body: `<div class="cards">${panel}</div><script type="module" src="/static/watch.js"></script>` };
}
const PAGES = { overview, agents: agentsPage, agent: agentDetail, work: workPage, pr: prDetail, issue: issueDetail, job: jobDetail, watch: watchPage, activity: activityPage, timeline: timelinePage, usage: usagePage, reviews: reviewsPage, supervisor: supervisorPage, ticks: ticksPage, upgrades: upgradesPage, system: systemPage };

// Returns { status, html }. A drill-down for something that does not exist is a 404 page, not an empty one.
// REFS is a module-level lookup that the link helpers read; it is set for one synchronous render and cleared after (issue #182).
export function renderRoute(view, route, opts = {}) {
  REFS = view.refs || { issue: {}, pr: {}, job: {} };
  try { return renderRouteWith(view, route, opts); } finally { REFS = { issue: {}, pr: {}, job: {} }; }
}
function renderRouteWith(view, route, { query = new URLSearchParams(), pathname = '/', refreshSeconds = 60 } = {}) {
  const fn = PAGES[route.page];
  const page = fn ? fn(view, query, pathname.replace(/\/+$/, '') || '/', route) : null;
  const res = page || { title: 'Not found', body: `<div class="cards">${card({ id: 'nf', title: 'Not found', span: 12, movable: false, body: empty('This item is not in the dashboard data', 'It may be closed and no longer cached, or the number is wrong.', 'warn') })}</div>`, crumbs: [['/work', 'Work'], [null, 'Not found']] };
  const steps = trail(route.page, res.crumbs || []), parent = [...steps].reverse().find(([h]) => h)?.[0];
  const crumbs = steps.length ? `<a class="btn back" href="${esc(parent || '/')}" data-back>${icon('back')}Back</a><nav class="crumbs" aria-label="Breadcrumb"><ol>${steps.map(([h, t], i) => `<li>${h ? `<a href="${esc(h)}">${esc(t)}</a>` : `<span aria-current="page">${esc(t)}</span>`}${i < steps.length - 1 ? '<span class="sep" aria-hidden="true">›</span>' : ''}</li>`).join('')}</ol></nav>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshSeconds > 0 ? `<noscript><meta http-equiv="refresh" content="${refreshSeconds}"></noscript><meta name="refresh-seconds" content="${refreshSeconds}">` : ''}<title>${esc(res.title)} · DevTest team</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/static/style.css"><script src="/static/early.js"></script></head>
<body class="${res.bodyClass || ''}">${sprite}<a class="skip" href="#main">Skip to content</a>${statusBar(view, route, (crumbs ? `<div class="pagehead">${crumbs}<h1 id="page-title">${esc(res.title)}</h1></div>` : `<h1 id="page-title">${esc(res.title)}</h1>`))}<main id="main" aria-labelledby="page-title">${res.body}</main><p id="tznote" class="sub tznote">Times are shown in UTC (your browser's time zone is applied when scripts run). Data is stored in UTC.</p><p id="copy-status" class="vh" role="status" aria-live="polite"></p><button type="button" id="to-top" class="to-top" aria-label="Back to top" title="Back to top" hidden>${icon('up')}</button><script type="module" src="/static/app.js"></script></body></html>`;
  return { status: page ? 200 : 404, html };
}
// Kept for callers that only want the overview.
export const renderPage = (view, opts = {}) => renderRoute(view, opts.route || { page: 'overview' }, opts).html;
