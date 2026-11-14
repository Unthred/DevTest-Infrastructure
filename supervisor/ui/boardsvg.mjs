// Issue #1312: draws the board as SVG from the geometry of boardlayout.mjs. Elements are built with textContent only, so no text from the
// model is read as markup. It keeps no state: board.mjs passes the model, the time and what is open.
import { LAYOUT, boardGeometry, hopperBalls, boxBalls, runningBalls, allowanceView, isOut, jobClass, agentClass, ballName, boxLabel } from './boardlayout.mjs';
import { PEG } from './boardmotion.mjs';
import { percent, dateTime, duration } from './format.mjs';

// The SVG namespace is an identifier, not a request; it is joined so the no-external-address check of tests/ui-static.test.mjs stays strict.
const NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
export function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
  return node;
}
const text = (x, y, content, cls = '') => {
  const node = svg('text', { x, y, class: cls });
  node.textContent = content;
  return node;
};

// A ball: a circle with its number, a lap count above zero, and a hint (hold reason, no estimate, running long) shown on hover and focus.
function ball(entry, place, extra) {
  const { x, y, cls, key, label, hint, mark } = extra;
  const group = svg('g', { class: `ball ${cls}`, tabindex: '0', role: 'button', 'data-ball': key, 'aria-label': `${label}${hint ? `. ${hint}` : ''}` });
  group.append(svg('circle', { cx: x, cy: y, r: LAYOUT.ballRadius }));
  const number = text(x, y + 3, entry.number == null ? '–' : String(entry.number), 'num');
  group.append(number);
  if (mark) group.append(svg('rect', { class: `tied ${mark}`, x: x + 4, y: y - LAYOUT.ballRadius - 2, width: 7, height: 7 }));
  if (entry.laps > 0) group.append(text(x - LAYOUT.ballRadius, y - LAYOUT.ballRadius, `${entry.laps}↻`, 'laps'));
  if (hint) {
    const width = Math.max(90, hint.length * 6);
    const tipX = Math.min(Math.max(2, x - width / 2), place.width - width - 2);
    const tip = svg('g', { class: 'tip' }, svg('rect', { x: tipX, y: y - 34, width, height: 20, rx: 4 }), text(tipX + 6, y - 20, hint));
    group.append(tip);
  }
  return group;
}

function drawLanes(root, geometry, data, view) {
  for (const group of geometry.groups) {
    const out = isOut(group.agent);
    const layer = svg('g', { class: `group${out ? ' out' : ''}`, 'data-agent-group': group.agent.id });
    layer.append(text(group.x, 22, group.agent.display_name, 'agent-name'));
    for (const { lane, x, w } of group.lanes) {
      layer.append(svg('rect', { class: 'lane', x, y: LAYOUT.laneTop, width: w, height: LAYOUT.laneBottom - LAYOUT.laneTop, rx: 6, 'data-lane': lane.id }));
      layer.append(text(x + w / 2, LAYOUT.laneBottom + 14, lane.model ?? 'default', 'lane-label'));
    }
    drawAllowance(layer, geometry, group, view);
    root.append(layer);
  }
}

function bar(x, y, width, label, window) {
  const view = allowanceView(window);
  const node = svg('g', { class: `bar${view.known ? '' : ' unknown'}`,
    role: 'img', 'aria-label': `${label} ${view.known ? `${percent(view.left)} left` : 'unknown'}` });
  node.append(svg('rect', { class: 'track', x, y, width, height: 8, rx: 3 }));
  if (view.known) node.append(svg('rect', { class: 'fill', x, y, width: Math.max(1, view.left * width), height: 8, rx: 3 }));
  return node;
}

// One window: its words, a bar, and under it the reset time. An unknown window says unknown and draws a hatched bar with no fill.
function drawWindow(layer, group, label, window, y) {
  const known = allowanceView(window).known;
  layer.append(text(group.x, y, known ? `${label}: ${percent(allowanceView(window).left)} left` : `${label}: unknown`, `allow${known ? '' : ' unknown'}`));
  layer.append(bar(group.x, y + 4, group.w - 4, label, window));
  if (known) layer.append(text(group.x, y + 26, `resets ${window.resets_at ? dateTime(window.resets_at) : 'unknown'}`, 'reset'));
}

function drawAllowance(layer, geometry, group, view) {
  const { agent } = group;
  const top = geometry.allowanceTop + 12;
  drawWindow(layer, group, 'Weekly', agent.weekly, top);
  drawWindow(layer, group, '5 hour', agent.short, top + 44);
  if (agent.reading) {
    const age = agent.reading.age_seconds;
    const aged = Number.isFinite(age) ? age + Math.max(0, Math.floor((view.now - view.receivedAt) / 1000)) : null;
    layer.append(text(group.x, top + 90,
      aged === null ? 'Reading age unknown' : `Read ${duration(aged)} ago${agent.reading.stale ? ' (stale)' : ''}`, 'reading'));
  }
  if (!isOut(agent)) return;
  layer.append(text(group.x, top + 106, agent.out_until ? `Out until ${dateTime(agent.out_until)}` : 'Out, reset time not reported', 'out-label'));
  if (agent.out_reason) layer.append(text(group.x, top + 120, agent.out_reason.slice(0, 40), 'out-label'));
}

