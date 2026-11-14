// Issue #1219: the view switch above the Inbox list and the three renderings of the same items: Cards (the existing card), Table and
// Compact list. The page server-renders all three from one ordered list of items and the browser script (dashui/inbox-views-ui.mjs)
// shows one, so the filtered items and their order are the same in every view. Without the script the Cards view shows.
import { COLUMNS, VIEWS, VIEW_LABELS, decisionForms, kindLabel, rowOf, stateMark, stateSeverity } from './dashui/inbox-views.mjs';

// The scripts the Inbox page loads; dashserver adds them to its static files with one Object.assign.
const js = file => [file, 'text/javascript; charset=utf-8'];
export const INBOX_VIEWS_STATIC = {
  '/static/inbox-views.mjs': js('inbox-views.mjs'),
  '/static/inbox-views-ui.mjs': js('inbox-views-ui.mjs'),
  '/static/table-columns.mjs': js('table-columns.mjs'),
};

// Issue #1414: the card's reference ("C142", or "C142, issue #1411" once posted) leads the title in every view.
const refHtml = (row, highlight) => (row.reference ? `<span class="inbox-ref">${highlight(row.reference)}</span> ` : '');
const titleHtml = (row, esc, highlight) => `<span class="iv-title">${refHtml(row, highlight)}${highlight(row.title)}</span>`;

// Issue #1416: the Kind and State chips are the Now card's badges; a decision card already clicked says "decided" in place of the bare "waiting", with the sentence under the title.
const chip = (sev, mark, word, esc) => `<span class="badge sev-${sev}"><span aria-hidden="true">${mark}</span> ${esc(word)}</span>`;
const kindChip = (row, esc) => chip('info', '▪', kindLabel(row.kind), esc);
const stateChip = (row, esc) => {
  if (row.decided && row.state === 'pending') return chip('info', '✔', 'decided', esc);
  const [mark, word] = stateMark(row.state);
  return chip(stateSeverity(row.state), mark, word, esc);
};
const decidedLine = (row, esc) => (row.decided ? `<span class="iv-decided">${esc(row.decided)}</span>` : '');

const cell = (row, key, esc, highlight) => {
  if (key === 'title') return titleHtml(row, esc, highlight) + decidedLine(row, esc);
  if (key === 'kind') return kindChip(row, esc);
  if (key === 'state') return stateChip(row, esc);
  if (key === 'result') return row.result ? `<span class="iv-result">${highlight(row.result)}</span>` : '<span class="iv-none">–</span>';
  return esc(row[key]);
};

// The forms, an error place and an outcome place the decision script (dashui/app.js) finds through data-inbox; empty when the item has no buttons.
function actionsHtml(row, form) {
  const { approve, reject } = decisionForms(row, form);
  if (!approve && !reject) return '';
  return `<div class="acts iv-acts">${approve}${reject}</div><div class="inbox-err" role="alert" hidden></div><span class="inbox-outcome" hidden></span>`;
}

// The chip cells sort on the record's own word, not on the chip's marker character (data-sort).
const SORTED_AS_WORD = new Set(['kind', 'state']);
export function tableRow(row, { esc, highlight, form, noResult = false }) {
  const cells = COLUMNS.map(c => {
    const created = c.key === 'age' ? ` data-created="${row.created ?? ''}"` : '';
    const sort = SORTED_AS_WORD.has(c.key) ? ` data-sort="${esc(row[c.key])}"` : '';
    const empty = c.key === 'result' && noResult ? ' data-empty="1" hidden' : '';
    return `<td data-col="${c.key}" data-label="${esc(c.label)}"${created}${sort}${empty}>${cell(row, c.key, esc, highlight)}</td>`;
  }).join('');
  const actions = `<td data-col="actions" data-label="Actions">${actionsHtml(row, form)}</td>`;
  return `<tr data-id="${esc(row.id)}" data-inbox="${esc(row.id)}" data-state="${esc(row.state)}">${cells}${actions}</tr>`;
}

