// Issue #1315: a second board style used only by the browser check, served by the test as boardstyle-marble.mjs. It has no imports and
// draws a different middle area so the check can see the switch redraw it; its paths are straight lines.
export const name = 'marble';
export const label = 'Marble run';

export function draw(geometry, svg) {
  const track = svg('rect', { class: 'marble-track', x: geometry.pegs.x, y: geometry.pegs.y, width: geometry.pegs.w, height: geometry.pegs.h, rx: 8,
    fill: 'none', stroke: 'currentColor', 'stroke-width': 3 });
  return { defs: [], nodes: [track] };
}

export function plan({ from, to }) {
  return { points: [from, to], durationMs: 1500 };
}
