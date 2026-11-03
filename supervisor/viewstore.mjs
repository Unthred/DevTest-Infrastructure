// Issue #467: one prepared copy of each dashboard view serves every request and every open tab. Pure apart from the injected `build`.
//  - fresh copy (younger than ttlMs): returned at once;
//  - older copy: returned at once, marked, while ONE background rebuild runs (stale-while-revalidate);
//  - no copy yet: the request waits for the build, and every request arriving meanwhile shares that same build;
//  - a rebuild that fails keeps the last good copy, marked stale with the reason (never shown as current).
// Reads files only through `build`; no model or GitHub call.
export const VIEW_TTL_MS = 3000;
export const VIEW_STALE_MS = 30000;   // a copy older than this is marked stale on the page

export function createViewStore({ build, ttlMs = VIEW_TTL_MS, staleMs = VIEW_STALE_MS, clock = Date.now, yieldTo = fn => setImmediate(fn) }) {
  const entries = new Map();   // key -> { view, builtAt, failed, running }
  const startBuild = (key, opts, entry) => {
    if (entry.running) return entry.running;   // a build already running is shared, never repeated
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
    if (!entry) entries.set(key, entry = { view: null, builtAt: 0, failed: null, running: null });
    const now = clock();
    if (ttlMs <= 0 || !entry.view) await startBuild(key, opts, entry);   // no copy yet (or reuse disabled): wait, shared with concurrent requests
    else if (now - entry.builtAt >= ttlMs) startBuild(key, opts, entry).catch(() => {});   // old copy: serve it, rebuild in the background
    const at = clock(), ageMs = Math.max(0, at - entry.builtAt);
    return { view: entry.view, builtAt: entry.builtAt, ageMs, stale: ageMs >= staleMs || !!entry.failed, refreshing: !!entry.running, failed: entry.failed };
  }
  return { get, size: () => entries.size };
}
