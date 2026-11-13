// Issue #1312: the pure side of the live board screen. Every position and size comes from the one LAYOUT table below; the functions turn
// the liveboard model (GET /api/v1/liveboard) into places, heights, colours and detail rows. No DOM, no clock, no fetch: the screen passes
// the time in. It holds no rules about jobs; the model already decided every box and every hold.
export const LAYOUT = Object.freeze({
  minWidth: 640,        // below this the board is not drawn at all
  laneWidth: 56,
  laneGap: 6,           // between the lanes of one agent
  groupGap: 24,         // between agent groups
  groupMinWidth: 190,   // room for the allowance text under a group of one lane
  leftPad: 12,
  laneTop: 36,
  laneBottom: 230,
  allowanceHeight: 150, // under the lanes of each group: two bars with their reset times, the reading age and the out label
  hopperHeight: 110,
  hopperMinWidth: 220,
  pegsWidth: 340,
  boxHeight: 120,
  boxGap: 8,
  boxMinWidth: 92,
  ballRadius: 12,
  ballGap: 3,
  rideCap: 0.92,        // the highest a running ball goes, as a fraction of the lane
  noEstimateRide: 0.5,
  bottomPad: 12,
});

export const BOXES = Object.freeze([
  { id: 'merged', label: 'Merged' },
  { id: 'passed', label: 'Passed' },
  { id: 'to_review', label: 'To review' },
  { id: 'changes_asked', label: 'Changes asked' },
  { id: 'done', label: 'Done' },
  { id: 'out_of_allowance', label: 'Out of allowance' },
  { id: 'failed', label: 'Failed' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'needs_you', label: 'Needs you' },
]);
const BOX_IDS = new Set(BOXES.map(box => box.id));
export const boxLabel = id => BOXES.find(box => box.id === id)?.label ?? 'Done';

// An unknown box name lands in Done and says so; warn is injected so a test can see it.
export function boxOf(name, warn = console.warn) {
  if (BOX_IDS.has(name)) return name;
  warn(`liveboard: unknown box "${name}", shown in Done`);
  return 'done';
}

const JOB_TYPES = ['implement', 'review', 'fix', 'cifix', 'continue', 'rebase', 'split', 'inbox'];
// The class names the stylesheet colours; a type the stylesheet does not know gets the neutral one.
export const jobClass = type => `job-${JOB_TYPES.includes(type) ? type : 'other'}`;
export const agentClass = (agents, id) => `agent-${Math.max(0, agents.findIndex(agent => agent.id === id)) % 6}`;

export const pounds = pence => (Number.isFinite(pence) ? `£${(pence / 100).toFixed(2)}` : 'unknown');
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Groups of lanes in the order of the agents the model serves; a lane whose agent the model does not list gets a group of its own at the end.
export function groupLanes(data) {
  const groups = data.agents.map(agent => ({ agent, lanes: data.lanes.filter(lane => lane.agent === agent.id) }));
  const known = new Set(data.agents.map(agent => agent.id));
  for (const id of [...new Set(data.lanes.map(lane => lane.agent))].filter(id => !known.has(id))) {
    groups.push({
      agent: { id, display_name: id, out_until: null, out_reason: null, weekly: null, short: null, reading: null },
      lanes: data.lanes.filter(lane => lane.agent === id),
    });
  }
  return groups.filter(group => group.lanes.length > 0 || group.agent.weekly);
}

const groupWidth = laneCount => Math.max(LAYOUT.groupMinWidth, laneCount * LAYOUT.laneWidth + Math.max(0, laneCount - 1) * LAYOUT.laneGap);

// The geometry of the whole board for an available width in pixels. Not drawn below the minimum width, for a width that is 0 or not a number.
export function boardGeometry(data, width) {
  if (!Number.isFinite(width) || width < LAYOUT.minWidth) return { drawn: false };
  const groups = groupLanes(data);
  let x = LAYOUT.leftPad;
  const placed = groups.map(group => {
    const w = groupWidth(group.lanes.length);
    const lanes = group.lanes.map((lane, index) => ({ lane, x: x + index * (LAYOUT.laneWidth + LAYOUT.laneGap), w: LAYOUT.laneWidth }));
    const result = { ...group, x, w, lanes };
    x += w + LAYOUT.groupGap;
    return result;
  });
  const leftWidth = Math.max(LAYOUT.hopperMinWidth, x - LAYOUT.groupGap - LAYOUT.leftPad);
  const allowanceTop = LAYOUT.laneBottom + 26;
  const hopperTop = allowanceTop + LAYOUT.allowanceHeight + 8;
  const boxTop = hopperTop + LAYOUT.hopperHeight + 16;
  const viewWidth = Math.max(LAYOUT.leftPad * 2 + leftWidth + LAYOUT.pegsWidth, LAYOUT.leftPad * 2 + BOXES.length * (LAYOUT.boxMinWidth + LAYOUT.boxGap));
  const boxWidth = (viewWidth - LAYOUT.leftPad * 2 - (BOXES.length - 1) * LAYOUT.boxGap) / BOXES.length;
  return {
    drawn: true,
    width: viewWidth,
    height: boxTop + LAYOUT.boxHeight + LAYOUT.bottomPad,
    groups: placed,
    allowanceTop,
    hopper: { x: LAYOUT.leftPad, y: hopperTop, w: leftWidth, h: LAYOUT.hopperHeight },
    pegs: { x: LAYOUT.leftPad * 2 + leftWidth, y: LAYOUT.laneTop, w: viewWidth - LAYOUT.leftPad * 3 - leftWidth, h: boxTop - LAYOUT.laneTop - 16 },
    boxes: BOXES.map((box, index) => ({ ...box, x: LAYOUT.leftPad + index * (boxWidth + LAYOUT.boxGap), y: boxTop, w: boxWidth, h: LAYOUT.boxHeight })),
  };
}

