// Issue #1254: GET /api/v1/events, the change stream. It says which read models changed so a client never polls everything and never
// reloads. Events come from the bounded log in eventlog.mjs; this module only watches the tick cache and writes the wire format.
// Limits are the job transcript stream's: 12 open streams, and a stream ends after 6 hours so the client reconnects.
import { readCache, STALE_TICK_MS } from '../../dashdata.mjs';
import { freshnessOf, CONTRACT } from '../envelope.mjs';
import { append, newestId, readSince, observe, idNumber } from '../eventlog.mjs';

export const name = 'events';
export const method = 'GET';
export const path = 'events';
export const events = ['hello', 'heartbeat', 'model_changed', 'command_applied', 'freshness_changed', 'resync_required'].map(type => ({ name: type }));
export { append };
export const cursor = newestId;

export const MAX_STREAMS = 12;
export const MAX_STREAM_MS = 6 * 3600000;
export const HEARTBEAT_MS = 15000;
export const POLL_MS = 2000;
const RETRY_SECONDS = 5;
const SSE_TYPE = 'text/event-stream; charset=utf-8';
const active = new Set();

// The test shortens the poll and the heartbeat with these variables; a bad value falls back to the default.
const fromEnv = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 10 ? value : fallback;
};

const lastTickAt = root => {
  try { return readCache(root)?.tick?.at ?? null; } catch { return null; }
};
const wire = event => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

// The cursor a client sends: the standard header, else the query name cursor. A value that is not a valid id counts as none.
export function requestedCursor(req, query) {
  const raw = req.headers['last-event-id'] ?? query.cursor;
  return idNumber(raw) === null ? null : raw;
}

function refuse(context, req, res) {
  const body = { error: { code: 'too_many_streams', text: 'Too many change streams are open.', retry_after_seconds: RETRY_SECONDS } };
  context.reply(req, res, 503, 'application/json; charset=utf-8', JSON.stringify(body), { 'retry-after': String(RETRY_SECONDS) });
}

function openStream({ req, res, context, after }) {
  const { root } = context;
  const modelNames = context.models.map(m => m.name);
  const token = {};
  active.add(token);
  let done = false;
  let sentAt = Date.now();
  let sent = idNumber(after ?? newestId(root));
  const send = event => { res.write(wire(event)); sentAt = Date.now(); };
  // hello, heartbeat and resync_required are not kept in the log: they carry the newest id, so a reconnect never moves backwards.
  const synthetic = (type, fields) => ({ id: newestId(root), type, at: new Date().toISOString(), ...fields });
  const freshness = () => freshnessOf({ tickAt: lastTickAt(root), now: Date.now(), staleAfterMs: STALE_TICK_MS });
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(poller);
    clearInterval(beat);
    clearTimeout(cap);
    active.delete(token);
    res.end();
  };
  const pump = () => {
    if (done) return;
    try {
      observe(root, { tickAt: lastTickAt(root), freshness: freshness(), models: modelNames });
      for (const event of readSince(root, `e-${sent}`).events) {
        send(event);
        sent = idNumber(event.id);
      }
    } catch { finish(); }
  };
  const heartbeat = () => {
    if (!done && Date.now() - sentAt >= fromEnv('DEVTEST_EVENTS_HEARTBEAT_MS', HEARTBEAT_MS)) send(synthetic('heartbeat', { freshness: freshness() }));
  };
  res.writeHead(200, {
    ...context.headers, 'content-type': SSE_TYPE, 'cache-control': 'no-store', connection: 'keep-alive',
    'x-accel-buffering': 'no', 'foreman-contract': CONTRACT,
  });
  send(synthetic('hello', { contract: CONTRACT }));
  if (after !== null && readSince(root, after).gap) {
    send(synthetic('resync_required', { reason_code: 'cursor_too_old' }));
    sent = idNumber(newestId(root));
  }
  const poller = setInterval(pump, fromEnv('DEVTEST_EVENTS_POLL_MS', POLL_MS));
  const beat = setInterval(heartbeat, Math.max(10, Math.floor(fromEnv('DEVTEST_EVENTS_HEARTBEAT_MS', HEARTBEAT_MS) / 3)));
  const cap = setTimeout(finish, MAX_STREAM_MS);
  req.on('close', finish);
  res.on('close', finish);
  pump();
}

export function handle(req, res, context) {
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...context.headers, 'content-type': SSE_TYPE, 'cache-control': 'no-store', 'foreman-contract': CONTRACT });
    return res.end();
  }
  if (active.size >= MAX_STREAMS) return refuse(context, req, res);
  return openStream({ req, res, context, after: requestedCursor(req, context.query) });
}
