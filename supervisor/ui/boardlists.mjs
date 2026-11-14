// Issue #1312: the lists of the board screen as plain HTML: on a phone they are the screen, at every width they are what a screen reader
// reads. Every list item that stands for a ball is a button with the same data-ball key as the drawn ball, so it opens the same side panel.
import { BOXES, boxOf, ballName, allowanceView, isOut, inboxLink, groupLanes } from './boardlayout.mjs';
import { familyClass, agentAndModel, laneModelText } from './boardball.mjs';
import { percent, dateTime, duration } from './format.mjs';
import { ageNow } from './appbar.mjs';

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
  return node;
}

const windowLine = (label, window) => {
  const view = allowanceView(window);
  if (!view.known) return `${label}: unknown`;
  return `${label}: ${percent(view.left)} left, resets ${window.resets_at ? dateTime(window.resets_at) : 'unknown'}`;
};

export function agentItem(agent, view, lanes = []) {
  const age = agent.reading ? ageNow(agent.reading, view.receivedAt, view.now) : null;
  const lines = [windowLine('Weekly', agent.weekly), windowLine('5 hour', agent.short), age === null ? 'Reading age unknown' : `Read ${duration(age)} ago`];
  if (lanes.length > 0) lines.push(`Models: ${lanes.map(lane => laneModelText(lane.model)).join(', ')}`);
  if (isOut(agent)) {
    const until = agent.out_until ? `Out until ${dateTime(agent.out_until)}` : 'Out, reset time not reported';
    lines.push(`${until}${agent.out_reason ? `: ${agent.out_reason}` : ''}`);
  }
  return el('li', { class: `agent-item${isOut(agent) ? ' out' : ''}` }, el('b', {}, agent.display_name), ...lines.map(line => el('div', {}, line)));
}

// A list item for a ball: the family swatch, the words, and the agent and model as text (the model is kept as text for screen readers).
const ballButton = (key, entry, label, detail, data) => el('button', { type: 'button', class: 'item', 'data-ball': key },
  el('span', { class: `swatch ${familyClass(entry.job_type)}`, 'aria-hidden': 'true' }), ` ${label}`,
  el('span', { class: 'detail' }, ` ${[agentAndModel(entry, data), detail].filter(Boolean).join('; ')}`));

const waitingItem = (entry, data) => el('li', {},
  ballButton(`waiting:${entry.place}`, entry, `${entry.place}. ${ballName(entry)}`, entry.held ? `held: ${entry.held.reason}` : entry.title ?? '', data));
const runningItem = (entry, data) => el('li', {},
  ballButton(`running:${entry.job_id}`, entry, ballName(entry), `on ${data.lanes.find(lane => lane.id === entry.lane_id)?.id ?? entry.lane_id}`, data));

function landedItem(entry, boxId, data) {
  const item = el('li', {}, ballButton(`landed:${entry.job_id}`, entry, ballName(entry), entry.title ?? '', data));
  if (boxId === 'needs_you') item.append(' ', el('a', { class: 'inbox-link', href: inboxLink(entry.number) }, 'Open in Inbox'));
  return item;
}

export function boxItems(data, boxId) {
  return data.landed.filter(entry => boxOf(entry.box, () => {}) === boxId).map(entry => landedItem(entry, boxId, data));
}

function emptyOr(items, words) {
  return items.length ? el('ul', {}, ...items) : el('p', { class: 'none' }, words);
}

// The list of one box, shown under the board when its box is clicked, and one heading per box in the full lists.
export function boxSection(data, boxId, label, level = 'h3') {
  const total = data.counts[boxId] ?? 0;
  const section = el('section', { class: `box-section${boxId === 'needs_you' ? ' you' : ''}`, 'data-box-list': boxId }, el(level, {}, `${label} (${total})`));
  const items = boxItems(data, boxId);
  section.append(emptyOr(items, 'Nothing landed here in the last 24 hours.'));
  if (total > items.length) section.append(el('p', { class: 'none' }, `${total - items.length} more are not listed.`));
  return section;
}

export function renderLists(data, view) {
  const groups = groupLanes(data);
  const root = el('div', { class: 'board-lists' });
  root.append(
    el('section', {}, el('h2', {}, 'Agents'), emptyOr(groups.map(group => agentItem(group.agent, view, group.lanes)), 'No agents.')),
    el('section', {}, el('h2', {}, `Waiting (${data.waiting.length})`), emptyOr(data.waiting.map(entry => waitingItem(entry, data)), 'Nothing is waiting.')),
    el('section', {}, el('h2', {}, `Running (${data.running.length})`), emptyOr(data.running.map(entry => runningItem(entry, data)), 'Nothing is running.')),
    el('h2', {}, 'Landed in the last 24 hours'),
    ...BOXES.map(box => boxSection(data, box.id, box.label)),
  );
  return root;
}

// The line shown when a request failed: the error, Retry, and when a last good board is kept, the stale mark with the time it was received.
export function errorLine(error, receivedAt, hasBoard) {
  const stale = hasBoard ?
    el('span', { class: 'stale-mark' }, ` Stale: showing the last good board, received ${dateTime(new Date(receivedAt).toISOString())}.`) : '';
  return el('p', { class: 'board-error', role: 'alert' }, el('b', {}, 'The board could not be loaded.'),
    ` ${error} `, el('button', { type: 'button', 'data-retry': '' }, 'Retry'), stale);
}

// The side panel of one ball: the rows of ballDetail and a Close button.
export function detailPanel(rows) {
  const list = el('dl', {}, ...rows.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, String(value))]));
  return el('aside', { class: 'ball-panel', role: 'dialog', 'aria-label': 'Job details', id: 'ball-panel' },
    el('div', { class: 'panel-head' }, el('b', {}, 'Job details'), el('button', { type: 'button', 'data-close': '' }, 'Close')), list);
}
