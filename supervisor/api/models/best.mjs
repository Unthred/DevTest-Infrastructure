// Issue #1325: the best model, GET /api/v1/best. The best first review approval rate and the most pull requests merged in any 24 hours so
// far, the current 24 hours on the same basis and the distance to each record. Read from the stored record (supervisor/best-day-store.mjs);
// nothing is fetched or stored by a request. Before the first build there are no records and `built` is false.
import { readBest } from '../../best-day-store.mjs';
import { currentWindow, MIN_FIRST_REVIEWS } from '../../best-day.mjs';

export const name = 'best';
export const path = 'best';
export const schema = 'best.schema.json';
export const usesView = false;

export function build(_view, context) {
  const stored = readBest(context.root);
  const records = { approval: stored?.records?.approval ?? null, merges: stored?.records?.merges ?? null };
  const now = currentWindow({ verdicts: stored?.verdicts ?? [], merges: stored?.merges ?? [] }, context.now, records);
  return {
    built: stored?.built === true,
    min_first_reviews: MIN_FIRST_REVIEWS,
    basis: 'The first review of a pull request is its earliest posted verdict comment and counts in the 24 hours that hold it.',
    records,
    current: { ...now.window, qualifies: now.qualifies },
    distance: now.distance,
    updated_at: Number.isFinite(stored?.updatedAt) ? new Date(stored.updatedAt).toISOString() : null,
  };
}
