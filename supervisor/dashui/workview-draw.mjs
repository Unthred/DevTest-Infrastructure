// Issue #1224: the HTML of the Work page's table, board, filter bar and side panel, as strings. Pure (no DOM), so the tests render the same
// markup the page shows. Every value is escaped here; the browser script only places the strings and binds events.
import { COLUMNS, GROUPS, STATES, STATE_LABEL, cellText, countLine } from './worktable.mjs';

export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DEFAULT_WIDTH = { title: 320, holdReason: 280, waitsOn: 140, labels: 160, checks: 90 };
const widthOf = (state, key) => state.widths[key] || DEFAULT_WIDTH[key] || 110;
export const visibleColumns = state => COLUMNS.filter(c => !state.hidden.includes(c.key));

// ---- filter bar
function chip(kind, value, label, count, on) {
  return `<button type="button" class="qf wv-chip" data-facet="${kind}" data-value="${esc(value)}" aria-pressed="${on}">`
    + `<span>${esc(label)}</span> <span class="qf-n">${count}</span></button>`;
}
const facetRow = (title, chips) => `<div class="wv-facet" role="group" aria-label="Filter by ${esc(title)}">`
  + `<span class="wv-facet-t">${esc(title)}</span>${chips.join('')}</div>`;

function controlsHtml({ state, saved, selected, shown, total }) {
  const groups = GROUPS.map(([k, l]) => `<option value="${k}"${state.group === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const columns = COLUMNS.map(c => {
    const on = state.hidden.includes(c.key) ? '' : ' checked';
    return `<label class="wv-col"><input type="checkbox" data-col-toggle="${c.key}"${on}> ${esc(c.label)}</label>`;
  }).join('');
  const views = saved.map(v => `<option value="${esc(v.name)}"${v.name === selected ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
  return `<div class="wv-controls"><label>Group by <select data-wv-group>${groups}</select></label>
<details class="wv-cols"><summary class="btn">Columns</summary><div class="wv-colmenu">${columns}</div></details>
<label>Saved views <select data-wv-saved aria-label="Saved views"><option value="">Choose a saved view</option>${views}</select></label>
<label>Name <input type="text" data-wv-name maxlength="40" placeholder="Name for this view"></label>
<button type="button" class="btn" data-wv-save>Save this view</button>
<button type="button" class="btn" data-wv-delete${saved.length ? '' : ' hidden'}>Delete saved view</button>
<button type="button" class="btn" data-wv-clear>Clear filters</button><button type="button" class="btn" data-wv-csv>Export CSV</button>
<span class="sub" data-wv-count role="status">${esc(countLine(shown, total))}</span></div>`;
}

export function filterBarHtml({ state, counts, values, saved, selected, shown, total }) {
  const f = state.filters;
  const states = STATES.map(([k, l]) => chip('state', k, l, counts.state[k] || 0, f.state.includes(k)));
  const agents = values.agent.map(a => chip('agent', a, a, counts.agent[a] || 0, f.agent.includes(a)));
  const labels = values.label.map(l => chip('label', l, l, counts.label[l] || 0, f.label.includes(l)));
  const search = `<label class="wv-search"><input type="search" class="dl-q" aria-label="Search the queue" data-wv-q `
    + `placeholder="Search ref, title, agent, hold reason" value="${esc(f.q)}" maxlength="200"></label>`;
  return `<div class="wv-tools">${search}${facetRow('state', states)}${facetRow('agent', agents)}${labels.length ? facetRow('label', labels) : ''}`
    + `${controlsHtml({ state, saved, selected, shown, total })}</div>`;
}

// ---- table
const stateBadge = r => `<span class="wv-state wv-state-${esc(r.state)}">${esc(STATE_LABEL[r.state])}</span>`;
function cellHtml(r, c, ctx) {
  const text = cellText(r, c.key, ctx);
  if (c.key === 'ref') {
    return `<button type="button" class="wv-open" data-open="${esc(r.key)}" aria-label="Open details for ${esc(text)} ${esc(r.title)}">${esc(text)}</button>`;
  }
  if (c.key === 'state') return stateBadge(r);
  if (c.key === 'title') return `<span class="wv-title">${esc(text)}</span>`;
  return esc(text);
}
function headCell(c, state, sortKey, sortDir) {
  const on = c.key === sortKey, sort = on ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none';
  const arrow = on ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th scope="col" data-col="${c.key}" style="width:${widthOf(state, c.key)}px" aria-sort="${sort}">`
    + `<button type="button" class="wv-sort" data-sort="${c.key}">${esc(c.label)}<span aria-hidden="true">${arrow}</span></button>`
    + `<span class="wv-resize" data-resize="${c.key}" role="separator" aria-orientation="vertical"`
    + ` aria-label="Resize ${esc(c.label)}" tabindex="0"></span></th>`;
}
const rowHtml = (r, cols, ctx) => `<tr class="wv-row" data-row="${esc(r.key)}">`
  + `${cols.map(c => `<td data-cell="${c.key}" class="${c.type === 'num' ? 'num' : ''}">${cellHtml(r, c, ctx)}</td>`).join('')}</tr>`;
const groupHeader = (g, cols) => (g.label
  ? `<tr class="wv-group"><th colspan="${cols.length}" scope="colgroup">${esc(g.label)} <span class="qf-n">${g.rows.length}</span></th></tr>`
  : '');

export function tableHtml({ groups, state, ctx, sortKey, sortDir }) {
  const cols = visibleColumns(state);
  const head = cols.map(c => headCell(c, state, sortKey, sortDir)).join('');
  const body = groups.map(g => groupHeader(g, cols) + g.rows.map(r => rowHtml(r, cols, ctx)).join('')).join('');
  const width = cols.reduce((n, c) => n + widthOf(state, c.key), 0);
  return `<div class="wv-scroll"><table class="wv-table" style="width:${width}px">`
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---- board
function cardHtml(r) {
  const hold = r.holdReason ? ` · ${esc(r.holdReason)}` : '';
  return `<button type="button" class="wv-card" data-open="${esc(r.key)}"><b>${esc(cellText(r, 'ref'))}</b> `
    + `<span class="wv-title">${esc(r.title)}</span><span class="sub">${esc(r.agent || 'no agent')}${hold}</span></button>`;
}
export function boardHtml(columns) {
  const column = col => `<section class="wv-col-board" data-board="${col.id}" aria-label="${esc(col.label)}">`
    + `<h3>${esc(col.label)} <span class="qf-n">${col.rows.length}</span></h3>`
    + `${col.rows.length ? col.rows.map(cardHtml).join('') : '<p class="sub">Nothing here</p>'}</section>`;
  return `<div class="wv-board">${columns.map(column).join('')}</div>`;
}

// ---- side panel
const when = (ms, ctx) => (Number.isFinite(ms) ? esc(ctx.time(ms)) : 'not recorded');
const list = items => `<ul class="panel-list">${items.join('')}</ul>`;
const jobItem = j => `<li><b>${esc(j.kind)}</b> ${esc(j.status)} · ${esc(j.agent || '')} · ${esc(j.tokens ?? '–')} tokens · ${esc(j.costText)}`
  + `<div class="sub">${esc(j.cause)}</div><a href="${esc(j.page)}">Job ${esc(j.id)}</a>`
  + `${j.transcript ? ` · <a href="${esc(j.transcript)}">Transcript</a>` : ''}</li>`;
const verdictItem = (v, ctx) => `<li><b>${esc(v.verdict || 'no verdict')}</b> by ${esc(v.reviewer || 'unknown')}${v.model ? ` (${esc(v.model)})` : ''}`
  + ` at ${esc(v.head)} <span class="sub">${when(v.at, ctx)}</span>`
  + `${v.findings.length ? `<ul>${v.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</li>`;
const chainItem = c => `<li style="margin-left:${(c.depth - 1) * 14}px">${c.blocking ? 'Open' : 'Closed'} · `
  + `<a href="/work/issue/${c.ref}">#${c.ref}</a> ${esc(c.title || '')}</li>`;

export function panelHtml(row, detail, ctx) {
  const d = detail || { jobs: [], verdicts: [], chain: [] };
  const fact = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const hold = row.holdReason ? `${esc(row.holdReason)}<br><span class="sub">Began: ${when(row.holdSince, ctx)}</span>` : 'Not held';
  const start = row.estStart ? ctx.time(row.estStart) : row.estText || 'no estimate';
  const facts = fact('State', stateBadge(row)) + fact('Agent', esc(row.agent || '–')) + fact('Rank', esc(cellText(row, 'rank') || '–'))
    + fact('Hold reason', hold) + fact('Estimated start', esc(start)) + fact('Checks', esc(row.checks || '–')) + fact('Cost', esc(row.costText));
  const chain = d.chain.length ? list(d.chain.map(chainItem)) : '<p class="sub">No prerequisites.</p>';
  const jobs = d.jobs.length ? list(d.jobs.map(jobItem)) : '<p class="sub">No jobs recorded.</p>';
  const reviews = d.verdicts.length ? list(d.verdicts.map(v => verdictItem(v, ctx))) : '<p class="sub">No reviews yet.</p>';
  const links = `<a href="${esc(row.url)}" rel="noopener noreferrer" target="_blank">${row.kind === 'pr' ? 'Pull request' : 'Issue'} on GitHub</a>`
    + ` · <a href="${esc(row.page)}">Dashboard page</a>`;
  return `<div class="wv-side-head"><h3 id="wv-side-title">${esc(cellText(row, 'ref'))} ${esc(row.title)}</h3>`
    + `<button type="button" class="btn" data-wv-close>Close</button></div><dl class="kv">${facts}</dl>`
    + `<h4>Dependency chain</h4>${chain}<h4>Jobs</h4>${jobs}<h4>Reviews and verdicts</h4>${reviews}<h4>Links</h4><p>${links}</p>`;
}
