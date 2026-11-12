// Issue #1162: the Limit resets card on the Usage and cost page: per agent, each reset with its advice and the figures behind it, and the forms
// to add, edit, mark used and delete a record. Rendering only; the decisions come from resetadvice.mjs. Helpers (esc, card, badge, lt) are passed in
// by dashrender.mjs so this file does not import it.
const VERDICT = {
  use_now: { level: 'action', label: 'Use now' },
  hold: { level: 'info', label: 'Hold' },
  lost_cause: { level: 'info', label: 'Does not help Foreman' },
  use_before_expiry: { level: 'warning', label: 'Use before expiry' },
};
const LIMIT_WORD = { weekly: 'Weekly', five_hour: 'Five hour' };

const tokens = n => (Number.isFinite(n) ? (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`) : 'unknown');
const hours = h => (Number.isFinite(h) ? (h >= 48 ? `${Math.round(h / 24 * 10) / 10} days` : `${h} h`) : 'unknown');
const share = s => (Number.isFinite(s) ? `${Math.round(s * 100)}%` : 'unknown');

function figuresHtml(f, esc) {
  const rows = [['Would restore', f.restoreTokens === null ? 'not measured' : `${tokens(f.restoreTokens)} tokens`],
    ['Could spend before the natural reset', f.spendableTokens === null ? 'unknown' : `${tokens(f.spendableTokens)} tokens`],
    ['Usable share', share(f.usableShare)], ['Hours left', hours(f.hoursLeft)]];
  return `<dl class="reset-figures">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

const hidden = (action, id) => `<input type="hidden" name="action" value="${action}">${id ? `<input type="hidden" name="id" value="${id}">` : ''}`;
const button = (action, id, label, title, esc) => `<form method="post" action="/resets" class="reset-act">${hidden(action, id)}<button type="submit" class="tbtn" title="${esc(title)}">${esc(label)}</button></form>`;
const dateOf = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');

function fieldsHtml(agentNames, rec, esc) {
  const pick = (name, values, current) => `<select name="${name}">${values.map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<label>Agent ${pick('agent', agentNames.map(n => [n, n]), rec?.agent)}</label>
<label>Limit ${pick('limit', [['weekly', 'Weekly'], ['five_hour', 'Five hour']], rec?.limit)}</label>
<label>Scope <input name="scope" value="${esc(rec?.scope ?? 'all')}" size="10" maxlength="24" title="all, or a model family such as fable"></label>
<label>Expires <input type="date" name="expiry" value="${esc(dateOf(rec?.expiry))}"></label>
<label>Note <input name="note" value="${esc(rec?.note ?? '')}" size="16" maxlength="120"></label>`;
}

function editHtml(agentNames, a, esc) {
  return `<details class="reset-edit"><summary>Edit</summary><form method="post" action="/resets" class="reset-form">${hidden('edit', a.id)}${fieldsHtml(agentNames, a, esc)}<button type="submit" class="tbtn">Save</button></form></details>`;
}

function rowHtml(a, ctx) {
  const { esc, badge, lt, agentNames } = ctx;
  const v = VERDICT[a.verdict] || VERDICT.hold;
  const amber = a.expiring && !a.expired ? ` ${badge('warning', `${a.daysToExpiry} day${a.daysToExpiry === 1 ? '' : 's'} left`)}` : '';
  const expiry = Number.isFinite(a.expiry) ? `${lt(a.expiry)}${amber}` : '<span class="muted">no expiry</span>';
  const actions = `${button('used', a.id, 'Mark used', 'Record that you applied this reset on claude.ai; Foreman then refreshes the allowance', esc)}${editHtml(agentNames, a, esc)}${button('delete', a.id, 'Delete', 'Remove this record', esc)}`;
  return `<tr data-reset="${esc(a.id)}" data-verdict="${esc(a.verdict)}"><td>${esc(LIMIT_WORD[a.limit])}${a.scope === 'all' ? '' : ` ${esc(a.scope)}`}</td><td>${expiry}</td>`
    + `<td>${badge(v.level, v.label)} ${esc(a.why)}${a.spacing ? `<br><span class="sub">${esc(a.spacing)}</span>` : ''}</td><td>${figuresHtml(a.figures, esc)}</td><td class="reset-actions">${actions}</td></tr>`;
}

function agentHtml(name, group, ctx) {
  const { esc } = ctx;
  const rows = group.advice.map(a => rowHtml(a, ctx)).join('');
  const table = rows ? `<table><thead><tr><th>Reset</th><th>Expires</th><th>Advice</th><th>Figures</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="sub">No available resets recorded.</p>';
  const used = group.used.length ? `<p class="sub">${group.used.length} used (${group.used.map(r => `${esc(LIMIT_WORD[r.limit])}${r.scope === 'all' ? '' : ` ${esc(r.scope)}`}`).join(', ')}).</p>` : '';
  return `<section class="reset-agent" data-agent="${esc(name)}"><h3>${esc(name)}</h3>${table}${used}</section>`;
}

export function limitResetsCard(view, ctx) {
  const { esc, card } = ctx;
  const data = view.limitResets;
  if (!data) return '';
  const names = data.agentNames || Object.keys(data.agents);
  const full = { ...ctx, agentNames: names };
  const body = `<p class="sub">Only you can apply a reset (claude.ai, Settings, Usage); Foreman advises. A reset does not move the weekly reset time, so it is worth most when Foreman is held early in a week.
Worth using when at least ${share(data.settings.usable_share)} of what it restores could be spent before the natural reset; amber from ${data.settings.expiry_warn_days} days before an expiry.</p>`
    + Object.entries(data.agents).map(([name, group]) => agentHtml(name, group, full)).join('')
    + `<details class="reset-add"><summary>Add a reset</summary><form method="post" action="/resets" class="reset-form">${hidden('add', '')}${fieldsHtml(names, null, esc)}<button type="submit" class="tbtn">Add</button></form></details>`;
  return card({ id: 'limit-resets', title: 'Limit resets', span: 12, movable: true, body });
}
