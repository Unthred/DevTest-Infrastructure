// HTML for the team dashboard v2 (issue #54): one server-rendered page per URL, charts as inline SVG, tables sorted, filtered and
// paginated on the server from the URL (so every state is bookmarkable and works without script). One small same-origin script
// (dashui/app.js) adds the countdown, theme, legend toggles, chart expand and card layout. Every dynamic value goes through esc().
import { formatCost } from './money.mjs';
import { ACTIVITY_FILTERS, DEFAULT_PAGE_SIZE, DEFAULT_RANGE, PAGE_SIZES, RANGES, SEVERITIES, activityFilters, collapseIdle, countText, filterActivity, formatLocal, inRange, pillLinks, localStamps, tmark, tableState, trail, versionStatus } from './dashui/logic.mjs';
import { PINNED } from './dashui/grid.mjs';
import { CARD_IDS, CARD_TITLES, WINDOWS } from './headline.mjs';
import { resultSeverity, tickLine } from './suphealth.mjs';
import { entryLink, entryText, filterTimeline } from './history.mjs';
import { DEFAULT_SINCE, SECTIONS, SINCE_RANGES } from './since.mjs';
import { fmtElapsed, renderEntries, renderTotals, totals } from './dashui/watch.mjs';
import { DIRECTION_WORDS, SORT_LABELS, footerText, searchVisible, sortListRows, sortsVisible } from './dashui/lists.mjs';
import { approvals, decisionHtml, stepDoneForm } from './approvals-ui.mjs';
import { inboxPage } from './inbox-page.mjs';
import { agentLine } from './agentline.mjs';
import { CAUSE_LABEL } from './idlecause.mjs';
import { healthPage } from './healthpage.mjs';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from './diagnostics.mjs';
import { meaningfulRange } from './estimate.mjs';
import { CLIENT_POLL_MS, readingStatus } from './procsample.mjs';
import { resetsCard } from './resetscard.mjs';
import { allowanceBody as allowanceCard } from './allowancecard.mjs';
import { outcomeFromQuery, outcomeNote } from './probeoutcome.mjs';
import { agentBarHtml } from './appbaragent.mjs';
import { withWorkViews } from './jobs-page.mjs';
import { bestLine } from './dashbest.mjs';
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
  ['overview', '/', 'Overview', 'grid'], ['agents', '/agents', 'Agents', 'users'], ['work', '/work', 'Work', 'list'],
  ['inbox', '/inbox', 'Inbox', 'list'], ['activity', '/activity', 'Activity', 'pulse'],
  ['usage', '/usage', 'Usage & cost', 'chart'], ['reviews', '/reviews', 'Reviews', 'review'], ['supervisor', '/supervisor', 'Supervisor', 'shield'], ['diagnostics', '/diagnostics', 'Diagnostics', 'clock'], ['health', '/health', 'Health', 'pulse'], ['system', '/system', 'System', 'gear']
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
  if (p === '/system/processes') return { page: 'processes' };
  if ((m = /^\/system\/processes\/([A-Za-z0-9_-]{1,40})$/.exec(p))) return { page: 'processes', agent: m[1] };
  if (p === '/evidence') return { page: 'evidence' };
  if ((m = /^\/evidence\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(p))) return { page: 'evidence-run', id: m[1] };
  if (p === '/activity/timeline') return { page: 'timeline' };
  if (p === '/supervisor/ticks') return { page: 'ticks' };
  if (p === '/supervisor/upgrades') return { page: 'upgrades' };
  if ((m = /^\/headline\/([a-z-]{1,20})$/.exec(p)) && CARD_IDS.includes(m[1])) return { page: 'headline', id: m[1] };
  return null;
}
const parentOf = page => ({ processes: 'system', agent: 'agents', pr: 'work', issue: 'work', job: 'work', watch: 'work', ticks: 'supervisor', upgrades: 'supervisor', timeline: 'activity', headline: 'overview', evidence: 'system', 'evidence-run': 'system' })[page] || page;

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
  shield: '<path d="M12 3 4 6v6c0 4.500 3.400 7.700 8 9 4.600-1.300 8-4.500 8-9V6z"/><path d="m9 12 2 2 4-4"/>', zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', resize: '<path d="M20 12v8h-8M20 20 12 12"/>', rail: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', back: '<path d="m15 6-6 6 6 6"/>', pin: '<path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3z"/>'
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
// A running job's card shows its description once, as the link; the name is the fallback when the reference table has none.
const jobLinkNamed = j => named(jobPath(j.id), REFS.job[String(j.id).slice(0, 8)], j.name || `job ${String(j.id).slice(0, 8)}`);
// Issue #430: Watch / Stop watching. One small same-origin form post; `back` returns to the page the button was on.
const watchedBy = (view, kind, n) => (view.watching || []).find(w => (kind === 'pr' ? w.pr === Number(n) : w.issue === Number(n)));
const watchForm = (kind, n, action, label, back, cls = '') => `<form method="post" action="/watch" class="watch-form"><input type="hidden" name="kind" value="${esc(kind)}"><input type="hidden" name="number" value="${Number(n)}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="back" value="${esc(back)}"><button class="btn ${cls}" type="submit">${esc(label)}</button></form>`;
const watchBtn = (view, kind, n, back = '/') => (watchedBy(view, kind, n) ? watchForm(kind, n, 'unwatch', 'Stop watching', back, 'watch-on') : watchForm(kind, n, 'watch', 'Watch', back));
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
// ---- lists (one shared component for every Overview list): a row is built by dli(), a list by dlist().
// The server renders the default order and the footer, so a list is complete and scrolls inside its own card without script;
// dashui/lists-ui.mjs adds the search box, the sort controls and keeps their state across the page's refresh.
// A row carries what the controls sort and search on: severity (data-sev), a number, a short name and the age in ms.
const plain = h => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (m, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[c]).replace(/\s+/g, ' ').trim();
export function dli({ cls = '', id = '', extra = '', key = '', sev = null, num = null, name = '', age = null, inner = '' }) {
  const attrs = [cls ? `class="${esc(cls)}"` : '', id ? `id="${esc(id)}"` : '', key ? `data-key="${esc(key)}"` : '', sev ? `data-sev="${esc(sev)}"` : '',
    Number.isFinite(num) ? `data-num="${num}"` : '', name ? `data-name="${esc(String(name).slice(0, 120))}"` : '', Number.isFinite(age) ? `data-age="${Math.round(age)}"` : '', extra].filter(Boolean).join(' ');
  return { html: `<li ${attrs}>${inner}</li>`, sev, num: Number.isFinite(num) ? num : null, name, age: Number.isFinite(age) ? age : null };
}
// `sorts` are the sort keys that make sense for these rows (lists.mjs SORT_KEYS); `defaultSort` is what the list is rendered in.
// `compact` is for small lists inside a card that has other content (a shorter fixed height).
export function dlist({ id, label, noun = 'items', rows, sorts = ['default'], defaultSort = { key: 'default', dir: 'asc' }, defaultLabel = 'Original order', compact = false, listCls = 'panel-list' }) {
  const ordered = sortListRows(rows.map((r, i) => ({ ...r, i })), defaultSort.key, defaultSort.dir);
  const words = k => (k === 'default' ? [defaultLabel, 'Reversed'] : DIRECTION_WORDS[k]);
  const search = searchVisible(rows.length), sort = sortsVisible(sorts) && rows.length > 1;
  const word = words(defaultSort.key)[defaultSort.dir === 'desc' ? 1 : 0];
  const bar = search || sort ? `<div class="dl-bar">${search ? `<div class="dl-search"><input type="search" class="dl-q" placeholder="Search" autocomplete="off" spellcheck="false" aria-label="Search ${esc(label)}" maxlength="200"><button type="button" class="tbtn dl-clear" aria-label="Clear search" title="Clear search" hidden>${icon('stop')}</button></div>` : ''}${sort ? `<label class="dl-sort"><span class="vh">Sort ${esc(label)} by</span><select class="dl-key">${sorts.map(k => `<option value="${k}"${k === defaultSort.key ? ' selected' : ''}>${esc(k === 'default' ? defaultLabel : SORT_LABELS[k])}</option>`).join('')}</select></label><button type="button" class="btn dl-dir" aria-label="Sort direction: ${esc(word)}. Press to reverse." title="Reverse the order" ${sorts.length ? '' : 'hidden'}>${icon(defaultSort.dir === 'desc' ? 'down' : 'up')}<span>${esc(word)}</span></button>` : ''}</div>` : '';
  return `<div class="dlist${compact ? ' compact' : ''}" data-dlist="${esc(id)}" data-sorts="${esc(sorts.join(','))}" data-default-key="${esc(defaultSort.key)}" data-default-dir="${defaultSort.dir === 'desc' ? 'desc' : 'asc'}" data-default-label="${esc(defaultLabel)}" data-noun="${esc(noun)}">${bar}<ul class="${esc(listCls)} dl-scroll" tabindex="0" aria-label="${esc(label)}">${ordered.map(r => r.html.replace('<li ', `<li data-i="${r.i}" `)).join('')}</ul><p class="dl-none sub" role="status" hidden></p><div class="dl-foot sub" data-dl-foot aria-live="polite">${esc(footerText(rows, rows, noun))}</div></div>`;
}

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
// Alternative styles for the allowance charts (issue #926). Every style is drawn into the same SVG and tagged data-ly; the
// stylesheet shows the layers of the figure's data-style, so switching needs no new request and the choice is a pure client setting.
export const CHART_STYLES = [['line', 'Line'], ['area', 'Line with shaded area'], ['step', 'Stepped line'], ['stack', 'Stacked area (sum of readings)'], ['bars', 'Bars per day (daily peak) with line']];
const DAY = 86400000;
function dayBuckets(t0, t1) {
  const out = []; for (let d = Math.floor(t0 / DAY) * DAY; d < t1 && out.length < 400; d += DAY) out.push({ from: d, to: d + DAY, day: new Date(d).toISOString().slice(0, 10) });
  return out.length ? out : [{ from: t0, to: t1, day: new Date(t0).toISOString().slice(0, 10) }];
}
// Stacked area: each series is sampled at 48 points (its latest reading, held only until the next reading or briefly after the last),
// and stacked. The y axis is rescaled to the largest sum, so the labels are the sum of readings, not an allowance percentage.
function stackLayer(live, t0, t1, x, top, bottom) {
  const N = 48, step = (t1 - t0) / (N - 1), times = Array.from({ length: N }, (_, i) => t0 + i * step);
  const at = (s, t) => { let k = -1; for (let i = 0; i < s.points.length && s.points[i].at <= t; i++) k = i; if (k < 0) return 0; const nx = s.points[k + 1]; return (nx ? !nx.gap : t - s.points[k].at <= step * 2) ? s.points[k].v : 0; };
  const vals = live.map(s => times.map(t => at(s, t))), totals = times.map((_, i) => vals.reduce((a, v) => a + v[i], 0)), max = Math.max(...totals, 0.01);
  const ys = v => bottom - (v / max) * (bottom - top), shapes = new Map(), acc = times.map(() => 0);
  live.forEach((s, k) => {
    const lo = [...acc]; times.forEach((_, i) => { acc[i] += vals[k][i]; });
    const pts = [...times.map((t, i) => `${x(t).toFixed(1)},${ys(acc[i]).toFixed(1)}`), ...times.map((t, i) => `${x(t).toFixed(1)},${ys(lo[i]).toFixed(1)}`).reverse()].join(' ');
    shapes.set(s.key, `<polygon data-ly="stack" fill="${s.colour}" fill-opacity="0.6" stroke="${s.colour}" points="${pts}"><title>${esc(s.label)} (stacked)</title></polygon>`);
  });
  const axis = [0, 0.25, 0.5, 0.75, 1].map(v => `<text data-ly="stack" x="38" y="${(ys(max * v) + 4).toFixed(1)}" text-anchor="end" class="ax">${Math.round(max * v * 100)}%</text>`).join('');
  return { shapes, axis };
}
function lineChart({ series, resets = [], expected = [], now, range, title }) {
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return empty('No allowance history in this range', 'The chart fills in as ticks record what the providers report.', 'chart');
  const W = 900, H = 320, L = 44, B = 28, T = 12, R = 14;
  const t1 = now, t0 = Number.isFinite(RANGES[range]) ? now - RANGES[range] : Math.min(...pts.map(p => p.at));
  const x = t => L + ((t - t0) / (t1 - t0)) * (W - L - R), y = v => T + (1 - Math.min(1, Math.max(0, v))) * (H - T - B);
  let g = [0, 0.25, 0.5, 0.75, 1].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax" data-ly="line area step bars">${v * 100}%</text>`).join('');
  for (let i = 0; i <= 4; i++) { const t = t0 + ((t1 - t0) * i) / 4; g += `<text x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" class="ax" ${lms(Math.round(t), '{t}', range === '24h')}>${esc(fmtAxisTime(t, range))}</text>`; }
  for (const r of resets.filter(r => r.at >= t0)) g += `<line x1="${x(r.at)}" x2="${x(r.at)}" y1="${T}" y2="${H - B}" class="reset" data-series="reset"><title ${lms(r.at, `${r.window} window reset {t}`)}>${esc(r.window)} window reset ${esc(utc(r.at))}</title></line>`;
  const shownExpected = expected.filter(r => r.at >= t0 && r.at <= t1);
  for (const r of shownExpected) g += `<line x1="${x(r.at).toFixed(1)}" x2="${x(r.at).toFixed(1)}" y1="${T}" y2="${H - B}" class="reset expected" data-series="expected"><title ${lms(r.at, `${r.window} window expected to reset {t}: the reading before it has expired`)}>${esc(r.window)} window expected to reset ${esc(utc(r.at))}: the reading before it has expired</title></line>`;
  const live = series.filter(s => s.points.length);
  const X = p => x(p.at).toFixed(1), Y = p => y(p.v).toFixed(1), base = y(0).toFixed(1);
  const stack = stackLayer(live, t0, t1, x, T, H - B);
  const days = dayBuckets(t0, t1), slot = (W - L - R) / days.length;
  for (const s of live) {
    // a gap (reading expired, then a new one) splits the line: nothing is drawn across the time no reading was current
    const segments = s.points.reduce((acc, p) => { if (p.gap || !acc.length) acc.push([]); acc.at(-1).push(p); return acc; }, []);
    const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
    const poly = (ly, pts) => `<polyline data-ly="${ly}" fill="none" stroke="${s.colour}" stroke-width="2.5" stroke-linejoin="round"${dash} points="${pts}"/>`;
    const step = seg => seg.flatMap((p, i) => (i ? [`${X(p)},${Y(seg[i - 1])}`, `${X(p)},${Y(p)}`] : [`${X(p)},${Y(p)}`])).join(' ');
    const area = seg => `<polygon data-ly="area" fill="${s.colour}" fill-opacity="0.18" stroke="none" points="${X(seg[0])},${base} ${seg.map(p => `${X(p)},${Y(p)}`).join(' ')} ${X(seg.at(-1))},${base}"/>`;
    const bars = days.map((d, di) => { const v = Math.max(0, ...s.points.filter(p => p.at >= d.from && p.at < d.to).map(p => p.v)); if (!v) return ''; const bw = Math.max(1, (slot - 2) / live.length), bx = L + di * slot + 1 + live.indexOf(s) * bw; return `<rect data-ly="bars" x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}" fill="${s.colour}" fill-opacity="0.55"><title>${esc(s.label)}: peak ${pct(v)} on ${esc(d.day)}</title></rect>`; }).join('');
    g += `<g data-series="${esc(s.key)}">${segments.map(seg => area(seg) + poly('line area bars', seg.map(p => `${X(p)},${Y(p)}`).join(' ')) + poly('step', step(seg))).join('')}${bars}${stack.shapes.get(s.key) || ''}`
      + s.points.filter((_, i, a) => a.length < 60 || i % Math.ceil(a.length / 60) === 0).map(p => `<circle class="pt" data-ly="line area step bars" tabindex="0" cx="${X(p)}" cy="${Y(p)}" r="5" fill="${s.colour}"><title ${lms(p.at, `${s.label}: ${pct(p.v)} at {t}`)}>${esc(s.label)}: ${pct(p.v)} at ${esc(utc(p.at))}</title></circle>`).join('') + '</g>';
  }
  g += stack.axis;
  const items = [...series.filter(s => s.points.length).map(s => ({ key: s.key, label: s.label, colour: s.colour })), ...(resets.length ? [{ key: 'reset', label: 'Window reset', colour: 'var(--action)', marker: true }] : []), ...(shownExpected.length ? [{ key: 'expected', label: 'Expected reset (reading expired)', colour: 'var(--mut)', marker: true }] : [])];
  return `<figure class="chart" data-style="line" data-styles="${CHART_STYLES.map(([k]) => k).join(' ')}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg>${legend(items)}</figure>`;
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
function card({ id, title, span = 6, body, href, tools = '', cls = '', movable = true, expandable = false, type = 'info' }) {
  if (expandable) { type = 'chart'; cls = `${cls} chart-card`; }
  const pin = PINNED.includes(id) || /\bhc-action\b/.test(cls);   // a card that needs action can never be hidden in layout mode
  return `<section class="card ${cls}" data-card="${esc(id)}" data-type="${esc(type)}" data-span="${span}"${pin ? ' data-pin="1"' : ''} style="--span:${span}" id="c-${esc(id)}" aria-labelledby="h-${esc(id)}"><header>${movable ? `<span class="tbtn" data-handle title="Drag to move" aria-hidden="true">${icon('drag')}</span>` : ''}<h2 id="h-${esc(id)}">${esc(title)}</h2>
<span class="tools">${tools}<button class="tbtn" type="button" data-collapse aria-expanded="true" aria-label="Collapse ${esc(title)}" title="Collapse or expand (or double-click the header)" hidden>${icon('down')}</button>${expandable ? `<button class="tbtn" type="button" data-expand aria-label="Expand ${esc(title)}" title="Expand">${icon('expand')}</button>` : ''}${movable ? `<button class="tbtn" type="button" data-move="-1" aria-label="Move ${esc(title)} earlier" title="Move earlier">${icon('up')}</button><button class="tbtn" type="button" data-move="1" aria-label="Move ${esc(title)} later" title="Move later">${icon('down')}</button>` : ''}${href ? `<a class="tbtn" href="${esc(href)}" aria-label="Details: ${esc(title)}" title="Details">${icon('link')}</a>` : ''}</span></header>${body}</section>`;
}
const grid = (layout, cards, cls = '') => `<div class="cards ${cls}" data-layout="${esc(layout)}">${cards}</div>`;
const kpi = ({ id, label, value, href, spark = '', span = 2, sub = '' }) => `<a class="card kpi" data-card="${esc(id)}" data-type="kpi" data-span="${span}" style="--span:${span}" href="${esc(href)}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${sub ? `<div class="sub kpi-sub">${esc(sub)}</div>` : ''}<div class="spark-slot">${spark}</div></a>`;

// ---- the four panels (Overview top) and the status bar
function nowPanel(view, { describe = true, list = null } = {}) {
  const now = view.generatedAt;
  const slots = `<div class="sub slots">${(view.slots || []).map(x => `<div>${esc(x.text)}${x.capacity > 1 ? ` (${x.held.length} of ${x.capacity})` : ''}</div>`).join('')}${(view.capNotes || []).map(n => `<div class="cap-note">Held down: ${esc(n)}</div>`).join('')}${Object.entries(view.budget || {}).filter(([, b]) => b.known).map(([n, b]) => `<div class="rate-note">${esc(n)}: ${Number.isFinite(b.ratePerHour) ? `${(b.ratePerHour * 100).toFixed(2)}% of the week per hour, ` : ''}estimate ${Number.isFinite(b.projected) ? `${Math.round(b.projected * 100)}%` : 'unknown'} at reset</div>`).join('')}</div>`;
  // Issue #213: one card per running or paused job (role, model, item, elapsed); an agent with none gets one idle/blocked/unknown card.
  // The description is the link text, once; the agent card passes describe:false and gets a plain id link (issue #421).
  const jobRef = (id, name) => (describe ? named(jobPath(id), REFS.job[String(id).slice(0, 8)], name || `job ${String(id).slice(0, 8)}`) : named(jobPath(id), null, `job ${String(id).slice(0, 8)}`));
  const jobItem = (a, j) => {
    const level = j.paused ? 'warning' : 'info', role = j.role === 'reviewer' ? 'Reviewer' : j.role === 'rebaser' ? 'Rebaser' : j.role === 'inbox' ? 'Inbox lane' : 'Implementer';
    const when = j.paused ? `paused (${esc(j.lastEvent)})${j.nextAttemptAt ? `, retry ${esc(inFuture(j.nextAttemptAt, now))}` : ''}`+ (j.resumeWait ? `; ${esc(j.resumeWait)}` : '') : `elapsed ${esc(dur(j.elapsedMs))}`;
    return dli({ cls: `sev-${level}`, extra: `data-job-card="${esc(j.id)}"`, key: `job-${j.id}`, sev: level, name: a.name, age: j.elapsedMs, inner: `<div class="t">${agentTag(a.name, view)} ${badge('info', role)} ${stateBadge(j.paused ? 'paused' : 'running')}</div><div>${j.model ? `${esc(j.model)} · ` : ''}${jobRef(j.id, j.name)} · attempt ${Number(j.attempts)} · ${when}${j.fullId ? ` · ${watchLink(j.fullId, j.paused ? 'Transcript' : 'Watch live')}` : ''}</div>` });
  };
  // Issue #530: the Now card on the Overview carries the state and one short idle line per agent (the share of the last 24 h and the biggest
  // cause); the full breakdown, every cause and each hold with its time, is on the agent's own page, one click away.
  const ic = view.idleCauses, shown = new Set(view.agents.map(a => a.name));
  const idleLine = ic ? Object.entries(ic.agents).filter(([n]) => shown.has(n)).map(([n, r]) => {
    const causes = Object.entries(r.minutes).filter(([k, v]) => v > 0 && k !== 'no-eligible-work' && k !== 'unrecorded').sort((x, y) => y[1] - x[1]);
    if (list) {
      const top = causes[0] ? `, mostly ${esc(CAUSE_LABEL[causes[0][0]])}` : '';
      return `<div class="sub" data-idle-causes="${esc(n)}">${esc(n)}, last 24 h: idle with work available ${esc(r.idleWithWorkPercent)}%${top} <a href="/agents/${esc(encodeURIComponent(n))}">Breakdown</a></div>`;
    }
    const holds = Object.entries(r.holds).sort((x, y) => y[1] - x[1]);
    return `<div class="sub" data-idle-causes="${esc(n)}">${esc(n)}, last 24 h: idle with work available ${esc(r.idleWithWorkPercent)}% (${causes.map(([k, v]) => `${esc(CAUSE_LABEL[k])} ${esc(Math.round(v))} min`).join(', ') || 'none'})${holds.length ? `; holds: ${holds.map(([h, m]) => `${esc(h)} ${esc(Math.round(m))} min`).join(' | ')}` : ''}</div>`;
  }).join('') : '';
  const rows = view.agents.flatMap(a => {
    if (a.jobs?.length) return a.jobs.map(j => jobItem(a, j));
    const j = a.job, level = stateSev[a.state] || 'info';
    const what = j ? `${jobRef(j.id)} · attempt ${Number(j.attempts)} · ${a.state === 'paused' ? `paused (${esc(j.lastEvent)})${j.nextAttemptAt ? `, retry ${esc(inFuture(j.nextAttemptAt, now))}` : ''}` : `elapsed ${esc(dur(j.elapsedMs))}`}${j.fullId ? ` · ${watchLink(j.fullId, a.state === 'running' ? 'Watch live' : 'Transcript')}` : ''}`
      : `<span>Idle: ${a.idleReason ? esc(a.idleReason.text) : 'nothing to do'}</span> ${(a.idleReason?.links || []).map(l => ext(l.url, l.text)).join(' ')}`;
    return [dli({ cls: `sev-${level}`, key: `agent-${a.name}`, sev: level, name: a.name, age: j?.elapsedMs, inner: `<div class="t">${agentTag(a.name, view)} ${stateBadge(a.state)}</div><div>${what}</div>` })];
  });
  return `${slots}${idleLine}${list ? dlist({ id: list, label: 'Now', noun: 'agents and jobs', rows, sorts: ['default', 'severity', 'age', 'name'], defaultLabel: 'Agent order', compact: false }) : `<ul class="panel-list">${rows.map(r => r.html).join('')}</ul>`}`;
}
// Allowance mode and weekly projection for one agent (issue #56).
function budgetBlock(view, name) {
  const b = view.budget?.[name];
  if (!b) return '';
  const sev = { normal: 'ok', reviews_only: 'warning', waiting: 'action' }[b.mode] || 'info', now = view.generatedAt;
  const proj = b.known ? `Weekly ${pct(b.used)} used; estimate at reset <b>${pct(b.projected)}</b> (${esc(inFuture(b.resetsAt, now))}; rate from the ${esc(b.rateSource)}; an estimate only, it does not hold work back)${b.runsOutAt && b.runsOutAt < b.resetsAt ? `; at this rate it would run out ${esc(inFuture(b.runsOutAt, now))}` : ''}` : 'Weekly use unknown';
  return `<div class="budget" data-mode="${esc(b.mode)}"><p>${badge(sev, b.label)}${b.mode !== 'normal' && b.until ? ` <span class="sub">until ${lt(b.until)}</span>` : ''}</p><p class="sub">${proj}</p>${b.reason ? `<p class="sub">Why: ${esc(b.reason)}</p>` : ''}${Object.entries(b.held || {}).map(([t, w]) => `<p class="sub">Held back (${esc(t)}): ${esc(w)}</p>`).join('')}</div>`;
}
// Issue #156: the estimated finish with its basis on hover; waits Foreman knows about get their own time.
const estFor = (view, kind, ref) => view.estimates?.items?.[`${kind}:${ref}`] || null;
function estHtml(e, tz = 'UTC', now = null) {
  if (!e) return '';
  const tip = (e.basis || []).join('\n');
  // A range too wide to mean anything is left out (issue #413); waits stay.
  const wide = e.status === 'estimated' && now !== null && !meaningfulRange(e, now);
  if (wide && !(e.waits || []).length) return '';
  return `<div class="sub est" data-est="${esc(e.status)}" title="${esc(tip)}">${icon('clock')} ${wide ? '' : `${esc(e.text)} <span class="tzl">(${esc(tz)})</span>`}${(e.waits || []).map(w => ` <span class="est-wait" data-wait="${esc(w.kind)}">${esc(w.text)}</span>`).join('')}</div>`;
}
const globalWaitsHtml = view => (view.estimates?.waits || []).map(w => `<p class="sub est-wait" data-wait="${esc(w.kind)}">${icon('clock')} ${esc(w.text)} <span class="tzl">(${esc(view.tz || 'UTC')})</span></p>`).join('');
// Issue #76: when nothing is planned, say why. Counts link to the Work lists, filtered.
function nextWhyHtml(view) {
  const w = view.panels.nextWhy; if (!w) return '';
  const li = [];
  for (const b of w.busy) li.push(dli({ key: `busy-${b.agent}`, name: b.agent, sev: 'info', inner: `${agentTag(b.agent, view)} is busy with a running job (see Now)` }));
  for (const p of w.paused) li.push(dli({ key: `paused-${p.agent}`, name: p.agent, sev: 'warning', inner: `${agentTag(p.agent, view)} is paused${p.resumeAt ? `, resumes about ${lt(p.resumeAt)}` : ''}` }));
  if (w.blocked) li.push(dli({ key: 'blocked', name: 'blocked by dependencies', sev: 'info', inner: `<a href="/work?issues.show=blocked">${w.blocked} queued item${w.blocked === 1 ? '' : 's'} blocked by dependencies</a>` }));
  if (w.waitingReview) li.push(dli({ key: 'review', name: 'waiting for review', sev: 'info', inner: `<a href="/work?prs.show=awaiting-review">${w.waitingReview} waiting for review</a>` }));
  return `<div class="why" data-why><p class="sub">Nothing is planned because:</p>${li.length ? dlist({ id: 'next-why', label: 'Why nothing is planned', noun: 'reasons', rows: li, sorts: ['default', 'severity', 'name'], defaultLabel: 'As listed', compact: true }) : '<p class="sub">no agent has work waiting.</p>'}</div>`;
}
function nextPanel(view) {
  const now = view.generatedAt, plan = view.panels.next;
  const rows = plan.map(p => {
    const issueLike = ['implement', 'continue'].includes(p.type), kind = issueLike ? 'issue' : 'pr', what = p.type === 'cifix' ? 'fix CI' : p.type;
    return dli({ cls: 'sev-info', key: `next-${p.agent || ''}-${p.type}-${p.ref}`, sev: 'info', num: Number(p.ref), name: `${p.agent || ''} ${what}`, inner: `<div class="t">${agentTag(p.agent, view)}: ${esc(what)}</div><div>${issueLike ? issueLink(p.ref) : prLink(p.ref)} ${watchBtn(view, kind, p.ref, '/')}</div>${estHtml(estFor(view, kind, p.ref), view.tz, now)}${p.reassignedFrom || p.why ? `<div class="sub">${esc(p.why || `reassigned for allowance from ${p.reassignedFrom}`)}</div>` : ''}` });
  });
  return `${globalWaitsHtml(view)}${plan.length ? '' : nextWhyHtml(view)}${plan.length ? dlist({ id: 'next', label: 'Next', noun: 'planned items', rows, sorts: ['default', 'number', 'name'], defaultLabel: 'Run order' }) : empty('Nothing planned', 'The next tick has no work to start.', 'check')}`;
}
// Issue #549: the circuit breaker's status on the Overview, and the wasted usage by cause. Cost is the CLI's own estimate, not a cash charge.
function breakerCard(view) {
  const b = view.breaker;
  const fcWeek = (b?.failCauses?.week || []).filter(r => r.jobs > 0);
  if (!b || (!b.halt && !b.byCause.length && !b.error && !fcWeek.length)) return '';
  // Issue #626: a Resume button per halt (D-029 write protection; the form gets the access proof from withProof). Only a person's click works.
  const resumeBtn = (scope, label) => `<form method="post" action="/breaker-resume" class="breaker-resume"><input type="hidden" name="scope" value="${esc(scope)}"><button type="submit" class="tbtn">${esc(label)}</button></form>`;
  const buttons = b.halt ? (b.halt.entries || []).map(e => resumeBtn(e.cause === '@global' ? 'global' : e.cause, `Resume ${e.cause === '@global' ? 'all new jobs' : e.cause}`)).join('') + ((b.halt.entries || []).length > 1 ? resumeBtn('all', 'Resume everything') : '') : '';
  const halt = b.halt ? `<p class="sev-action"><strong>Work halted.</strong> ${escT(b.halt.text)} ${escT(b.halt.running_text)}</p><p class="sub">${escT(b.halt.action)}</p>${buttons}` : '<p class="sub">Circuit breaker: no halt.</p>';
  const err = b.error ? `<p class="sev-action">The breaker failed: ${escT(b.error)}</p>` : '';
  const rows = b.byCause.slice(0, 12).map(r => `<tr><td>${escT(r.cause)}${r.halted ? ' (halted)' : ''}</td><td>${r.jobs}</td><td>${num(r.tokens)}</td><td>${esc(formatCost(r.cost))}</td><td>${escT(r.prs.map(n => '#' + n).join(', '))}</td></tr>`).join('');
  const table = rows ? `<table><thead><tr><th>Cause</th><th>Wasted jobs</th><th>Tokens</th><th>Cost (usage equivalent)</th><th>PRs</th></tr></thead><tbody>${rows}</tbody></table><p class="sub">Cost is ${escT(b.costLabel)}.</p>` : '';
  // Issue #1020: the honest cause of every failed job, ordered by waste, with the items involved.
  const fcRow = r => `<tr><td>${escT(r.label)}</td><td>${r.jobs}</td><td>${num(r.tokens)}</td><td>$${r.cost.toFixed(2)}</td><td>${escT([...r.prs.map(n => 'PR #' + n), ...r.issues.map(n => '#' + n)].slice(0, 12).join(', '))}</td></tr>`;
  const fcDay = (b?.failCauses?.day || []).filter(r => r.jobs > 0);
  const fcTable = (title, rows) => rows.length ? `<h4>${escT(title)}</h4><table><thead><tr><th>Failure cause</th><th>Failed jobs</th><th>Tokens</th><th>Cost (usage equivalent)</th><th>Items</th></tr></thead><tbody>${rows.slice(0, 9).map(fcRow).join('')}</tbody></table>` : '';
  const causes = fcTable('Failure causes, last 24 hours', fcDay) + fcTable('Failure causes, last 7 days', fcWeek);
  return card({ id: 'breaker', title: b.halt ? 'Work halted' : 'Wasted usage', span: 12, body: err + halt + table + causes, cls: 'panel', type: b.halt ? 'action' : 'info' });
}
// Issue #995: liveness limit and last activity per running job, retry counts by cause, and what a recovery re-armed.
function robustnessCard(view) {
  const r = view.robustness;
  if (!r || (!r.running.length && !r.retries.length && !r.rearm && !r.cancelled.length)) return '';
  const ago = ms => (ms == null ? 'unknown' : `${Math.round(ms / 60000)} min ago`);
  const jobs = r.running.map(j => `<tr><td>${esc(j.id)}</td><td>${esc(j.kind || '')}</td><td>${esc(ago(j.idleMs))}</td></tr>`).join('');
  const retries = r.retries.map(x => `<tr><td>${esc(x.key)}</td><td>${esc(x.cause)}</td><td>${x.count}${x.capped ? ' (stopped)' : ''}</td></tr>`).join('');
  const body = `<p class="sub">A running job with no activity for ${r.limitMinutes} minutes is cancelled and requeued.</p>`
    + (jobs ? `<table><thead><tr><th>Job</th><th>Kind</th><th>Last activity</th></tr></thead><tbody>${jobs}</tbody></table>` : '')
    + (r.cancelled.length ? `<p class="sub">Cancelled for inactivity: ${r.cancelled.map(c => escT(`${c.job} (${c.reason})`)).join('; ')}</p>` : '')
    + (retries ? `<table><thead><tr><th>Item</th><th>Same cause</th><th>Attempts</th></tr></thead><tbody>${retries}</tbody></table>` : '')
    + (r.rearm ? `<p class="sub">Re-armed after ${escT(r.rearm.scopes.join(', '))} cleared: ${escT(r.rearm.items.join(', '))}.</p>` : '');
  return card({ id: 'robustness', title: 'Job liveness and retries', span: 12, body, cls: 'panel', type: 'info' });
}
// Issue #124: the Approve/Reject card of one inbox item. The item's own text is shown in full (escaped), so the click is informed.
// Issue #977: every inbox item shows its short id (the first 8 characters, as the overseer quotes it) beside its kind, as a link to /inbox/<id>.
// The full id sits in a hidden span so the list search matches either.
const KIND_WORD = { prompt: 'prompt', issue_draft: 'issue draft', action: 'action', host_value: 'host value' };
const inboxTag = (id, kind) => (/^[a-f0-9]{32}$/.test(String(id)) ? `<span class="inbox-tag"><a class="inbox-id" href="/inbox/${id}" title="Direct link to this item"><code>${id.slice(0, 8)}</code></a>${KIND_WORD[kind] ? ` <span class="inbox-kind">${KIND_WORD[kind]}</span>` : ''}<span class="inbox-fullid" hidden>${id}</span></span>` : '');
const inboxForm = (id, decision, label, cls) => `<form method="post" action="/inbox" class="inbox-form"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="decision" value="${decision}"><button class="btn ${cls}" type="submit">${label}</button></form>`;
// Issue #856: what was chosen and when ("Approved 06:20"), shown beside the title. dashui/app.js rewrites the time in the viewer's zone from data-lms.
const OUTCOME = { approve: ['Approved', 'approved', '✓'], reject: ['Rejected', 'rejected', '✗'] };
// Issue #925: an approval nothing has acted on yet says it is waiting for a free slot; once the tick has taken it, it reads plainly "Approved".
// Issue #971: a prompt is queued for, then running in, the inbox lane; the time it waited is shown.
const outcomeSpan = (decision, ms, state, c = {}) => { const [label, cls] = OUTCOME[decision] || OUTCOME.reject, laneWait = c.lane === 'inbox' && Number.isFinite(c.waitedMs) ? ` (waited ${dur(c.waitedMs)})` : '', wait = c.lane === 'inbox' && decision === 'approve' && (state === 'approved' || state === 'running') ? (state === 'approved' ? `, queued for the inbox lane${laneWait}` : `, running in the inbox lane${laneWait}`) : decision === 'approve' && state === 'approved' ? ', waiting for a free slot' : ''; return `<span class="inbox-outcome ${cls}" ${lms(ms, `${label} {t}${wait}`, true)}>${label} ${esc(utc(ms).slice(11, 16))} UTC${wait}</span>`; };
const undoForm = c => (c.undoUntil ? `<form method="post" action="/inbox" class="inbox-form inbox-undo" data-undo-until="${Math.round(c.undoUntil)}"><input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="decision" value="undo"><button class="linkbtn" type="submit">Undo</button></form>` : '');
// The collapsed "Decided today" list (newest first). It is also rendered, hidden and empty, while a proposal is pending, so the script can move a decided card into it.
function decidedBlock(view) {
  const list = view.panels.inboxDecided || [], pending = (view.panels.inbox || []).length > 0;
  if (!list.length && !pending) return '';
  const rows = list.map(c => `<li id="inbox-${esc(c.id)}" data-decided="${esc(c.id)}"><span class="inbox-title">${esc(c.title || 'Overseer proposal')}</span> ${inboxTag(c.id, c.kind)}${c.issue ? ` ${issueLink(c.issue)}` : ''} ${outcomeSpan(c.decision, c.decidedAt, c.state, c)} ${undoForm(c)}</li>`).join('');
  return `<details class="inbox-decided"${list.length ? '' : ' hidden'}><summary>Decided today (<span class="inbox-decided-n">${list.length}</span>)</summary><ul class="inbox-decided-list">${rows}</ul></details>`;
}
function needsPanel(view) {
  const items = view.panels.needsYou;
  const rows = items.map(a => dli({ cls: 'sev-action', id: `att-${a.id}`, key: `att-${a.id}`, sev: 'action', num: a.ref?.n, name: a.text, inner: `<h3 class="t">${badge('action')} ${escT(a.text)} ${refOf(a.ref)}${a.inboxId ? ` ${inboxTag(a.inboxId, a.inboxKind)}` : ''}${a.inbox ? ' <span class="inbox-outcome" hidden></span>' : ''}</h3>${a.tried ? `<div class="sub">Tried: ${esc(a.tried)}</div>` : ''}${decisionHtml(a, `att-${a.id}`)}${(a.causes || []).length > 1 ? `<details class="causes"><summary>${a.causes.length} causes</summary><ul>${a.causes.map(c => `<li>${escT(c.text)}${c.action ? ` <span class="sub">Action: ${esc(c.action)}</span>` : ''}</li>`).join('')}</ul></details>` : ''}${(a.links || []).length ? `<div class="sub">${a.links.map(l => (l.url.startsWith('/') ? `<a href="${esc(l.url)}">${esc(l.text)}</a>` : ext(l.url, l.text))).join(' · ')}</div>` : ''}${a.inbox ? inboxBlock(a.inbox) : ''}${a.command ? cmdBlock(a.command) : stepDoneForm(a)}${a.watch ? `<div class="acts">${watchLink(a.watch, 'Replay transcript')}</div>` : ''}${a.overseer ? `<div class="acts">${overseerBtn(a.overseer)}</div>` : ''}` }));
  return (items.length ? `${copyAllBtn(items, 'Needs you items')}${dlist({ id: 'needs', label: 'Needs you', noun: 'items', rows, sorts: ['default', 'number', 'name'], defaultLabel: 'Blocks most work first' })}`
    : empty('Nothing needs you', 'No homeowner decision or failed work is waiting.', 'check')) + decidedBlock(view);
}
// Issue #414: parked or staged work, quieter than Needs you: what it waits for and who or what ends the wait.
function laterPanel(view) {
  const items = view.panels.later || [];
  return items.length ? dlist({ id: 'later', label: 'Later', noun: 'items', rows: items.map(a => dli({ cls: 'sev-info', id: `later-${a.number}`, key: `later-${a.number}`, sev: 'info', num: Number(a.number), name: a.name, inner: `<div class="t">${ext(a.url, a.name)}</div><div class="sub">Waits: ${esc(a.waits)}</div><div class="sub">Ends: ${esc(a.ends)}</div>` })), sorts: ['default', 'number', 'name'], defaultLabel: 'As parked' }) : empty('Nothing later', 'No parked or staged work is waiting.', 'check');
}
function warningsPanel(view) {
  const unknown = view.agents.filter(a => a.state === 'unknown');
  const items = unknown.length ? [...view.panels.warnings, { severity: 'warning', text: `${unknown.length} agent record${unknown.length === 1 ? '' : 's'} could not be read or have an unknown state: running count is unknown` }] : view.panels.warnings;
  return items.length ? `${copyAllBtn(items, 'warnings')}${dlist({ id: 'warnings', label: 'Warnings', noun: 'warnings', rows: items.map((a, n) => dli({ cls: `sev-${a.severity}`, key: `warn-${a.id || n}`, sev: a.severity, num: a.ref?.n, name: a.text, inner: `<div class="t">${badge(a.severity)} ${escT(a.text)} ${refOf(a.ref)}</div>${a.overseer ? `<div class="acts">${overseerBtn(a.overseer)}</div>` : ''}` })), sorts: ['severity', 'default', 'number', 'name'], defaultSort: { key: 'severity', dir: 'desc' }, defaultLabel: 'As reported' })}` : empty('No warnings', 'No stalls, stale data or version drift.', 'check');
}
// Issue #473: one of three states, never "due now". The tick's real schedule (or its live lock) is the source.
const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export function nextTickHtml(view, now) {
  const n = view.nextTick || (view.nextTickAt ? { state: 'scheduled', at: view.nextTickAt, lastAt: view.tick?.at } : null);
  if (!n) return '';
  if (n.state === 'running') return `<b data-tick-state="running" data-running>tick running since ${lt(n.since)}</b>`;
  const last = `, last tick ${lt(n.lastAt)}`;
  if (n.state === 'starting') return `<b data-tick-state="starting"><span data-overdue="${n.at}">tick due, starting</span></b>`;
  if (n.state === 'overdue') return `<b data-tick-state="overdue"><span data-overdue="${n.at}">overdue by ${esc(clock(now - n.at))}</span>${last}</b>`;
  // scheduled: the script counts down, then turns the count into "overdue by" and reveals the last tick time
  return `<b data-tick-state="scheduled"><span data-countdown="${n.at}">in ${esc(clock(n.at - now))}</span><span data-after hidden>${last}</span></b>`;
}
// Issue #467: how old the prepared copy behind this page is. Never shown as current once it is old or its rebuild failed.
export function pageDataStat(view) {
  const d = view.pageData; if (!d || !Number.isFinite(d.ageMs)) return '';
  const secs = Math.round(d.ageMs / 1000), age = secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`;
  const why = d.failed ? `The last rebuild failed (${d.failed}); this is the last good copy.` : d.behindWrite ? 'This copy was prepared before the latest change and does not show it yet; a new copy is built on the next request.' : d.stale ? (d.refreshing ? 'This copy is older than expected and is being rebuilt.' : 'This copy is older than expected; a new copy is built on the next request.') : 'Pages are served from a copy prepared in the background.';
  return `<div class="stat" data-bar="page-data" data-bar-name="Page data" data-page-data="${d.stale ? 'stale' : 'ok'}" title="${esc(why)}"><span class="k">Page data</span>${d.stale ? badge('warning', `Stale · ${age} old`) : `<span>${esc(age)} old</span>`}</div>`;
}
function statusBar(view, route, head = '', crumbs = '') {
  const now = view.generatedAt, t = view.tick;
  const tickBadge = !t ? badge('action', 'No tick yet') : badge(t.status === 'ok' ? 'ok' : t.status === 'error' ? 'action' : 'info', `Tick ${t.status}`);
  const L = pillLinks({ health: view.health, attention: view.attention, needsYou: view.panels?.needsYou, version: view.version });
  const pill = (href, inner, why) => `<a class="pill" href="${esc(href)}" title="${esc(why)}">${inner}</a>`;
  return `<header class="statusbar" role="banner"><div class="brand" data-bar="brand">${icon('pulse')} <span class="brand-name">DevTest team</span></div>${head}
${['paused', 'running'].includes(view.health.state) ? '' : `<div class="stat" data-bar="health" data-bar-name="Health" title="Overall health">${pill(L.health, badge(view.health.severity, view.health.label, 'big'), 'Overall health: open what explains it')}</div>`}
${agentBarHtml({ esc, lt, dur, utc }, view)}
<div class="stat" data-bar="last-tick" data-bar-name="Last tick"><span class="k">Last tick</span>${pill(L.tick, tickBadge, 'Open the last tick and its error')}<span>${t ? esc(ago(t.at, now)) : ''}</span></div>
<div class="stat" data-bar="next-tick" data-bar-name="Next tick"><span class="k">Next</span>${nextTickHtml(view, now) || '<span class="muted">none</span>'}</div>
${pageDataStat(view)}
<button class="barbtn wide-only" id="barEdit" type="button" aria-pressed="false" title="Rearrange, remove and add app bar items">Edit bar</button><button class="stickybtn wide-only" id="sticky" type="button" aria-pressed="false" aria-label="Keep the app bar at the top while scrolling" title="Keep the app bar at the top while scrolling">${icon('pin')}</button><button class="theme" id="theme" type="button" aria-label="Switch between light and dark theme" title="Theme">${icon('moon')}</button></header>${crumbs}
<nav class="nav" id="nav" aria-label="Pages"><button type="button" class="dock-handle wide-only" data-dock-handle aria-label="Dock the navigation: arrow keys move it to a screen edge, Home resets it" title="Drag to a screen edge to dock the navigation, or use the arrow keys">${icon('drag')}</button>${NAV.map(([page, href, label, ic]) => `<a href="${href}"${route.page === page || parentOf(route.page) === page ? ' aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></a>`).join('')}<div class="nav-resize wide-only" role="separator" aria-orientation="vertical" tabindex="0" data-nav-resize aria-label="Resize the menu: arrow keys change its width, Home resets it" title="Drag to resize the menu"></div><button class="nav-collapse wide-only" type="button" data-nav-collapse aria-pressed="false" title="Collapse or expand the navigation rail">${icon('rail')}<span>Collapse</span></button></nav>`;
}

// ---- "Since you were last here" (issue #253): the range lives in the URL (?since=), Mark as read is a same-origin form POST.
function sincePanel(view, query) {
  const sv = view.since, now = view.generatedAt;
  const range = Object.hasOwn(SINCE_RANGES, query.get('since')) ? query.get('since') : DEFAULT_SINCE, r = sv.ranges[range];
  const picker = `<div class="ranges" role="group" aria-label="Summary range">${Object.entries(SINCE_RANGES).map(([k, label]) => `<a href="${esc(withQuery('/', query, { since: k === DEFAULT_SINCE ? null : k }))}"${k === range ? ' aria-current="true"' : ''}>${esc(label)}</a>`).join('')}</div>`;
  const when = sv.lastSeen === null ? 'never marked as read' : lt(sv.lastSeen);
  const total = SECTIONS.slice(0, 5).reduce((n, [k]) => n + r[k].length, 0);
  const item = (k, i, n) => dli({ key: `since-${k}-${n}`, name: i.text, age: Number.isFinite(i.at) ? now - i.at : null, inner: `${i.url ? `<a href="${esc(i.url)}">${esc(i.text)}</a>` : esc(i.text)}${Number.isFinite(i.at) ? ` <span class="muted">${esc(ago(i.at, now))}</span>` : ''}` });
  const sections = SECTIONS.map(([k, label]) => `<div class="since-sec"><h3>${esc(label)} <span class="muted">(${r[k].length})</span></h3>${r[k].length ? dlist({ id: `since-${k}`, label, noun: 'entries', rows: r[k].slice(0, 30).map((i, n) => item(k, i, n)), listCls: 'since-list', sorts: ['age', 'name', 'default'], defaultSort: { key: 'default', dir: 'asc' }, defaultLabel: 'As listed', compact: true }) + (r[k].length > 30 ? `<p class="muted">and ${r[k].length - 30} more</p>` : '') : '<p class="muted">None</p>'}</div>`).join('');
  const note = query.get('notice') === 'mark-read-cooldown' ? '<p class="muted" role="status">Marked as read a moment ago, so that click was ignored. Try again in a few seconds.</p>' : '';
  const body = `${note}<div class="since-head"><span>Last marked as read: ${when}. Showing ${esc(r.label.toLowerCase())}, from ${lt(r.from)}${r.fallback ? ' (you have not marked anything as read yet, so this is the last 24 h)' : ''}.</span>${copyBtn(r.text, 'the summary', { label: 'Copy summary' })}<form method="post" action="/mark-read" class="since-mark"><input type="hidden" name="at" value="${esc(now)}"><button class="btn" type="submit">Mark as read</button></form></div>
<p class="since-tokens">Tokens used: <b>${r.tokens === null ? 'unknown' : esc(num(r.tokens))}</b> <span class="muted">across ${r.tokenJobs} job${r.tokenJobs === 1 ? '' : 's'}</span></p>${total || r.needsYou.length ? '' : '<p class="muted">Nothing has happened in this range.</p>'}<div class="since-grid">${sections}</div>`;
  return card({ id: 'since', title: 'Since you were last here', span: 12, tools: picker, body, cls: 'panel since', type: 'panel' });
}

// ---- pages
const agentCols = view => ({ agent: { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) } });
const STEP_WORD = { done: 'done', active: 'in progress', blocked: 'stuck', pending: 'not yet', skipped: 'not needed' };
function watchingCard(view) {
  const now = view.generatedAt, list = view.watching || [];
  const item = w => {
    const ref = w.pr !== null ? prLink(w.pr) : issueLink(w.issue), back = '/';
    const steps = w.steps.map(st => { const h = w.history[st.key] || []; return `<li class="wstep st-${esc(st.status)}${w.current === st.key ? ' cur' : ''}" data-step="${esc(st.key)}" data-status="${esc(st.status)}"><details><summary><span class="wlabel">${esc(st.label)}</span><span class="wstate">${esc(STEP_WORD[st.status] || st.status)}</span></summary>${h.length ? `<ul class="whist">${h.map(r => `<li><b>${lt(r.at)}</b> ${esc(r.text)}</li>`).join('')}</ul>` : '<p class="sub">Nothing recorded yet.</p>'}</details></li>`; }).join('');
    const issueTag = w.pr !== null && w.issue !== null ? ` <span class="sub">for ${issueLink(w.issue)}</span>` : '';
    const est = w.done ? '' : estHtml(estFor(view, w.pr !== null ? 'pr' : 'issue', w.pr !== null ? w.pr : w.issue), view.tz, now);
    return dli({ cls: `watch-item${w.needs ? ' needs' : ''}`, extra: `data-watch="${esc(w.id)}"`, key: `watch-${w.id}`, sev: w.needs ? 'action' : w.done ? 'ok' : 'info', num: Number(w.number), name: w.pr !== null ? `PR ${w.pr}` : `issue ${w.issue}`, age: Number.isFinite(w.since) ? now - w.since : null, inner: `<div class="watch-head"><b>${ref}</b>${issueTag}${w.pinned ? ' <span class="badge sev-info">Pinned</span>' : ''}<span class="watch-acts">${watchForm(w.kind, w.number, w.pinned ? 'unpin' : 'pin', w.pinned ? 'Unpin' : 'Pin', back)}${watchForm(w.kind, w.number, 'unwatch', 'Stop watching', back, 'watch-on')}</span></div><ol class="wsteps" aria-label="Steps from implement to verified">${steps}</ol><p class="watch-sentence">${esc(w.sentence)}</p>${est}` });
  };
  const body = list.length ? dlist({ id: 'watching', label: 'Watching', noun: 'watched items', rows: list.map(item), listCls: 'watch-list', sorts: ['severity', 'age', 'number', 'name', 'default'], defaultSort: { key: 'severity', dir: 'desc' }, defaultLabel: 'Order added' }) : empty('Nothing watched', 'Press Watch on any issue or pull request to follow it from start to installed.', 'info');
  return card({ id: 'watching', title: `Watching${list.length ? ` (${list.length})` : ''}`, span: 12, movable: false, body, cls: 'panel watching', type: 'panel' });
}
// ---- Issue #866: headline progress numbers (top of the Overview) and the drill-down behind each.
const pctText = n => (Number.isFinite(n) ? `${dec1(n)}%` : 'no data');
const signed = n => (n > 0 ? `+${num(n)}` : n < 0 ? `\u2212${num(-n)}` : '0');
const HEADLINE = {
  issues: c => ({ big: `net ${signed(c.net)}`, sub: `${c.opened} opened, ${c.closed} closed` }),
  processed: c => ({ big: pctText(c.value), sub: `${c.processed} closed of ${c.total} in play` }),
  throughput: c => ({ big: Number.isFinite(c.openedPerHour) ? `${dec1(c.openedPerHour)} PRs opened/h` : 'no data', sub: `${dec1(c.mergedPerHour)} merged/h, ${dec1(c.implementedPerHour)} issues implemented/h (${c.opened} opened, ${c.merged} merged, ${c.implemented} implemented)` }),
  cost: c => ({ big: formatCost(c.value, { unknown: 'unknown' }), sub: `per merged issue, from implement through merge incl. review, fix and rebase rounds; ${c.withKnownCost} of ${c.merged} merged with known cost; usage equivalent, not a cash charge` }),
  'merge-rate': c => ({ big: Number.isFinite(c.value) ? `${dec1(Math.round(c.value * 100) / 100)}/h` : 'no data', sub: `${c.merged} merged` }),
  'first-pass': c => ({ big: pctText(c.value), sub: c.reviewed ? `${c.approved} of ${c.reviewed} approved first time${c.descriptionOnlyRejected ? `; ${c.descriptionOnlyRejected} more rejected for the description only` : ''}` : 'no first reviews' }),
  rounds: c => ({ big: Number.isFinite(c.value) ? dec1(c.value) : 'no data', sub: `${c.merged} merged (review, fix and rebase rounds)` }),
  tokens: c => ({ big: Number.isFinite(c.value) ? num(c.value) : 'unknown', sub: `${c.withKnownTokens} of ${c.merged} merged with known usage; usage equivalent, not a cash charge` }),
  waste: c => ({ big: num(c.value), sub: c.topCause ? `top cause: ${c.topCause.cause} (${num(c.topCause.tokens)})` : 'no wasted jobs' }),
  rejects: c => ({ big: String(c.value), sub: `${c.changes} CHANGES, ${c.blocked} blocked` }),
};
const trendText = (c, name) => (c.direction === null ? (c.previousNote ? 'no previous period to compare' : `no previous ${name} figure`) : c.direction === 'flat' ? `unchanged from the previous ${name}` : `${c.direction} ${num(Math.abs(c.delta))} from the previous ${name}`);
function headlineCards(view) {
  const h = view.headline;
  if (!h) return '';
  return CARD_IDS.map(id => {
    const rows = Object.keys(WINDOWS).map(name => {
      const c = h.windows[name].cards[id], t = HEADLINE[id](c);
      return `<div class="hl-row" data-window="${esc(name)}"><span class="hl-w">${esc(name === '24h' ? 'Last 24 hours' : 'Last 7 days')}</span><a class="hl-v" href="${esc(`/headline/${id}?window=${name}`)}">${esc(t.big)}</a><span class="sub">${esc(t.sub)}</span>
        <span class="sub hl-trend" data-dir="${esc(c.direction || '')}">${icon(c.direction === 'up' ? 'up' : c.direction === 'down' ? 'down' : 'sort')}${esc(trendText(c, name === '24h' ? '24 hours' : '7 days'))}</span>
        ${name === '24h' ? bestLine(id, view.best, view.tz) : ''}</div>`;
    }).join('');
    const extra = id === 'issues' ? `<p class="sub">${h.openNow} open now</p>` : '';
    return card({ id: `hl-${id}`, title: CARD_TITLES[id], span: 3, href: `/headline/${id}`, cls: 'panel headline', type: 'panel', body: rows + extra });
  }).join('');
}
function headlinePage(view, query, path, route) {
  const h = view.headline, id = route.id;
  if (!h || !CARD_IDS.includes(id)) return null;
  const name = Object.hasOwn(WINDOWS, query.get('window')) ? query.get('window') : '24h', c = h.windows[name].cards[id], t = HEADLINE[id](c);
  const switcher = `<div class="ranges" role="group" aria-label="Period">${Object.keys(WINDOWS).map(w => `<a href="${esc(withQuery(path, query, { window: w, 'hl.page': null }))}"${w === name ? ' aria-current="true"' : ''}>${w}</a>`).join('')}</div>`;
  const summary = card({ id: 'hl-sum', title: CARD_TITLES[id], span: 12, movable: false, tools: switcher, cls: 'panel', type: 'panel',
    body: `<p class="hl-v-big">${esc(t.big)}</p><p class="sub">${esc(t.sub)}. ${esc(trendText(c, name === '24h' ? '24 hours' : '7 days'))}.</p><p class="sub">${esc(h.note)}</p>${c.count > c.shown ? `<p class="sub">The table shows the newest ${c.shown} of ${c.count}.</p>` : ''}` });
  const link = r => (r.kind === 'pr' ? prLink(r.ref) : r.kind === 'issue' ? issueLink(r.ref) : r.kind === 'job' ? esc(`job ${r.ref}`) : esc(String(r.ref)));
  const rows = c.items.map(r => ({ ...r, item: `${r.kind} ${r.ref}` }));
  const t2 = card({ id: 'hl-items', title: 'Items behind the number', span: 12, movable: false, body: table({ id: 'hl', path, query, noun: 'items', rows, searchKeys: ['item', 'title', 'detail'], totals: { item: 'count', tokens: 'sum' },
    cols: [{ key: 'item', label: 'Item', html: link }, { key: 'title', label: 'What' }, { key: 'detail', label: 'Detail' }, { key: 'at', label: 'When', num: true, html: r => lt(r.at) }, { key: 'tokens', label: 'Tokens (usage equivalent)', num: true, html: r => (Number.isFinite(r.tokens) ? num(r.tokens) : '<span class="muted">unknown</span>') }],
    emptyState: empty('Nothing in this period', 'No items behind this number.') }) });
  return { title: CARD_TITLES[id], crumbs: [['/', 'Overview'], [null, CARD_TITLES[id]]], body: grid('headline', summary + t2) };
}
// Issue #928: the queue tile's split. 'issue' entries are implement work and 'review' entries are reviews; a pull request entry is a fix (CHANGES, red CI, draft), a rebase (conflict or not mergeable) or just waiting (CI pending, merge on the next tick).
export function queueSplit(view) {
  const n = { implement: 0, review: 0, fix: 0, rebase: 0, waiting: 0, total: 0 };
  for (const q of Object.values(view.queues || {})) for (const e of q) {
    n.total++;
    if (e.type === 'issue') n.implement++;
    else if (e.type === 'review') n.review++;
    else if (/rebase|conflict|not mergeable/i.test(e.reason || '')) n.rebase++;
    else if (/CHANGES|CI failing|draft|fix/i.test(e.reason || '')) n.fix++;
    else n.waiting++;
  }
  return n;
}
const queueSub = (view, running) => { const n = queueSplit(view); return `${n.implement} implement, ${n.review} review, ${n.fix} fix, ${n.rebase} rebase${n.waiting ? `, ${n.waiting} waiting on CI or merge` : ''}; ${running} running now`; };
function overview(view, query) {
  const range = Object.hasOwn(RANGES, query.get('range')) ? query.get('range') : DEFAULT_RANGE;
  const now = view.generatedAt;
  const open = view.prs.filter(p => ['open', 'draft'].includes(p.status)), active = view.agents.reduce((n, a) => n + (a.jobs || []).filter(j => !j.paused).length, 0), available = view.agents.filter(a => a.state === 'idle').length;
  const tokens = Object.values(view.usage).reduce((s, u) => s + u.totalTokens, 0);
  const daily = Object.values(view.graphs.jobsPerDay).map(d => Object.values(d).reduce((a, b) => a + b, 0));
  const verdicts = view.verdicts;
  const warnCount = view.panels.warnings.length + (view.agents.some(a => a.state === 'unknown') ? 1 : 0);
  const panels = [
    breakerCard(view),
    robustnessCard(view),
    card({ id: 'now', title: 'Now', span: 3, body: approvals(view, nowPanel(view, { list: 'now' }), esc, ago), href: '/agents', cls: 'panel', type: 'panel' }),
    card({ id: 'next', title: 'Next', span: 3, body: nextPanel(view), href: '/work', cls: 'panel', type: 'panel' }),
    card({ id: 'needs', title: `Needs you${view.panels.needsYou.length ? ` (${view.panels.needsYou.length})` : ''}`, span: 3, body: needsPanel(view), href: '/work', cls: 'panel', type: 'panel' }),
    card({ id: 'later', title: `Later${(view.panels.later || []).length ? ` (${view.panels.later.length})` : ''}`, span: 3, body: laterPanel(view), href: '/work', cls: 'panel', type: 'panel' }),
    card({ id: 'warnings', title: `Warnings${warnCount ? ` (${warnCount})` : ''}`, span: 3, body: warningsPanel(view), href: '/system', cls: 'panel', type: 'panel' })
  ].join('');
  const kpis = [
    kpi({ id: 'k-active', label: 'Jobs running', value: view.agents.some(a => a.state === 'unknown') ? `? / ${view.capacity ?? view.agents.length}` : `${active} / ${view.capacity ?? view.agents.length}`, href: '/agents' }),
    kpi({ id: 'k-avail', label: 'Agents available', value: view.agents.some(a => a.state === 'unknown') ? '?' : `${available} / ${view.agents.length}`, href: '/agents' }),
    kpi({ id: 'k-prs', label: 'Open pull requests', value: String(open.length), href: '/work', spark: sparkline(daily) }),
    kpi({ id: 'k-queue', label: 'Queued items', value: String(queueSplit(view).total), sub: queueSub(view, active), href: '/work' }),
    kpi({ id: 'k-reviews', label: 'Reviews recorded', value: String(verdicts.length), href: '/reviews' }),
    kpi({ id: 'k-tokens', label: 'Tokens recorded', value: tokens ? num(tokens) : 'unknown', href: '/usage' }),
    kpi({ id: 'k-fresh', label: 'Data age', value: view.freshness.ageMs === null ? 'none' : dur(view.freshness.ageMs), sub: 'how old the GitHub data behind this page is', href: '/system' })
  ].join('');
  const charts = [
    card({ id: 'c-allow', title: `Allowance used (${range})`, span: 6, href: '/usage', expandable: true, tools: rangeSelector('/', query, range), body: lineChart({ series: allowanceSeries(view, range), resets: allResets(view, range), expected: allExpected(view), now, range, title: 'allowance used over time' }), cls: 'chart-card', type: 'chart' }),
    card({ id: 'c-jobs', title: `Jobs per day (${range})`, span: 6, href: '/activity', expandable: true, body: stackedChart({ days: view.graphs.jobsPerDay, title: 'jobs per day', range, now }), cls: 'chart-card', type: 'chart' })
  ].join('');
  return { title: 'Overview', body: `${grid('overview', headlineCards(view) + watchingCard(view) + sincePanel(view, query) + panels + kpis + charts)}`, bodyClass: 'overview' };
}

function agentsPage(view, query, path) {
  const cards = view.agents.map(a => {
    const q = view.queues[a.name] || [];
    return card({ id: `a-${a.name}`, title: a.name, span: 6, href: `/agents/${encodeURIComponent(a.name)}`, movable: true, body: `<p>${stateBadge(a.state)} <span class="sub">${esc(a.provider)} · last activity ${esc(ago(a.lastActivityAt, view.generatedAt))}</span></p>${nowPanel({ ...view, agents: [a] }, { describe: false })}${budgetBlock(view, a.name)}<p class="sub">${q.length} queued · <a href="/agents/${encodeURIComponent(a.name)}">Job history and queue</a></p>` });
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
    cols: [{ key: 'next', label: 'Next', html: r => (r.next ? badge('info', 'Next') : '') }, { key: 'type', label: 'Type' }, { key: 'ref', label: 'Item', num: true, html: r => (r.type === 'inbox' ? `Inbox lane: ${esc(r.title)}` : r.type === 'issue' ? issueLink(r.ref) : prLink(r.ref)) }, { key: 'est', label: 'Est. finish', html: r => { const e = r.type === 'review' || r.type === 'inbox' ? null : estFor(view, r.type === 'issue' ? 'issue' : 'pr', r.ref); return e && !(e.status === 'estimated' && !meaningfulRange(e, view.generatedAt)) ? `<span title="${esc((e.basis || []).join('\n'))}" data-est="${esc(e.status)}">${esc(e.text)}</span>` : ''; } }, { key: 'reason', label: 'Reason', more: true }],
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
  const queues = Object.entries(view.queues).map(([name, items]) => card({ id: `wq-${name}`, title: `Queue: ${name}`, span: 6, movable: true, type: 'queue', body: items.length ? `<ul class="panel-list">${items.slice(0, 8).map(i => `<li class="sev-${i.next ? 'info' : 'ok'}"><div class="t">${i.next ? badge('info', 'Next') + ' ' : ''}${i.type === 'inbox' ? `${badge('info', 'Inbox lane')} ${esc(i.title)}` : `${i.type === 'issue' ? issueLink(i.ref) : prLink(i.ref)} ${watchBtn(view, i.type === 'issue' ? 'issue' : 'pr', i.ref, '/work')}`}</div><div class="sub">${esc(i.reason)}</div>${i.type === 'review' || i.type === 'inbox' ? '' : estHtml(estFor(view, i.type === 'issue' ? 'issue' : 'pr', i.ref), view.tz, view.generatedAt)}</li>`).join('')}</ul>${items.length > 8 ? `<p class="sub">+${items.length - 8} more on <a href="/agents/${encodeURIComponent(name)}">the agent page</a></p>` : ''}` : empty('Queue is empty', 'Nothing is waiting for this agent.', 'check') })).join('');
  const issues = card({ id: 'issues', title: 'Issues', span: 12, movable: false, body: showChip(path, query, 'issues.show', 'blocked', 'Showing only open issues blocked by dependencies') + table({ id: 'issues', path, query, noun: 'issues', rows: view.issues.filter(i => query.get('issues.show') !== 'blocked' || (i.state === 'OPEN' && i.blockedBy.length)).map(i => ({ ...i, blockers: i.blockedBy.length, need: i.needsHomeowner ? 'yes' : '' })), searchKeys: ['name', 'title', 'agent', 'number', 'state', 'reason'],
    cols: [{ key: 'number', label: 'Issue', num: true, html: r => `${issueLink(r.number)} ${watchBtn(view, 'issue', r.number, path)}` }, { key: 'state', label: 'State' }, { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) },
      { key: 'blockers', label: 'Blockers', num: true, html: r => (r.blockedBy.length ? r.blockedBy.map(issueLink).join(', ') : '–') }, { key: 'reason', label: 'Status', more: true }],
    totals: { number: 'count', blockers: 'sum' }, emptyState: empty('No issues cached', 'The first tick fills the cache.', 'list') }) });
  const prs = card({ id: 'prs', title: 'Pull requests', span: 12, movable: false, body: showChip(path, query, 'prs.show', 'awaiting-review', 'Showing only pull requests waiting for review') + table({ id: 'prs', path, query, noun: 'pull requests', rows: view.prs.filter(p => query.get('prs.show') !== 'awaiting-review' || p.awaitingReview), searchKeys: ['name', 'title', 'agent', 'status', 'number', 'verdict'],
    cols: [{ key: 'number', label: 'Pull request', num: true, html: r => `${prLink(r.number)} ${watchBtn(view, 'pr', r.number, path)}` }, { key: 'agent', label: 'Author', html: r => agentTag(r.agent, view) }, { key: 'status', label: 'State', html: r => esc(r.stage ? `${r.status} (${r.stage})` : r.status) },
      { key: 'checks', label: 'CI', html: r => checksBadge(r.checks) }, { key: 'verdict', label: 'Verdict', html: r => verdictBadge(r.verdict) }, { key: 'reviewRounds', label: 'Review rounds', num: true, more: true },
      { key: 'fixRounds', label: 'Fix rounds', num: true, more: true }, { key: 'rebaseRounds', label: 'Rebase rounds', num: true, more: true }, { key: 'tokens', label: 'Tokens', num: true, html: r => esc(num(r.tokens)), more: true }],
    totals: { number: 'count', reviewRounds: 'avg', fixRounds: 'avg', tokens: 'sum' }, emptyState: empty('No pull requests yet', 'Pull requests appear once an agent opens one.', 'list') }) });
  const ex = view.excluded || [];
  const excluded = card({ id: 'excluded', title: `Excluded issues (${ex.length})`, span: 12, movable: false, body: ex.length ? `<ul class="panel-list">${ex.map(e => `<li class="sev-info"><div class="t">${issueLink(e.number)}</div><div class="sub">${esc(e.reason)}</div></li>`).join('')}</ul>` : empty('Nothing is excluded', 'Every open issue is eligible.', 'check') });
  return { title: 'Work', body: grid('work', queues + issues + excluded + prs, 'fit') };
}
function prDetail(view, query, path, route) {
  const p = view.prs.find(x => x.number === route.id);
  if (!p) return null;
  const facts = card({ id: 'facts', title: p.full || p.name, span: 12, movable: false, body: `<dl class="kv"><dt>State</dt><dd>${esc(p.stage ? `${p.status} (${p.stage})` : p.status)}</dd><dt>Author</dt><dd>${agentTag(p.agent, view)}</dd><dt>CI</dt><dd>${checksBadge(p.checks)}</dd><dt>Latest verdict</dt><dd>${verdictBadge(p.verdict)}</dd>${p.carry ? `<dt>Carried verdict</dt><dd>${esc(`${String(p.carry.oldHead).slice(0, 7)} → ${String(p.carry.newHead).slice(0, 7)}`)}${p.carry.valid ? '' : ' (record does not match this head)'}<br>${esc(`no conflict resolved: ${p.carry.evidence.resolvedConflicts === false ? 'yes' : 'not shown'}; patch unchanged: ${p.carry.evidence.patchUnchanged === true ? 'yes' : 'not shown'}; CI: ${p.carry.evidence.ci || 'unknown'}`)}</dd>` : ''}
<dt>Rounds</dt><dd>${p.reviewRounds} review · ${p.fixRounds} fix · ${p.rebaseRounds} rebase</dd><dt>Tokens</dt><dd>${esc(num(p.tokens))}</dd><dt>On GitHub</dt><dd>${ext(p.url, p.name || `PR #${p.number}`)}</dd><dt>Watch</dt><dd>${watchBtn(view, 'pr', p.number, path)}</dd></dl>` });
  const tl = card({ id: 'tl', title: 'Timeline', span: 6, movable: false, body: p.timeline.length ? `<ol class="tl">${p.timeline.map(r => `<li><b>${lt(r.at)}</b><br>${esc(r.text)}</li>`).join('')}</ol>` : empty('No events recorded', 'Review, fix and merge events appear here.', 'clock') });
  const vh = card({ id: 'vh', title: 'Verdict history', span: 6, movable: false, body: p.verdicts.length ? p.verdicts.map(v => `<h3>${verdictBadge(v.verdict)} ${esc(v.reviewer)}${v.model ? ` <span class="sub">(${esc(v.model)})</span>` : ''} at ${v.fullHead ? shaCopy(v.fullHead) : `<span class="mono">${sha7(v.head)}</span>`} <span class="sub">${lt(v.at)}</span></h3>${v.findings.length ? `<ul>${v.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="sub">No findings recorded.</p>'}${v.followUpIssue ? `<p class="sub">Follow-up: ${issueLink(v.followUpIssue)}</p>` : ''}`).join('') : empty('No verdicts yet', 'No independent reviewer has reviewed this pull request.', 'review') });
  const jobs = card({ id: 'pj', title: 'Jobs on this PR', span: 12, movable: false, body: table({ id: 'jobs', path, query, noun: 'jobs', rows: p.jobs, searchKeys: ['id', 'kind', 'status', 'agent'], cols: jobCols(view).map(c => ({ ...c, total: undefined })), totals: jobTotals, emptyState: empty('No jobs recorded', 'Jobs that reviewed or fixed this PR show here.', 'list') }) });
  return { title: p.name || `PR #${p.number}`, crumbs: [['/work', 'Work'], [null, p.name || `PR #${p.number}`]], body: grid('pr', facts + tl + vh + jobs, 'fit') };
}
function issueDetail(view, query, path, route) {
  const i = view.issues.find(x => x.number === route.id);
  if (!i) return null;
  const dependents = view.issues.filter(o => o.dependsOn.includes(i.number));
  const deps = i.dependsOn.length ? `<ul class="panel-list">${i.dependsOn.map(d => { const di = view.issues.find(x => x.number === d); const blocked = i.blockedBy.includes(d); return `<li class="sev-${blocked ? 'warning' : 'ok'}"><div class="t">${blocked ? badge('warning', 'Blocking') : badge('ok', 'Done')} ${issueLink(d)}</div></li>`; }).join('')}</ul>` : empty('No prerequisites', 'This issue does not wait on another one.', 'check');
  const facts = card({ id: 'facts', title: i.name || `#${i.number}`, span: 12, movable: false, body: `<dl class="kv"><dt>State</dt><dd>${esc(i.state)}</dd><dt>Assigned to</dt><dd>${agentTag(i.agent, view)}</dd><dt>Status</dt><dd>${esc(i.reason || '–')}</dd>
<dt>Needs homeowner</dt><dd>${i.needsHomeowner ? badge('action', 'Yes') : 'No'}</dd><dt>On GitHub</dt><dd>${ext(i.url, i.name || `#${i.number}`)}</dd><dt>Watch</dt><dd>${watchBtn(view, 'issue', i.number, path)}</dd></dl>` });
  return { title: i.name || `#${i.number}`, crumbs: [['/work', 'Work'], [null, i.name || `#${i.number}`]], body: grid('issue', facts + card({ id: 'deps', title: 'Dependencies and blockers', span: 6, movable: false, body: deps })
    + card({ id: 'dependents', title: 'Waiting on this issue', span: 6, movable: false, body: dependents.length ? `<ul class="panel-list">${dependents.map(d => `<li class="sev-info"><div class="t">${issueLink(d.number)}</div></li>`).join('')}</ul>` : empty('Nothing waits on it', 'No cached issue lists this one as a prerequisite.', 'check') }), 'fit') };
}

// Issue #362: the whole retained history, from the first job. Read from files only (no GitHub, no model); every field was allowlisted
// and redacted when it was archived, and the text shown is rebuilt from those fields. Filters are plain GET parameters.
const KIND_LABEL = { job: 'Job', verdict: 'Review', merge: 'Merge', rebase: 'Rebase', description: 'Description round', unblock: 'Unblock', migration: 'Migration' };
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
// One agent's allowance card (issue #75, supervisor/allowancecard.mjs): the helpers it needs are passed in.
const allowanceBody = (u, now, name = '') => allowanceCard({ esc, badge, lt, dur, pct, inFuture, ago, empty }, u, now, name);
// Issue #1330: each agent's allowance card; a refresh just asked for adds the sentence saying what it found, under the card's Refresh allowance button.
function usageAgentCards(view, query, now) {
  return Object.entries(view.usage).map(([name, u]) => card({ id: `u-${name}`, title: `Allowance: ${name}`, span: 6, movable: true,
    body: budgetBlock(view, name) + allowanceBody(u, now, name) + outcomeNote(outcomeFromQuery(query, name), u, now, { esc, lt, ago }) })).join('');
}
function usagePage(view, query, path) {
  const range = Object.hasOwn(RANGES, query.get('range')) ? query.get('range') : DEFAULT_RANGE, now = view.generatedAt;
  const win = usageAgentCards(view, query, now);
  const chart = card({ id: 'u-chart', title: `Allowance used over time (${range})`, span: 12, expandable: true, tools: rangeSelector(path, query, range), movable: true, body: lineChart({ series: allowanceSeries(view, range), resets: allResets(view, range), expected: allExpected(view), now, range, title: 'allowance used over time' }) });
  const toks = view.graphs.tokensPerPr.slice(-12).map(m => ({ label: `PR #${m.pr}${m.agent ? ' ' + m.agent : ''}`, value: m.tokens, series: m.agent || 'unknown', colour: colourOf(m.agent) }));
  const tokChart = card({ id: 'u-tok', title: 'Tokens per merged PR', span: 12, expandable: true, movable: true, body: barChart({ rows: toks, title: 'tokens per merged PR', emptyTitle: 'No merged PR has recorded tokens' }) });
  const usd = n => formatCost(n);   // issue #1097: pounds, one formatter (money.mjs)
  const ucols = [jobCols(view)[0], jobCols(view)[1], jobCols(view)[2], jobCols(view)[3], jobCols(view)[4],
    { key: 'inTokens', label: 'Input tokens', num: true, html: r => esc(num(r.inTokens)) }, { key: 'outTokens', label: 'Output tokens', num: true, html: r => esc(num(r.outTokens)) },
    { key: 'cost', label: 'CLI cost estimate (£)*', num: true, html: r => esc(usd(r.cost)), fmt: usd, more: true }];
  const table_ = card({ id: 'u-jobs', title: 'Tokens per job', span: 12, movable: false, body: table({ id: 'jobs', path, query, noun: 'jobs', rows: view.jobs, searchKeys: ['id', 'agent', 'kind', 'status'], totals: { id: 'count', inTokens: 'sum', outTokens: 'sum', cost: 'sum' }, cols: ucols,
    emptyState: empty('No jobs recorded', 'Token counts appear after a job finishes.', 'chart') }) + '<p class="sub">*Token counts and the CLI cost estimate are what the CLI reported, not billing. Subscription use is not billed per token.</p>' });
  const mcols = [{ key: 'kind', label: 'Job type' }, { key: 'model', label: 'Model' }, { key: 'effort', label: 'Effort' }, { key: 'jobs', label: 'Jobs', num: true },
    { key: 'inTokens', label: 'Input tokens', num: true, html: r => esc(num(r.inTokens)) }, { key: 'outTokens', label: 'Output tokens', num: true, html: r => esc(num(r.outTokens)) },
    { key: 'cost', label: 'CLI cost estimate (£)*', num: true, html: r => esc(usd(r.cost)), fmt: usd }];
  const byModel = card({ id: 'u-models', title: 'Tokens per job type and model', span: 12, movable: false, body: table({ id: 'models', path, query, noun: 'groups', rows: view.modelUsage || [], searchKeys: ['kind', 'model', 'effort'], totals: { jobs: 'sum', inTokens: 'sum', outTokens: 'sum', cost: 'sum' }, cols: mcols,
    emptyState: empty('No model usage recorded', 'Token counts appear per job type and model after jobs finish.', 'chart') }) });
  const fs_ = view.failedSpend || { jobs: 0, rows: [] };
  const fcols = [{ key: 'name', label: 'Job' }, { key: 'status', label: 'Status' }, { key: 'attempts', label: 'Attempts', num: true },
    { key: 'tokens', label: 'Tokens', num: true, html: x => esc(num(x.tokens)) }, { key: 'cost', label: 'CLI cost estimate (£)*', num: true, html: x => esc(usd(x.cost)), fmt: usd }];
  const failed = card({ id: 'u-failed', title: `Failed attempts: ${fs_.jobs} job${fs_.jobs === 1 ? '' : 's'}, ${fs_.tokens == null ? 'unknown' : num(fs_.tokens)} tokens, ${usd(fs_.cost)}`, span: 12, movable: false, body: table({ id: 'failed', path, query, noun: 'failed jobs', rows: fs_.rows, searchKeys: ['name', 'kind', 'status'], totals: { attempts: 'sum', tokens: 'sum', cost: 'sum' }, cols: fcols,
    emptyState: empty('No failed attempts', 'Jobs that ended failed or blocked, with the tokens and cost they used, are listed here.', 'chart') }) });
  const limits = resetsCard({ esc, card, badge, lt }, view.limitResets);
  return { title: 'Usage & cost', body: `${grid('usage', limits + win + chart + tokChart + byModel + failed + table_)}` };
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
<dt>Last good tick</dt><dd>${t?.lastOkAt ? esc(ago(t.lastOkAt, now)) : 'never'}</dd>${t?.error ? `<dt>Error</dt><dd>${errCopy(t.error)}</dd>` : ''}<dt>Next tick</dt><dd>${nextTickHtml(view, now) || 'none'}</dd>
<dt>Data freshness</dt><dd>${badge(view.freshness.level, view.freshness.label)} GitHub data cached ${esc(ago(view.cacheFetchedAt, now))}</dd><dt>Page built</dt><dd>${lt(now)}</dd><dt>Processes</dt><dd><a href="/system/processes">Live processes per agent</a></dd><dt>UI review evidence</dt><dd><a href="/evidence">Browse review runs</a></dd></dl>` });
  const ver = card({ id: 'ver', title: 'Version', span: 6, movable: false, body: v ? `<dl class="kv"><dt>Installed</dt><dd>${shaCopy(v.installed)}</dd><dt>Main</dt><dd>${shaCopy(v.main)}</dd>${v.mcp ? `<dt>MCP server</dt><dd>${v.mcp.installed ? shaCopy(v.mcp.installed) : 'not installed'} ${v.mcp.drift ? badge('action', 'differs from Foreman') : badge('ok', 'same as Foreman')}${v.mcp.last?.result === 'failed' ? ` ${badge('action', 'last install failed')} ${esc(v.mcp.last.reason)}` : ''}</dd>` : ''}<dt>State</dt><dd>${(vs => badge(vs.level, escT(vs.label), '', true))(versionStatus(v))}</dd><dt>Last upgrade result</dt><dd>${esc(v.result)}</dd></dl><p class="sub"><a href="/supervisor">Supervisor health</a> · <a href="/supervisor/upgrades">Upgrade history</a></p>` : empty('No version record', 'The self-upgrade step has not recorded anything yet.', 'info') });
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
<dt>Last install</dt><dd>${c.install ? `${badge(c.install.severity, c.install.result)}${c.install.sha ? ` ${shaCopy(c.install.sha)}` : ''}${c.install.at ? ` <span class="sub">${esc(ago(c.install.at, now))}</span>` : ''}${c.install.reason ? `<br>${errCopy(c.install.reason)}` : ''}${c.install.retried ? ' <span class="sub">(failed twice, each in a fresh copy)</span>' : ''}${c.install.excerpt ? `<details><summary>Failure output</summary><pre>${esc(c.install.excerpt)}</pre></details>` : ''}` : '<span class="muted">no record</span>'}</dd>
<dt>Next attempt</dt><dd>${c.install?.nextAttemptAt ? lt(c.install.nextAttemptAt) : '<span class="muted">none scheduled</span>'}</dd>
<dt>Last upgrade</dt><dd>${u ? `${badge(resultSeverity(u.result), u.result)} ${shaCopy(u.from)} → ${shaCopy(u.to)} <span class="sub">${esc(ago(u.at, now))}</span>${u.reason ? `<br>${errCopy(u.reason)}` : ''}` : '<span class="muted">no record</span>'}</dd>
<dt>Pre-check latched</dt><dd>${list(c.prechecked.map(p => `<li>${shaCopy(p.sha)} since ${lt(p.at)}${p.isMain ? ` ${badge('warning', 'is origin/main')}` : ''}</li>`))}</dd>
${c.latch ? `<dt>Rollback latch</dt><dd>${badge('action', 'Set')} ${errCopy(c.latch.reason)}</dd>` : ''}${c.pending ? `<dt>Pending</dt><dd>${shaCopy(c.pending.to)} awaiting a live tick</dd>` : ''}`;
  } else if (c.id === 'tick') {
    const t = c.tick;
    dl = t ? `<dt>When</dt><dd>${lt(t.at)} <span class="sub">(${esc(ago(t.at, now))}${c.stale ? ', more than two intervals' : ''})</span></dd><dt>Status</dt><dd>${tickStatusBadge(t.status)}</dd>
<dt>Verdicts ingested</dt><dd>${t.ingested.length}</dd><dt>Actions</dt><dd>${list(t.actions.map(a => `<li>${esc(a.agent)} ${esc(a.type === 'cifix' ? 'fix CI' : a.type)} ${tickRef(a)}</li>`))}</dd>
<dt>Skipped</dt><dd>${t.note ? esc(t.note) : list(t.skipped.map(s => `<li><b>${esc(s.what)}</b>: ${errCopy(s.reason)}</li>`))}</dd>` : '';
  } else if (c.id === 'testruns') {
    dl = `<dt>Running (limit ${c.limit})</dt><dd>${list(c.running.map(r => `<li>${esc(r.label)} <span class="sub">since ${lt(r.since)}</span></li>`))}</dd><dt>Waiting</dt><dd>${list(c.waiting.map(w => `<li>${esc(w.label)} <span class="sub">since ${lt(w.since)}</span></li>`))}</dd>
<dt>Skipped ticks (last hour)</dt><dd>${list(c.skips.map(s => `<li>${lt(s.at)}: ${errCopy(s.reason)}</li>`))}</dd>`;
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
  return { title: 'Supervisor', body: grid('supervisor', cards + ticks + leases) };
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
  return { title: `Job ${route.id.slice(0, 8)}`, crumbs: [['/work', 'Work'], [null, `Job ${route.id.slice(0, 8)}`]], body: `${grid('watch', panel)}<script type="module" src="/static/watch.js"></script>` };
}
// ---- UI review evidence (issue #455): read-only browsing of <evidence root>/ui-review. Data comes from evidence.mjs through route.data.
const evUrl = parts => `/evidence/files/${parts.map(encodeURIComponent).join('/')}`;
const PROFILE_ORDER = ['desktop', 'tablet', 'phone', 'other'];
const profileGroup = p => (PROFILE_ORDER.includes(p.split('-')[0]) ? p.split('-')[0] : 'other');
const shot = (run, parts, caption) => `<figure class="ev-shot"><a href="${esc(evUrl([run, ...parts]))}"><img src="${esc(evUrl([run, ...parts]))}" alt="${esc(caption)}" loading="lazy"></a><figcaption>${esc(caption)}</figcaption></figure>`;
function evidencePage(view, query, path, route) {
  const data = route.data || { available: false, runs: [] };
  const rows = data.runs.map(r => `<tr><td><a href="/evidence/${esc(encodeURIComponent(r.name))}">${esc(r.name)}</a></td><td>${lt(r.mtime)}</td><td>${r.commit ? esc(String(r.commit).slice(0, 12)) : '<span class="muted">not recorded</span>'}</td><td>${r.source ? esc(r.source) : '<span class="muted">not recorded</span>'}</td><td class="num">${r.screenshots}</td><td class="num">${r.pairs}</td><td>${r.hasReport ? badge('ok', 'Report') : badge('info', 'No report')}</td></tr>`).join('');
  const body = data.runs.length ? `<div class="tbl-wrap"><table><thead><tr><th scope="col">Review run</th><th scope="col">Last changed</th><th scope="col">Commit</th><th scope="col">Data source</th><th scope="col" class="num">Screenshots</th><th scope="col" class="num">Before/after pairs</th><th scope="col">Report</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : empty(data.available ? 'No review run yet' : 'No evidence folder yet', data.available ? 'A UI review writes its report, manifest and screenshots to a folder here.' : 'The ui-review evidence folder does not exist on this host yet; the first UI review creates it.', 'review');
  return { title: 'UI review evidence', crumbs: [['/system', 'System'], [null, 'UI review evidence']], bodyClass: 'ev', body: grid('evidence', card({ id: 'ev-runs', title: `Review runs (${data.runs.length})`, span: 12, movable: false, body: `${body}<p class="sub">Read-only. Screenshots are kept outside Git. Only png, json and md files in the review evidence folder are shown.</p>` })) };
}
function evidenceRunPage(view, query, path, route) {
  const r = route.data;
  if (!r) return null;
  const facts = r.manifest.facts.length ? `<dl class="kv">${r.manifest.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : `<p class="sub">${r.manifest.invalid ? 'manifest.json could not be read as an object.' : r.manifest.present ? 'The manifest has no simple fields to show.' : 'No manifest.json in this run.'}</p>`;
  const files = [...(r.hasManifest ? ['manifest.json'] : []), ...r.others.filter(f => f !== 'manifest.json')].map(f => `<a class="btn" href="${esc(evUrl([r.name, f]))}">${esc(f)}</a>`).join(' ');
  const info = card({ id: 'ev-info', title: 'Manifest', span: 4, movable: false, body: `${facts}${files ? `<p>${files}</p>` : ''}` });
  const report = card({ id: 'ev-report', title: 'Report', span: 8, movable: false, body: r.report ? `<pre class="ev-report" tabindex="0" aria-label="Report text">${esc(r.report)}</pre>` : empty(r.reportTooLarge ? 'Report is too large to show' : 'No report.md in this run', r.reportTooLarge ? 'Open it from the file list instead.' : 'The audit PR carries the report.', 'info') });
  const pairBlock = r.pairs.length ? PROFILE_ORDER.map(g => ({ g, items: r.pairs.filter(p => profileGroup(p.profile) === g) })).filter(x => x.items.length).map(({ g, items }) => `<h3 class="ev-h">${esc(g)}</h3><div class="ev-pairs">${items.map(p => `<div class="ev-pair"><div class="ev-name">${esc(p.name)}</div><div class="ev-sides"><div><div class="ev-side">Before</div>${shot(r.name, p.before, `Before: ${p.name}`)}</div><div><div class="ev-side">After</div>${shot(r.name, p.after, `After: ${p.name}`)}</div></div></div>`).join('')}</div>`).join('') : '';
  const unpaired = r.unpaired.length ? `<p class="sub">Without a partner: ${r.unpaired.map(u => `${esc(u.side)}/${esc(u.name)}`).join(', ')}</p>` : '';
  const pairs = card({ id: 'ev-pairs', title: `Before and after (${r.pairs.length})`, span: 12, movable: false, body: (pairBlock || empty('No before/after pair', 'Pairs are PNG files with the same name in the before/ and after/ folders.', 'info')) + unpaired });
  const shotBlock = r.shots.length ? PROFILE_ORDER.map(g => ({ g, items: r.shots.filter(s => profileGroup(s.profile) === g) })).filter(x => x.items.length).map(({ g, items }) => `<h3 class="ev-h">${esc(g)}</h3><div class="ev-grid">${items.map(s => shot(r.name, s.parts, s.name)).join('')}</div>`).join('') : empty('No screenshot', 'PNG files placed in the run folder appear here, grouped by desktop, tablet and phone.', 'info');
  const shots = card({ id: 'ev-shots', title: `Screenshots (${r.shots.length})`, span: 12, movable: false, body: shotBlock });
  return { title: `Review run ${r.name}`, crumbs: [['/system', 'System'], ['/evidence', 'UI review evidence'], [null, r.name]], bodyClass: 'ev', body: grid('evidence-run', info + report + pairs + shots) };
}
// ---- Diagnostics (issue #496): where the cycle loses time, over a stated retention window. Read-only; data comes from diagnostics.mjs through route.data.
const mins = n => (Number.isFinite(n) ? `${n} min` : '–');
const plainTable = (head, rows, label) => `<div class="tbl-wrap"><table aria-label="${esc(label)}"><thead><tr>${head.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''} data-label="${esc(head[i])}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const diagSpark = (hourly, key, label, unit) => {
  const v = hourly.map(h => h[key]).filter(Number.isFinite);
  return `<div class="diag-spark" data-diag-series="${esc(key)}"><span class="muted">${esc(label)}</span> ${sparkline(v, 'var(--s3)')}<span class="sub">highest hour ${v.length ? esc(Math.max(...v)) : '–'}${esc(unit)}</span></div>`;
};
function diagnosticsPage(view, query, path, route) {
  const d = route.data;
  if (!d) return { title: 'Diagnostics', body: `${grid('diagnostics', card({ id: 'diag-none', title: 'Diagnostics', span: 12, movable: false, body: empty('Diagnostics are not available here', 'This page was rendered without its data.', 'warn') }))}` };
  const intro = card({ id: 'diag-about', title: 'What this shows', span: 12, movable: false, body: `<p class="sub" data-diag-retention>Read-only history of the last ${esc(d.retentionDays)} days (UTC days), then dropped from this page; the supervisor's own records are kept longer. Every figure comes from files already on the host: no model call and no GitHub call. The recorder logs are read in bounded amounts (at most ${esc(MAX_FILE_BYTES / 1048576)} MiB per file and ${esc(MAX_TOTAL_BYTES / 1048576)} MiB per page view, only the new part of a file after the first read).</p>` });
  const t = d.ticks;
  const ticks = card({ id: 'diag-ticks', title: 'Gaps between ticks, planned and actual', span: 12, movable: false, body: `<p class="sub">Planned: one tick every ${esc(t.plannedMinutes)} min. A gap of ${esc(t.lateAtMinutes)} min or more is a missed tick. Lost minutes are the time beyond the plan.</p>${plainTable(['Day', 'Ticks', 'Median gap', 'Longest gap', 'Missed ticks', 'Lost'], t.days.map(r => [r.day, r.ticks, mins(r.medianMinutes), mins(r.maxMinutes), r.count ? r.lateCount : '–', r.count ? mins(r.lostMinutes) : '–']), 'Gaps between ticks per day')}` });
  const turn = card({ id: 'diag-turnaround', title: 'Job end to the next job start, per agent', span: 12, movable: false, body: d.agents.length ? `<p class="sub">Time an agent had no job between one job ending and the next starting.</p>${d.agents.map(a => `<h3 class="ev-h" data-diag-agent="${esc(a)}">${esc(a)}</h3>${plainTable(['Day', 'Gaps', 'Median', 'Longest', 'Total'], d.turnaround[a].days.map(r => [r.day, r.count, mins(r.medianMinutes), mins(r.maxMinutes), r.count ? mins(r.totalMinutes) : '–']), `${a} job gaps per day`)}`).join('')}` : empty('No agent configured', 'No agent is in the team configuration.', 'info') });
  const lag = card({ id: 'diag-verdicts', title: 'Review end to verdict recorded', span: 12, movable: false, body: `<p class="sub">Time from a review job ending to the dispatcher recording its verdict. Carried verdicts are not counted.</p>${plainTable(['Day', 'Verdicts', 'Median', 'Longest', 'Total'], d.verdictLag.days.map(r => [r.day, r.count, mins(r.medianMinutes), mins(r.maxMinutes), r.count ? mins(r.totalMinutes) : '–']), 'Verdict recording time per day')}` });
  const idleRows = d.idle.flatMap(r => d.agents.map(a => { const x = r.agents[a]; return x ? [r.day, a, mins(x.busyMinutes), mins(x.idleWithWorkMinutes), `${x.idleWithWorkPercent}%`, mins(x.minutes['waiting-for-tick']), mins(x.minutes['tick-run']), mins(x.minutes.upgrade), mins(x.minutes['named-hold'])] : null; })).filter(Boolean);
  const idle = card({ id: 'diag-idle', title: 'Idle time by cause, per day', span: 12, movable: false, body: `<p class="sub">The same measure as the Agents page (idle with work available), one row per agent and day.</p>${plainTable(['Day', 'Agent', 'Busy', 'Idle with work', 'Share of day', 'Waiting for tick', 'Tick run', 'Upgrade', 'Named hold'], idleRows, 'Idle time by cause per day')}` });
  // Issue #406: passes by what started them, and the wake cap. A dropped request is said plainly; the schedule is the fallback.
  const ps = d.passes, wk = d.wake;
  const wakeCard = ps ? card({ id: 'diag-passes', title: 'Passes by trigger', span: 12, movable: false, body: `${wk?.capHit ? `<p class="sub" data-diag-wake-cap role="alert"><strong>Wake cap reached:</strong> ${esc(wk.droppedLastHour)} request${wk.droppedLastHour === 1 ? '' : 's'} dropped in the last hour (${esc(wk.acceptedLastHour)} of ${esc(wk.cap)} used). Work waits for the five-minute schedule until the hour rolls over.</p>` : wk ? `<p class="sub" data-diag-wake>Event wakes in the last hour: ${esc(wk.acceptedLastHour)} of ${esc(wk.cap)} allowed. The five-minute schedule always runs as well.</p>` : ''}${d.lastPass ? `<p class="sub" data-diag-last-pass>Last pass (${esc(d.lastPass.trigger)}): ${esc(d.lastPass.seconds)} s${d.lastPass.phases.length ? `; ${d.lastPass.phases.map(([k, s]) => `${esc(k)} ${esc(s)} s`).join(', ')}` : ''}.</p>` : ''}${wk?.pending ? `<p class="sub" data-diag-wake-pending>Waiting for the running pass: ${esc(wk.pending.reasons.join(', '))}${wk.pending.ageSeconds == null ? '' : ` (waiting ${esc(wk.pending.ageSeconds)} s)`}.</p>` : ''}<p class="sub">${esc(ps.total)} passes in the last ${esc(d.retentionDays)} days, ${esc(ps.didNothing)} did nothing. ${ps.unlabelled ? `${esc(ps.unlabelled)} were recorded before triggers were kept and are counted as scheduled. ` : ''}A pass that did nothing planned no action. ${ps.noop ? `${esc(ps.noop)} of them ended early because GitHub was unchanged (median ${ps.seconds?.medianNoop == null ? 'n/a' : esc(Math.round(ps.seconds.medianNoop)) + ' s'} against ${ps.seconds?.medianDidNothingFull == null ? 'n/a' : esc(Math.round(ps.seconds.medianDidNothingFull)) + ' s'} for a full pass that did nothing).` : 'None ended early as unchanged yet.'}</p>${plainTable(['Trigger', 'Passes', 'Started something', 'Did nothing', 'Ended early (unchanged)'], Object.entries(ps.byTrigger).map(([k, v]) => [k, v.passes, v.startedSomething, v.didNothing, v.noop || 0]), 'Passes by trigger')}` }) : '';
  return { title: 'Diagnostics', body: grid('diagnostics', intro + ticks + wakeCard + turn + lag + idle) };
}

// ---- Live processes per agent and job (issue #568). Rendered from a procsample reading; /api/processes returns the same fragment
// so processes.js can swap it in every few seconds. Names only (never arguments); a stale or failed reading is said so and dimmed.
const mb = kb => (Number.isFinite(kb) ? (kb >= 1048576 ? `${dec1(kb / 1048576)} GB` : `${num(Math.round(kb / 1024))} MB`) : '–');
const procLeft = n => (n ? `<span class="badge sev-warning" title="Still running after its job ended">${icon('warn')}${num(n)} leftover</span>` : '');
const nameList = top => (top?.length ? top.map(t => `${esc(t.name)} \u00d7${num(t.count)}`).join(', ') : '–');
function procStatus(sample, now) {
  const st = readingStatus(sample, now), r = sample?.reading;
  if (st === 'none' || !r) return { st: 'none', banner: `<p class="proc-note sev-action">${icon('alert')} No reading yet${sample?.error ? `: ${esc(sample.error)}` : ''}.</p>` };
  const age = dur(Math.max(0, now - r.at)), at = `The figures are from ${esc(age)} ago`;
  if (st === 'failed') return { st, banner: `<p class="proc-note sev-action">${icon('alert')} <b>Reading failed</b> (${esc(sample.error)}). ${at}; they are not current.</p>` };
  if (st === 'stale') return { st, banner: `<p class="proc-note sev-warning">${icon('warn')} <b>Stale reading.</b> ${at}; they are not current.</p>` };
  return { st, banner: `<p class="proc-note muted">Read ${esc(age === '0m' ? 'just now' : age + ' ago')} \u00b7 refreshes about every ${CLIENT_POLL_MS / 1000} s while this page is open \u00b7 memory is resident size (shared pages count in each process)</p>` };
}
function procSpark(sample, agent, colour) {
  const h = sample.history?.[agent] || [];
  return h.length >= 2 ? `<span title="Process count, last ${h.length} readings since the dashboard started">${sparkline(h.map(p => p.processes), colour)}</span>` : '<span class="muted" title="Needs two readings">–</span>';
}
function procTable(cols, rows, extra = '') {
  return `<div class="tbl-wrap"><table class="proc-table"><thead><tr>${cols.map(c => `<th scope="col"${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr${r.cls ? ` class="${r.cls}"` : ''}>${cols.map(c => `<td data-label="${esc(c.label)}"${c.num ? ' class="num"' : ''}>${c.html(r)}</td>`).join('')}</tr>`).join('')}</tbody>${extra}</table></div>`;
}
const jobSubject = j => (j.pr ? prLink(j.pr) : j.issue ? issueLink(j.issue) : '<span class="muted">–</span>');
function procSummary(view, sample, now) {
  const { st, banner } = procStatus(sample, now), r = sample.reading;
  if (!r) return banner;
  const cols = [
    { label: 'Agent', html: a => (a.kind === 'agent' ? `<a href="/system/processes/${esc(encodeURIComponent(a.agent))}">${esc(a.agent)}</a>` : esc(a.label)) },
    { label: 'Processes', num: true, html: a => num(a.processes) }, { label: 'Memory', num: true, html: a => mb(a.rssKb) }, { label: 'Swap', num: true, html: a => mb(a.swapKb) },
    { label: 'Jobs', num: true, html: a => (a.kind === 'agent' ? num(a.jobs) : '–') }, { label: 'Leftovers', html: a => procLeft(a.leftoverProcesses) || '<span class="muted">none</span>' },
    { label: 'History', html: a => procSpark(sample, a.agent || a.key, a.colour) }];
  const rows = [...r.agents.map((a, i) => ({ ...a, kind: 'agent', colour: colourOf(a.agent, i) })),
    { kind: 'row', key: '(unattributed)', label: 'Unattributed', ...r.unattributed, leftoverProcesses: 0, colour: 'var(--s3)', cls: 'proc-un' },
    { kind: 'row', key: 'tower', label: 'Tower total', ...r.total, leftoverProcesses: 0, colour: 'var(--s4)', cls: 'proc-total' }];
  const host = r.host?.swapTotalKb ? `<p class="proc-note muted">Host swap in use: ${mb(r.host.swapUsedKb)} of ${mb(r.host.swapTotalKb)}${r.host.memAvailableKb ? ` \u00b7 memory available: ${mb(r.host.memAvailableKb)} of ${mb(r.host.memTotalKb)}` : ''}</p>` : '';
  const un = r.unattributed.processes ? `<p class="proc-note muted">Unattributed (not tied to any job; never guessed): ${nameList(r.unattributed.top)}${r.ambiguous ? ` \u00b7 ${num(r.ambiguous)} claimed by more than one job` : ''}</p>` : '';
  return `${banner}<div class="proc-body" data-state="${st}">${procTable(cols, rows)}${host}${un}</div>`;
}
function procAgent(view, sample, agent, now) {
  const { st, banner } = procStatus(sample, now), r = sample.reading;
  if (!r) return banner;
  const a = r.agents.find(x => x.agent === agent), jobs = r.jobs.filter(j => j.agent === agent);
  if (!a) return `${banner}<div class="proc-body" data-state="${st}">${empty('No processes attributed to ' + agent, 'None of its jobs has a process running right now.', 'check')}</div>`;
  const cols = [
    { label: 'Job', html: j => jobLink(j.id) }, { label: 'Kind', html: j => esc(j.kind) }, { label: 'PR / issue', html: jobSubject },
    { label: 'Processes', num: true, html: j => num(j.processes) }, { label: 'Memory', num: true, html: j => mb(j.rssKb) }, { label: 'Swap', num: true, html: j => mb(j.swapKb) },
    { label: 'Age', num: true, html: j => (Number.isFinite(j.ageMs) ? esc(dur(j.ageMs)) : '–') },
    { label: 'State', html: j => (j.leftover ? procLeft(j.processes) : badge('ok', 'Running')) }, { label: 'Largest by name', html: j => nameList(j.top) }];
  const head = `<p>${num(a.processes)} processes, ${mb(a.rssKb)} memory, ${mb(a.swapKb)} swap across ${num(a.jobs)} jobs${a.leftoverJobs ? ` (${procLeft(a.leftoverProcesses)} from ${num(a.leftoverJobs)} ended jobs)` : ''}. ${procSpark(sample, agent, colourOf(agent))}</p>`;
  return `${banner}<div class="proc-body" data-state="${st}">${head}${procTable(cols, jobs.map(j => ({ ...j, cls: j.leftover ? 'proc-left' : '' })))}</div>`;
}
export function processesFragment(view, sample, agent = null) {
  REFS = view.refs || { issue: {}, pr: {}, job: {} };
  try { return agent ? procAgent(view, sample, agent, view.generatedAt) : procSummary(view, sample, view.generatedAt); } finally { REFS = { issue: {}, pr: {}, job: {} }; }
}
function processesPage(view, query, pathname, route) {
  const sample = route.sample || { ok: false, error: 'not available', reading: null }, agent = route.agent || null;
  const known = new Set((sample.reading?.agents || []).map(a => a.agent).concat(Object.keys(view.usage || {})));
  if (agent && sample.reading && !known.has(agent)) return null;
  const inner = agent ? procAgent(view, sample, agent, view.generatedAt) : procSummary(view, sample, view.generatedAt);
  const body = card({ id: agent ? 'proc-agent' : 'proc', title: agent ? `Jobs of ${agent}` : 'Processes by agent', span: 12, movable: false, body: `<div data-procs data-agent="${esc(agent || '')}" data-poll="${CLIENT_POLL_MS}">${inner}</div>` });
  return { title: agent ? `Processes: ${agent}` : 'Processes', crumbs: agent ? [['/system', 'System'], ['/system/processes', 'Processes'], [null, agent]] : [['/system', 'System'], [null, 'Processes']], bodyClass: 'procs',
    body: `${grid('processes', body)}<script type="module" src="/static/processes.js"></script>` };
}
const PAGES = { headline: headlinePage, processes: processesPage, diagnostics: diagnosticsPage, health: (view, query, path, route) => healthPage(route, { esc, card, grid, empty, legend, plainTable, diagSpark, utc }), evidence: evidencePage, 'evidence-run': evidenceRunPage, overview, agents: agentsPage, agent: agentDetail, work: workPage, pr: prDetail, issue: issueDetail, job: jobDetail, watch: watchPage, activity: activityPage, timeline: timelinePage, usage: usagePage, reviews: reviewsPage, supervisor: supervisorPage, ticks: ticksPage, upgrades: upgradesPage, system: systemPage };
PAGES.work = withWorkViews(workPage, { esc, lt, badge, agentTag, prLink, issueLink, copyBtn, card, grid, empty });
PAGES.inbox = (view, query) => inboxPage(view, query, { card, decided: decidedBlock, esc, form: inboxForm, grid, tag: inboxTag });

export const PAGE_NAMES = Object.keys(PAGES);

// Returns { status, html }. A drill-down for something that does not exist is a 404 page, not an empty one.
// REFS is a module-level lookup that the link helpers read; it is set for one synchronous render and cleared after (issue #182).
export function renderRoute(view, route, opts = {}) {
  REFS = view.refs || { issue: {}, pr: {}, job: {} };
  try { return renderRouteWith(view, route, opts); } finally { REFS = { issue: {}, pr: {}, job: {} }; }
}
function renderRouteWith(view, route, { query = new URLSearchParams(), pathname = '/', refreshSeconds = 60 } = {}) {
  const fn = PAGES[route.page];
  const page = fn ? fn(view, query, pathname.replace(/\/+$/, '') || '/', route) : null;
  const res = page || { title: 'Not found', body: `${grid('notfound', card({ id: 'nf', title: 'Not found', span: 12, movable: false, body: empty('This item is not in the dashboard data', 'It may be closed and no longer cached, or the number is wrong.', 'warn') }))}`, crumbs: [['/work', 'Work'], [null, 'Not found']] };
  const steps = trail(route.page, res.crumbs || []), parent = [...steps].reverse().find(([h]) => h)?.[0];
  const crumbs = steps.length ? `<div class="crumbstrip"><a class="btn back" href="${esc(parent || '/')}" data-back>${icon('back')}Back</a><nav class="crumbs" aria-label="Breadcrumb"><ol>${steps.map(([h, t], i) => `<li>${h ? `<a href="${esc(h)}">${esc(t)}</a>` : `<span aria-current="page">${esc(t)}</span>`}${i < steps.length - 1 ? '<span class="sep" aria-hidden="true">›</span>' : ''}</li>`).join('')}</ol></nav></div>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshSeconds > 0 ? `<noscript><meta http-equiv="refresh" content="${refreshSeconds}"></noscript><meta name="refresh-seconds" content="${refreshSeconds}">` : ''}<title>${esc(res.title)} · DevTest team</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/static/style.css"><script src="/static/early.js"></script></head>
<body class="${res.bodyClass || ''}">${sprite}<a class="skip" href="#main">Skip to content</a>${statusBar(view, route, `<h1 id="page-title">${esc(res.title)}</h1>`, crumbs)}<main id="main" aria-labelledby="page-title">${res.body}</main><p id="tznote" class="sub tznote">Times are shown in UTC (your browser's time zone is applied when scripts run). Data is stored in UTC.</p><script src="/static/layout-early.js"></script><p id="copy-status" class="vh" role="status" aria-live="polite"></p><button type="button" id="to-top" class="to-top" aria-label="Back to top" title="Back to top" hidden>${icon('up')}</button><script type="module" src="/static/app.js"></script></body></html>`;
  return { status: page ? 200 : 404, html };
}
// Kept for callers that only want the overview.
export const renderPage = (view, opts = {}) => renderRoute(view, opts.route || { page: 'overview' }, opts).html;
