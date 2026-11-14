// Issue #1410: the one place that decides which reason a wake request carries. A homeowner command names its own action (requeue,
// accept-split, clear-retry-cap); all of them are a person pressing a button, so they wake as `approve` (never dropped, never counted).
export const REASON_ALIASES = Object.freeze({ requeue: 'approve', 'accept-split': 'approve', 'clear-retry-cap': 'approve' });
export const normalizeReason = reason => REASON_ALIASES[reason] ?? reason;
