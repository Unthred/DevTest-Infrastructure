// Issue #1319: the dotted trail of a flight, for a board style whose plan returns `trail` (the points of the arc). It is drawn into the board
// when a flight is put on its ball and takes itself away when the flight ends, so two flights at once show two trails and a redraw in the middle
// of a flight draws the trail again with the time that is left.
import { svg } from './boardsvg.mjs';

// `board` is the drawn svg element; `travel` carries trail, durationMs and delayMs; `elapsed` is the time since the travel began.
export function showTrail(board, travel, elapsed) {
  const left = travel.durationMs + (travel.delayMs ?? 0) - elapsed;
  if (!board || left <= 0) return null;
  const d = travel.trail.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const path = svg('path', { class: 'flight-trail', d, 'data-trail': travel.target.id ?? '', 'aria-hidden': 'true' });
  board.append(path);
  const timer = path.animate([{ opacity: 1 }, { opacity: 1 }], { duration: left });
  timer.finished.then(() => path.remove(), () => path.remove());
  return path;
}
