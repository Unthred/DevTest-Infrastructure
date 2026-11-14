// Issue #1317: draws the body of a ball and the model text of a lane. The shape of a ball is its agent's icon used as a mask over a square
// painted in the family colour, or a disc carrying the agent's first letter; the number sits beside it at the lower right. Elements are built
// with the svg builder of boardsvg.mjs (passed in) and textContent only. Colours are in board.css, not here.
import { LAYOUT } from './boardlayout.mjs';
import { laneTextPlan } from './boardball.mjs';

const maskId = id => `icon-mask-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;

// One alpha mask per agent whose icon has loaded; the icon only needs a shape and an alpha channel, its own colour is not used.
export function iconMasks(svg, agents, icons) {
  const masks = [];
  for (const agent of agents) {
    const href = icons?.href(agent.id) ?? null;
    if (href === null) continue;
    masks.push(svg('mask', { id: maskId(agent.id), 'mask-type': 'alpha', maskContentUnits: 'objectBoundingBox' },
      svg('image', { href, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'xMidYMid meet' })));
  }
  return masks;
}

// The ring is the first circle of the group, in both shapes: it takes the focus outline and the long and no-estimate marks, and is the
// click target. The disc fills it; an icon leaves it empty and paints the masked square instead.
export function ballBody(svg, x, y, shape, agentId, number) {
  const r = LAYOUT.ballRadius;
  const parts = [];
  if (shape.icon) {
    parts.push(svg('circle', { class: 'ball-ring', cx: x, cy: y, r }));
    parts.push(svg('rect', { class: 'ball-fill icon', x: x - r + 1, y: y - r - 1, width: 2 * r - 2, height: 2 * r - 2, mask: `url(#${maskId(agentId)})` }));
  } else {
    parts.push(svg('circle', { class: 'ball-ring ball-fill disc', cx: x, cy: y, r }));
    if (shape.letter !== '') {
      const letter = svg('text', { class: 'letter', x, y: y + 3.5 });
      letter.textContent = shape.letter;
      parts.push(letter);
    }
  }
  const num = svg('text', { class: 'num', x: x + r + 1, y: y + r });
  num.textContent = number == null ? '–' : String(number);
  parts.push(num);
  return parts;
}

// The model name of a lane, faint, along the lane and reading from the foot upward. ballYs are the centres of the balls riding the lane.
export function drawLaneModel(svg, lane, entry, ballYs) {
  const plan = laneTextPlan(lane.model, ballYs, LAYOUT.laneTop, LAYOUT.laneBottom);
  const node = svg('text', { class: 'lane-model', 'aria-hidden': 'true', x: entry.x + entry.w / 2 + 3, y: plan.startY, 'data-lane-text': plan.half,
    transform: `rotate(-90 ${entry.x + entry.w / 2 + 3} ${plan.startY})` });
  node.textContent = plan.text;
  return node;
}
