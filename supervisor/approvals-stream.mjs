// Server-sent events for the "Waiting for approval" list (issue #1101). It sends a `changed` event when the set of waiting items differs from the
// last one it saw, so an open page re-reads itself when a proposal arrives or is decided anywhere, without a reload. Read-only.
export const APPROVALS_POLL_MS = 3000, APPROVALS_HEARTBEAT_MS = 15000, APPROVALS_MAX_STREAMS = 12, APPROVALS_MAX_MS = 6 * 3600000;

// Pure: the rows -> a short text that changes exactly when an item is added or removed.
export const approvalsSignature = rows => (rows || []).map(r => r.id).sort().join('|');

// read: async () => rows (the one pendingApprovals() list, from the cached view). headers: the dashboard's response headers.
export function approvalsStream({ req, res, headers, active, read, pollMs = APPROVALS_POLL_MS }) {
  if (active.size >= APPROVALS_MAX_STREAMS) { res.writeHead(503, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' }); return res.end('too many live views'); }
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const token = {}; active.add(token);
  let last = null, quiet = 0, done = false, busy = false;
  const finish = () => { if (done) return; done = true; clearInterval(timer); clearTimeout(cap); active.delete(token); res.end(); };
  const pump = async () => {
    if (done || busy) return; busy = true;
    try {
      const sig = approvalsSignature(await read());
      if (done) return;
      if (last !== null && sig !== last) { res.write(`event: changed\ndata: ${JSON.stringify({ count: sig ? sig.split('|').length : 0 })}\n\n`); quiet = 0; }
      last = sig; quiet += pollMs;
      if (quiet >= APPROVALS_HEARTBEAT_MS) { res.write(': keep-alive\n\n'); quiet = 0; }
    } catch { finish(); } finally { busy = false; }
  };
  const timer = setInterval(pump, pollMs), cap = setTimeout(finish, APPROVALS_MAX_MS);
  req.on('close', finish);
  res.write('retry: 3000\n\n'); pump();
}
