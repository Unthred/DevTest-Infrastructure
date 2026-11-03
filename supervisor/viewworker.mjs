// Issue #467: the dashboard build (viewworker-entry.mjs) runs on a worker thread, so the server's event loop keeps answering requests (from the prepared copy)
// while a build is running. The worker reads files only (no model call, no GitHub call). The build crosses the thread as JSON text.
import { Worker } from 'node:worker_threads';

// Returns { build(opts), close() }. `opts.config` must already be a plain object. The worker starts on first use and restarts after a crash.
export function createWorkerBuild({ url = new URL('./viewworker-entry.mjs', import.meta.url).href } = {}) {
  let worker = null, seq = 0;
  const pending = new Map();
  const fail = reason => { for (const p of pending.values()) p.reject(new Error(reason)); pending.clear(); };
  const start = () => {
    const w = new Worker(new URL(url));
    w.unref();
    w.on('message', ({ id, json, error }) => {
      const p = pending.get(id); if (!p) return; pending.delete(id);
      if (error) return p.reject(new Error(error));
      try { p.resolve(JSON.parse(json)); } catch (e) { p.reject(e); }
    });
    w.on('error', e => { if (worker === w) worker = null; fail(`dashboard build worker failed: ${e?.message || e}`); });
    w.on('exit', () => { if (worker === w) worker = null; fail('dashboard build worker exited'); });
    return w;
  };
  return {
    build: opts => new Promise((resolve, reject) => {
      worker ||= start();
      const id = ++seq; pending.set(id, { resolve, reject });
      worker.postMessage({ id, opts });
    }),
    close: () => { const w = worker; worker = null; return w ? w.terminate() : undefined; },
  };
}
