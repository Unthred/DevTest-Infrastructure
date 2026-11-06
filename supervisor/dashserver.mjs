// Team dashboard server (issue #32). Node built-ins only. It reads the supervisor state and the cache/history the tick wrote; it makes
// no GitHub call and no model call. GET/HEAD only, except two form posts, each needing an access proof (issue #434; the probe has a 5-minute per-agent cooldown and Mark as read a 5-second shared cooldown, both kept in the state root): POST /mark-read moves the Mark as read marker (issue #253), and
// POST /probe/<agent> runs one minimal allowance probe (issue #110).
// no GitHub call and no model call. GET/HEAD only, except three form posts: POST /mark-read moves the Mark as read marker (issue #253),
// POST /probe/<agent> runs one minimal allowance probe (issue #110), and POST /watch changes which changes are followed (issue #430).
// Each post needs an access proof (issue #434); the probe also has a per-agent cooldown.
import http from 'node:http';
import { SupervisorError } from './core.mjs';
import { readTimeline, computeGaps, allSnapshots, storageReport } from './history.mjs';
import { readCache, readEvents, readLastSeen, writeLastSeen, readJobs, readSnapshots, readTeamState, redact } from './dashdata.mjs';
import { applyAction, readWatchlist } from './watchlist.mjs';
import { createViewStore, VIEW_STALE_MS } from './viewstore.mjs';
import { createWorkerBuild } from './viewworker.mjs';
import { buildView } from './dashboard.mjs';
import { defaultZone } from './clocktext.mjs';
import { readRegister } from './planning.mjs';
import fs from 'node:fs';
import { matchRoute, nextTickHtml, renderRoute, processesFragment } from './dashrender.mjs';
import { createSampler, createJobReader } from './procsample.mjs';
import { validateTeamConfig } from './team.mjs';
import { readTranscript } from './transcript.mjs';
import { jobOutcome, discarded } from './joboutcome.mjs';
import { installs, breakerHistory } from './installs.mjs';
import { defaultRegistry } from './core.mjs';
import { probeNow } from './probenow.mjs';
import { listRuns, readRun, readEvidenceFile, parseFilePath, DEFAULT_EVIDENCE_ROOT } from './evidence.mjs';
import { buildDiagnostics, DEFAULT_RECORDER_DIR } from './diagnostics.mjs';
import { wakeStatus, requestWake, spawnDetachedPass, inboxWatcher } from './wake.mjs';
import { fileURLToPath } from 'node:url';
import { decide as decideInbox, ID_RE as INBOX_ID } from './inbox.mjs';
import { proofValid, withProof, reserveCooldown, releaseCooldown, MARK_READ_COOLDOWN_MS, INBOX_COOLDOWN_MS } from './dashwrite.mjs';
import { BREAKER_RESUME_COOLDOWN_MS, requestBreakerResume } from './breakerresume.mjs';
import { underSupervisedJob } from './breaker.mjs';

export const DEFAULT_PORT = 8731;
// Issue #406: ask for a pass now. Only when the team loop is enabled; never throws, never blocks the answer to the homeowner.
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export function defaultWake(root, reason, config) {
  try {
    if (!config?.enabled) return;
    requestWake({ root, reason, spawnPass: why => spawnDetachedPass({ root, reason: why, self: cliPath }) });
  } catch (error) { console.error(`dashboard: wake not requested: ${error?.name || 'Error'}`); }
}

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
  // `invalid` names why the file was refused while the last good one is served (issue #191), so the page can say so.
  const read = () => { try { good = config(); read.invalid = null; } catch (error) { if (!good) throw error; read.invalid = String(error?.message || error); } return good; };
  read.invalid = null;
  return read;
}

// `tz` is the zone for clock times on the page (issue #185); it defaults to the host zone, as 'team status' does.
// Issue #362: `timeline` loads the retained timeline; `allTime` also loads the archived tick snapshots for the all-time chart range. Both read
// local files only. Storage figures are always included (a few directory sizes) so the Needs you warning shows on every page.
export async function currentView({ root, config, now = Date.now(), tz = defaultZone(), configError = null, timeline = false, allTime = false }) {
  if (typeof config === 'function') config = config();
  const jobs = readJobs(root);
  const register = registerCached(config);
  const hot = readSnapshots(root), tl = readTimeline(root);
  const history = { timeline: timeline ? tl : [], gaps: timeline ? computeGaps(tl, allSnapshots(root, hot), now) : [], storage: storageReport(root, { now, timeline: tl }), ...(allTime ? { chartSnapshots: allSnapshots(root, hot) } : {}) };
  return buildView({ config: validateTeamConfig(config), root, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), cache: readCache(root), snapshots: hot, history, now, tz, configError, lastSeen: readLastSeen(root), watchlist: readWatchlist(root), register, registerUnreadable: !register });
}

