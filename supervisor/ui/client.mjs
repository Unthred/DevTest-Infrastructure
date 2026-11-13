// Issue #1266: the client of the read contract. It fetches a read model by name and follows the change stream, and says nothing about
// what a model means. Every address it builds is under /api/v1/.
export const BASE = '/api/v1/';
export const BEHIND_AFTER_MS = 35000;
const CHECK_MS = 5000;
const MODEL_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export async function fetchModel(name, fetchFn = globalThis.fetch.bind(globalThis)) {
  if (!MODEL_NAME.test(name)) throw new Error(`not a model name: ${name}`);
  const response = await fetchFn(`${BASE}${name}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return response.json();
}

const parse = event => {
  try { return JSON.parse(event.data) ?? {}; } catch { return {}; }
};

// Connection state: connecting, live (hello, heartbeat or any event seen), reconnecting (stream error), behind (nothing for 35 seconds).
// handlers: onState(state), onChange(names) with names null for resync_required, onFreshness(freshness). deps are for tests.
export function openStream(handlers, deps = {}) {
  const Source = deps.EventSource ?? globalThis.EventSource;
  const now = deps.now ?? Date.now;
  const every = deps.every ?? setInterval;
  const stopEvery = deps.stopEvery ?? clearInterval;
  let state = 'connecting';
  let lastSeen = now();
  const setState = next => {
    if (next === state) return;
    state = next;
    handlers.onState(next);
  };
  const seen = () => {
    lastSeen = now();
    setState('live');
  };
  const source = new Source(`${BASE}events`);
  source.addEventListener('hello', seen);
  for (const type of ['heartbeat', 'freshness_changed']) {
    source.addEventListener(type, event => {
      seen();
      const freshness = parse(event).freshness;
      if (freshness) handlers.onFreshness(freshness);
    });
  }
  for (const type of ['model_changed', 'command_applied']) {
    source.addEventListener(type, event => {
      seen();
      const models = parse(event).models;
      handlers.onChange(Array.isArray(models) ? models : []);
    });
  }
  source.addEventListener('resync_required', () => {
    seen();
    handlers.onChange(null);
  });
  // The browser retries by itself, and each failed try is another error: once behind, stay behind until something arrives.
  source.onerror = () => {
    if (state !== 'behind') setState('reconnecting');
  };
  const timer = every(() => {
    if (now() - lastSeen > BEHIND_AFTER_MS) setState('behind');
  }, CHECK_MS);
  return { state: () => state, close: () => { source.close(); stopEvery(timer); } };
}
