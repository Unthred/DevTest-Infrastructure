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

// `config` may be a loader function: it is called on every request, so an edit of team.local.json shows without a restart. A
// loader that throws (a half-written or invalid file) keeps the last good configuration rather than breaking the page.
export function configSource(config) {
  if (typeof config !== 'function') return () => config;
  let good = null;
  return () => { try { good = config(); } catch (error) { if (!good) throw error; } return good; };
}

export async function currentView({ root, config, now = Date.now() }) {
  if (typeof config === 'function') config = config();
  const jobs = readJobs(root);
  const register = registerCached(config);
  return buildView({ config: validateTeamConfig(config), root, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), cache: readCache(root), snapshots: readSnapshots(root), now, register, registerUnreadable: !register });
}

// The only files served besides pages: fixed names, read from this package, never a path taken from the request.
const STATIC = { '/static/style.css': ['style.css', 'text/css; charset=utf-8'], '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/static/logic.mjs': ['logic.mjs', 'text/javascript; charset=utf-8'], '/static/early.js': ['early.js', 'text/javascript; charset=utf-8'] };
const staticFile = name => fs.readFileSync(new URL(`./dashui/${name}`, import.meta.url));

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

export function handler({ root, config, host, port, now = () => Date.now() }) {
  const source = configSource(config);
  const allowedHost = `${host}:${port}`;
  return async (req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'read-only dashboard', { allow: 'GET, HEAD' });
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');   // blocks DNS-rebinding
    const [path, search = ''] = (req.url || '/').split('?');
    try {
      if (path === '/healthz') return send(200, 'text/plain; charset=utf-8', 'ok\n');
      if (STATIC[path]) return send(200, STATIC[path][1], staticFile(STATIC[path][0]));
      const route = path === '/api/view.json' ? null : matchRoute(path);
      if (path !== '/api/view.json' && !route) return send(404, 'text/plain; charset=utf-8', 'not found');
      const view = await currentView({ root, config: source(), now: now() });
      if (path === '/api/view.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(view));
      const out = renderRoute(view, route, { query: new URLSearchParams(search), pathname: path });
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
