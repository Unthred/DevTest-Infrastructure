// Issue #1222: the markup of the Stalled card (top of Overview) and of the stalled marks in the app bar. Data comes from stallview.mjs.
// The page helpers are passed in (the appbaralloc pattern) so this module imports nothing from the renderer.
import { NO_REASON } from './stallview.mjs';

export const STALL_HREF = '/#c-stalled';

const refText = (type, ref) => (ref === null ? type : `${type} ${type === 'implement' ? 'issue' : 'PR'} #${ref}`);

function actionLi(h, a) {
  const reason = a.reason ? h.esc(a.reason) : `<b data-no-reason>${NO_REASON}</b>`;
  const title = a.title ? ` ${h.esc(a.title)}` : '';
  return `<li data-action="${h.esc(a.type)}" data-ref="${h.esc(a.ref ?? '')}"><b>${h.esc(refText(a.type, a.ref))}</b>${title}<br><span class="sub">Not started: ${reason}</span></li>`;
}

function agentBlock(h, s) {
  const idle = s.idleMs === null ? 'idle (since unknown)' : `idle for ${h.dur(s.idleMs)}`;
  return `<div class="stall-agent" data-stall-agent="${h.esc(s.agent)}"><h4>${h.esc(s.agent)} <span class="sub">${idle}, work waiting for ${h.dur(s.waitingMs)}</span></h4><ul>${s.actions.map(a => actionLi(h, a)).join('')}</ul></div>`;
}

function jobLi(h, j) {
  const err = j.error ? `Last error: ${h.esc(j.error)}` : 'No error recorded';
  return `<li data-stall-job="${h.esc(j.id)}"><b>${h.esc(j.agent)}</b>: ${h.esc(j.kind)} job <code>${h.esc(j.id)}</code> paused, should have resumed ${h.lt(j.resumeAt)} (${h.dur(j.overdueMs)} ago)<br><span class="sub">${err}</span></li>`;
}

function waitingBlock(h, waiting) {
  if (!waiting.length) return '';
  const lis = waiting.map(w => `<li data-action="${h.esc(w.type)}" data-ref="${h.esc(w.ref ?? '')}"><b>${h.esc(w.agent)}</b>: ${h.esc(refText(w.type, w.ref))}${w.title ? ` ${h.esc(w.title)}` : ''}<br><span class="sub">${w.reason ? h.esc(w.reason) : 'Waiting for the homeowner'}</span></li>`);
  return `<div class="stall-waiting" data-stall-waiting><h4>Waiting for you</h4><p class="sub">These wait on a decision of yours, so they are not a fault.</p><ul>${lis.join('')}</ul></div>`;
}

// The card body, or null when nothing is stalled (the card then does not exist).
export function stallBody(h, stall) {
  if (!stall?.stalled) return null;
  const jobs = stall.jobs.length ? `<div class="stall-jobs" data-stall-jobs><h4>Paused jobs past their resume time</h4><ul>${stall.jobs.map(j => jobLi(h, j)).join('')}</ul></div>` : '';
  return `<p class="sub">An agent has been idle with planned work for more than ${h.esc(stall.limitMinutes)} minutes, or a paused job is past its resume time.</p>${stall.agents.map(s => agentBlock(h, s)).join('')}${jobs}${waitingBlock(h, stall.waiting)}`;
}

export function stallCard(h, view, card) {
  const body = stallBody(h, view.stall);
  if (body === null) return '';
  const n = view.stall.agents.length + view.stall.jobs.length;
  return card({ id: 'stalled', title: `Stalled (${n})`, span: 12, body, cls: 'panel hc-action stall-card', type: 'panel', movable: false });
}

// The marker beside an agent in the app bar, a link to the card; empty for an agent that is not stalled.
export const agentStallMark = (h, agent) => (agent.stalled
  ? `<a class="ab-stall sev-action" href="${STALL_HREF}" data-stall-mark="${h.esc(agent.name)}" aria-label="${h.esc(agent.name)} is stalled: open the Stalled card" title="Stalled: open the Stalled card">Stalled</a>` : '');

// The red marker beside the Needs you pill: its own bar item, shown only while something is stalled.
export function pillStallMark(health) {
  if (!health?.stalled) return '';
  const link = `<a class="pill-stall sev-action" href="${STALL_HREF}" data-pill-stall aria-label="Stalled: open the Stalled card" title="Stalled: open the Stalled card">!</a>`;
  return `<div class="stat" data-bar="stall-mark" data-bar-name="Stalled marker">${link}</div>`;
}
