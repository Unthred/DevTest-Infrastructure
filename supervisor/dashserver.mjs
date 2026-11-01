// Read-only team dashboard server (issue #32). Node built-ins only. It reads the supervisor state and the cache/history the
// tick wrote; it makes no GitHub call and no model call, and exposes no endpoint that changes anything (GET/HEAD only).
import http from 'node:http';
import { SupervisorError } from './core.mjs';
import { readCache, readEvents, readJobs, readSnapshots, readTeamState, redact } from './dashdata.mjs';
import { buildView } from './dashboard.mjs';
import { readRegister } from './planning.mjs';
import fs from 'node:fs';
import { matchRoute, renderRoute } from './dashrender.mjs';
import { validateTeamConfig } from './team.mjs';
import { readTranscript } from './transcript.mjs';

export const DEFAULT_PORT = 8731;

// Tower LAN address only: a private IPv4 literal. Wildcards, loopback names and public addresses are refused.
export function validateBind(host, port) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host || '');
  const o = m ? m.slice(1).map(Number) : null;
  if (!o || o.some(n => n > 255)) throw new SupervisorError('dashboard host must be an IPv4 address of the Tower LAN');
  const private_ = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
  if (!private_) throw new SupervisorError('dashboard host must be a private LAN address (wildcard, loopback and public addresses are refused)');
  if (o[3] === 0 || o[3] === 255) throw new SupervisorError('dashboard host must be a single interface address');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new SupervisorError('dashboard port must be 1024-65535');
  return { host, port };
}

// The register on main changes rarely and reading it spawns git, so the server keeps it for a minute.
// Keyed by repository path; an empty (failed) read is never kept, so the next request retries.
const registerMemo = new Map();
export function registerCached(config, read = readRegister, now = Date.now()) {
  const hit = registerMemo.get(config.repo_path);
  if (hit && now - hit.at <= 60000) return hit.text;
  const text = read(config);
  if (text) registerMemo.set(config.repo_path, { at: now, text }); else registerMemo.delete(config.repo_path);
  return text;
}
export const clearRegisterMemo = () => registerMemo.clear();

export async function currentView({ root, config, now = Date.now() }) {
  const jobs = readJobs(root);
  const register = registerCached(config);
  return buildView({ config: validateTeamConfig(config), root, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), cache: readCache(root), snapshots: readSnapshots(root), now, register, registerUnreadable: !register });
}

// The only files served besides pages: fixed names, read from this package, never a path taken from the request.
const STATIC = { '/static/style.css': ['style.css', 'text/css; charset=utf-8'], '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/static/logic.mjs': ['logic.mjs', 'text/javascript; charset=utf-8'], '/static/early.js': ['early.js', 'text/javascript; charset=utf-8'],
  '/static/watch.mjs': ['watch.mjs', 'text/javascript; charset=utf-8'], '/static/watch.js': ['watch.js', 'text/javascript; charset=utf-8'] };
const staticFile = name => fs.readFileSync(new URL(`./dashui/${name}`, import.meta.url));

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

const LIVE = ['queued', 'running'];
export const SSE_POLL_MS = 250, SSE_HEARTBEAT_MS = 15000, SSE_MAX_STREAMS = 12, SSE_MAX_MS = 6 * 3600000;
const jobRecord = (root, id) => { try { return JSON.parse(fs.readFileSync(`${root}/jobs/${id}.json`, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; } };
const jobInfo = (j, at) => (j ? { status: j.status, startedAt: j.createdAt ?? null, elapsedMs: Number.isFinite(j.createdAt) ? (LIVE.includes(j.status) ? at : (j.updatedAt || j.createdAt)) - j.createdAt : null } : { status: 'unknown', startedAt: null, elapsedMs: null });

// Server-sent events for one job: every transcript entry after `after`, then new ones as the file grows, until the job is no
// longer running and the file is drained. Read-only; the event id is the entry sequence so a reconnect resumes without gaps.
function stream({ root, req, res, id, after, now, active }) {
  if (active.size >= SSE_MAX_STREAMS) { res.writeHead(503, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' }); return res.end('too many live views'); }
  res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let offset = 0, last = after, quiet = 0, done = false;
  const token = {}; active.add(token);
  const finish = () => { if (done) return; done = true; clearInterval(timer); clearTimeout(cap); active.delete(token); res.end(); };
  const pump = () => {
    if (done) return;
    try {
      const j = jobRecord(root, id), live = j ? LIVE.includes(j.status) : false;
      const r = readTranscript(root, id, { offset, after: last }); offset = r.offset;
      for (const e of r.entries) { res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); last = e.seq; quiet = 0; }
      // The job read happened BEFORE the file read, so a finished job with nothing new is really drained.
      if (!live && !r.entries.length) { res.write(`event: end\ndata: ${JSON.stringify(jobInfo(j, now()))}\n\n`); return finish(); }
      quiet += SSE_POLL_MS;
      if (quiet >= SSE_HEARTBEAT_MS) { res.write(': keep-alive\n\n'); quiet = 0; }
    } catch { finish(); }
  };
  const timer = setInterval(pump, SSE_POLL_MS), cap = setTimeout(finish, SSE_MAX_MS);
  req.on('close', finish);
  res.write('retry: 2000\n\n'); pump();
}

export function handler({ root, config, host, port, now = () => Date.now() }) {
  const activeStreams = new Set();
  const allowedHost = `${host}:${port}`;
  return async (req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'read-only dashboard', { allow: 'GET, HEAD' });
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');   // blocks DNS-rebinding
    const [path, search = ''] = (req.url || '/').split('?');
    try {
      if (path === '/healthz') return send(200, 'text/plain; charset=utf-8', 'ok\n');
      if (STATIC[path]) return send(200, STATIC[path][1], staticFile(STATIC[path][0]));
      let m;
      if ((m = /^\/api\/jobs\/([a-f0-9]{32})\/(events|transcript\.json)$/.exec(path))) {
        const id = m[1], q = new URLSearchParams(search);
        const afterRaw = req.headers['last-event-id'] ?? q.get('after') ?? '0', after = /^\d{1,12}$/.test(String(afterRaw)) ? Number(afterRaw) : 0;
        if (m[2] === 'events') return stream({ root, req, res, id, after, now, active: activeStreams });
        const r = readTranscript(root, id, { after });
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ job: jobInfo(jobRecord(root, id), now()), entries: r.entries, last: r.entries.at(-1)?.seq ?? after }));
      }
      const route = path === '/api/view.json' ? null : matchRoute(path);
      if (path !== '/api/view.json' && !route) return send(404, 'text/plain; charset=utf-8', 'not found');
      const view = await currentView({ root, config, now: now() });
      if (path === '/api/view.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(view));
      const watch = route.page === 'watch';
      const out = renderRoute(view, watch ? { ...route, transcript: readTranscript(root, route.id), job: jobRecord(root, route.id), runningNow: now() } : route, { query: new URLSearchParams(search), pathname: path, ...(watch ? { refreshSeconds: 0 } : {}) });
      return send(out.status, 'text/html; charset=utf-8', out.html);
    } catch (error) {
      console.error(`dashboard: ${error?.name || 'Error'}: ${redact(error?.message, 160)}`);
      return send(500, 'text/plain; charset=utf-8', 'dashboard could not read the supervisor state');
    }
  };
}

export function serve({ root, config, host, port = DEFAULT_PORT }) {
  validateBind(host, port);
  const server = http.createServer(handler({ root, config, host, port }));
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