// The only files served besides pages: fixed names, read from this package, never a path taken from the request. Tests and the smoke scripts derive what to stage from this list (issues #447, #455).
export const STATIC = { '/static/style.css': ['style.css', 'text/css; charset=utf-8'], '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/static/logic.mjs': ['logic.mjs', 'text/javascript; charset=utf-8'], '/static/legend.mjs': ['legend.mjs', 'text/javascript; charset=utf-8'], '/static/grid.mjs': ['grid.mjs', 'text/javascript; charset=utf-8'], '/static/lists.mjs': ['lists.mjs', 'text/javascript; charset=utf-8'], '/static/lists-ui.mjs': ['lists-ui.mjs', 'text/javascript; charset=utf-8'], '/static/early.js': ['early.js', 'text/javascript; charset=utf-8'], '/static/layout-early.js': ['layout-early.js', 'text/javascript; charset=utf-8'],
  '/static/watch.mjs': ['watch.mjs', 'text/javascript; charset=utf-8'], '/static/watch.js': ['watch.js', 'text/javascript; charset=utf-8'], '/static/processes.js': ['processes.js', 'text/javascript; charset=utf-8'] };
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

// Target (issue #448): a page answers within 1 second at the median while a full test suite runs; the view is reused for this long.
export const DASHBOARD_VIEW_TTL_MS = 3000;
// Issue #496: the Diagnostics page's data, from local records and the recorder logs only.
export function diagnosticsData({ root, config, now, recorderDir }) {
  if (typeof config === 'function') config = config();
  const cfg = validateTeamConfig(config);
  return buildDiagnostics({ jobs: readJobs(root), snapshots: readSnapshots(root), verdicts: readTeamState(root)?.verdicts || {}, agents: Object.fromEntries(Object.entries(cfg.agents).map(([n, x]) => [n, x.provider])), now, recorderDir, wake: (() => { try { return wakeStatus(root, now); } catch { return null; } })() });
}
const pageData = p => ({ builtAt: p.builtAt, ageMs: p.ageMs, stale: p.stale, behindWrite: p.behindWrite, refreshing: p.refreshing, failed: p.failed });
export function handler({ root, config, host, port, now = () => Date.now(), supervised = underSupervisedJob, sampler = null, probe = probeNow, registry = defaultRegistry, viewTtlMs = 0, viewStaleMs = VIEW_STALE_MS, wake = defaultWake, evidenceRoot = DEFAULT_EVIDENCE_ROOT, offload = false, recorderDir = process.env.DEVTEST_RECORDER_DIR || DEFAULT_RECORDER_DIR }) {
  // Issues #448, #467: one prepared copy per view serves every request and tab; an old copy is served (marked) while one shared background
  // rebuild runs; a first build is shared by all requests that arrive meanwhile. ttl 0 (tests) rebuilds on every request, still shared.
  const worker = offload ? createWorkerBuild() : null;   // issue #467: the real server builds off the event loop
  const store = createViewStore({ build: worker ? worker.build : currentView, ttlMs: viewTtlMs, staleMs: viewStaleMs, clock: () => Date.now(),
    rebuildOpts: o => ({ ...o, now: now(), config: source(), configError: source.invalid }) });   // the timer rebuilds with the current time and config, not the last request's
  const cachedView = opts => store.get(`${opts.timeline}:${opts.allTime}`, opts);
  const source = configSource(config);
  const activeStreams = new Set();
  // Issue #568: one cached /proc reading shared by every tab (10 s); a new one is taken only when a page or the poll asks for it.
  const procs = sampler || createSampler({ readJobs: createJobReader(root), now });
  const allowedHost = `${host}:${port}`;
  // Mark as read (issue #253): the only write. Same-origin form POST; moves the marker to the time the page was built, so work that
  // finished between page load and click is still shown next time. It can never move the marker backwards or into the future.
  const markRead = async (req, res, send) => {
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');
    if (req.headers.origin !== `http://${allowedHost}`) return send(403, 'text/plain; charset=utf-8', 'cross-origin request refused');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return send(413, 'text/plain; charset=utf-8', 'too large'); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return send(403, 'text/plain; charset=utf-8', 'missing or wrong access proof');
    const at = Number(form.get('at')), t = now(), prev = readLastSeen(root);
    if (!/^\d{10,15}$/.test(form.get('at') || '') || at > t) return send(400, 'text/plain; charset=utf-8', 'bad time');
    const slot = reserveCooldown(root, 'mark-read', t, MARK_READ_COOLDOWN_MS);
    // A quick double-click lands back on the dashboard with a notice instead of a bare error page; nothing moved.
    if (!slot.ok) return send(303, 'text/plain; charset=utf-8', 'too soon', { location: '/?notice=mark-read-cooldown', 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000))) });
    writeLastSeen(root, Math.max(at, prev ?? 0));
    store.invalidate();   // issue #467: the redirect page must show this write, not the copy built before it
    return send(303, 'text/plain; charset=utf-8', 'marked', { location: '/' });
  };
  // Watch (issue #430): the third write. It changes only which changes the dashboard follows; it starts, stops and alters no work.
  // Same host, same origin, one small form post, and the access proof (issue #434) like the other writes. The target must be an issue or PR the tick has seen.
  const watch = async (req, res, send) => {
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');
    if (req.headers.origin !== `http://${allowedHost}`) return send(403, 'text/plain; charset=utf-8', 'cross-origin request refused');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return send(413, 'text/plain; charset=utf-8', 'too large'); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return send(403, 'text/plain; charset=utf-8', 'missing or wrong access proof');
    const kind = form.get('kind'), action = form.get('action'), raw = form.get('number') || '', number = /^\d{1,7}$/.test(raw) ? Number(raw) : NaN;
    const back = /^\/[A-Za-z0-9/_-]{0,80}$/.test(form.get('back') || '') ? form.get('back') : '/';
    if (!['issue', 'pr'].includes(kind) || !Number.isSafeInteger(number) || number < 1 || !['watch', 'unwatch', 'pin', 'unpin'].includes(action)) return send(400, 'text/plain; charset=utf-8', 'bad request');
    if (action === 'watch') {
      const cache = readCache(root) || {}, known = kind === 'issue' ? (cache.issues || []).some(i => i.number === number) : [...(cache.pulls || []), ...(cache.merged || [])].some(p => p.number === number) || (readTeamState(root).mergeLog || []).some(m => m.pr === number);
      if (!known) return send(404, 'text/plain; charset=utf-8', 'unknown issue or pull request');
    }
    const r = applyAction(root, { kind, number, action, now: now() });
    if (!r.ok) return send(409, 'text/plain; charset=utf-8', r.reason);
    store.invalidate();   // issue #467: as for Mark as read
    return send(303, 'text/plain; charset=utf-8', 'ok', { location: back });
  };
  // Inbox (issue #124): Approve or Reject one pending overseer proposal. The same write protection as the other posts (D-029): host, origin, the
  // secret proof, and a short cooldown. The decision is recorded only; the next tick acts on an approval. This route is the only way to approve.
  const inbox = async (req, res, send) => {
    if (!source().inbox?.dir) return send(404, 'text/plain; charset=utf-8', 'the inbox is not configured');
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');
    if (req.headers.origin !== `http://${allowedHost}`) return send(403, 'text/plain; charset=utf-8', 'cross-origin request refused');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return send(413, 'text/plain; charset=utf-8', 'too large'); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return send(403, 'text/plain; charset=utf-8', 'missing or wrong access proof');
    const id = form.get('id') || '', decision = form.get('decision') || '';
    if (!INBOX_ID.test(id) || !['approve', 'reject'].includes(decision)) return send(400, 'text/plain; charset=utf-8', 'bad request');
    const t = now(), slot = reserveCooldown(root, 'inbox', t, INBOX_COOLDOWN_MS);
    if (!slot.ok) return send(303, 'text/plain; charset=utf-8', 'too soon', { location: '/?notice=inbox-cooldown', 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000))) });
    const r = decideInbox(source().inbox.dir, id, decision, t);
    if (!r.ok) { releaseCooldown(root, 'inbox', t); return send(409, 'text/plain; charset=utf-8', r.reason); }
    try { wake(root, 'approve', source()); } catch { /* issue #406: the decision is recorded; the schedule is the fallback */ }   // the decision starts a pass now
    return send(303, 'text/plain; charset=utf-8', 'recorded', { location: '/' });
  };
  // Resume (issue #626): the circuit breaker's button. Host, origin, the secret proof and a cooldown (D-029), and it must be a person's click:
  // the browser marks a click on a form button as a same-origin user navigation (Sec-Fetch-Site and Sec-Fetch-User), which a script does
  // not send unless it forges them, and a dashboard that runs under a supervised job refuses. It only leaves a request; the tick clears the halt.
  const breakerResume = async (req, res, send) => {
    if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');
    if (req.headers.origin !== `http://${allowedHost}`) return send(403, 'text/plain; charset=utf-8', 'cross-origin request refused');
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-user'] !== '?1' || supervised()) return send(403, 'text/plain; charset=utf-8', 'resume needs a person clicking the button');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return send(413, 'text/plain; charset=utf-8', 'too large'); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return send(403, 'text/plain; charset=utf-8', 'missing or wrong access proof');
    const scope = form.get('scope') || '', halts = readTeamState(root)?.breaker || {};
    const known = scope === 'all' ? !!(halts.global || Object.keys(halts.halts || {}).length) : scope === 'global' ? !!halts.global : !!(halts.halts || {})[scope];
    if (!known) return send(409, 'text/plain; charset=utf-8', 'nothing halted for that scope');
    const t = now(), slot = reserveCooldown(root, 'breaker-resume', t, BREAKER_RESUME_COOLDOWN_MS);
    if (!slot.ok) return send(303, 'text/plain; charset=utf-8', 'too soon', { location: '/?notice=breaker-resume-cooldown', 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000))) });
    requestBreakerResume(root, scope, t);
    try { wake(root, 'approve', source()); } catch { /* the schedule is the fallback */ }   // the request is applied by the next pass
    store.invalidate();
    return send(303, 'text/plain; charset=utf-8', 'requested', { location: '/' });
  };
  return async (req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    const [reqPath] = (req.url || '/').split('?');
    if (req.method === 'POST' && reqPath === '/mark-read') return markRead(req, res, send);
    if (req.method === 'POST' && reqPath === '/watch') return watch(req, res, send);
    if (req.method === 'POST' && reqPath === '/inbox') return inbox(req, res, send);
    if (req.method === 'POST' && reqPath === '/breaker-resume') return breakerResume(req, res, send);
    // A second write the dashboard accepts (issue #110): "Refresh allowance" runs a single minimal probe for one configured agent and stores
    // its allowance record. Same-origin form post only; it changes no mode, latch, job or repository.
    const probePath = req.method === 'POST' ? /^\/probe\/([A-Za-z0-9_-]{1,40})$/.exec(reqPath) : null;
    if (probePath) {
      if (req.headers.host !== allowedHost) return send(421, 'text/plain; charset=utf-8', 'unexpected host');
      if (req.headers.origin !== `http://${allowedHost}`) return send(403, 'text/plain; charset=utf-8', 'cross-origin request refused');
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1024) return send(413, 'text/plain; charset=utf-8', 'too large'); chunks.push(c); }
      if (!proofValid(root, new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('proof'))) return send(403, 'text/plain; charset=utf-8', 'missing or wrong access proof');
      // Cooldown per agent, kept in the state root. An unknown agent is refused before it takes a slot.
      const agent = probePath[1], at = now();
      if (!source().agents?.[agent]) return send(404, 'text/plain; charset=utf-8', 'unknown agent');
      const slot = reserveCooldown(root, `probe:${agent}`, at);
      if (!slot.ok) return send(429, 'text/plain; charset=utf-8', `too soon, try again at ${new Date(slot.retryAt).toISOString()}\n`, { 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - at) / 1000))) });
      try {
        const out = await probe({ root, registry, config: source(), agent, now: at });
        if (out.error === 'overage-risk' || out.error === 'busy') releaseCooldown(root, `probe:${agent}`, at);   // nothing was spent
        store.invalidate();   // issue #467: the page after the probe must show its reading
        return send(303, 'text/plain; charset=utf-8', out.ok ? 'refreshed\n' : 'no reading\n', { location: `/usage?probe=${out.ok ? 'ok' : 'failed'}` });
      } catch (error) {
        releaseCooldown(root, `probe:${agent}`, at);
        return send(error instanceof SupervisorError ? 404 : 500, 'text/plain; charset=utf-8', error instanceof SupervisorError ? 'unknown agent' : 'probe failed');
      }
    }
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
      // Issue #623: two bounded, redacted, read-only records for the Foreman MCP tools (the account there cannot read the state root).
      if ((m = /^\/api\/jobs\/([a-f0-9]{32})\/outcome\.json$/.exec(path))) { const out = jobOutcome(root, m[1]); return out ? send(200, 'application/json; charset=utf-8', JSON.stringify(out)) : send(404, 'text/plain; charset=utf-8', 'not found'); }
      if (path === '/api/discarded.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(discarded(readTeamState(root), 200)));
      // Issue #625: install history (with the version each process runs) and the circuit breaker's trip history, for the Foreman MCP tools.
      if (path === '/api/installs.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(installs(root, { now: now() })));
      if (path === '/api/breaker.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(breakerHistory(readTeamState(root), 100)));
      // UI review evidence (issue #455): read-only files from <evidence root>/ui-review, png, json and md only, no symlink followed.
      const fileRequest = /^\/evidence\/files\/(.+)$/.exec(path);
      if (fileRequest) {
        const parsed = parseFilePath(fileRequest[1]), r = parsed ? readEvidenceFile(evidenceRoot, parsed) : { error: 'not-found' };
        if (r.error) return send(r.error === 'too-large' ? 413 : 404, 'text/plain; charset=utf-8', r.error === 'too-large' ? 'too large' : 'not found');
        return send(200, r.type, r.body, { 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' });
      }
      const apiPath = path === '/api/view.json' || path === '/api/next' || path === '/api/processes';
      const route = apiPath ? null : matchRoute(path);
      if (!apiPath && !route) return send(404, 'text/plain; charset=utf-8', 'not found');
      const q0 = new URLSearchParams(search);
      const prepared = await cachedView({ root, config: source(), now: now(), configError: source.invalid, timeline: route?.page === 'timeline', allTime: q0.get('range') === 'all' });
      const view = { ...prepared.view, pageData: pageData(prepared) };   // pages and the JSON carry the freshness of the prepared copy
      if (path === '/api/view.json') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ...view, pageData: pageData(prepared) }));
      // Issue #481: only the Next element, so a page that polls during a long tick does not re-fetch a whole page (a watch page carries its transcript).
      if (path === '/api/next') return send(200, 'text/html; charset=utf-8', nextTickHtml(view, view.generatedAt) || '<span class="muted">none</span>');
      if (path === '/api/processes') {
        const agent = /^[A-Za-z0-9_-]{1,40}$/.test(q0.get('agent') || '') ? q0.get('agent') : null;
        return send(200, 'text/html; charset=utf-8', processesFragment({ ...view, generatedAt: now() }, procs.get(), agent));
      }
      const diag = route.page === 'diagnostics', watch = route.page === 'watch', evidence = route.page === 'evidence' || route.page === 'evidence-run';
      const routed = diag ? { ...route, data: diagnosticsData({ root, config: source(), now: now(), recorderDir }) } : route.page === 'processes' ? { ...route, sample: procs.get() } : watch ? { ...route, transcript: readTranscript(root, route.id), job: jobRecord(root, route.id), runningNow: now() }
        : evidence ? { ...route, data: route.page === 'evidence' ? listRuns(evidenceRoot) : readRun(evidenceRoot, route.id) } : route;
      const out = renderRoute(route.page === 'processes' ? { ...view, generatedAt: now() } : view, routed, { query: new URLSearchParams(search), pathname: path, ...(watch ? { refreshSeconds: 0 } : {}) });
      // The evidence pages show same-origin screenshots, so only they may load images from 'self'; every other page keeps data: only.
      return send(out.status, 'text/html; charset=utf-8', withProof(out.html, root), evidence ? { 'content-security-policy': HEADERS['content-security-policy'].replace("img-src data:", "img-src 'self' data:") } : {});
    } catch (error) {
      console.error(`dashboard: ${error?.name || 'Error'}: ${redact(error?.message, 160)}`);
      return send(500, 'text/plain; charset=utf-8', 'dashboard could not read the supervisor state');
    }
  };
}

export function serve({ root, config, host, port = DEFAULT_PORT, evidenceRoot }) {
  validateBind(host, port);
  const server = http.createServer(handler({ root, config, host, port, viewTtlMs: DASHBOARD_VIEW_TTL_MS, offload: true, ...(evidenceRoot ? { evidenceRoot } : {}) }));
  // Issue #406: a new proposal file in the inbox folder starts a pass (no new port; one directory listing every few seconds).
  const src = configSource(config);
  const inboxDir = (() => { try { return src().inbox?.dir || null; } catch { return null; } })();
  const watcher = inboxDir ? inboxWatcher({ dir: inboxDir, onNew: () => { try { defaultWake(root, 'inbox', src()); } catch { /* the schedule is the fallback */ } } }) : { stop() {} };
  server.once('close', () => watcher.stop());
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
