// HTML for the team dashboard v2 (issue #54): one server-rendered page per URL, charts as inline SVG, tables sorted, filtered and
// paginated on the server from the URL (so every state is bookmarkable and works without script). One small same-origin script
// (dashui/app.js) adds the countdown, theme, legend toggles, chart expand and card layout. Every dynamic value goes through esc().
import { DEFAULT_PAGE_SIZE, DEFAULT_RANGE, PAGE_SIZES, RANGES, SEVERITIES, inRange, tableState } from './dashui/logic.mjs';
import { resultSeverity } from './suphealth.mjs';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const utc = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown');
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
  if (p === '/supervisor/ticks') return { page: 'ticks' };
  if (p === '/supervisor/upgrades') return { page: 'upgrades' };
  return null;
}
const parentOf = page => ({ agent: 'agents', pr: 'work', issue: 'work', ticks: 'supervisor', upgrades: 'supervisor' })[page] || page;

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
  shield: '<path d="M12 3 4 6v6c0 4.500 3.400 7.700 8 9 4.600-1.300 8-4.500 8-9V6z"/><path d="m9 12 2 2 4-4"/>', zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', resize: '<path d="M20 12v8h-8M20 20 12 12"/>'
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" viewBox="0 0 24 24"><use href="#i-${esc(name)}"/></svg>`;
const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${Object.entries(ICONS).map(([n, d]) => `<symbol id="i-${n}" viewBox="0 0 24 24">${d}</symbol>`).join('')}</defs></svg>`;

const sev = level => SEVERITIES[level] || SEVERITIES.info;
export const badge = (level, text, extra = '') => `<span class="badge sev-${esc(level)} ${extra}">${icon(sev(level).icon)}${esc(text ?? sev(level).label)}</span>`;
const stateSev = { running: 'ok', idle: 'info', paused: 'warning', blocked: 'action' };
const stateBadge = s => badge(stateSev[s] || 'info', ({ running: 'Running', idle: 'Idle', paused: 'Paused', blocked: 'Blocked' })[s] || s);
const checksBadge = c => (c === 'green' ? badge('ok', 'CI green') : c === 'red' ? badge('action', 'CI failing') : c === 'pending' ? badge('info', 'CI running') : c ? badge('info', 'No CI') : '<span class="muted">–</span>');
const verdictBadge = v => (v === 'PASS' ? badge('ok', 'PASS') : v === 'CHANGES' ? badge('warning', 'CHANGES') : '<span class="muted">none</span>');
const agentTag = (name, view) => (name ? `<a href="/agents/${esc(encodeURIComponent(name))}"><span class="agent-dot" style="background:${colourOf(name, Object.keys(view.usage || {}).indexOf(name))}"></span>${esc(name)}</a>` : '<span class="muted">–</span>');
const prLink = n => `<a href="/work/pr/${Number(n)}">PR #${Number(n)}</a>`;
const issueLink = n => `<a href="/work/issue/${Number(n)}">issue #${Number(n)}</a>`;
const refOf = r => (r ? (r.kind === 'pull' ? prLink(r.n) : issueLink(r.n)) : '');
const ext = (url, text) => `<a href="${esc(url)}">${esc(text)}</a>`;
// ---- copy buttons (issue #72): the text to copy is in data-copy; dashui/app.js does the copying and shows "Copied".
// Hidden until the script runs, because without script a button that does nothing is worse than none.
export const copyBtn = (text, what, { label = '', cls = '' } = {}) => `<button type="button" class="copy ${label ? 'btn' : 'tbtn'} ${cls}" data-copy="${esc(text)}" aria-label="Copy ${esc(what)}" title="Copy ${esc(what)}" hidden>${icon('copy')}${label ? `<span data-copy-label>${esc(label)}</span>` : ''}</button>`;
const overseerBtn = text => copyBtn(text, 'a plain-text summary for the overseer', { label: 'Copy for overseer', cls: 'overseer' });
const cmdBlock = command => `<div class="cmdrow"><code class="cmd mono">${esc(command)}</code>${copyBtn(command, 'command')}</div>`;
const idCopy = (shown, full, what) => `<span class="mono">${esc(shown)}</span>${full ? copyBtn(full, what) : ''}`;
const shaCopy = (sha, what = 'commit ID') => (sha ? idCopy(String(sha).slice(0, 7), sha, what) : '<span class="muted">–</span>');
const errCopy = text => (text ? `<span class="err">${esc(text)}</span>${copyBtn(text, 'error message')}` : '');
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
    if (op === 'sum') v = c.fmt ? c.fmt(st.footer[c.key]) : num(st.footer[c.key]); else if (op === 'avg') v = `avg ${c.fmt ? c.fmt(st.footer[c.key]) : dec1(st.footer[c.key])}`; else if (op === 'count') v = `${st.footer[c.key]} ${noun}`;
    return `<td data-label="${esc(c.label)}"${c.num ? ' class="num"' : ''}>${i === 0 && !op ? 'Total' : esc(v)}</td>`;
  }).join('')}</tr></tfoot>` : '';
  const needle = q('q', '');
  const bar = `<form class="tbar" method="get" action="${esc(path)}" role="search">${[...query].filter(([k]) => !k.startsWith(`${id}.`)).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${sortKey ? `<input type="hidden" name="${id}.sort" value="${esc(sortKey)}"><input type="hidden" name="${id}.dir" value="${dir}">` : ''}
<label class="sr"><span class="muted">Filter ${esc(noun)}</span> <input type="search" name="${id}.q" value="${esc(needle)}" placeholder="Filter ${esc(noun)}" aria-label="Filter ${esc(noun)}"></label>
<label><span class="muted">Per page</span> <select name="${id}.size" aria-label="Rows per page">${PAGE_SIZES.map(s => `<option${s === st.pageSize ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
<button type="submit">Apply</button>${needle ? `<a class="btn" href="${href({ q: null, page: 1 })}">Clear</a>` : ''}</form>`;
  const pager = `<nav class="pager" aria-label="${esc(noun)} pages">${st.total ? `<span>${st.from}–${st.to} of ${st.total}</span>` : ''}
${st.page > 1 ? `<a href="${href({ page: st.page - 1 })}" rel="prev">Previous</a>` : '<span class="dis">Previous</span>'}<span class="cur" aria-current="page">Page ${st.page} of ${st.pages}</span>
${st.page < st.pages ? `<a href="${href({ page: st.page + 1 })}" rel="next">Next</a>` : '<span class="dis">Next</span>'}</nav>`;
  if (!rows.length) return emptyState || empty(`No ${noun} yet`, 'Nothing has been recorded.');
  return `${bar}<div class="tbl-wrap"><table data-table="${esc(id)}"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}">${esc(`No ${noun} match the filter.`)}</td></tr>`}</tbody>${foot}</table></div>${pager}`;
}

// ---- charts: inline SVG, hover tooltips (<title>), per-series toggles (script), colours per agent
const fmtAxisTime = (t, range) => new Date(t).toISOString().slice(range === '24h' ? 11 : 5, range === '24h' ? 16 : 10);
function legend(items) {
  return `<div class="legend" role="group" aria-label="Series">${items.map(s => `<button type="button" aria-pressed="true" data-series="${esc(s.key)}"><i style="background:${s.colour}"></i>${esc(s.label)}</button>`).join('')}</div>`;
}
function lineChart({ series, resets = [], expected = [], now, range, title }) {
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return empty('No allowance history in this range', 'The chart fills in as ticks record what the providers report.', 'chart');
  const W = 900, H = 320, L = 44, B = 28, T = 12, R = 14;
  const t1 = now, t0 = now - RANGES[range];
  const x = t => L + ((t - t0) / (t1 - t0)) * (W - L - R), y = v => T + (1 - Math.min(1, Math.max(0, v))) * (H - T - B);
  let g = [0, 0.25, 0.5, 0.75, 1].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v * 100}%</text>`).join('');
  for (let i = 0; i <= 4; i++) { const t = t0 + ((t1 - t0) * i) / 4; g += `<text x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" class="ax">${esc(fmtAxisTime(t, range))}</text>`; }
  for (const r of resets.filter(r => r.at >= t0)) g += `<line x1="${x(r.at)}" x2="${x(r.at)}" y1="${T}" y2="${H - B}" class="reset" data-series="reset"><title>${esc(r.window)} window reset ${esc(utc(r.at))}</title></line>`;
  const shownExpected = expected.filter(r => r.at >= t0 && r.at <= t1);
  for (const r of shownExpected) g += `<line x1="${x(r.at).toFixed(1)}" x2="${x(r.at).toFixed(1)}" y1="${T}" y2="${H - B}" class="reset expected" data-series="expected"><title>${esc(r.window)} window expected to reset ${esc(utc(r.at))}: the reading before it has expired</title></line>`;
  for (const s of series) {
    if (!s.points.length) continue;
    // a gap (reading expired, then a new one) splits the line: nothing is drawn across the time no reading was current
    const segments = s.points.reduce((acc, p) => { if (p.gap || !acc.length) acc.push([]); acc.at(-1).push(p); return acc; }, []);
    g += `<g data-series="${esc(s.key)}">${segments.map(seg => `<polyline fill="none" stroke="${s.colour}" stroke-width="2.5" stroke-linejoin="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} points="${seg.map(p => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>`).join('')}`
      + s.points.filter((_, i, a) => a.length < 60 || i % Math.ceil(a.length / 60) === 0).map(p => `<circle class="pt" tabindex="0" cx="${x(p.at).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="5" fill="${s.colour}"><title>${esc(s.label)}: ${pct(p.v)} at ${esc(utc(p.at))}</title></circle>`).join('') + '</g>';
  }
  const items = [...series.filter(s => s.points.length).map(s => ({ key: s.key, label: s.label, colour: s.colour })), ...(resets.length ? [{ key: 'reset', label: 'Window reset', colour: 'var(--action)' }] : []), ...(shownExpected.length ? [{ key: 'expected', label: 'Expected reset (reading expired)', colour: 'var(--mut)' }] : [])];
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
function card({ id, title, span = 6, body, href, tools = '', cls = '', movable = true, expandable = false }) {
  return `<section class="card ${cls}" data-card="${esc(id)}" data-span="${span}" style="--span:${span}" aria-labelledby="h-${esc(id)}"><header>${movable ? `<span class="tbtn" data-handle title="Drag to move" aria-hidden="true">${icon('drag')}</span>` : ''}<h2 id="h-${esc(id)}">${esc(title)}</h2>
<span class="tools">${tools}${expandable ? `<button class="tbtn" type="button" data-expand aria-label="Expand ${esc(title)}" title="Expand">${icon('expand')}</button>` : ''}${movable ? `<button class="tbtn" type="button" data-move="-1" aria-label="Move ${esc(title)} earlier" title="Move earlier">${icon('up')}</button><button class="tbtn" type="button" data-move="1" aria-label="Move ${esc(title)} later" title="Move later">${icon('down')}</button>` : ''}${href ? `<a class="tbtn" href="${esc(href)}" aria-label="Details: ${esc(title)}" title="Details">${icon('link')}</a>` : ''}</span></header>${body}${movable ? `<span class="resize wide-only" tabindex="0" role="slider" aria-label="Resize ${esc(title)} (left and right arrow keys)" aria-valuemin="2" aria-valuemax="12" aria-valuenow="${span}">${icon('resize')}</span>` : ''}</section>`;
}
const grid = (layout, cards, cls = '') => `<div class="cards ${cls}" data-layout="${esc(layout)}">${cards}</div>`;
const kpi = ({ id, label, value, href, spark = '', span = 2 }) => `<a class="card kpi" data-card="${esc(id)}" data-span="${span}" style="--span:${span}" href="${esc(href)}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${spark}</a>`;

// ---- the four panels (Overview top) and the status bar
function nowPanel(view) {
  const now = view.generatedAt;
  return `<ul class="panel-list">${view.agents.map(a => {
    const j = a.job, level = stateSev[a.state] || 'info';
    const what = j ? `${esc(j.kind)} ${jobRef({ kind: j.kind, ref: j.ref })} · attempt ${Number(j.attempts)} · ${a.state === 'paused' ? `paused (${esc(j.lastEvent)})${j.nextAttemptAt ? `, retry ${esc(inFuture(j.nextAttemptAt, now))}` : ''}` : `elapsed ${esc(dur(j.elapsedMs))}`}`
      : `<span>Idle: ${a.idleReason ? esc(a.idleReason.text) : 'nothing to do'}</span> ${(a.idleReason?.links || []).map(l => ext(l.url, l.text)).join(' ')}`;
    return `<li class="sev-${level}"><div class="t">${agentTag(a.name, view)} ${stateBadge(a.state)}</div><div>${what}</div></li>`;
  }).join('')}</ul>`;
}
function nextPanel(view) {
  const now = view.generatedAt, plan = view.panels.next;
  const when = view.nextTickAt ? `<p class="sub">${icon('clock')} Next tick <b data-countdown="${view.nextTickAt}">${esc(inFuture(view.nextTickAt, now))}</b></p>` : '<p class="sub">No tick is scheduled: the team loop is off or has never run.</p>';
  return `${when}${plan.length ? `<ul class="panel-list">${plan.map(p => `<li class="sev-info"><div class="t">${agentTag(p.agent, view)}: ${esc(p.type === 'cifix' ? 'fix CI' : p.type)}</div><div>${['implement', 'continue'].includes(p.type) ? issueLink(p.ref) : prLink(p.ref)}</div></li>`).join('')}</ul>` : empty('Nothing planned', 'The next tick has no work to start.', 'check')}`;
}
function needsPanel(view) {
  const items = view.panels.needsYou;
  return items.length ? `<ul class="panel-list">${items.map(a => `<li class="sev-action"><div class="t">${badge('action')} ${esc(a.text)} ${refOf(a.ref)}</div><div class="sub">Decision: ${esc(a.decision)}</div>${a.command ? cmdBlock(a.command) : ''}${a.overseer ? `<div class="acts">${overseerBtn(a.overseer)}</div>` : ''}</li>`).join('')}</ul>`
    : empty('Nothing needs you', 'No homeowner decision or failed work is waiting.', 'check');
}
function warningsPanel(view) {
  const items = view.panels.warnings;
  return items.length ? `<ul class="panel-list">${items.map(a => `<li class="sev-${esc(a.severity)}"><div class="t">${badge(a.severity)} ${esc(a.text)} ${refOf(a.ref)}</div></li>`).join('')}</ul>` : empty('No warnings', 'No stalls, stale data or version drift.', 'check');
}
function statusBar(view, route) {
  const now = view.generatedAt, t = view.tick, fr = view.freshness, v = view.version;
  const tickBadge = !t ? badge('action', 'No tick yet') : badge(t.status === 'ok' ? 'ok' : t.status === 'error' ? 'action' : 'info', `Tick ${t.status}`);
  return `<header class="statusbar" role="banner"><div class="brand">${icon('pulse')} DevTest team</div>
<div class="stat" title="Overall health">${badge(view.health.severity, view.health.label, 'big')}</div>
<div class="stat"><span class="k">Last tick</span>${tickBadge}<span>${t ? esc(ago(t.at, now)) : ''}</span></div>
<div class="stat"><span class="k">Next</span>${view.nextTickAt ? `<b data-countdown="${view.nextTickAt}">${esc(inFuture(view.nextTickAt, now))}</b>` : '<span class="muted">none</span>'}</div>
<div class="stat"><span class="k">Data</span>${badge(fr.level, fr.label)}</div>
<div class="stat"><span class="k">Team loop</span>${view.teamEnabled ? badge('ok', 'Enabled') : badge('info', 'Disabled')}</div>
<div class="stat"><span class="k">Version</span>${v ? (v.drift ? badge('warning', `${String(v.installed).slice(0, 7)} → ${String(v.main).slice(0, 7)} deploy needed`) : badge('ok', `${String(v.installed).slice(0, 7)} = main`)) : badge('info', 'unknown')}</div>
<button class="theme" id="theme" type="button" aria-label="Switch between light and dark theme" title="Theme">${icon('moon')}</button></header>
<nav class="nav" aria-label="Pages">${NAV.map(([page, href, label, ic]) => `<a href="${href}"${route.page === page || parentOf(route.page) === page ? ' aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></a>`).join('')}</nav>`;
}

// ---- pages
const agentCols = view => ({ agent: { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) } });
function overview(view, query) {
  const range = query.get('range') in RANGES ? query.get('range') : DEFAULT_RANGE;
  const now = view.generatedAt;
  const open = view.prs.filter(p => ['open', 'draft'].includes(p.status)), active = view.agents.filter(a => a.state === 'running').length;
  const tokens = Object.values(view.usage).reduce((s, u) => s + u.totalTokens, 0);
  const daily = Object.values(view.graphs.jobsPerDay).map(d => Object.values(d).reduce((a, b) => a + b, 0));
  const verdicts = view.verdicts;
  const panels = [
    card({ id: 'now', title: 'Now', span: 3, body: nowPanel(view), href: '/agents', cls: 'panel' }),
    card({ id: 'next', title: 'Next', span: 3, body: nextPanel(view), href: '/work', cls: 'panel' }),
    card({ id: 'needs', title: `Needs you${view.panels.needsYou.length ? ` (${view.panels.needsYou.length})` : ''}`, span: 3, body: needsPanel(view), href: '/work', cls: 'panel' }),
    card({ id: 'warnings', title: `Warnings${view.panels.warnings.length ? ` (${view.panels.warnings.length})` : ''}`, span: 3, body: warningsPanel(view), href: '/system', cls: 'panel' })
  ].join('');
  const kpis = [
    kpi({ id: 'k-active', label: 'Agents running', value: `${active} / ${view.agents.length}`, href: '/agents' }),
    kpi({ id: 'k-prs', label: 'Open pull requests', value: String(open.length), href: '/work', spark: sparkline(daily) }),
    kpi({ id: 'k-queue', label: 'Queued items', value: String(Object.values(view.queues).reduce((s, q) => s + q.length, 0)), href: '/work' }),
    kpi({ id: 'k-reviews', label: 'Reviews recorded', value: String(verdicts.length), href: '/reviews' }),
    kpi({ id: 'k-tokens', label: 'Tokens recorded', value: tokens ? num(tokens) : 'unknown', href: '/usage' }),
    kpi({ id: 'k-fresh', label: 'Data age', value: view.freshness.ageMs === null ? 'none' : dur(view.freshness.ageMs), href: '/system' })
  ].join('');
  const charts = [
    card({ id: 'c-allow', title: `Allowance used (${range})`, span: 6, href: '/usage', expandable: true, tools: rangeSelector('/', query, range), body: lineChart({ series: allowanceSeries(view, range), resets: allResets(view, range), expected: allExpected(view), now, range, title: 'allowance used over time' }), cls: 'chart-card' }),
    card({ id: 'c-jobs', title: `Jobs per day (${range})`, span: 6, href: '/activity', expandable: true, body: stackedChart({ days: view.graphs.jobsPerDay, title: 'jobs per day', range, now }), cls: 'chart-card' })
  ].join('');
  return { title: 'Overview', body: `<div class="toolrow"><button class="btn" type="button" data-reset-layout>Reset layout</button></div>${grid('overview', panels + kpis + charts)}`, bodyClass: 'overview' };
}

function agentsPage(view, query, path) {
  const cards = view.agents.map(a => {
    const q = view.queues[a.name] || [];
    return card({ id: `a-${a.name}`, title: a.name, span: 6, href: `/agents/${encodeURIComponent(a.name)}`, movable: true, body: `<p>${stateBadge(a.state)} <span class="sub">${esc(a.provider)} · last activity ${esc(ago(a.lastActivityAt, view.generatedAt))}</span></p>${nowPanel({ ...view, agents: [a] })}<p class="sub">${q.length} queued · <a href="/agents/${encodeURIComponent(a.name)}">Job history and queue</a></p>` });
  }).join('');
  return { title: 'Agents', body: grid('agents', cards) };
}
function jobCols(view, { agent = true } = {}) {
  return [
    { key: 'id', label: 'Job', html: r => idCopy(r.id, r.fullId, 'job ID') },
    ...(agent ? [{ key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) }] : []),
    { key: 'kind', label: 'Kind' }, { key: 'ref', label: 'Ref', num: true, html: r => (r.ref ? jobRef(r, view) : '–') },
    { key: 'status', label: 'Status', html: r => badge(({ completed: 'ok', running: 'ok', queued: 'info', paused_limit: 'warning', paused_manual: 'warning', blocked: 'action', failed: 'action' })[r.status] || 'info', r.status) },
    { key: 'model', label: 'Model', html: r => esc(r.model || 'default'), more: true }, { key: 'effort', label: 'Effort', html: r => esc(r.effort || 'default'), more: true },
    { key: 'attempts', label: 'Attempts', num: true, more: true, totals: 'avg' }, { key: 'startedAt', label: 'Started', num: true, html: r => esc(utc(r.startedAt)), more: true },
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
    cols: [{ key: 'next', label: 'Next', html: r => (r.next ? badge('info', 'Next') : '') }, { key: 'type', label: 'Type' }, { key: 'ref', label: 'Ref', num: true, html: r => (r.type === 'issue' ? issueLink(r.ref) : prLink(r.ref)) }, { key: 'title', label: 'Title' }, { key: 'reason', label: 'Reason', more: true }],
    totals: { next: 'count' }, emptyState: empty('Queue is empty', 'No work is waiting for this agent.', 'check') }) });
  const hist = card({ id: 'hist', title: `Job history (${jobs.length})`, span: 12, movable: false, body: table({ id: 'jobs', path, query, noun: 'jobs', rows: jobs, searchKeys: ['id', 'kind', 'status', 'branch'], cols: jobCols(view, { agent: false }).map(c => ({ ...c, total: undefined })), totals: jobTotals,
    emptyState: empty('No jobs yet', 'This agent has not run a job.', 'list') }) });
  return { title: `Agent ${a.name}`, crumbs: [['/agents', 'Agents'], [null, a.name]], body: grid('agent', cur + queue + hist) };
}

