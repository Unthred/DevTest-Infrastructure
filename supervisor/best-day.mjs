// Issue #1325: the best 24 hours so far, as a pure function of the posted verdict comments and the merge times.
// Basis: the first review of a pull request is its earliest verdict comment, and it counts in the window that holds that comment. A window
// is half-open, [start, start + 24 h), so a first review exactly on the start counts in that window and one exactly on the end counts in the
// next only. Candidate windows start on whole UTC hours. No I/O: the store, the history rebuild and the model call this.
export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
export const MIN_FIRST_REVIEWS = 20;

const isTime = value => Number.isFinite(value) && value > 0;
const percent = (approved, reviewed) => (reviewed > 0 ? Math.round((approved / reviewed) * 1000) / 10 : null);
const iso = ms => new Date(ms).toISOString();

// The earliest verdict of each pull request, in time order. A verdict is { pr, at (ms), verdict: 'PASS' | 'CHANGES' }.
export function firstReviews(verdicts) {
  const first = new Map();
  for (const v of verdicts || []) {
    if (!v || !Number.isSafeInteger(v.pr) || !isTime(v.at)) continue;
    const seen = first.get(v.pr);
    if (!seen || v.at < seen.at) first.set(v.pr, v);
  }
  return [...first.values()].sort((a, b) => a.at - b.at);
}

// How many of the sorted times fall in [start, end).
function countIn(sortedTimes, start, end) {
  const below = bound => {
    let low = 0;
    let high = sortedTimes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sortedTimes[mid] < bound) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return below(end) - below(start);
}

// The figures of one window, from data prepared by prepare().
export function measure(data, start, end = start + DAY_MS) {
  const reviewed = countIn(data.firstTimes, start, end);
  const approved = countIn(data.firstPassTimes, start, end);
  const merged = countIn(data.mergeTimes, start, end);
  const verdicts = countIn(data.verdictTimes, start, end);
  return {
    start: iso(start), end: iso(end), approved, reviewed, merged,
    rate: percent(approved, reviewed), verdicts, verdicts_per_merged: merged > 0 ? Math.round((verdicts / merged) * 100) / 100 : null,
  };
}

export function prepare({ verdicts = [], merges = [] } = {}) {
  const valid = verdicts.filter(v => v && isTime(v.at));
  const firsts = firstReviews(valid);
  const times = list => list.map(v => v.at).sort((a, b) => a - b);
  return {
    firstTimes: times(firsts), firstPassTimes: times(firsts.filter(v => v.verdict === 'PASS')),
    verdictTimes: times(valid), mergeTimes: times((merges || []).filter(m => m && isTime(m.at))),
  };
}

// True when the first window is a better approval record than the second: a higher rate, or the same rate over more first reviews.
export function beatsApproval(a, b) {
  if (!b) return true;
  const left = a.approved * b.reviewed;
  const right = b.approved * a.reviewed;
  return left !== right ? left > right : a.reviewed > b.reviewed;
}
export const beatsMerges = (a, b) => !b || a.merged > b.merged;

// The best qualifying window for approval (at least 20 first reviews) and the window with most merges; null where there is no data.
// Ties after the rule above go to the earlier window.
export function bestWindows(input) {
  const data = prepare(input);
  const all = [...data.firstTimes, ...data.mergeTimes];
  if (!all.length) return { approval: null, merges: null };
  const lowest = Math.floor(Math.min(...all) / HOUR_MS) * HOUR_MS - DAY_MS + HOUR_MS;
  const highest = Math.floor(Math.max(...all) / HOUR_MS) * HOUR_MS;
  let approval = null;
  let merges = null;
  for (let start = lowest; start <= highest; start += HOUR_MS) {
    const window = measure(data, start);
    if (window.reviewed >= MIN_FIRST_REVIEWS && beatsApproval(window, approval)) approval = window;
    if (window.merged > 0 && beatsMerges(window, merges)) merges = window;
  }
  return { approval, merges };
}

// The 24 hours ending at now, on the same basis, and the distance to each record: percentage points of approval rate (null while the
// current window has fewer than 20 first reviews or there is no record) and merged pull requests.
export function currentWindow(input, now, records = {}) {
  const current = measure(prepare(input), now - DAY_MS, now + 1);
  const qualifies = current.reviewed >= MIN_FIRST_REVIEWS;
  const approvalGap = qualifies && records.approval ? Math.round((current.rate - records.approval.rate) * 10) / 10 : null;
  const mergeGap = records.merges ? current.merged - records.merges.merged : null;
  return { window: { ...current, start: iso(now - DAY_MS), end: iso(now) }, qualifies, distance: { approval: approvalGap, merges: mergeGap } };
}
