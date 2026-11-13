// Issue #1248: connects the contract router to the dashboard, so dashserver.mjs holds a single wrapping call. Requests under /api/v1/ are
// answered by the router (which does its own Host and method checks); every other request goes to the dashboard handler unchanged.
// DEVTEST_API_DIR names a folder holding models/, routes/ and schemas/ instead of this package's own (tests use it for a folder with fewer models).
import { readCache, readVersion, codeVersion, STALE_TICK_MS } from '../dashdata.mjs';
import { proofValid, reserveCooldown, releaseCooldown } from '../dashwrite.mjs';
import { createApiRouter } from './router.mjs';

const SHORT = 7;
const dirs = () => {
  const base = process.env.DEVTEST_API_DIR ? new URL(`file://${process.env.DEVTEST_API_DIR.replace(/\/?$/, '/')}`) : new URL('./', import.meta.url);
  return { modelsDir: new URL('models/', base), routesDir: new URL('routes/', base), schemasDir: new URL('schemas/', base) };
};
const lastTickAt = root => {
  try { return readCache(root)?.tick?.at ?? null; } catch { return null; }   // an unreadable cache is "no tick known", not a failed reply
};
const shortVersion = root => {
  const full = readVersion(root)?.installed || codeVersion() || '';
  return full ? full.slice(0, SHORT) : null;
};

// Issue #1251: the dashboard's own write checks, handed to route modules so none is copied. Each wraps the function the dashboard uses.
function makeGuard({ root, now, source, store, originAllowed, wake }) {
  return {
    originAllowed: req => originAllowed(req),
    proofValid: value => proofValid(root, value),
    reserveCooldown: (name, ms) => reserveCooldown(root, name, now(), ms),
    releaseCooldown: name => releaseCooldown(root, name, now()),
    invalidateView: () => store.invalidate(),
    wake: reason => wake(root, reason, source()),
  };
}

export function withApi({ root, headers, allowedHost, now, cachedView, source, store, originAllowed, wake }, next) {
  const getView = async () => (await cachedView({ root, config: source(), now: now(), configError: source.invalid, timeline: false, allTime: false })).view;
  const api = createApiRouter({
    ...dirs(), root, getConfig: () => source(), headers,
    guard: makeGuard({ root, now, source, store, originAllowed, wake }), allowedHost, now, getView, staleAfterMs: STALE_TICK_MS,
    tickAt: () => lastTickAt(root), coreVersion: () => shortVersion(root),
  });
  return (req, res) => {
    const [path] = (req.url || '/').split('?');
    return api.owns(path) ? api.handle(req, res, path) : next(req, res);
  };
}
