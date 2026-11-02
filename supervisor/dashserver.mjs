// Read-only team dashboard server (issue #32). Node built-ins only. It reads the supervisor state and the cache/history the
// tick wrote; it makes no GitHub call and no model call, and changes nothing except the Mark as read marker (POST /mark-read; every other request is GET/HEAD only).
import http from 'node:http';
import { SupervisorError } from './core.mjs';
import { readCache, readEvents, readLastSeen, writeLastSeen, readJobs, readSnapshots, readTeamState, redact } from './dashdata.mjs';
import { buildView } from './dashboard.mjs';
import { defaultZone } from './clocktext.mjs';
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
// Keyed by repository path; a failed read is kept for only 5 s, so a hung or slow git costs one blocking call per 5 s, not one per request.
const registerMemo = new Map();
export function registerCached(config, read = readRegister, now = Date.now()) {
  const hit = registerMemo.get(config.repo_path);
  if (hit && now - hit.at <= (hit.text ? 60000 : 5000)) return hit.text;
  const text = read(config);
  registerMemo.set(config.repo_path, { at: now, text });
  return text;
}
export const clearRegisterMemo = () => registerMemo.clear();

// `config` may be a loader function: it is called on every request, so an edit of team.local.json shows without a restart. A
// loader that throws (a half-written or invalid file) keeps the last good configuration rather than breaking the page.
export function configSource(config) {
  if (typeof config !== 'function') return () => config;
  let good = null;
  return () => { try { good = config(); } catch (error) { if (!good) throw error; } return good; };
}

// `tz` is the zone for clock times on the page (issue #185); it defaults to the host zone, as 'team status' does.
export async function currentView({ root, config, now = Date.now(), tz = defaultZone() }) {
  if (typeof config === 'function') config = config();
  const jobs = readJobs(root);
  const register = registerCached(config);
  return buildView({ config: validateTeamConfig(config), root, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), cache: readCache(root), snapshots: readSnapshots(root), now, tz, lastSeen: readLastSeen(root), register, registerUnreadable: !register });
}

// The only files served besides pages: fixed names, read from this package, never a path taken from the request.
const STATIC = { '/static/style.css': ['style.css', 'text/css; charset=utf-8'], '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/static/logic.mjs': ['logic.mjs', 'text/javascript; charset=utf-8'], '/static/legend.mjs': ['legend.mjs', 'text/javascript; charset=utf-8'], '/static/early.js': ['early.js', 'text/javascript; charset=utf-8'],
  '/static/watch.mjs': ['watch.mjs', 'text/javascript; charset=utf-8'], '/static/watch.js': ['watch.js', 'text/javascript; charset=utf-8'] };
const staticFile = name => fs.readFileSync(new URL(`./dashui/${name}`, import.meta.url));

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };

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
  const source = configSource(config);
  const activeStreams = new Set();
  const allowedHost = `${host}:${port}`;
  // Mark as read (issue #253): the only write. Same-origin form POST; moves the marker to the time the page was built, so work that
  // finished between page load and click is still shown next time. It can never move the marker backwards or into the future.
  const markRead = async (req, res, send) => {
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');
    if (req.headers.origin !== `http://${allowedHost}`) return send(403, 'text/plain; charset=utf-8', 'cross-origin request refused');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return send(413, 'text/plain; charset=utf-8', 'too large'); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const at = Number(form.get('at')), t = now(), prev = readLastSeen(root);
    if (!/^\d{10,15}$/.test(form.get('at') || '') || at > t) return send(400, 'text/plain; charset=utf-8', 'bad time');
    writeLastSeen(root, Math.max(at, prev ?? 0));
    return send(303, 'text/plain; charset=utf-8', 'marked', { location: '/' });
  };
  return async (req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    const [reqPath] = (req.url || '/').split('?');
    if (req.method === 'POST' && reqPath === '/mark-read') return markRead(req, res, send);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'read-only dashboard', { allow: 'GET, HEAD' });
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');   // blocks DNS-rebinding
    const [, search = ''] = (req.url || '/').split('?'), path = reqPath;
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
      const view = await currentView({ root, config: source(), now: now() });
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
