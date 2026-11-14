// Issue #1313: carries out the travels that boardmotion.mjs planned. It holds the travels still under way, and after every redraw puts each
// one back on its ball at the point it has reached, using the Web Animations API on the ball's own element. Nothing here starts a travel by
// itself: board.mjs hands it the plan made from a change event, and an empty hand means nothing moves.
import { targetKey, offsetsOf } from './boardmotion.mjs';

const sameTarget = (a, b) => a.kind === b.kind && a.id === b.id && a.ident === b.ident;

export const prefersReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export class Travels {
  constructor(deps = {}) {
    this.now = deps.now ?? Date.now;
    this.active = [];
  }

  // A new change: travels of a ball that is no longer where it was, or that has a newer travel, end at its new place.
  begin(planned, data) {
    const at = this.now();
    this.active = this.active.filter(travel => at - travel.startedAt < travel.durationMs + (travel.delayMs ?? 0) && targetKey(travel.target, data) !== null
      && !planned.some(next => sameTarget(next.target, travel.target)));
    this.active.push(...planned.map(travel => ({ ...travel, startedAt: at })));
  }

  stop() {
    this.active = [];
  }

  // Puts every travel still under way on its ball in the freshly drawn root, at the point of its path it has reached by now.
  apply(root, data) {
    const at = this.now();
    this.active = this.active.filter(travel => at - travel.startedAt < travel.durationMs + (travel.delayMs ?? 0));
    for (const travel of this.active) {
      const key = targetKey(travel.target, data);
      const node = key === null ? null : root.querySelector(`.board-svg [data-ball="${CSS.escape(key)}"]`);
      if (node) this.move(node, travel, at - travel.startedAt);
    }
  }

  move(node, travel, elapsed) {
    const rest = travel.points[travel.points.length - 1];
    const offsets = offsetsOf(travel.points);
    const frames = travel.points.map((point, index) => ({ transform: `translate(${point.x - rest.x}px, ${point.y - rest.y}px)`, offset: offsets[index] }));
    const animation = node.animate(frames, { duration: travel.durationMs, delay: travel.delayMs ?? 0, fill: 'backwards', easing: 'linear' });
    animation.currentTime = elapsed;
    if (travel.laps) this.showLaps(node, travel.laps, animation);
  }

  // A returning ball shows the laps it had until it is back in the hopper, then the figure that is one more.
  showLaps(node, laps, animation) {
    const label = node.querySelector('.laps');
    if (!label) return;
    if (laps.from > 0) label.textContent = `${laps.from}↻`;
    else label.setAttribute('visibility', 'hidden');
    animation.finished.then(() => {
      label.textContent = `${laps.to}↻`;
      label.removeAttribute('visibility');
    }, () => {});
  }
}
