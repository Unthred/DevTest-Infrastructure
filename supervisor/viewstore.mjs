// Issue #467: one prepared copy of each dashboard view serves every request and every open tab. Pure apart from the injected `build`.
//  - fresh copy (younger than ttlMs): returned at once;
//  - older copy: returned at once, marked, while ONE background rebuild runs (stale-while-revalidate);
//  - no copy yet: the request waits for the build, and every request arriving meanwhile shares that same build;
//  - a rebuild that fails keeps the last good copy, marked stale with the reason (never shown as current).
//  - one timer keeps every copy that was requested recently rebuilt before it can go stale, so a normal page reload is served a fresh copy.
//    The timer runs only while the view has been requested within activeMs; once nobody has looked for that long it stops and an unwatched
//    dashboard adds no steady load. A rebuild never overlaps another for the same key (the running build is shared).
// Reads files only through `build`; no model or GitHub call.
export const VIEW_TTL_MS = 3000;
export const VIEW_STALE_MS = 30000;   // a copy older than this is marked stale on the page
export const VIEW_REFRESH_MS = 15000;   // the timer rebuilds a requested copy once it is this old, well inside VIEW_STALE_MS
export const VIEW_ACTIVE_MS = 300000;   // the timer keeps running for this long after the last request

const everyUnref = (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return () => clearInterval(h); };

export function createViewStore({ build, ttlMs = VIEW_TTL_MS, staleMs = VIEW_STALE_MS, clock = Date.now, yieldTo = fn => setImmediate(fn),
  refreshMs = VIEW_REFRESH_MS, activeMs = VIEW_ACTIVE_MS, every = everyUnref, rebuildOpts = o => o }) {
  const entries = new Map();   // key -> { view, builtAt, failed, running, opts }
  let lastRequestAt = -Infinity, stopTimer = null;
  // The single timer. refreshMs <= 0 or ttlMs <= 0 (reuse disabled, as in tests) means no timer at all.
  const warm = () => {
    const now = clock();
    if (now - lastRequestAt > activeMs) { stopTimer?.(); stopTimer = null; return; }   // nobody is looking: stop
    for (const [key, entry] of entries) {
      if (entry.running || !entry.view || now - Math.max(entry.builtAt, entry.triedAt || 0) < refreshMs) continue;   // one rebuild at a time, only copies that are getting old
      startBuild(key, rebuildOpts(entry.opts), entry).catch(() => {});   // a failure keeps the last copy and marks it stale (recorded on the entry)
    }
  };
  const ensureTimer = () => { if (!stopTimer && refreshMs > 0 && ttlMs > 0) stopTimer = every(warm, Math.max(1, Math.floor(refreshMs / 3))); };
  const startBuild = (key, opts, entry) => {
    if (entry.running) return entry.running;   // a build already running is shared, never repeated
    entry.triedAt = clock();   // a failing rebuild is not retried by the timer more often than refreshMs
    entry.running = new Promise((resolve, reject) => yieldTo(() => {
      Promise.resolve().then(() => build(opts)).then(view => { entry.view = view; entry.builtAt = clock(); entry.failed = null; resolve(entry); }, error => {
        entry.failed = String(error?.message || error).slice(0, 160); reject(error);
      });
    })).finally(() => { entry.running = null; });
    entry.running.catch(() => {});   // a background failure is recorded on the entry, not left unhandled
    return entry.running;
  };
  // Returns { view, builtAt, ageMs, stale, refreshing, failed }.
  async function get(key, opts) {
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { view: null, builtAt: 0, failed: null, running: null, opts });
    entry.opts = opts;
    lastRequestAt = clock(); ensureTimer();
    const now = clock();
    if (ttlMs <= 0 || !entry.view) await startBuild(key, opts, entry);   // no copy yet (or reuse disabled): wait, shared with concurrent requests
    else if (now - entry.builtAt >= ttlMs) startBuild(key, opts, entry).catch(() => {});   // old copy: serve it, rebuild in the background
    const at = clock(), ageMs = Math.max(0, at - entry.builtAt);
    return { view: entry.view, builtAt: entry.builtAt, ageMs, stale: ageMs >= staleMs || !!entry.failed, refreshing: !!entry.running, failed: entry.failed };
  }
  return { get, size: () => entries.size, timerRunning: () => !!stopTimer, close: () => { stopTimer?.(); stopTimer = null; } };
}
