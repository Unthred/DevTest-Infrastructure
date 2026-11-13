// Issue #1221: ONE app bar item per configured agent: name, state dot, the role of its running or paused job, weekly used %, 5 hour used %.
// Reset times, reading age, the OK / High / Near limit wording and the stale reason are not printed in the bar: they sit in the
// tooltip (title) and in the detail that opens when the item is focused or tapped (a <details>, so it needs no script).
// Pure data first (agentBarItems, built on the budget view's readings), then the markup. The page helpers are passed in so this
// module imports nothing from the renderer. No agent name is in here: the items follow the agent list the view was built from.
import { allowanceItems, LEVEL_MARK, LEVEL_TEXT } from './appbaralloc.mjs';

const STATE_TEXT = { running: 'Running', idle: 'Idle', paused: 'Paused', held: 'Held', blocked: 'Blocked', unknown: 'Unknown' };
const ROLE_TEXT = { reviewer: 'Reviewer', rebaser: 'Rebaser', inbox: 'Inbox lane' };
const FIGURE_LABEL = { weekly: { short: 'W', long: 'Week' }, short: { short: '5h', long: '5 hour' } };

// An idle agent the dispatcher is holding back (an upgrade, a named hold, a parked agent) is "held", not "idle".
const isHeld = a => a.state === 'idle' && /^(held|parked)\b/i.test(a.idleReason?.text || '');

function roleOf(a) {
  if (a.state !== 'running' && a.state !== 'paused') return '';   // a paused job still has its role (the 12 Nov example: codex, paused, Implementer)
  const jobs = a.jobs?.length ? a.jobs : a.job ? [a.job] : [];
  if (jobs.length > 1) return `${jobs.length} jobs`;
  return jobs.length === 1 ? ROLE_TEXT[jobs[0].role] || 'Implementer' : '';
}

// One plain item per agent: the allowance figures plus the agent's state and role.
export function agentBarItems(view) {
  const byName = new Map((view.agents || []).map(a => [a.name, a]));
  return allowanceItems(view).map(al => {
    const a = byName.get(al.agent) || {};
    const state = isHeld(a) ? 'held' : STATE_TEXT[a.state] ? a.state : 'unknown';
    return { ...al, state, role: roleOf(a), why: state === 'held' ? a.idleReason.text : '' };
  });
}

const pct = f => `${Math.round(f.used * 100)}%`;
// Plain text of one window for the tooltip and the aria-label; `when` renders a reset time.
const windowText = (key, f, when) => {
  const name = FIGURE_LABEL[key].long;
  if (f.state !== 'known') return `${name}: unknown (${f.reason})`;
  return `${name}: ${pct(f)} ${LEVEL_TEXT[f.level]}, resets ${when(f.resetsAt)}`;
};
const ageSentence = item => {
  if (!item.seen) return 'No allowance reading yet';
  const age = item.ageMinutes === null ? 'Reading age unknown' : `Read ${item.ageText} ago`;
  return item.stale ? `${age}. Stale: older than the ${item.maxAgeMinutes} minute limit, so the figures may be out of date` : age;
};
const summaryLine = (item, when) => [
  `${item.agent}: ${STATE_TEXT[item.state]}${item.role ? ` (${item.role})` : ''}`,
  windowText('weekly', item.weekly, when),
  windowText('short', item.short, when),
  ageSentence(item)
].join('. ');

const figure = (h, key, f) => {
  const label = `<span class="ai-k">${FIGURE_LABEL[key].short}</span>`;
  const attrs = ` data-window="${key}" data-state="${f.state}"`;
  if (f.state !== 'known') return `<span class="ai-fig"${attrs}>${label} <span class="ai-unknown">unknown</span></span>`;
  const mark = LEVEL_MARK[f.level] ? `<span class="ai-mark" aria-hidden="true">${LEVEL_MARK[f.level]}</span>` : '';
  return `<span class="ai-fig"${attrs} data-level="${f.level}">${label} ${mark}<b class="ai-pct">${pct(f)}</b></span>`;
};

const detailWindow = (h, key, f) => {
  const name = FIGURE_LABEL[key].long;
  if (f.state !== 'known') return `<li data-window="${key}" data-state="unknown"><b>${name}</b> unknown: ${h.esc(f.reason)}</li>`;
  const level = `<span class="ai-lvl">${LEVEL_TEXT[f.level]}</span>`;
  return `<li data-window="${key}" data-state="known" data-level="${f.level}"><b>${name}</b> ${pct(f)} ${level}, resets ${h.lt(f.resetsAt)}</li>`;
};

export function agentBarItem(h, raw) {
  const item = { ...raw, ageText: raw.ageMinutes === null ? '' : h.dur(raw.ageMinutes * 60000) };
  const id = `agent-${item.agent}`, tip = summaryLine(item, h.utc);
  const staleMark = item.stale || item.weekly.state !== 'known' || item.short.state !== 'known'
    ? `<span class="ai-stale" data-stale="${item.stale}" aria-hidden="true">◷</span>` : '';
  const role = item.role ? `<span class="ai-role">${h.esc(item.role)}</span>` : '';
  const sum = `<summary title="${h.esc(tip)}" aria-label="${h.esc(summaryLine(item, h.utc))}"><b class="ai-name">${h.esc(item.agent)}</b>`
    + `<span class="ai-dot" data-state="${item.state}" aria-hidden="true"></span>${role}`
    + `${figure(h, 'weekly', item.weekly)}${figure(h, 'short', item.short)}${staleMark}</summary>`;
  const note = item.why ? `<p class="ai-why">${h.esc(item.why)}</p>` : '';
  const detail = `<div class="ai-detail"><p><b>${STATE_TEXT[item.state]}</b>${item.role ? ` · ${h.esc(item.role)}` : ''}</p>${note}`
    + `<ul>${detailWindow(h, 'weekly', item.weekly)}${detailWindow(h, 'short', item.short)}</ul>`
    + `<p class="ai-age" data-stale="${item.stale}">${h.esc(ageSentence(item))}</p>`
    + `<p class="ai-links"><a href="/usage">Usage page</a> <a href="/agents/${h.esc(encodeURIComponent(item.agent))}">Agent page</a></p></div>`;
  const bar = `data-bar="${h.esc(id)}" data-bar-name="${h.esc(`Agent: ${item.agent}`)}" data-agent="${h.esc(item.agent)}" data-state="${item.state}"`;
  return `<div class="stat agent-item" ${bar}><details>${sum}${detail}</details></div>`;
}

export const agentBarHtml = (h, view) => agentBarItems(view).map(item => agentBarItem(h, item)).join('\n');
