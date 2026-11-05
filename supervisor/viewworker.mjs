// Issue #467: the dashboard build (viewworker-entry.mjs) runs on a worker thread, so the server's event loop keeps answering requests (from the prepared copy)
// while a build is running. The worker reads files only (no model call, no GitHub call). The build crosses the thread as JSON text.
import { Worker } from 'node:worker_threads';

// Returns { build(opts), close() }. `opts.config` must already be a plain object. The worker starts on first use and restarts after a crash.
// A build that has not answered within timeoutMs is rejected and the worker is terminated, so a hung worker cannot stall every later rebuild; the
// next build starts a new one (the store keeps serving the last good copy, marked stale, meanwhile).
export function createWorkerBuild({ url = new URL('./viewworker-entry.mjs', import.meta.url).href, timeoutMs = 120000 } = {}) {
  let worker = null, seq = 0;
  const pending = new Map();
  // Only the builds that were sent to this worker fail with it: a terminated worker's late exit must not reject a build on its replacement.
  const fail = (reason, w) => { for (const [id, p] of [...pending]) if (p.w === w) { pending.delete(id); p.reject(new Error(reason)); } };
  const start = () => {
    const w = new Worker(new URL(url));
    w.unref();
    w.on('message', ({ id, json, error }) => {
      const p = pending.get(id); if (!p) return; pending.delete(id);
      if (error) return p.reject(new Error(error));
      try { p.resolve(JSON.parse(json)); } catch (e) { p.reject(e); }
    });
    w.on('error', e => { if (worker === w) worker = null; fail(`dashboard build worker failed: ${e?.message || e}`, w); });
    w.on('exit', () => { if (worker === w) worker = null; fail('dashboard build worker exited', w); });
    return w;
  };
  return {
    build: opts => new Promise((resolve, reject) => {
      worker ||= start();
      const id = ++seq, w = worker;
      const timer = setTimeout(() => { if (!pending.has(id)) return; pending.delete(id); reject(new Error(`dashboard build timed out after ${Math.round(timeoutMs / 1000)} s`)); if (worker === w) worker = null; w.terminate().catch(() => {}); }, timeoutMs);
      timer.unref?.();
      pending.set(id, { w, resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      w.postMessage({ id, opts });
    }),
    close: () => { const w = worker; worker = null; return w ? w.terminate() : undefined; },
  };
}