const step = () => LAYOUT.ballRadius * 2 + LAYOUT.ballGap;

// Balls laid in rows inside a rectangle, first one at the top left. A rectangle that holds fewer than the balls reports the rest as hidden.
function grid(items, rect, header) {
  const cols = Math.max(1, Math.floor((rect.w - 8) / step()));
  const rows = Math.max(1, Math.floor((rect.h - header - 6) / step()));
  const shown = items.slice(0, cols * rows);
  return {
    placed: shown.map((item, index) => ({
      item,
      x: rect.x + 8 + LAYOUT.ballRadius + (index % cols) * step(),
      y: rect.y + header + LAYOUT.ballRadius + Math.floor(index / cols) * step(),
    })),
    hidden: items.length - shown.length,
  };
}

// The hopper: the waiting entries in plan order, the next one in the top row, nearest the lanes above it.
export const hopperBalls = (waiting, geometry) => grid([...waiting].sort((a, b) => a.place - b.place), geometry.hopper, 6);

// The landed balls of every box; the box of each is the model's, an unknown name goes to Done.
export function boxBalls(landed, geometry, warn = console.warn) {
  const byBox = new Map(BOXES.map(box => [box.id, []]));
  for (const entry of landed) byBox.get(boxOf(entry.box, warn)).push(entry);
  return geometry.boxes.map(box => ({ box, ...grid(byBox.get(box.id), box, 38) }));
}

// How high a running ball rides, 0 at the foot and 1 at the top of the lane. Null estimate: mid height and flagged; past the typical
// time the ball goes on rising slowly but never reaches the top (capped), and it is flagged long.
export function rideHeight(startedAt, typicalSeconds, now) {
  const elapsed = Math.max(0, ((Number.isFinite(now) ? now : 0) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(elapsed)) return { fraction: 0, noEstimate: typicalSeconds == null, long: false, elapsed: 0 };
  if (typicalSeconds == null) return { fraction: LAYOUT.noEstimateRide, noEstimate: true, long: false, elapsed };
  const ratio = typicalSeconds > 0 ? elapsed / typicalSeconds : Infinity;
  return { fraction: Math.min(LAYOUT.rideCap, Math.max(0, ratio) * 0.8), noEstimate: false, long: ratio > 1, elapsed };
}

// The place of every running ball: in the middle of its lane at the height above. A job whose lane is not drawn is left out of the picture.
export function runningBalls(running, geometry, now) {
  const lanes = new Map(geometry.groups.flatMap(group => group.lanes.map(entry => [entry.lane.id, entry])));
  const height = LAYOUT.laneBottom - LAYOUT.laneTop - LAYOUT.ballRadius * 2;
  const result = [];
  for (const job of running) {
    const entry = lanes.get(job.lane_id);
    if (!entry) continue;
    const ride = rideHeight(job.started_at, job.typical_seconds, now);
    result.push({ job, ride, x: entry.x + entry.w / 2, y: LAYOUT.laneBottom - LAYOUT.ballRadius - ride.fraction * height });
  }
  return result;
}

// What one reading of an allowance window shows: the fraction left, or unknown (never empty or full).
export function allowanceView(window) {
  if (!window || window.state !== 'known' || !Number.isFinite(window.used_fraction)) return { known: false, left: null };
  return { known: true, left: Math.min(1, Math.max(0, 1 - window.used_fraction)) };
}

export const isOut = agent => Boolean(agent.out_until) || Boolean(agent.out_reason);

// The rows of the side panel for one ball. kind is waiting, running or landed; data is the whole model data (for the agent and the model of a lane).
export function ballDetail(kind, entry, data, formats) {
  const lane = data.lanes.find(candidate => candidate.id === entry.lane_id);
  const agent = lane ? data.agents.find(candidate => candidate.id === lane.agent)?.display_name ?? lane.agent : entry.tied_agent ?? 'any agent';
  const rows = [
    ['Title', entry.title ?? 'No title recorded'],
    ['Job type', entry.job_type],
    ['Agent', agent],
    ['Model', lane ? lane.model ?? 'provider default' : 'not chosen yet'],
    ['Started', kind === 'waiting' ? 'not started' : formats.dateTime(entry.started_at ?? null)],
    ['Ended', kind === 'landed' ? formats.dateTime(entry.ended_at) : 'not ended'],
    ['Box', kind === 'landed' ? boxLabel(entry.box) : kind === 'running' ? 'still running' : 'waiting'],
    ['Laps', String(entry.laps ?? 0)],
    ['Tokens', Number.isFinite(entry.tokens) ? String(entry.tokens) : 'unknown'],
    ['Cost', pounds(entry.cost_pence)],
  ];
  if (kind === 'waiting' && entry.held) rows.push(['Held', `${entry.held.kind}: ${entry.held.reason}`]);
  return rows;
}

// The short name of a ball for its label and its accessible name: number, type, laps.
export function ballName(entry) {
  const laps = entry.laps > 0 ? `, ${count(entry.laps, 'lap', 'laps')}` : '';
  return `${entry.number == null ? 'no number' : `#${entry.number}`} ${entry.job_type}${laps}`;
}

// The Inbox page of an item: the Inbox search finds the item by its issue or pull request number.
export const inboxLink = number => (Number.isInteger(number) ? `/inbox?state=all&search=${number}` : '/inbox?state=all');