function workPage(view, query, path) {
  const queues = Object.entries(view.queues).map(([name, items]) => card({ id: `wq-${name}`, title: `Queue: ${name}`, span: 6, movable: true, body: items.length ? `<ul class="panel-list">${items.slice(0, 8).map(i => `<li class="sev-${i.next ? 'info' : 'ok'}"><div class="t">${i.next ? badge('info', 'Next') + ' ' : ''}${i.type === 'issue' ? issueLink(i.ref) : prLink(i.ref)} ${esc(i.title)}</div><div class="sub">${esc(i.reason)}</div></li>`).join('')}</ul>${items.length > 8 ? `<p class="sub">+${items.length - 8} more on <a href="/agents/${encodeURIComponent(name)}">the agent page</a></p>` : ''}` : empty('Queue is empty', 'Nothing is waiting for this agent.', 'check') })).join('');
  const issues = card({ id: 'issues', title: 'Issues', span: 12, movable: false, body: table({ id: 'issues', path, query, noun: 'issues', rows: view.issues.map(i => ({ ...i, blockers: i.blockedBy.length, need: i.needsHomeowner ? 'yes' : '' })), searchKeys: ['title', 'agent', 'number', 'state', 'reason'],
    cols: [{ key: 'number', label: '#', num: true, html: r => issueLink(r.number) }, { key: 'title', label: 'Title' }, { key: 'state', label: 'State' }, { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) },
      { key: 'blockers', label: 'Blockers', num: true, html: r => (r.blockedBy.length ? r.blockedBy.map(issueLink).join(', ') : '–') }, { key: 'reason', label: 'Status', more: true }],
    totals: { number: 'count', blockers: 'sum' }, emptyState: empty('No issues cached', 'The first tick fills the cache.', 'list') }) });
  const prs = card({ id: 'prs', title: 'Pull requests', span: 12, movable: false, body: table({ id: 'prs', path, query, noun: 'pull requests', rows: view.prs, searchKeys: ['title', 'agent', 'status', 'number', 'verdict'],
    cols: [{ key: 'number', label: '#', num: true, html: r => prLink(r.number) }, { key: 'title', label: 'Title' }, { key: 'agent', label: 'Author', html: r => agentTag(r.agent, view) }, { key: 'status', label: 'State' },
      { key: 'checks', label: 'CI', html: r => checksBadge(r.checks) }, { key: 'verdict', label: 'Verdict', html: r => verdictBadge(r.verdict) }, { key: 'reviewRounds', label: 'Review rounds', num: true, more: true },
      { key: 'fixRounds', label: 'Fix rounds', num: true, more: true }, { key: 'rebaseRounds', label: 'Rebase rounds', num: true, more: true }, { key: 'tokens', label: 'Tokens', num: true, html: r => esc(num(r.tokens)), more: true }],
    totals: { number: 'count', reviewRounds: 'avg', fixRounds: 'avg', tokens: 'sum' }, emptyState: empty('No pull requests yet', 'Pull requests appear once an agent opens one.', 'list') }) });
  return { title: 'Work', body: `${grid('work', queues)}<div class="cards">${issues}${prs}</div>` };
}
function prDetail(view, query, path, route) {
  const p = view.prs.find(x => x.number === route.id);
  if (!p) return null;
  const facts = card({ id: 'facts', title: `PR #${p.number}: ${p.title}`, span: 12, movable: false, body: `<dl class="kv"><dt>State</dt><dd>${esc(p.status)}</dd><dt>Author</dt><dd>${agentTag(p.agent, view)}</dd><dt>CI</dt><dd>${checksBadge(p.checks)}</dd><dt>Latest verdict</dt><dd>${verdictBadge(p.verdict)}</dd>
<dt>Rounds</dt><dd>${p.reviewRounds} review · ${p.fixRounds} fix · ${p.rebaseRounds} rebase</dd><dt>Tokens</dt><dd>${esc(num(p.tokens))}</dd><dt>On GitHub</dt><dd>${ext(p.url, `PR #${p.number}`)}</dd></dl>` });
  const tl = card({ id: 'tl', title: 'Timeline', span: 6, movable: false, body: p.timeline.length ? `<ol class="tl">${p.timeline.map(r => `<li><b>${esc(utc(r.at))}</b><br>${esc(r.text)}</li>`).join('')}</ol>` : empty('No events recorded', 'Review, fix and merge events appear here.', 'clock') });
  const vh = card({ id: 'vh', title: 'Verdict history', span: 6, movable: false, body: p.verdicts.length ? p.verdicts.map(v => `<h3>${verdictBadge(v.verdict)} ${esc(v.reviewer)} at ${v.fullHead ? shaCopy(v.fullHead) : `<span class="mono">${sha7(v.head)}</span>`} <span class="sub">${esc(utc(v.at))}</span></h3>${v.findings.length ? `<ul>${v.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="sub">No findings recorded.</p>'}${v.followUpIssue ? `<p class="sub">Follow-up: ${issueLink(v.followUpIssue)}</p>` : ''}`).join('') : empty('No verdicts yet', 'The opposite agent has not reviewed this pull request.', 'review') });
  const jobs = card({ id: 'pj', title: 'Jobs on this PR', span: 12, movable: false, body: table({ id: 'jobs', path, query, noun: 'jobs', rows: p.jobs, searchKeys: ['id', 'kind', 'status', 'agent'], cols: jobCols(view).map(c => ({ ...c, total: undefined })), totals: jobTotals, emptyState: empty('No jobs recorded', 'Jobs that reviewed or fixed this PR show here.', 'list') }) });
  return { title: `PR #${p.number}`, crumbs: [['/work', 'Work'], [null, `PR #${p.number}`]], body: grid('pr', facts + tl + vh + jobs) };
}
function issueDetail(view, query, path, route) {
  const i = view.issues.find(x => x.number === route.id);
  if (!i) return null;
  const dependents = view.issues.filter(o => o.dependsOn.includes(i.number));
  const deps = i.dependsOn.length ? `<ul class="panel-list">${i.dependsOn.map(d => { const di = view.issues.find(x => x.number === d); const blocked = i.blockedBy.includes(d); return `<li class="sev-${blocked ? 'warning' : 'ok'}"><div class="t">${blocked ? badge('warning', 'Blocking') : badge('ok', 'Done')} ${issueLink(d)} ${esc(di?.title || '')}</div></li>`; }).join('')}</ul>` : empty('No prerequisites', 'This issue does not wait on another one.', 'check');
  const facts = card({ id: 'facts', title: `Issue #${i.number}: ${i.title}`, span: 12, movable: false, body: `<dl class="kv"><dt>State</dt><dd>${esc(i.state)}</dd><dt>Assigned to</dt><dd>${agentTag(i.agent, view)}</dd><dt>Status</dt><dd>${esc(i.reason || '–')}</dd>
<dt>Needs homeowner</dt><dd>${i.needsHomeowner ? badge('action', 'Yes') : 'No'}</dd><dt>On GitHub</dt><dd>${ext(i.url, `issue #${i.number}`)}</dd></dl>` });
  return { title: `Issue #${i.number}`, crumbs: [['/work', 'Work'], [null, `Issue #${i.number}`]], body: grid('issue', facts + card({ id: 'deps', title: 'Dependencies and blockers', span: 6, movable: false, body: deps })
    + card({ id: 'dependents', title: 'Waiting on this issue', span: 6, movable: false, body: dependents.length ? `<ul class="panel-list">${dependents.map(d => `<li class="sev-info"><div class="t">${issueLink(d.number)} ${esc(d.title)}</div></li>`).join('')}</ul>` : empty('Nothing waits on it', 'No cached issue lists this one as a prerequisite.', 'check') })) };
}

function activityPage(view, query, path) {
  const rows = view.activity.map(r => ({ at: r.at, text: r.text, link: r.link }));
  return { title: 'Activity', body: grid('activity', card({ id: 'act', title: `Recent activity (last ${rows.length})`, span: 12, movable: false, body: table({ id: 'act', path, query, noun: 'events', rows, searchKeys: ['text'],
    cols: [{ key: 'at', label: 'When', num: true, html: r => esc(utc(r.at)) }, { key: 'text', label: 'What' }, { key: 'link', label: 'Link', sortable: false, html: r => (r.link ? ext(r.link.url, r.link.text) : '') }], totals: { text: 'count' }, emptyState: empty('No activity yet', 'Events appear after the first tick.', 'pulse') }) })) };
}
// One agent's allowance card (issue #75): the last known reading with its age; an expired window (reset time passed) is
// marked and never shown as current; a limit pause says when it resets and on what basis.
const SOURCE = { job: 'reported to a supervised job', 'session-log': 'read from the local Codex session log (no model call)' };
function allowanceBody(u, now) {
  const l = u.limit;
  const limit = l ? `<p class="limit">${badge('action', 'Limit reached')} ${l.resetsAt ? `resets <b>${esc(utc(l.resetsAt))}</b> (${esc(inFuture(l.resetsAt, now))}; ${esc(l.basis)})` : 'reset time not reported by the provider'}${l.retryAt ? `. The supervisor retries ${esc(inFuture(l.retryAt, now))}.` : '.'}</p>` : '';
  if (!u.windows.length) return `${limit}<p>Allowance: <b>unknown</b></p>${empty('No allowance reported', 'The provider has never reported a limit window to the supervisor.', 'info')}`;
  const used = w => (Number.isFinite(w.utilization) ? `<div class="bar${w.expired ? ' expired' : ''}" role="img" aria-label="${pct(w.utilization)} used${w.expired ? ', expired' : ''}"><b style="width:${Math.min(100, w.utilization * 100)}%"></b></div> ${pct(w.utilization)}${w.expired ? ' <span class="muted">(expired)</span>' : ''}` : 'unknown');
  const resets = w => (!w.resetsAt ? 'unknown' : w.expired ? `reset ${esc(dur(now - w.resetsAt))} ago; current use unknown` : esc(inFuture(w.resetsAt, now)));
  const rows = u.windows.map(w => `<tr${w.expired ? ' class="expired"' : ''}><td>${esc(w.label)}</td><td>${used(w)}</td><td>${resets(w)}</td></tr>`).join('');
  const note = u.allExpired ? `<p class="sub">${badge('warning', 'Expired')} Every window in this reading has reset since; current use is unknown until the provider reports again.</p>` : '';
  return `${limit}<table><thead><tr><th>Window</th><th>Used</th><th>Resets</th></tr></thead><tbody>${rows}</tbody></table>${note}<p class="sub">Last reading ${esc(ago(u.observedAt, now))} (${esc(utc(u.observedAt))}), ${esc(SOURCE[u.source] || 'reported by the provider')}.</p>`;
}
function usagePage(view, query, path) {
  const range = query.get('range') in RANGES ? query.get('range') : DEFAULT_RANGE, now = view.generatedAt;
  const win = Object.entries(view.usage).map(([name, u]) => card({ id: `u-${name}`, title: `Allowance: ${name}`, span: 6, movable: true, body: allowanceBody(u, now) })).join('');
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
  return { title: 'Usage & cost', body: grid('usage', win + chart + tokChart + byModel + table_) };
}
function reviewsPage(view, query, path) {
  const range = query.get('range') in RANGES ? query.get('range') : DEFAULT_RANGE;
  const verdictRows = Object.entries(view.graphs.verdicts).flatMap(([a, v]) => [{ label: `${a} PASS`, value: v.PASS, series: `${a} PASS`, colour: 'var(--s3)' }, { label: `${a} CHANGES`, value: v.CHANGES, series: `${a} CHANGES`, colour: 'var(--claude)' }]);
  const merges = view.graphs.merges.slice(-12).map(m => ({ label: `PR #${m.pr}${m.agent ? ' ' + m.agent : ''}`, value: m.hours, text: Number.isFinite(m.hours) ? `${dec1(m.hours)} h` : null, series: m.agent || 'unknown', colour: colourOf(m.agent) }));
  const v = card({ id: 'r-v', title: 'Verdicts per agent', span: 6, expandable: true, body: barChart({ rows: verdictRows, title: 'review verdicts', emptyTitle: 'No verdicts recorded' }) });
  const m = card({ id: 'r-m', title: 'Issue start to merge (hours)', span: 6, expandable: true, body: barChart({ rows: merges, title: 'time from issue start to merge', emptyTitle: 'No merges recorded' }) });
  const rows = view.verdicts.map(r => ({ ...r, findingCount: r.findings.length }));
  const t = card({ id: 'r-t', title: 'Verdict history', span: 12, movable: false, body: table({ id: 'rev', path, query, noun: 'verdicts', rows, searchKeys: ['pr', 'reviewer', 'verdict', 'head'], totals: { pr: 'count', findingCount: 'avg' },
    cols: [{ key: 'pr', label: 'PR', num: true, html: r => prLink(r.pr) }, { key: 'reviewer', label: 'Reviewer', html: r => agentTag(r.reviewer, view) }, { key: 'verdict', label: 'Verdict', html: r => verdictBadge(r.verdict) }, { key: 'head', label: 'Head', html: r => (r.fullHead ? shaCopy(r.fullHead) : `<span class="mono">${sha7(r.head)}</span>`), more: true },
      { key: 'findingCount', label: 'Findings', num: true }, { key: 'at', label: 'When', num: true, html: r => esc(utc(r.at)), more: true }], emptyState: empty('No reviews yet', 'Verdicts appear after the first review.', 'review') }) });
  return { title: 'Reviews', body: grid('reviews', v + m + t) };
}
function systemPage(view) {
  const t = view.tick, v = view.version, now = view.generatedAt;
  const facts = card({ id: 'sys', title: 'Dispatcher', span: 6, movable: false, body: `<dl class="kv"><dt>Repository</dt><dd>${esc(view.repository)}</dd><dt>Team loop</dt><dd>${view.teamEnabled ? badge('ok', 'Enabled') : badge('info', 'Disabled')}</dd>
<dt>Health</dt><dd>${badge(view.health.severity, view.health.label)}</dd><dt>Last tick</dt><dd>${t ? `${badge(t.status === 'ok' ? 'ok' : 'action', t.status)} ${esc(utc(t.at))} (${esc(ago(t.at, now))})` : badge('action', 'none recorded')}</dd>
<dt>Last good tick</dt><dd>${t?.lastOkAt ? esc(ago(t.lastOkAt, now)) : 'never'}</dd>${t?.error ? `<dt>Error</dt><dd>${errCopy(t.error)}</dd>` : ''}<dt>Next tick</dt><dd>${view.nextTickAt ? `<b data-countdown="${view.nextTickAt}">${esc(inFuture(view.nextTickAt, now))}</b>` : 'none'}</dd>
<dt>Data freshness</dt><dd>${badge(view.freshness.level, view.freshness.label)} GitHub data cached ${esc(ago(view.cacheFetchedAt, now))}</dd><dt>Page built</dt><dd>${esc(utc(now))}</dd></dl>` });
  const ver = card({ id: 'ver', title: 'Version', span: 6, movable: false, body: v ? `<dl class="kv"><dt>Installed</dt><dd>${shaCopy(v.installed)}</dd><dt>Main</dt><dd>${shaCopy(v.main)}</dd><dt>State</dt><dd>${v.drift ? badge('warning', 'Deploy needed') : badge('ok', 'Up to date')}</dd><dt>Last upgrade result</dt><dd>${esc(v.result)}</dd></dl><p class="sub"><a href="/supervisor">Supervisor health</a> · <a href="/supervisor/upgrades">Upgrade history</a></p>` : empty('No version record', 'The self-upgrade step has not recorded anything yet.', 'info') });
  const all = card({ id: 'all', title: 'All attention items', span: 12, movable: false, body: view.attention.length ? `<ul class="panel-list">${view.attention.map(a => `<li class="sev-${esc(a.severity)}"><div class="t">${badge(a.severity)} ${esc(a.text)} ${refOf(a.ref)}</div></li>`).join('')}</ul>` : empty('All clear', 'Nothing needs attention.', 'check') });
  return { title: 'System', body: grid('system', facts + ver + all) };
}

// ---- Supervisor area (issue #72): health cards with drill-downs, tick history, upgrade history
const list = (items, cls = '') => (items.length ? `<ul class="mini ${cls}">${items.join('')}</ul>` : '<span class="muted">none</span>');
const tickRef = a => (a.type === 'implement' || a.type === 'continue' ? (a.issue ? issueLink(a.issue) : `#${Number(a.ref)}`) : a.pr ? prLink(a.pr) : `#${Number(a.ref)}`);
function tickDetail(t) {
  return `<dl class="kv"><dt>Verdicts ingested</dt><dd>${list(t.ingested.map(i => `<li>${verdictBadge(i.verdict)} ${i.pr ? prLink(i.pr) : ''} ${i.job ? `job ${idCopy(i.job.slice(0, 8), i.job, 'job ID')}` : ''}</li>`))}</dd>
<dt>Actions</dt><dd>${list(t.actions.map(a => `<li>${esc(a.agent)} ${esc(a.type === 'cifix' ? 'fix CI' : a.type)} ${tickRef(a)}</li>`))}</dd>
<dt>Skipped</dt><dd>${t.note ? `<span class="muted">${esc(t.note)}</span>` : list(t.skipped.map(s => `<li><b>${esc(s.what)}</b>: ${errCopy(s.reason)}</li>`))}</dd>
<dt>Self-upgrade</dt><dd>${esc(t.selfUpgrade || '–')}</dd><dt>Leases released</dt><dd>${t.released}</dd>${t.rc !== null ? `<dt>Exit code</dt><dd>rc=${Number(t.rc)}</dd>` : ''}
<dt>Errors</dt><dd>${list(t.errors.map(e => `<li>${errCopy(e)}</li>`), 'errs')}</dd></dl>`;
}
const tickStatusBadge = s => badge(({ ok: 'ok', partial: 'warning', skipped: 'info', empty: 'warning', error: 'action' })[s] || 'info', ({ ok: 'OK', partial: 'Partial', skipped: 'Skipped', empty: 'No result', error: 'Error' })[s] || s);
function healthBody(c, view) {
  const now = view.generatedAt;
  const notes = c.notes.length ? `<ul class="mini notes">${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  let dl = '';
  if (c.id === 'version') {
    const u = c.lastUpgrade;
    dl = `<dt>Installed</dt><dd>${shaCopy(c.installed)}${c.installedAt ? ` <span class="sub">since ${esc(utc(c.installedAt))}</span>` : ''}</dd><dt>origin/main</dt><dd>${shaCopy(c.origin)}</dd>
<dt>Upgrade step</dt><dd>${esc(c.step || 'not reported')}</dd>
<dt>Last upgrade</dt><dd>${u ? `${badge(resultSeverity(u.result), u.result)} ${shaCopy(u.from)} → ${shaCopy(u.to)} <span class="sub">${esc(ago(u.at, now))}</span>${u.reason ? `<br>${errCopy(u.reason)}` : ''}` : '<span class="muted">no record</span>'}</dd>
<dt>Pre-check latched</dt><dd>${list(c.prechecked.map(p => `<li>${shaCopy(p.sha)} since ${esc(utc(p.at))}${p.isMain ? ` ${badge('warning', 'is origin/main')}` : ''}</li>`))}</dd>
${c.latch ? `<dt>Rollback latch</dt><dd>${badge('action', 'Set')} ${errCopy(c.latch.reason)}</dd>` : ''}${c.pending ? `<dt>Pending</dt><dd>${shaCopy(c.pending.to)} awaiting a live tick</dd>` : ''}`;
  } else if (c.id === 'tick') {
    const t = c.tick;
    dl = t ? `<dt>When</dt><dd>${esc(utc(t.at))} <span class="sub">(${esc(ago(t.at, now))}${c.stale ? ', more than two intervals' : ''})</span></dd><dt>Status</dt><dd>${tickStatusBadge(t.status)}</dd>
<dt>Verdicts ingested</dt><dd>${t.ingested.length}</dd><dt>Actions</dt><dd>${list(t.actions.map(a => `<li>${esc(a.agent)} ${esc(a.type === 'cifix' ? 'fix CI' : a.type)} ${tickRef(a)}</li>`))}</dd>
<dt>Skipped</dt><dd>${t.note ? esc(t.note) : list(t.skipped.map(s => `<li><b>${esc(s.what)}</b>: ${errCopy(s.reason)}</li>`))}</dd>` : '';
  } else if (c.id === 'leases') {
    const odd = c.leases.filter(l => l.state !== 'active');
    dl = `<dt>Held</dt><dd>${c.leases.length} job(s)</dd><dt>Needs recovery</dt><dd>${odd.length ? list(odd.map(l => `<li>${badge(l.state === 'stale' ? 'action' : 'warning', l.state === 'stale' ? 'Stale' : 'Held')} job ${idCopy(l.job.slice(0, 8), l.job, 'job ID')} ${esc(l.reason)}${l.command ? cmdBlock(l.command) : ''}</li>`)) : '<span class="muted">none</span>'}</dd>`;
  } else if (c.id === 'errors') {
    dl = `<dt>Count</dt><dd>${c.count}</dd><dt>Since</dt><dd>${c.since ? esc(utc(c.since)) : 'the start of the log'}</dd>
<dt>Latest</dt><dd>${c.latest ? `<span class="sub">${esc(utc(c.latest.at))}</span><br>${errCopy(c.latest.text)}` : '<span class="muted">none</span>'}</dd>`;
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
    cols: [{ key: 'job', label: 'Job', html: r => idCopy(r.job.slice(0, 8), r.job, 'job ID') }, { key: 'agent', label: 'Agent', html: r => agentTag(r.agent, view) }, { key: 'kind', label: 'Kind' }, { key: 'ref', label: 'Ref', num: true, html: r => (r.ref ? `#${Number(r.ref)}` : '–') },
      { key: 'ageMs', label: 'Age', num: true, html: r => esc(dur(r.ageMs)) }, { key: 'state', label: 'State', html: r => badge(r.state === 'stale' ? 'action' : r.state === 'held' ? 'warning' : 'ok', r.state) }, { key: 'status', label: 'Job status', more: true },
      { key: 'reason', label: 'Why', more: true, html: r => `${esc(r.reason)}${r.command ? cmdBlock(r.command) : ''}` }],
    totals: { job: 'count' }, emptyState: empty('No lease held', 'Leases appear while a supervised job owns an issue or worktree.', 'check') }) });
  const recent = s.ticks.slice(-5).reverse();
  const ticks = card({ id: 'h-recent', title: 'Recent ticks', span: 12, movable: false, href: '/supervisor/ticks', body: recent.length ? `<ul class="panel-list">${recent.map(t => `<li class="sev-${({ ok: 'ok', partial: 'warning', error: 'action' })[t.status] || 'info'}"><div class="t">${tickStatusBadge(t.status)} ${esc(utc(t.at))} <span class="sub">${esc(ago(t.at, view.generatedAt))}</span></div><div class="sub">${t.ingested.length} verdict(s), ${t.actions.length} action(s), ${t.skipped.length} skipped${t.errors.length ? `, ${t.errors.length} error(s)` : ''}${t.selfUpgrade ? `, self-upgrade ${esc(t.selfUpgrade)}` : ''}</div></li>`).join('')}</ul><p class="sub"><a href="/supervisor/ticks">Full tick history</a> · <a href="/supervisor/upgrades">Upgrade history</a></p>`
    : empty('No tick in the reconcile log', 'The reconcile cron writes one entry every five minutes.', 'clock') });
  return { title: 'Supervisor', body: `${grid('supervisor', cards)}<div class="cards">${ticks}${leases}</div>` };
}
function ticksPage(view, query, path) {
  // A row expands through the URL (ticks.open=<time>), like the rest of the table state: bookmarkable, works without script,
  // and nothing hidden is laid out (a closed <details> is still measured by the layout audit).
  const open = Number(query.get('ticks.open'));
  const rows = view.supervisor.ticks.slice().reverse().map((t, i) => ({ ...t, n: i, nIngested: t.ingested.length, nActions: t.actions.length, nSkipped: t.skipped.length, nErrors: t.errors.length, flags: t.errors.length ? 'error' : '',
    text: [...t.actions.map(a => `${a.agent} ${a.type} ${a.ref}`), ...t.skipped.map(s => `${s.what} ${s.reason}`), ...t.errors, t.note || ''].join(' ') }));
  return { title: 'Tick history', crumbs: [['/supervisor', 'Supervisor'], [null, 'Tick history']], body: grid('ticks', card({ id: 't-all', title: `Ticks in the reconcile log (${rows.length})`, span: 12, movable: false, body: table({ id: 'ticks', path, query, noun: 'ticks', rows, searchKeys: ['status', 'selfUpgrade', 'flags', 'text'],
    cols: [{ key: 'at', label: 'When', num: true, html: r => esc(utc(r.at)) }, { key: 'status', label: 'Status', html: r => tickStatusBadge(r.status) }, { key: 'nIngested', label: 'Verdicts', num: true }, { key: 'nActions', label: 'Actions', num: true },
      { key: 'nSkipped', label: 'Skipped', num: true }, { key: 'nErrors', label: 'Errors', num: true }, { key: 'selfUpgrade', label: 'Self-upgrade', more: true },
      { key: 'detail', label: 'Detail', sortable: false, html: r => (r.at === open && Number.isFinite(r.at)
        ? `<a class="btn" href="${esc(withQuery(path, query, { 'ticks.open': null }))}" aria-expanded="true">Hide</a><div class="tick-detail" id="tick-${r.at}">${tickDetail(r)}</div>`
        : Number.isFinite(r.at) ? `<a class="btn" href="${esc(withQuery(path, query, { 'ticks.open': r.at }))}#tick-${r.at}" aria-expanded="false">Show</a>` : '–') }],
    totals: { at: 'count', nActions: 'sum', nSkipped: 'sum', nErrors: 'sum' }, emptyState: empty('No tick in the reconcile log', 'The reconcile cron writes one entry every five minutes.', 'clock') }) })) };
}
function upgradesPage(view, query, path) {
  const rows = view.supervisor.upgrades.slice().reverse().map(u => ({ ...u, prText: u.prs.join(' '), checkText: Object.entries(u.checks).map(([k, v]) => `${k} ${v}`).join(', ') }));
  return { title: 'Upgrade history', crumbs: [['/supervisor', 'Supervisor'], [null, 'Upgrade history']], body: grid('upgrades', card({ id: 'u-all', title: `Self-upgrade records (${rows.length})`, span: 12, movable: false, body: table({ id: 'upg', path, query, noun: 'records', rows, searchKeys: ['result', 'reason', 'from', 'to', 'prText'],
    cols: [{ key: 'at', label: 'When', num: true, html: r => esc(utc(r.at)) }, { key: 'result', label: 'Result', html: r => badge(resultSeverity(r.result), r.result) }, { key: 'from', label: 'From', html: r => shaCopy(r.from) }, { key: 'to', label: 'To', html: r => shaCopy(r.to) },
      { key: 'prText', label: 'PRs', html: r => (r.prs.length ? r.prs.map(prLink).join(', ') : '–') }, { key: 'reason', label: 'Reason', html: r => (r.reason ? errCopy(r.reason) : '–') }, { key: 'checkText', label: 'Checks', more: true }],
    totals: { at: 'count' }, emptyState: empty('No self-upgrade record', 'Records appear in team/upgrades.jsonl when the supervisor upgrades itself.', 'info') }) })) };
}
const PAGES = { overview, agents: agentsPage, agent: agentDetail, work: workPage, pr: prDetail, issue: issueDetail, activity: activityPage, usage: usagePage, reviews: reviewsPage, supervisor: supervisorPage, ticks: ticksPage, upgrades: upgradesPage, system: systemPage };

// Returns { status, html }. A drill-down for something that does not exist is a 404 page, not an empty one.
export function renderRoute(view, route, { query = new URLSearchParams(), pathname = '/', refreshSeconds = 60 } = {}) {
  const fn = PAGES[route.page];
  const page = fn ? fn(view, query, pathname.replace(/\/+$/, '') || '/', route) : null;
  const res = page || { title: 'Not found', body: `<div class="cards">${card({ id: 'nf', title: 'Not found', span: 12, movable: false, body: empty('This item is not in the dashboard data', 'It may be closed and no longer cached, or the number is wrong.', 'warn') })}</div>`, crumbs: [['/work', 'Work']] };
  const crumbs = res.crumbs ? `<p class="crumbs">${res.crumbs.map(([h, t]) => (h ? `<a href="${h}">${esc(t)}</a>` : esc(t))).join(' / ')}</p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${refreshSeconds}"><title>${esc(res.title)} · DevTest team</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/static/style.css"></head>
<body class="${res.bodyClass || ''}">${sprite}<a class="skip" href="#main">Skip to content</a>${statusBar(view, route)}<main id="main"><h1>${esc(res.title)}</h1>${crumbs}${res.body}</main><p id="copy-status" class="vh" role="status" aria-live="polite"></p><script type="module" src="/static/app.js"></script></body></html>`;
  return { status: page ? 200 : 404, html };
}
// Kept for callers that only want the overview.
export const renderPage = (view, opts = {}) => renderRoute(view, opts.route || { page: 'overview' }, opts).html;
