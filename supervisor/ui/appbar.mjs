// Issue #1266: draws the app bar, the details panel of one agent and the lines under the bar from the app bar model. It builds elements
// with textContent only, so no text from the model is ever read as markup. It holds no state; app.mjs owns that.
import { toneOf } from './status.mjs';
import { percent, duration, shortDuration, clock, dateTime, words } from './format.mjs';

const CONNECTION = {
  live: ['active', 'Live'],
  connecting: ['waiting', 'Connecting'],
  reconnecting: ['unknown', 'Reconnecting'],
  behind: ['unknown', 'Behind'],
};
const WINDOWS = [['weekly', 'Weekly'], ['short', '5 hour']];

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) if (value !== null && value !== undefined) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}
const mark = tone => el('i', { class: `mark t-${tone}`, 'aria-hidden': 'true' });
const status = (tone, text) => el('span', { class: `st t-${tone}` }, mark(tone), el('span', { class: 'word' }, text));

// The reading age now: the age served plus the time since this client received it.
export function ageNow(reading, receivedAt, now) {
  if (!Number.isFinite(reading.age_seconds)) return null;
  return reading.age_seconds + Math.max(0, Math.floor((now - receivedAt) / 1000));
}

const known = window => window.state === 'known';
const figureWords = window => (known(window) ? percent(window.used_fraction) : 'unknown');

function figure(window, stale) {
  const text = known(window) ? percent(window.used_fraction) : '?';
  return el('b', { class: `figure${stale || !known(window) ? ' marked' : ''}` }, text);
}

function agentLabel(agent, tone, stale, age) {
  const reading = stale ? `, reading stale${age === null ? '' : `, ${duration(age)} old`}` : '';
  const state = words(agent.condition.state).toLowerCase();
  return `${agent.display_name}: ${state} (${tone}), weekly ${figureWords(agent.weekly)}, 5 hour ${figureWords(agent.short)}${reading}`;
}

function agentChip(agent, view) {
  const tone = toneOf(agent.condition, view.groups);
  const stale = agent.reading.stale === true;
  const age = ageNow(agent.reading, view.receivedAt, view.now);
  const chip = el('button', {
    type: 'button', class: 'chip agent', 'data-agent': agent.id, 'aria-expanded': String(view.open === agent.id), 'aria-controls': 'panel',
    'aria-label': agentLabel(agent, tone, stale, age), title: [words(agent.condition.state), agent.condition.reason_text].filter(Boolean).join(': '),
  },
  mark(tone),
  el('span', { class: 'name' }, agent.display_name),
  figure(agent.weekly, stale),
  el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
  figure(agent.short, stale));
  if (stale && age !== null) chip.append(el('span', { class: 'age' }, shortDuration(age)));
  return chip;
}

function systemChip(system, groups) {
  const tone = toneOf(system, groups);
  const text = words(system.state).toLowerCase();
  return el('span', { class: 'chip system', tabindex: '0', title: system.reason_text, 'aria-label': `System: ${text}. ${system.reason_text ?? ''}`.trim() },
    mark(tone), el('span', { class: 'name' }, 'System'), el('span', { class: 'word' }, text));
}

function connectionMark(connection) {
  const [tone, text] = CONNECTION[connection] ?? CONNECTION.connecting;
  return el('span', { class: `st t-${tone} connection`, id: 'connection', 'data-connection': connection }, mark(tone), el('span', { class: 'word' }, text));
}

function themeSwitch(theme) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return el('button', { type: 'button', class: 'chip theme', 'data-theme-switch': next, 'aria-label': `Switch to ${next} theme` }, words(next));
}

// view: { model (the app bar envelope or null), groups, connection, theme, open, receivedAt, now }
export function renderBar(bar, view) {
  const children = [];
  if (!view.model) {
    children.push(el('span', { class: 'chip system' }, mark('unknown'), el('span', { class: 'word' }, 'No data')));
  } else {
    children.push(systemChip(view.model.data.system, view.groups), ...view.model.data.agents.map(agent => agentChip(agent, view)));
  }
  children.push(el('span', { class: 'spacer' }), connectionMark(view.connection), themeSwitch(view.theme));
  bar.replaceChildren(...children);
}

function windowBlock(window, label, stale) {
  const block = el('div', { class: 'window' }, el('h3', {}, label));
  if (!known(window)) {
    block.append(
      el('div', { class: 'meter unknown', role: 'img', 'aria-label': `${label} unknown` }),
      el('p', { class: 'reason' }, window.reason_text ?? 'Unknown'),
    );
    return block;
  }
  const level = ['high', 'near'].includes(window.level) ? ` ${window.level}` : '';
  const width = `${Math.max(1, Math.round(window.used_fraction * 100))}%`;
  const fill = el('i');
  fill.style.width = width;
  block.append(
    el('div', { class: `meter${level}`, role: 'img', 'aria-label': `${label} ${percent(window.used_fraction)} used` }, fill),
    el('p', {}, el('b', { class: `figure${stale ? ' marked' : ''}` }, percent(window.used_fraction)),
      ` used${stale ? ' (as last read)' : ''}, resets ${dateTime(window.resets_at)}`),
  );
  return block;
}

export function renderPanel(panel, agent, view) {
  const stale = agent.reading.stale === true;
  const age = ageNow(agent.reading, view.receivedAt, view.now);
  const tone = toneOf(agent.condition, view.groups);
  const readingText = age === null ? 'No reading time recorded' : `${stale ? 'Reading is' : 'Read'} ${duration(age)}${stale ? ' old' : ' ago'}`;
  panel.replaceChildren(
    el('div', { class: 'panel-head' }, el('b', {}, agent.display_name), status(tone, words(agent.condition.state))),
    el('p', { class: 'reason' }, agent.condition.reason_text ?? ''),
    ...WINDOWS.map(([key, label]) => windowBlock(agent[key], label, stale)),
    el('p', { class: `reading${stale ? ' marked' : ''}` }, readingText),
    el('p', { class: 'roles' }, `Roles: ${agent.roles.length ? agent.roles.join(', ') : 'none'}`),
  );
}

// The lines under the bar: stale data (time and age of the last tick) and a connection that is behind.
export function renderBanners(container, view) {
  const lines = [];
  const freshness = view.freshness;
  if (freshness && freshness.state !== 'fresh') {
    const tickAge = Number.isFinite(Date.parse(freshness.tick_at)) ? Math.floor((view.now - Date.parse(freshness.tick_at)) / 1000) : freshness.age_seconds;
    const when = freshness.tick_at ? `Last tick ${clock(freshness.tick_at)} (${duration(tickAge)} ago).` : 'No tick has been recorded.';
    lines.push(el('p', { class: 'banner stale' }, status('unknown', 'Data is stale'), ` ${when} Figures may be out of date.`));
  }
  if (view.connection === 'behind') {
    const text = ' The live connection has gone quiet. Showing the last data received; retrying.';
    lines.push(el('p', { class: 'banner behind' }, status('unknown', 'Behind'), text));
  }
  container.replaceChildren(...lines);
}