export function compactRow(row, { esc, highlight, form }) {
  const result = row.full ? `<p class="iv-more-result"><b>Result</b> <span>${highlight(row.full)}</span></p>` : '';
  const prompt = row.prompt ? `<p class="iv-more-prompt"><b>Prompt</b> <span>${highlight(row.prompt)}</span></p>` : '';
  const chips = `<span class="iv-chips">${stateChip(row, esc)} ${kindChip(row, esc)}</span>`;
  const meta = `<span class="iv-meta"><span class="iv-age" data-created="${row.created ?? ''}">${esc(row.age)}</span> · <span class="iv-source">${esc(row.source)}</span></span>`;
  const summary = `${chips}<span class="iv-body">${titleHtml(row, esc, highlight)}${decidedLine(row, esc)}</span>${meta}`;
  const actions = actionsHtml(row, form);
  return `<li class="iv-crow" data-id="${esc(row.id)}" data-inbox="${esc(row.id)}" data-state="${esc(row.state)}"><details><summary>${summary}</summary>`
    + `<div class="iv-more">${result + prompt || '<p class="sub">No result yet.</p>'}</div></details>${actions}</li>`;
}

const viewButton = (v, esc) => `<button type="button" class="btn iv-view" data-view="${v}" aria-pressed="${v === 'cards'}">${esc(VIEW_LABELS[v])}</button>`;
const columnToggle = (c, esc) => `<label><input type="checkbox" data-col="${c.key}" checked> ${esc(c.label)}</label>`;

const switchBar = esc => `<div class="iv-bar"><div class="iv-switch" role="group" aria-label="Inbox view">${VIEWS.map(v => viewButton(v, esc)).join('')}</div>`
  + `<details class="iv-cols"><summary>Columns</summary><div class="iv-colmenu">${COLUMNS.map(c => columnToggle(c, esc)).join('')}</div></details></div>`;

const headCell = (c, esc, noResult) => `<th scope="col" data-col="${c.key}"${c.key === 'result' && noResult ? ' data-empty="1" hidden' : ''}><button type="button" class="iv-sort" data-sort="${c.key}">${esc(c.label)}</button>`
  + `<span class="iv-grip" data-grip="${c.key}" role="separator" aria-orientation="vertical" aria-label="Resize ${esc(c.label)}" tabindex="0"></span></th>`;

// Actions is last, is not in COLUMNS (so not in the Columns menu, not sortable, never hidden).
const actionsHead = '<th scope="col" data-col="actions">Actions</th>';

// Issue #1416: the Result column exists only while a visible row has a result (data-empty keeps the column script from showing it again).
const tableHtml = (rows, ctx) => {
  const noResult = !rows.some(r => r.result);
  const col = c => `<col data-col="${c.key}"${c.key === 'result' && noResult ? ' data-empty="1" hidden' : ''}>`;
  return `<div class="iv-tablewrap" data-pane="table" hidden><table class="iv-table">`
    + `<colgroup>${COLUMNS.map(col).join('')}<col data-col="actions"></colgroup>`
    + `<thead><tr>${COLUMNS.map(c => headCell(c, ctx.esc, noResult)).join('')}${actionsHead}</tr></thead>`
    + `<tbody>${rows.map(r => tableRow(r, { ...ctx, noResult })).join('')}</tbody></table></div>`;
};

// records: the filtered inbox records in display order; cardsHtml: the existing card list for the same records.
export function inboxViews({ records, now, esc, highlight, cardsHtml, form }) {
  const rows = records.map(r => rowOf(r, now));
  const ctx = { esc, highlight, form };
  return `<div class="iv" data-iv data-view="cards">${switchBar(esc)}<div data-pane="cards">${cardsHtml}</div>${tableHtml(rows, ctx)}`
    + `<ul class="iv-compact" data-pane="compact" hidden>${rows.map(r => compactRow(r, ctx)).join('')}</ul>`
    + '<script type="module" src="/static/inbox-views-ui.mjs"></script></div>';
}
