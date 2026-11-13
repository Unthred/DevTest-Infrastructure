// Issue #1219: the view switch above the Inbox list and the three renderings of the same items: Cards (the existing card), Table and
// Compact list. The page server-renders all three from one ordered list of items and the browser script (dashui/inbox-views-ui.mjs)
// shows one, so the filtered items and their order are the same in every view. Without the script the Cards view shows.
import { COLUMNS, VIEWS, VIEW_LABELS, rowOf, stateMark } from './dashui/inbox-views.mjs';

// The scripts the Inbox page loads; dashserver adds them to its static files with one Object.assign.
const js = file => [file, 'text/javascript; charset=utf-8'];
export const INBOX_VIEWS_STATIC = {
  '/static/inbox-views.mjs': js('inbox-views.mjs'),
  '/static/inbox-views-ui.mjs': js('inbox-views-ui.mjs'),
  '/static/table-columns.mjs': js('table-columns.mjs'),
};

const cell = (row, key, esc, highlight) => {
  if (key === 'title') return `<span class="iv-title">${highlight(row.title)}</span>`;
  if (key === 'result') return row.result ? `<span class="iv-result">${highlight(row.result)}</span>` : '<span class="iv-none">–</span>';
  return esc(row[key]);
};

export function tableRow(row, { esc, highlight }) {
  const cells = COLUMNS.map(c => {
    const created = c.key === 'age' ? ` data-created="${row.created ?? ''}"` : '';
    return `<td data-col="${c.key}" data-label="${esc(c.label)}"${created}>${cell(row, c.key, esc, highlight)}</td>`;
  }).join('');
  return `<tr data-id="${esc(row.id)}" data-state="${esc(row.state)}">${cells}</tr>`;
}

export function compactRow(row, { esc, highlight }) {
  const [mark, word] = stateMark(row.state);
  const result = row.full ? `<p class="iv-more-result"><b>Result</b> <span>${highlight(row.full)}</span></p>` : '';
  const prompt = row.prompt ? `<p class="iv-more-prompt"><b>Prompt</b> <span>${highlight(row.prompt)}</span></p>` : '';
  const markHtml = `<span class="iv-mark" title="${esc(word)}" aria-label="${esc(word)}">${mark}</span>`;
  const summary = `${markHtml}<span class="iv-title">${highlight(row.title)}</span><span class="iv-kind">${esc(row.kind)}</span>`
    + `<span class="iv-age" data-created="${row.created ?? ''}">${esc(row.age)}</span>`;
  return `<li class="iv-crow" data-id="${esc(row.id)}" data-state="${esc(row.state)}"><details><summary>${summary}</summary>`
    + `<div class="iv-more">${result + prompt || '<p class="sub">No result yet.</p>'}</div></details></li>`;
}

const viewButton = (v, esc) => `<button type="button" class="btn iv-view" data-view="${v}" aria-pressed="${v === 'cards'}">${esc(VIEW_LABELS[v])}</button>`;
const columnToggle = (c, esc) => `<label><input type="checkbox" data-col="${c.key}" checked> ${esc(c.label)}</label>`;

const switchBar = esc => `<div class="iv-bar"><div class="iv-switch" role="group" aria-label="Inbox view">${VIEWS.map(v => viewButton(v, esc)).join('')}</div>`
  + `<details class="iv-cols"><summary>Columns</summary><div class="iv-colmenu">${COLUMNS.map(c => columnToggle(c, esc)).join('')}</div></details></div>`;

const headCell = (c, esc) => `<th scope="col" data-col="${c.key}"><button type="button" class="iv-sort" data-sort="${c.key}">${esc(c.label)}</button>`
  + `<span class="iv-grip" data-grip="${c.key}" role="separator" aria-orientation="vertical" aria-label="Resize ${esc(c.label)}" tabindex="0"></span></th>`;

const tableHtml = (rows, ctx) => `<div class="iv-tablewrap" data-pane="table" hidden><table class="iv-table">`
  + `<colgroup>${COLUMNS.map(c => `<col data-col="${c.key}">`).join('')}</colgroup>`
  + `<thead><tr>${COLUMNS.map(c => headCell(c, ctx.esc)).join('')}</tr></thead>`
  + `<tbody>${rows.map(r => tableRow(r, ctx)).join('')}</tbody></table></div>`;

// records: the filtered inbox records in display order; cardsHtml: the existing card list for the same records.
export function inboxViews({ records, now, esc, highlight, cardsHtml }) {
  const rows = records.map(r => rowOf(r, now));
  const ctx = { esc, highlight };
  return `<div class="iv" data-iv data-view="cards">${switchBar(esc)}<div data-pane="cards">${cardsHtml}</div>${tableHtml(rows, ctx)}`
    + `<ul class="iv-compact" data-pane="compact" hidden>${rows.map(r => compactRow(r, ctx)).join('')}</ul>`
    + '<script type="module" src="/static/inbox-views-ui.mjs"></script></div>';
}
