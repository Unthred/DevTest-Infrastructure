// Issue #1317: the pure side of what a ball and a lane look like. The colour of a ball is its job family, its shape is its agent's icon (or a
// disc with the agent's first letter), and the model name runs faintly up the lane. No DOM, no clock, no fetch.
// The four families are the only colours a ball takes: nine job colours cannot be told apart on a small ball.
// types are the job types of the family; aliases are other spellings the model uses for the same type (the model says cifix for ci-fix).
export const FAMILIES = Object.freeze([
  { id: 'new', label: 'New work', types: ['implement', 'continue', 'split'], aliases: [], words: 'implement, continue, split' },
  { id: 'fixing', label: 'Fixing', types: ['fix', 'ci-fix'], aliases: ['cifix'], words: 'fix, ci-fix' },
  { id: 'review', label: 'Review', types: ['review', 'interim-review'], aliases: [], words: 'review, interim-review' },
  // The catch-all family: rebase, Inbox jobs and any type not listed above.
  { id: 'housekeeping', label: 'Housekeeping', types: ['rebase', 'inbox'], aliases: [], words: 'rebase, Inbox jobs, anything else' },
]);

const FAMILY_OF_TYPE = new Map(FAMILIES.flatMap(family => [...family.types, ...family.aliases].map(type => [type, family.id])));
const LABELS = new Map(FAMILIES.map(family => [family.id, family.label]));

export const familyOf = jobType => FAMILY_OF_TYPE.get(jobType) ?? 'housekeeping';
export const familyClass = jobType => `family-${familyOf(jobType)}`;
export const familyLabel = jobType => LABELS.get(familyOf(jobType));

// The agent a ball belongs to: the agent of its lane, or the agent a waiting entry is tied to; null for a waiting ball with none yet.
export function agentIdOf(entry, data) {
  const lane = data.lanes.find(candidate => candidate.id === entry.lane_id);
  return lane ? lane.agent : entry.tied_agent ?? null;
}

const agentName = (data, id) => data.agents.find(agent => agent.id === id)?.display_name ?? id;

// The first letter of an agent's display name; nothing for a waiting ball with no agent or an agent with an empty name.
export function ballLetter(data, id) {
  if (id === null || id === undefined) return '';
  return Array.from(String(agentName(data, id) ?? '').trim())[0] ?? '';
}

// The icon path the model names is used only when it is under the agent icon route of the contract, so no other address is ever requested.
export const iconPathOk = path => typeof path === 'string' && /^\/api\/v1\/agent-icon\/[A-Za-z0-9_.-]+$/.test(path) && !path.includes('..');

// How the ball is drawn: the icon (a mask filled with the family colour) only once the icon is known to have loaded; otherwise a disc.
export function ballShape(data, id, iconHref) {
  return { icon: id !== null && iconHref ? iconHref : null, letter: ballLetter(data, id) };
}

// Reviews, fixes, CI fixes and rebases are about a pull request; the rest are about an issue.
const PULL_REQUEST_TYPES = new Set(['review', 'interim-review', 'fix', 'ci-fix', 'cifix', 'rebase']);
const numberWords = (type, number) => {
  if (!Number.isInteger(number)) return 'no number';
  return `${PULL_REQUEST_TYPES.has(type) ? 'pull request' : 'issue'} ${number}`;
};

// Job type, issue or pull request number, agent, model: for example "review, pull request 1244, claude, opus".
export function accessibleName(entry, data) {
  return [entry.job_type, numberWords(entry.job_type, entry.number), agentAndModel(entry, data)].join(', ');
}

// The agent and the model of a ball in words; a ball with no lane yet has no model, and a waiting ball with no agent has neither.
export function agentAndModel(entry, data) {
  const id = agentIdOf(entry, data);
  const lane = data.lanes.find(candidate => candidate.id === entry.lane_id);
  return [id === null ? 'no agent yet' : agentName(data, id), lane ? laneModelText(lane.model) : 'no model yet'].join(', ');
}

export const laneModelText = model => (typeof model === 'string' && model.trim() !== '' ? model : 'default model');

export const LANE_TEXT = Object.freeze({ size: 10, charWidth: 5.4, foot: 6, ballRadius: 12 });

const fit = (text, room) => {
  const chars = Math.max(1, Math.floor(room / LANE_TEXT.charWidth));
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
};

// Where the model name goes along a lane that spans top..bottom (y grows downward). It reads from the foot upward, so it starts at the
// foot of the half it is in. With exactly one ball in the lane it takes the half the ball is not in; with none, or two or more, it stays at
// the foot. ballYs are the centres of the balls riding the lane. Returns the text (shortened to fit its room), the y it starts at and the half.
export function laneTextPlan(model, ballYs, top, bottom) {
  const middle = (top + bottom) / 2;
  const text = laneModelText(model);
  const ballInFoot = ballYs.length === 1 && ballYs[0] >= middle;
  if (ballInFoot) {
    const start = middle - LANE_TEXT.ballRadius;
    return { half: 'head', text: fit(text, start - top - LANE_TEXT.foot), startY: start };
  }
  const start = bottom - LANE_TEXT.foot;
  // One ball in the head half leaves the foot half down to the ball's lowest edge; otherwise the whole lane is free.
  const room = ballYs.length === 1 ? start - (middle + LANE_TEXT.ballRadius) : bottom - top - 2 * LANE_TEXT.foot;
  return { half: 'foot', text: fit(text, room), startY: start };
}
