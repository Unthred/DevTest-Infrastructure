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

// Issue #1288: sends one command and returns the parsed reply, applied or refused alike. It never throws and never navigates: a network
// failure, a missing proof or an answer that is not JSON comes back shaped like a refusal with the code no_answer, so a screen shows one
// kind of message. The access proof is read from the page's foreman-proof meta element and sent in the x-foreman-proof header.
const COMMAND_NAME = /^[a-z]+(?:[._][a-z]+)*$/;
const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const refusal = (command, code, text) => ({
  ok: false, command, outcome: 'refused', audit_id: null, refusal_code: code, refusal_text: text, result: null, undo: null, cursor: null,
});
const noAnswer = (command, text) => refusal(command, 'no_answer', text);

export function newIdempotencyKey(random = globalThis.crypto) {
  const bytes = random.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, byte => KEY_CHARS[byte % KEY_CHARS.length]).join('');
}

const proofOf = doc => doc?.querySelector?.('meta[name="foreman-proof"]')?.getAttribute('content') || null;

// deps: fetchFn, doc (the page), newKey. Tests pass them; the page uses the defaults.
export async function sendCommand(name, input, reason = null, dryRun = false, key = null, deps = {}) {
  if (typeof name !== 'string' || !COMMAND_NAME.test(name)) {
    return refusal(String(name), 'bad_command_name', 'That is not a command name: use lower case words joined by dots and underscores.');
  }
  const proof = proofOf(deps.doc ?? globalThis.document);
  if (!proof) return noAnswer(name, 'The page has no access proof, so the command was not sent. Reload the page.');
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const body = { input: input ?? {}, reason: reason ?? null, idempotency_key: key ?? (deps.newKey ?? newIdempotencyKey)() };
  if (dryRun) body.dry_run = true;
  try {
    const response = await fetchFn(`${BASE}commands/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-foreman-proof': proof },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const reply = await response.json();
    return reply && typeof reply === 'object' && typeof reply.ok === 'boolean' ? reply : noAnswer(name, 'The answer was not in the expected form.');
  } catch {
    return noAnswer(name, 'No answer came back, so the command may not have been applied. Check the page before trying again.');
  }
}
