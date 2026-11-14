// Issue #1119: records a tick and, next to its status, the deliberate skips it listed (the tick's `skips`, see tickskips.mjs).
// Issue #1411: a real tick then starts a CI watcher for each pull request head whose checks are pending, and
// folds the GitHub reads the watchers made since the last pass into the pass's call count.
import { recordTick, addTickSkips } from './dashdata.mjs';
import { startCiWatchers, spawnWatcher, takeReads } from './ciwatch.mjs';

// Only the live tick passes its call count; a status-only record (error, disabled) and the dashboard's own writes do not.
const realTick = args => Number.isFinite(args.ghCalls) && !!args.team?.view;

export function recordTickWithSkips(root, args) {
  const reads = realTick(args) ? takeReads(root) : 0;
  const cache = recordTick(root, reads && Number.isFinite(args.ghCalls) ? { ...args, ghCalls: args.ghCalls + reads } : args);
  try {
    addTickSkips(root, args.skips);
  } catch {
    // listing the skips is best effort; the tick itself is recorded
  }
  if (realTick(args)) {
    try {
      startCiWatchers({ root, pulls: cache.pulls, start: head => spawnWatcher({ root, ...head }) });
    } catch {
      // a watcher that cannot start is left to the scheduled pass
    }
  }
  return cache;
}