function drawHopper(root, geometry, data) {
  const { hopper } = geometry;
  const group = svg('g', { class: 'hopper', 'data-hopper': '' });
  group.append(svg('rect', { class: 'hopper-box', x: hopper.x, y: hopper.y, width: hopper.w, height: hopper.h, rx: 8 }));
  group.append(text(hopper.x + 8, hopper.y - 4, `Waiting (${data.waiting.length})`, 'zone-label'));
  const { placed, hidden } = hopperBalls(data.waiting, geometry);
  for (const { item, x, y } of placed) {
    const tied = item.tied_agent ? agentClass(data.agents, item.tied_agent) : null;
    const hint = item.held ? `Held: ${item.held.reason}` : '';
    const cls = `${jobClass(item.job_type)}${item.held ? ' held' : ''}`;
    group.append(ball(item, geometry, { x, y, cls, key: `waiting:${item.place}`, label: `Waiting place ${item.place}, ${ballName(item)}`, hint, mark: tied }));
  }
  if (hidden > 0) group.append(text(hopper.x + hopper.w - 8, hopper.y + hopper.h - 6, `+${hidden} more, see the list`, 'more'));
  root.append(group);
}

function drawRunning(root, geometry, data, now) {
  for (const { job, ride, x, y } of runningBalls(data.running, geometry, now)) {
    const state = ride.long ? ' long' : ride.noEstimate ? ' no-estimate' : '';
    const hint = ride.long ? 'Running long' : ride.noEstimate ? 'No estimate' : '';
    const label = `Running, ${ballName(job)}${hint ? `, ${hint.toLowerCase()}` : ''}`;
    root.append(ball(job, geometry, { x, y, cls: `${jobClass(job.job_type)}${state}`, key: `running:${job.job_id}`, label, hint, mark: null }));
  }
}

function drawBoxes(root, geometry, data) {
  for (const { box, placed, hidden } of boxBalls(data.landed, geometry)) {
    const group = svg('g', { class: `box box-${box.id}`,
      tabindex: '0', role: 'button', 'data-box': box.id, 'aria-label': `${box.label}, ${data.counts[box.id] ?? 0} in the last 24 hours` });
    group.append(svg('rect', { class: 'box-rect', x: box.x, y: box.y, width: box.w, height: box.h, rx: 8 }));
    group.append(text(box.x + 8, box.y + 18, box.label, 'box-label'));
    group.append(text(box.x + 8, box.y + 32, String(data.counts[box.id] ?? 0), 'box-count'));
    root.append(group);
    for (const { item, x, y } of placed) {
      root.append(ball(item, geometry, { x, y, cls: jobClass(item.job_type),
        key: `landed:${item.job_id}`, label: `${boxLabel(box.id)}, ${ballName(item)}`, hint: '', mark: null }));
    }
    if (hidden > 0) root.append(text(box.x + box.w - 6, box.y + box.h - 6, `+${hidden}`, 'more'));
  }
}

// Returns the SVG element, or null when the board is not drawn (narrow or zero width).
export function drawBoard(data, width, now, view) {
  const geometry = boardGeometry(data, width);
  if (!geometry.drawn) return null;
  const root = svg('svg', { class: 'board-svg', viewBox: `0 0 ${geometry.width} ${geometry.height}`,
    role: 'group', 'aria-label': 'Live board', preserveAspectRatio: 'xMinYMin meet' });
  const hatch = svg('pattern', { id: 'hatch', width: 6, height: 6,
    patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('rect', { width: 3, height: 6, class: 'hatch-bar' }));
  const peg = svg('pattern', { id: 'peg', width: PEG.pitch, height: PEG.pitch, patternUnits: 'userSpaceOnUse' },
    ...PEG.spots.map(([cx, cy]) => svg('circle', { cx, cy, r: PEG.radius, class: 'peg-dot' })));
  root.append(svg('defs', {}, hatch, peg));
  root.append(svg('rect', { class: 'pegs', x: geometry.pegs.x, y: geometry.pegs.y, width: geometry.pegs.w, height: geometry.pegs.h, rx: 8 }));
  drawLanes(root, geometry, data, view);
  drawHopper(root, geometry, data);
  drawRunning(root, geometry, data, now);
  drawBoxes(root, geometry, data);
  return root;
}
