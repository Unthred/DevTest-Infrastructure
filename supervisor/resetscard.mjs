// Issue #1159: the "Limit resets" card on the Usage and cost page. The page helpers are passed in (the dashrender pattern), so this
// module imports nothing from the renderer. Every dynamic value goes through esc(). Forms are plain posts; the server adds the proof.
const SEV_WORD = { warning: 'amber', action: 'expired', ok: 'ok', info: 'no expiry' };
const ACTION = 'action="/limit-resets"';

const hidden = (name, value) => `<input type="hidden" name="${name}" value="${value}">`;
const button = (h, id, action, label) => {
  const form = `<form method="post" ${ACTION} class="inline">`;
  return `${form}${hidden('action', action)}${hidden('id', h.esc(id))}<button type="submit">${label}</button></form>`;
};

function selectOf(h, name, options, current) {
  const items = options.map(([v, l]) => `<option value="${h.esc(v)}"${v === current ? ' selected' : ''}>${h.esc(l)}</option>`);
  return `<select name="${name}">${items.join('')}</select>`;
}
function fields(h, r = {}) {
  const limit = selectOf(h, 'limit', [['weekly', 'Weekly limit'], ['five_hour', 'Five-hour limit']], r.limit);
  const scope = `<label>Models <input name="scope" value="${h.esc(r.scope === 'all' ? '' : r.scope || '')}" placeholder="all, or fable" size="10"></label>`;
  const expires = `<label>Expires <input name="expires" type="date" value="${h.esc(r.expires || '')}"></label>`;
  return `${limit} ${scope} ${expires}`;
}

function resetRow(h, r) {
  const scope = r.scope === 'all' ? 'all models' : `${r.scope} models only`;
  const used = r.usedAt ? ` ${h.badge('info', 'used')}` : '';
  const toggle = r.usedAt ? button(h, r.id, 'unuse', 'Mark available') : button(h, r.id, 'use', 'Mark used');
  const editHidden = `${hidden('action', 'edit')}${hidden('id', h.esc(r.id))}`;
  const editForm = `<form method="post" ${ACTION}>${editHidden}${fields(h, r)}<button type="submit">Save</button></form>`;
  const helps = `<p class="sub helps" data-helps="${r.helps.yes ? 'yes' : 'no'}">Helps Foreman now: ${h.esc(r.helps.text)}</p>`;
  const head = `<b>${h.esc(r.limitLabel)}</b>, ${h.esc(scope)}; ${h.badge(r.severity, r.text)}${used}`;
  return `<li data-reset="${h.esc(r.id)}" data-expiry="${h.esc(SEV_WORD[r.severity] || r.severity)}">${head}${helps}`
    + `${toggle}${button(h, r.id, 'delete', 'Delete')}<details><summary>Edit</summary>${editForm}</details></li>`;
}
function appliedRow(h, e) {
  const change = `weekly use fell from ${Math.round(e.from * 100)}% to ${Math.round(e.to * 100)}% without the window rolling over`;
  const kept = 'Kept out of the learned capacity and the run-out estimate.';
  return `<li data-applied="${e.at}">${h.badge('info', 'Limit reset applied')} ${h.lt(e.at)}: ${change}. ${kept}</li>`;
}

function agentSection(h, agent, a) {
  const list = a.resets.length ? `<ul class="plain">${a.resets.map(r => resetRow(h, r)).join('')}</ul>` : '';
  const events = a.applied.length ? `<ul class="plain">${a.applied.map(e => appliedRow(h, e)).join('')}</ul>` : '';
  return `<section data-agent="${h.esc(agent)}"><h4>${h.esc(agent)}</h4>${list}${events}</section>`;
}

export function resetsCard(h, view) {
  if (!view) return '';
  const sections = Object.entries(view.byAgent).map(([agent, a]) => agentSection(h, agent, a)).join('');
  const agentSelect = selectOf(h, 'agent', view.agents.map(a => [a, a]));
  const agentLabel = `<label>Agent ${agentSelect}</label>`;
  const form = `<form method="post" ${ACTION}>${hidden('action', 'add')}${agentLabel} ${fields(h)} <button type="submit">Add</button></form>`;
  const add = `<details${sections ? '' : ' open'}><summary>Record a reset</summary>${form}</details>`;
  const intro = sections ? '' : '<p class="sub">No limit resets recorded. Foreman cannot read them from the provider, so record each one you hold.</p>';
  return h.card({ id: 'u-resets', title: 'Limit resets', span: 12, movable: true, body: `${intro}${sections}${add}` });
}
