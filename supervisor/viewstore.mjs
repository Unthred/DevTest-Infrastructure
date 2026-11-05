// Issue #467: one prepared copy of each dashboard view serves every request and every open tab. Pure apart from the injected `build`.
//  - fresh copy (younger than ttlMs): returned at once;
//  - older copy: returned at once, marked, while ONE background rebuild runs (stale-while-revalidate);
//  - no copy yet: the request waits for the build, and every request arriving meanwhile shares that same build;
//  - a rebuild that fails keeps the last good copy, marked stale with the reason (never shown as current).
//  - one timer keeps each copy that was requested recently rebuilt before it can go stale, so a normal page reload is served a fresh copy.
//    Requests are tracked per key: the timer rebuilds only a key requested within activeMs, and stops when no key was. A view nobody has
//    looked at for that long is never rebuilt, whatever other pages are open. A rebuild never overlaps another for the same key.
//  - invalidate() (called by every dashboard write before it redirects) makes every copy older than the write unusable as current: the
//    next request waits for a build that started after the write, or, if that build fails, is served the old copy marked stale.
// Reads files only through `build`; no model or GitHub call.
export const VIEW_TTL_MS = 3000;
export const VIEW_STALE_MS = 30000;   // a copy older than this is marked stale on the page
export const VIEW_REFRESH_MS = 15000;   // the timer rebuilds a requested copy once it is this old, well inside VIEW_STALE_MS
export const VIEW_ACTIVE_MS = 300000;   // the timer keeps running for this long after the last request

const everyUnref = (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return () => clearInterval(h); };

export function createViewStore({ build, ttlMs = VIEW_TTL_MS, staleMs = VIEW_STALE_MS, clock = Date.now, yieldTo = fn => setImmediate(fn),
  refreshMs = VIEW_REFRESH_MS, activeMs = VIEW_ACTIVE_MS, every = everyUnref, rebuildOpts = o => o }) {
  const entries = new Map();   // key -> { view, builtAt, failed, running, opts, requestedAt, gen, builtGen }
  let stopTimer = null;
  // The single timer. refreshMs <= 0 or ttlMs <= 0 (reuse disabled, as in tests) means no timer at all.
  const warm = () => {
    const now = clock();
    let watched = false;
    for (const [key, entry] of entries) {
      if (now - entry.requestedAt > activeMs) continue;   // nobody has looked at this view recently: leave it alone
      watched = true;
      if (entry.running || !entry.view || now - Math.max(entry.builtAt, entry.triedAt || 0) < refreshMs) continue;   // one rebuild at a time, only copies that are getting old
      startBuild(key, rebuildOpts(entry.opts), entry).catch(() => {});   // a failure keeps the last copy and marks it stale (recorded on the entry)
    }
    if (!watched) { stopTimer?.(); stopTimer = null; }   // no view is being watched: stop
  };
  const ensureTimer = () => { if (!stopTimer && refreshMs > 0 && ttlMs > 0) stopTimer = every(warm, Math.max(1, Math.floor(refreshMs / 3))); };
  const startBuild = (key, opts, entry) => {
    if (entry.running) return entry.running;   // a build already running is shared, never repeated
    entry.triedAt = clock();   // a failing rebuild is not retried by the timer more often than refreshMs
    const gen = entry.runningGen = entry.gen;   // the writes this build is guaranteed to include: those before it started
    entry.running = new Promise((resolve, reject) => yieldTo(() => {
      Promise.resolve().then(() => build(opts)).then(view => { entry.view = view; entry.builtAt = clock(); entry.builtGen = gen; entry.failed = null; resolve(entry); }, error => {
        entry.failed = String(error?.message || error).slice(0, 160); reject(error);
      });
    })).finally(() => { entry.running = null; });
    entry.running.catch(() => {});   // a background failure is recorded on the entry, not left unhandled
    return entry.running;
  };
  // After a write, wait for a build that began after it. A build already running may have begun before the write, so it is awaited and
  // another is started; two rounds cover one write racing one build. If a build fails the old copy is served, marked stale with the reason.
  const rebuildAfterWrite = async (key, opts, entry) => {
    for (let round = 0; round < 3 && entry.builtGen !== entry.gen; round++) {
      try { if (entry.running && entry.runningGen === entry.gen) await entry.running; else if (entry.running) await entry.running.catch(() => {}); else await startBuild(key, opts, entry); }
      catch { return; }   // failed: the entry records it and the old copy is served stale
    }
  };
  // Returns { view, builtAt, ageMs, stale, refreshing, failed }.
  async function get(key, opts) {
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { view: null, builtAt: 0, failed: null, running: null, opts, requestedAt: -Infinity, gen: 0, builtGen: 0 });
    entry.opts = opts;
    entry.requestedAt = clock(); ensureTimer();
    const now = clock();
    if (ttlMs <= 0 || !entry.view) await startBuild(key, opts, entry);   // no copy yet (or reuse disabled): wait, shared with concurrent requests
    else if (entry.builtGen !== entry.gen) await rebuildAfterWrite(key, opts, entry);   // a write happened since this copy's build began: never serve it as current
    else if (now - entry.builtAt >= ttlMs) startBuild(key, opts, entry).catch(() => {});   // old copy: serve it, rebuild in the background
    const at = clock(), ageMs = Math.max(0, at - entry.builtAt);
    return { view: entry.view, builtAt: entry.builtAt, ageMs, stale: ageMs >= staleMs || !!entry.failed, refreshing: !!entry.running, failed: entry.failed };
  }
  // A dashboard write calls this before it redirects: every copy built before the write stops counting as current.
  const invalidate = () => { for (const entry of entries.values()) entry.gen++; return entries.size; };
  return { get, invalidate, size: () => entries.size, timerRunning: () => !!stopTimer, close: () => { stopTimer?.(); stopTimer = null; } };
}
