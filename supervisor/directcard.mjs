// Issue #1164: the "Overseer direct control" card on the Supervisor page: the one switch, and the audit trail with an Undo for each action that can be
// reversed. The page helpers are passed in (the dashrender pattern). Every dynamic value goes through esc(); forms are plain posts, the server adds the proof.
const ACTION = 'action="/direct"';
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${value}">`;
const OUTCOME = { done: ['ok', 'done'], refused: ['warning', 'refused'], failed: ['action', 'failed'] };

function switchForm(h, direct) {
  const on = direct.enabled;
  const state = on ? h.badge('ok', 'on') : h.badge('action', 'off');
  const next = on ? 'off' : 'on';
  const label = on ? 'Turn direct control off' : 'Turn direct control on';
  const note = on ? 'The overseer applies queue changes directly.' : 'The MCP is read and propose only; every direct action is refused.';
  return `<p data-switch="${on ? 'on' : 'off'}">Direct control is ${state}. ${note}</p>`
    + `<form method="post" ${ACTION}>${hidden('action', 'switch')}${hidden('value', next)}<button class="btn" type="submit">${label}</button></form>`;
}

function undoForm(h, e) {
  if (e.undone) return h.badge('info', 'undone');
  if (!e.undoable) return '';
  const fields = `${hidden('action', 'undo')}${hidden('id', h.esc(e.id))}`;
  return `<form method="post" ${ACTION} class="inline">${fields}<button class="btn" type="submit">Undo</button></form>`;
}

function auditRow(h, e) {
  const [sev, word] = OUTCOME[e.outcome] || OUTCOME.failed;
  const change = e.before || e.after ? ` <span class="sub">${h.esc(JSON.stringify(e.before))} to ${h.esc(JSON.stringify(e.after))}</span>` : '';
  const reason = e.reason ? ` <span class="sub">Reason: ${h.esc(e.reason)}</span>` : '';
  const head = `${h.badge(sev, word)} <b>${h.esc(e.action)}</b> ${h.esc(e.target)}${e.value ? ` (${h.esc(e.value)})` : ''} by ${h.esc(e.by)}, ${h.lt(e.at)}`;
  return `<li data-audit="${h.esc(e.id)}" data-outcome="${h.esc(e.outcome)}">${head}<br>${h.esc(e.text)}${change}${reason} ${undoForm(h, e)}</li>`;
}

export function directCard(h, direct) {
  if (!direct) return '';
  const rows = direct.audit.map(e => auditRow(h, e)).join('');
  const list = rows ? `<ul class="plain" data-audit-list>${rows}</ul>` : '<p class="sub">No direct actions recorded yet.</p>';
  return h.card({ id: 's-direct', title: 'Overseer direct control', span: 12, movable: false, body: `${switchForm(h, direct)}<h4>Audit trail</h4>${list}` });
}
