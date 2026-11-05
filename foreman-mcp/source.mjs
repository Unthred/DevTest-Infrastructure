// Data sources. Everything is read-only and bounded: the local dashboard's /api/view.json over HTTP GET (cached, size capped, short timeout)
// and /proc. Nothing here writes anywhere, takes a lock or calls a model.
import http from 'node:http';
import fs from 'node:fs';

export const VIEW_TIMEOUT_MS = 10000;
export const VIEW_MAX_BYTES = 48 * 1024 * 1024;
export const VIEW_CACHE_MS = 20000;

// GET a URL, reject on timeout or when the body exceeds maxBytes. Only http: is accepted.
export function getJson(url, { timeoutMs = VIEW_TIMEOUT_MS, maxBytes = VIEW_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('the dashboard address is not a valid URL')); }
    if (u.protocol !== 'http:') return reject(new Error('only an http dashboard address is accepted'));
    let done = false, req = null;
    const finish = (fn, value) => { if (done) return; done = true; try { req?.destroy(); } catch { /* already closed */ } fn(value); };   // settle first, then close: a destroyed request may never emit
    req = http.get(u, { timeout: timeoutMs, headers: { accept: 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return finish(reject, new Error(`the dashboard answered HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > maxBytes) return finish(reject, new Error('the dashboard view is larger than the size limit')); chunks.push(c); });
      res.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(resolve, v); } catch { finish(reject, new Error('the dashboard view is not valid JSON')); } });
      res.on('error', e => finish(reject, e));
      res.on('aborted', () => finish(reject, new Error('the dashboard closed the connection early')));
    });
    req.on('timeout', () => finish(reject, new Error(`the dashboard did not answer within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', e => finish(reject, e));
  });
}

// A cached view source: one fetch at most every cacheMs, concurrent callers share one fetch, and a failed fetch serves the last good copy marked stale.
export function createViewSource({ url, fetchJson = getJson, now = Date.now, cacheMs = VIEW_CACHE_MS }) {
  let cached = null, inflight = null;
  return {
    async get() {
      if (!url) throw new Error('no dashboard address is configured (viewUrl in the server configuration)');
      if (cached && now() - cached.at < cacheMs) return { view: cached.view, ageMs: now() - cached.at, stale: false };
      if (!inflight) inflight = fetchJson(url).then(view => { cached = { view, at: now() }; return view; }).finally(() => { inflight = null; });
      try { const view = await inflight; return { view, ageMs: 0, stale: false }; }
      catch (error) {
        if (cached) return { view: cached.view, ageMs: now() - cached.at, stale: true, error: error.message };
        throw error;
      }
    },
  };
}

const read = (file, fsRead = fs.readFileSync) => { try { return String(fsRead(file, 'utf8')); } catch { return null; } };

// Load average, memory and swap from /proc. Values are numbers; anything unreadable is null.
export function readHost({ proc = '/proc', fsRead = fs.readFileSync } = {}) {
  const la = (read(`${proc}/loadavg`, fsRead) || '').trim().split(/\s+/);
  const mem = {}; for (const line of (read(`${proc}/meminfo`, fsRead) || '').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) mem[m[1]] = Number(m[2]); }
  const mb = k => (Number.isFinite(mem[k]) ? Math.round(mem[k] / 1024) : null);
  const swapTotal = mb('SwapTotal'), swapFree = mb('SwapFree');
  const psi = (read(`${proc}/pressure/memory`, fsRead) || '').split('\n').filter(Boolean).slice(0, 2);
  const out = {
    load: { one: Number(la[0]) || null, five: Number(la[1]) || null, fifteen: Number(la[2]) || null },
    memoryMb: { total: mb('MemTotal'), available: mb('MemAvailable'), free: mb('MemFree'), cached: mb('Cached') },
    swapMb: { total: swapTotal, free: swapFree, used: swapTotal != null && swapFree != null ? swapTotal - swapFree : null, usedPercent: swapTotal ? Math.round(((swapTotal - swapFree) / swapTotal) * 1000) / 10 : null },
  };
  if (psi.length) out.memoryPressure = psi;   // omitted when the kernel has no /proc/pressure (Tower's has none)
  return out;
}
