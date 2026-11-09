// Issue #1119: records a tick and, next to its status, the deliberate skips it listed (the tick's `skips`, see tickskips.mjs).
import { recordTick, addTickSkips } from './dashdata.mjs';

export function recordTickWithSkips(root, args) {
  const cache = recordTick(root, args);
  try {
    addTickSkips(root, args.skips);
  } catch {
    // listing the skips is best effort; the tick itself is recorded
  }
  return cache;
}
