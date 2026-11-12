// Team dashboard server (issue #32). Node built-ins only. It reads the supervisor state and the cache/history the tick wrote; it makes
// no GitHub call and no model call. GET/HEAD only, except two form posts, each needing an access proof (issue #434; the probe has a 5-minute per-agent cooldown and Mark as read a 5-second shared cooldown, both kept in the state root): POST /mark-read moves the Mark as read marker (issue #253), and
// POST /probe/<agent> runs one minimal allowance probe (issue #110).
// no GitHub call and no model call. GET/HEAD only, except three form posts: POST /mark-read moves the Mark as read marker (issue #253),
// POST /probe/<agent> runs one minimal allowance probe (issue #110), and POST /watch changes which changes are followed (issue #430).
// Each post needs an access proof (issue #434); the probe also has a per-agent cooldown.
import http from 'node:http';
import { SupervisorError } from './core.mjs';
import { readTimeline, computeGaps, allSnapshots, storageReport } from './history.mjs';
import { hostPressureView } from './hostpressure.mjs';
import { readCache, readEvents, readLastSeen, writeLastSeen, readJobs, readSnapshots, readTeamState, redact } from './dashdata.mjs';
import { applyAction, readWatchlist } from './watchlist.mjs';
import { createViewStore, VIEW_STALE_MS } from './viewstore.mjs';
import { createWorkerBuild } from './viewworker.mjs';
import { buildView } from './dashboard.mjs';
import { withApprovals } from './approvals.mjs';
import { withDecisionCards } from './decisioncards.mjs';
import { decisionRoute } from './decisionroute.mjs';
import { approvalsStream } from './approvals-stream.mjs';
import { defaultZone } from './clocktext.mjs';
import { readRegister } from './planning.mjs';
import fs from 'node:fs';
import { matchRoute, nextTickHtml, renderRoute, processesFragment } from './dashrender.mjs';
import { createSampler, createJobReader } from './procsample.mjs';
import { configureDisplay } from './money.mjs';
import { validateTeamConfig, HEALTH_DEFAULTS } from './team.mjs';
import { readTranscript } from './transcript.mjs';
import { jobOutcome, discarded } from './joboutcome.mjs';
import { installs, breakerHistory } from './installs.mjs';
import { readIndex, searchIndex } from './issueindex.mjs';
import { wasteByCause, configView, testRunsView, ticksView } from './mcpreads.mjs';
import { alertsView } from './alertsview.mjs';
import { summarize as failCausesOf } from './failcause.mjs';
import { DEFAULT_TEST_SLOTS } from './testslots.mjs';
import nodePath from 'node:path';
import { defaultRegistry } from './core.mjs';
import { probeNow } from './probenow.mjs';
import { listRuns, readRun, readEvidenceFile, parseFilePath, DEFAULT_EVIDENCE_ROOT } from './evidence.mjs';
import { buildDiagnostics, readDiskSamples, readRecorder, DAY_MS, DEFAULT_RECORDER_DIR } from './diagnostics.mjs';
import { wakeView, requestWake, spawnDetachedPass, spawnDetachedLane, inboxWatcher, inboxScanDone } from './wake.mjs';
import * as inboxStore from './inbox.mjs';
import { controlsOf } from './controlactions.mjs';
import { fileURLToPath } from 'node:url';
import { recordRefusedOrigin } from './hostvalue.mjs';
import { decide as decideInbox, undo as undoInbox, ID_RE as INBOX_ID, allStatuses as inboxStatuses } from './inbox.mjs';
import { proofValid, withProof, reserveCooldown, releaseCooldown, MARK_READ_COOLDOWN_MS, INBOX_COOLDOWN_MS } from './dashwrite.mjs';
import { BREAKER_RESUME_COOLDOWN_MS, requestBreakerResume } from './breakerresume.mjs';
import { underSupervisedJob } from './breaker.mjs';
import { isLocalPeer, peerPid as defaultPeerPid } from './peerpid.mjs';
import { limitResetsRoute } from './resetswrite.mjs';
import { withLimitResets } from './resetsentries.mjs';

export const DEFAULT_PORT = 8731;
// Issue #406: ask for a pass now. Only when the team loop is enabled; never throws, never blocks the answer to the homeowner.
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const SHIPPED_CONFIG = fileURLToPath(new URL('./team.json', import.meta.url));
export function defaultWake(root, reason, config) {
  try {
    if (!config?.enabled) return;
    // Issue #985: an approval also starts the approved prompt at once in the fast lane, so it does not wait for a running pass to end.
    if (reason === 'approve') { try { spawnDetachedLane({ root, self: cliPath }); } catch { /* the woken pass starts it */ } }
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
  const read = () => { try { good = config(); if (good?.display) configureDisplay(good.display); read.invalid = null; } catch (error) { if (!good) throw error; read.invalid = String(error?.message || error); } return good; };
  read.invalid = null;
  return read;
}

// `tz` is the zone for clock times on the page (issue #185); it defaults to the host zone, as 'team status' does.
// Issue #362: `timeline` loads the retained timeline; `allTime` also loads the archived tick snapshots for the all-time chart range. Both read
// local files only. Storage figures are always included (a few directory sizes) so the Needs you warning shows on every page.
export async function currentView({ root, config, now = Date.now(), tz = defaultZone(), configError = null, timeline = false, allTime = false, statfs = undefined }) {
  if (typeof config === 'function') config = config();
  const jobs = readJobs(root);
  configureDisplay(validateTeamConfig(config).display);   // issue #1097
  const register = registerCached(config);
  const hot = readSnapshots(root), tl = readTimeline(root);
  const history = { timeline: timeline ? tl : [], gaps: timeline ? computeGaps(tl, allSnapshots(root, hot), now) : [], storage: storageReport(root, { now, timeline: tl, ...(statfs ? { statfs } : {}) }), ...(allTime ? { chartSnapshots: allSnapshots(root, hot) } : {}) };
  const checked = validateTeamConfig(config);   // the validated configuration carries the inbox folder the approvals list reads
  const view = await buildView({
    config: checked, root, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), cache: readCache(root),
    snapshots: hot, history, now, tz, configError, lastSeen: readLastSeen(root), watchlist: readWatchlist(root), register, registerUnreadable: !register,
  });
  return withLimitResets(withApprovals(withDecisionCards(view, checked, readCache(root)), checked), { root, config: checked, snapshots: history.chartSnapshots || hot, now });
}

// The only files served besides pages: fixed names, read from this package, never a path taken from the request. Tests and the smoke scripts derive what to stage from this list (issues #447, #455).
export const STATIC = { '/static/style.css': ['style.css', 'text/css; charset=utf-8'], '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/static/logic.mjs': ['logic.mjs', 'text/javascript; charset=utf-8'], '/static/legend.mjs': ['legend.mjs', 'text/javascript; charset=utf-8'], '/static/refresh.mjs': ['refresh.mjs', 'text/javascript; charset=utf-8'], '/static/chartopts.mjs': ['chartopts.mjs', 'text/javascript; charset=utf-8'], '/static/grid.mjs': ['grid.mjs', 'text/javascript; charset=utf-8'], '/static/appbar.mjs': ['appbar.mjs', 'text/javascript; charset=utf-8'], '/static/lists.mjs': ['lists.mjs', 'text/javascript; charset=utf-8'], '/static/lists-ui.mjs': ['lists-ui.mjs', 'text/javascript; charset=utf-8'], '/static/early.js': ['early.js', 'text/javascript; charset=utf-8'], '/static/layout-early.js': ['layout-early.js', 'text/javascript; charset=utf-8'],
  '/static/approve-all.mjs': ['approve-all.mjs', 'text/javascript; charset=utf-8'],
  '/static/watch.mjs': ['watch.mjs', 'text/javascript; charset=utf-8'], '/static/inbox-ui.mjs': ['inbox-ui.mjs', 'text/javascript; charset=utf-8'], '/static/watch.js': ['watch.js', 'text/javascript; charset=utf-8'], '/static/processes.js': ['processes.js', 'text/javascript; charset=utf-8'] };
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
  return buildDiagnostics({ jobs: readJobs(root), snapshots: readSnapshots(root), verdicts: readTeamState(root)?.verdicts || {}, agents: Object.fromEntries(Object.entries(cfg.agents).map(([n, x]) => [n, x.provider])), now, recorderDir, wake: (() => { try { return wakeView(root, now); } catch { return null; } })() });
}
const pageData = p => ({ builtAt: p.builtAt, ageMs: p.ageMs, stale: p.stale, behindWrite: p.behindWrite, refreshing: p.refreshing, failed: p.failed });
// Issue #1093: the Health page's data. Disk samples and the recorder are bounded reads of local files; no model or GitHub call.
export function healthData({ root, config, now, recorderDir }) {
  if (typeof config === 'function') config = config();
  const checked = validateTeamConfig(config);
  const h = { ...HEALTH_DEFAULTS, ...checked.health };
  return { now, warn: h.disk_warn_percent, alert: h.disk_alert_percent, disk: readDiskSamples(nodePath.join(root, 'dashboard', 'disk-samples.jsonl'), now),
    hostPressure: hostPressureView(readTeamState(root), checked, now),   // issue #1151
    recorder: recorderDir ? readRecorder(recorderDir, now - 7 * DAY_MS, now) : { status: 'missing', note: 'No recorder log folder is configured.', files: 0, samples: 0, hourly: [], days: [] } };
}
export function handler({ root, config, host, port, now = () => Date.now(), supervised = underSupervisedJob, peerPid = defaultPeerPid, sampler = null, probe = probeNow, registry = defaultRegistry, viewTtlMs = 0, viewStaleMs = VIEW_STALE_MS, wake = defaultWake, evidenceRoot = DEFAULT_EVIDENCE_ROOT, offload = false, recorderDir = process.env.DEVTEST_RECORDER_DIR || DEFAULT_RECORDER_DIR, statfs = undefined }) {
  // Issues #448, #467: one prepared copy per view serves every request and tab; an old copy is served (marked) while one shared background
  // rebuild runs; a first build is shared by all requests that arrive meanwhile. ttl 0 (tests) rebuilds on every request, still shared.
  // `statfs` is a test seam reaching only the in-process build; the worker build cannot receive a function, so refuse the combination (issue #841).
  if (offload && statfs) throw new Error('handler: the statfs option is not supported with offload: true');
  const worker = offload ? createWorkerBuild() : null;   // issue #467: the real server builds off the event loop
  const store = createViewStore({ build: worker ? worker.build : o => currentView(statfs ? { ...o, statfs } : o), ttlMs: viewTtlMs, staleMs: viewStaleMs, clock: () => Date.now(),
    rebuildOpts: o => ({ ...o, now: now(), config: source(), configError: source.invalid }) });   // the timer rebuilds with the current time and config, not the last request's
  const cachedView = opts => store.get(`${opts.timeline}:${opts.allTime}`, opts);
  const source = configSource(config);
  const activeStreams = new Set();
  // Issue #568: one cached /proc reading shared by every tab (10 s); a new one is taken only when a page or the poll asks for it.
  const procs = sampler || createSampler({ readJobs: createJobReader(root), now });
  const allowedHost = `${host}:${port}`;
  // Issue #556: the listen address plus the origins named in dashboard.allowed_origins (read per request, so an edit applies without a
  // restart). The comparison is exact; a missing or "null" Origin matches nothing.
  const originAllowed = req => { const o = req.headers.origin; if (typeof o !== 'string') return false; if (o === `http://${allowedHost}`) return true; try { return (source().dashboard?.allowed_origins || []).includes(o); } catch { return false; } };
  // A readable page with a way back, not a bare text body. It names the Host and Origin received so the right origin can be configured;
  // both are escaped, and the response is still a 403 that changes nothing.
  const esc = v => String(v ?? '(none)').slice(0, 200).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const q = v => JSON.stringify(String(v ?? '(none)').slice(0, 200));
  const page = (send, code, title, body) => send(code, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>${title}</h1>${body}<p><a href="/">Back to the dashboard</a></p></main></body></html>`);
  const seen = req => `<p>Origin received: <code>${esc(req.headers.origin)}</code><br>Host received: <code>${esc(req.headers.host)}</code></p>`;
  const refuseHost = (req, send) => { console.error(`dashboard: write refused, unexpected host (issue #556) origin=${q(req.headers.origin)} host=${q(req.headers.host)} url=${q(req.url)}`); return page(send, 421, 'Unexpected host', `<p>The dashboard did not accept this action because the request arrived with a Host it does not serve (unexpected host). Nothing was changed.</p>${seen(req)}<p>If a reverse proxy sits in front of this dashboard, it must forward the upstream Host (see docs/supervisor.md).</p>`); };
  const refuseOrigin = (req, send) => { try { recordRefusedOrigin(root, req.headers.origin); } catch { /* observation only */ } console.error(`dashboard: write refused (issue #556) origin=${q(req.headers.origin)} host=${q(req.headers.host)} url=${q(req.url)}`); return page(send, 403, 'Request refused', `<p>The dashboard did not accept this action because it came from an address that is not allowed (cross-origin request refused). Nothing was changed.</p>${seen(req)}<p>If this is the public address of this dashboard, add that origin to <code>dashboard.allowed_origins</code> in <code>team.local.json</code>.</p>`); };
  // Issue #830: the other refusals on a write route (access proof, size, inbox not configured) are readable pages too, with the same way back.
  const refuseWith = (send, code, title, text, hint = '') => page(send, code, title, `<p>${text} Nothing was changed.</p>${hint}`);
  const tooLarge = send => refuseWith(send, 413, 'Request too large', 'The request was too large (too large).');
  const badProof = send => refuseWith(send, 403, 'Access proof refused', 'The access proof was missing or wrong (missing or wrong access proof).', '<p>The page may be stale, for example after the proof was rotated. Go back to the dashboard, reload it and try again.</p>');
  // Mark as read (issue #253): the only write. Same-origin form POST; moves the marker to the time the page was built, so work that
  // finished between page load and click is still shown next time. It can never move the marker backwards or into the future.
  const markRead = async (req, res, send) => {
    if (req.headers.host !== allowedHost) return refuseHost(req, send);
    if (!originAllowed(req)) return refuseOrigin(req, send);
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return tooLarge(send); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return badProof(send);
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
    if (req.headers.host !== allowedHost) return refuseHost(req, send);
    if (!originAllowed(req)) return refuseOrigin(req, send);
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return tooLarge(send); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return badProof(send);
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
  // Issue #856: the script posts Accept: application/json and gets JSON, so a refusal shows on the card; every refusal changes nothing.
  const inbox = async (req, res, rawSend) => {
    const json = /application\/json/.test(req.headers.accept || '');
    const plainOf = html => String(html).replace(/<h1>[^]*?<\/h1>/, '').replace(/<p><a href[^]*$/, '').replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (m, c) => String.fromCharCode(Number(c))).replace(/\s+/g, ' ').trim().slice(0, 300);
    const send = !json ? rawSend : (code, type, body, headers = {}) => {
      if (code === 303 && /inbox-cooldown/.test(headers.location || '')) return rawSend(429, 'application/json; charset=utf-8', JSON.stringify({ ok: false, reason: 'That was too soon after the last decision; wait a second and press it again.' }), { 'retry-after': headers['retry-after'] });
      if (code >= 400) return rawSend(code, 'application/json; charset=utf-8', JSON.stringify({ ok: false, reason: type.startsWith('text/html') ? plainOf(body) : String(body) }));
      return rawSend(code, type, body, headers);
    };
    if (!source().inbox?.dir) return refuseWith(send, 404, 'Inbox not configured', 'The inbox is not configured (the inbox is not configured).');
    if (req.headers.host !== allowedHost) return refuseHost(req, send);
    if (!originAllowed(req)) return refuseOrigin(req, send);
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return tooLarge(send); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return badProof(send);
    const id = form.get('id') || '', decision = form.get('decision') || '';
    if (!INBOX_ID.test(id) || !['approve', 'reject', 'undo'].includes(decision)) return send(400, 'text/plain; charset=utf-8', 'bad request');
    const t = now(), slot = reserveCooldown(root, 'inbox', t, INBOX_COOLDOWN_MS);
    if (!slot.ok) return send(303, 'text/plain; charset=utf-8', 'too soon', { location: '/?notice=inbox-cooldown', 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000))) });
    const r = decision === 'undo' ? undoInbox(source().inbox.dir, id, t) : decideInbox(source().inbox.dir, id, decision, t);
    if (!r.ok) { releaseCooldown(root, 'inbox', t); return send(409, 'text/plain; charset=utf-8', r.reason); }
    store.invalidate();   // the next page must show this decision, not the copy built before it
    if (decision !== 'undo') { try { wake(root, 'approve', source()); } catch { /* issue #406: the decision is recorded; the schedule is the fallback */ } }   // the decision starts a pass now
    if (json) return rawSend(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, state: r.state, decidedAt: r.decidedAt ?? null, undoUntil: r.undoUntil ?? null }));
    return send(303, 'text/plain; charset=utf-8', 'recorded', { location: '/' });
  };
  const decision = decisionRoute({ root, source, cachedView, store, wake, now, guard: { allowedHost, originAllowed, refuseHost, refuseOrigin, tooLarge, badProof, refuseWith, esc } });
  // Resume (issue #626): the circuit breaker's button. Host, origin, the secret proof and a cooldown (D-029), and it must be a person's click:
  // the browser marks a click on a form button as a same-origin user navigation (Sec-Fetch-Site and Sec-Fetch-User), which a script does
  // not send unless it forges them, and a dashboard that runs under a supervised job refuses. It only leaves a request; the tick clears the halt.
  const breakerResume = async (req, res, send) => {
    if (req.headers.host !== allowedHost) return refuseHost(req, send);
    if (!originAllowed(req)) return refuseOrigin(req, send);
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-user'] !== '?1' || supervised()) return send(403, 'text/plain; charset=utf-8', 'resume needs a person clicking the button');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024) return tooLarge(send); chunks.push(c); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!proofValid(root, form.get('proof'))) return badProof(send);
    const scope = form.get('scope') || '', halts = readTeamState(root)?.breaker || {};
    const known = scope === 'all' ? !!(halts.global || Object.keys(halts.halts || {}).length) : scope === 'global' ? !!halts.global : !!(halts.halts || {})[scope];
    if (!known) return send(409, 'text/plain; charset=utf-8', 'nothing halted for that scope');
    const t = now(), slot = reserveCooldown(root, 'breaker-resume', t, BREAKER_RESUME_COOLDOWN_MS);
    if (!slot.ok) return send(303, 'text/plain; charset=utf-8', 'too soon', { location: '/?notice=breaker-resume-cooldown', 'retry-after': String(Math.max(1, Math.ceil((slot.retryAt - t) / 1000))) });
    // Issue #737: a request from this machine must not come from a process that descends from a supervised job, as the CLI route checks
    // its own caller. A caller that cannot be identified is refused rather than assumed to be a person. Issue #821: the lookup scans /proc
    // synchronously (about 180 ms on Tower), so it runs only for a request with a valid proof, a halted scope and no cooldown in force.
    // A refused caller gives the slot back so it cannot lock a person out.
    if (isLocalPeer(req.socket)) {
      const pid = peerPid(req.socket);
      if (!pid || supervised({ env: {}, pid })) {
        releaseCooldown(root, 'breaker-resume', t);
        return send(403, 'text/plain; charset=utf-8', pid ? 'resume needs a person clicking the button' : 'resume refused: the calling process could not be identified');
      }
    }
    requestBreakerResume(root, scope, t);
    try { wake(root, 'approve', source()); } catch { /* the schedule is the fallback */ }   // the request is applied by the next pass
    store.invalidate();
    return send(303, 'text/plain; charset=utf-8', 'requested', { location: '/' });
  };
  return async (req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    const [reqPath] = (req.url || '/').split('?');
    const limitResets = limitResetsRoute({ root, source, allowedHost, originAllowed, now, store });
    const writes = { '/mark-read': markRead, '/watch': watch, '/inbox': inbox, '/decision': decision, '/breaker-resume': breakerResume, '/limit-resets': limitResets };
    if (req.method === 'POST' && Object.hasOwn(writes, reqPath)) return writes[reqPath](req, res, send);
    // Issue #110: "Refresh allowance" runs one minimal probe for a configured agent and stores its record. Same-origin post only; it changes no mode or job.
    const probePath = req.method === 'POST' ? /^\/probe\/([A-Za-z0-9_-]{1,40})$/.exec(reqPath) : null;
    if (probePath) {
      if (req.headers.host !== allowedHost) return refuseHost(req, send);
      if (!originAllowed(req)) return refuseOrigin(req, send);
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1024) return tooLarge(send); chunks.push(c); }
      if (!proofValid(root, new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('proof'))) return badProof(send);
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
      // Issue #977: a direct link to one inbox item, by its full id or the first 8 characters. A waiting item opens the overview at its card
      // (the row is the page's :target, so it is highlighted); any other item gets a small page with its state, so the link never dead-ends.
      if ((m = /^\/inbox\/([a-f0-9]{8}|[a-f0-9]{32})$/.exec(path))) {
        const dir = source().inbox?.dir;
        if (!dir) return refuseWith(send, 404, 'Inbox not configured', 'The inbox is not configured.');
        const hits = inboxStatuses(dir).filter(s => s.id.startsWith(m[1]));
        if (hits.length !== 1) return refuseWith(send, hits.length ? 409 : 404, hits.length ? 'Ambiguous inbox id' : 'No such inbox item', hits.length ? 'More than one inbox item starts with that id; use the full id.' : 'No inbox item has that id. It may have been cleared after fourteen days.');
        const s = hits[0];
        if (s.state === 'pending') return send(302, 'text/plain; charset=utf-8', 'found', { location: `/inbox#att-inbox-${s.id}` });
        const issue = Number.isSafeInteger(s.issue) && s.issue > 0 && s.issue < 900000000 ? s.issue : null;
        return page(send, 200, `Inbox item ${esc(s.id.slice(0, 8))}`, `<p><code>${esc(s.id)}</code></p><ul><li>Kind: ${esc(s.kind || 'unknown')}</li><li>State: ${esc(s.state || 'unknown')}</li>${s.title ? `<li>Title: ${esc(String(s.title).slice(0, 200))}</li>` : ''}${issue ? `<li>GitHub issue: <a href="/work/issue/${issue}">#${issue}</a></li>` : ''}${s.reason ? `<li>Reason: ${esc(String(s.reason).slice(0, 300))}</li>` : ''}</ul>`);
      }
      if (path === '/api/approvals/events') return approvalsStream({ req, res, headers: HEADERS, active: activeStreams, read: async () => (await cachedView({ root, config: source(), now: now(), configError: source.invalid, timeline: false, allTime: false })).view.panels?.approvals });
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
      // Issue #635: the Diagnostics data, the failure cost by cause, and the effective configuration, for the Foreman MCP tools.
      if (path === '/api/diagnostics.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(diagnosticsData({ root, config: source(), now: now(), recorderDir })));
      if (path === '/api/failure-causes.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(failCausesOf(readTeamState(root).failCauses, { now: now(), days: new URLSearchParams(search).get('days') })));
      if (path === '/api/waste.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(wasteByCause(readTeamState(root), { now: now(), days: new URLSearchParams(search).get('days') })));
      // Issue #951: read-only search of the issue and pull request index, for the Foreman MCP tool foreman_issues.
      if (path === '/api/issues.json') { const q = Object.fromEntries(new URLSearchParams(search)); return send(200, 'application/json; charset=utf-8', JSON.stringify(searchIndex(readIndex(root), q, { verdicts: readTeamState(root).verdicts || {}, limit: q.limit }))); }
      // Issue #949: the alerts sent to the homeowner, newest first, grouped and counted per day, for the foreman_alerts MCP tool.
      if (path === '/api/alerts.json') { const q = new URLSearchParams(search); try { return send(200, 'application/json; charset=utf-8', JSON.stringify(alertsView(root, { now: now(), since: q.get('since'), contains: q.get('contains'), delivered: q.get('delivered'), limit: q.get('limit') }))); } catch (e) { return send(400, 'application/json; charset=utf-8', JSON.stringify({ error: String(e.message).slice(0, 200) })); } }
      // Issue #636: test-slot use with refused and killed runs, and recent ticks.
      if (path === '/api/tests.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(testRunsView(root, { limit: source()?.limits?.test_slots ?? DEFAULT_TEST_SLOTS, now: now() })));
      if (path === '/api/ticks.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(ticksView(root, { limit: new URLSearchParams(search).get('limit'), now: now() })));
      if (path === '/api/config.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(configView({ effective: source(), shippedFile: SHIPPED_CONFIG, localOverridePresent: fs.existsSync(nodePath.join(root, 'team.local.json')), configError: source.invalid })));
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
      if (path === '/api/view.json') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ...view, controls: controlsOf(source(), inboxStore) }));   // issue #1115
      // Issue #481: only the Next element, so a page that polls during a long tick does not re-fetch a whole page (a watch page carries its transcript).
      if (path === '/api/next') return send(200, 'text/html; charset=utf-8', nextTickHtml(view, view.generatedAt) || '<span class="muted">none</span>');
      if (path === '/api/processes') {
        const agent = /^[A-Za-z0-9_-]{1,40}$/.test(q0.get('agent') || '') ? q0.get('agent') : null;
        return send(200, 'text/html; charset=utf-8', processesFragment({ ...view, generatedAt: now() }, procs.get(), agent));
      }
      const diag = route.page === 'diagnostics', health = route.page === 'health', watch = route.page === 'watch', evidence = route.page === 'evidence' || route.page === 'evidence-run';
      const routed = health ? { ...route, data: healthData({ root, config: source(), now: now(), recorderDir }) } : diag ? { ...route, data: diagnosticsData({ root, config: source(), now: now(), recorderDir }) } : route.page === 'processes' ? { ...route, sample: procs.get() } : watch ? { ...route, transcript: readTranscript(root, route.id), job: jobRecord(root, route.id), runningNow: now() }
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
  const watcher = inboxDir ? inboxWatcher({ dir: inboxDir, onNew: () => {
    // Issue #985: validate the new proposal here and now (waiting -> pending), even while a pass runs. A scan that cannot run falls back to the wake.
    try { if (inboxScanDone(root, src(), inboxStore.scan)) return; } catch { /* fall back to a pass */ }
    try { defaultWake(root, 'inbox', src()); } catch { /* the schedule is the fallback */ }
  } }) : { stop() {} };
  server.once('close', () => watcher.stop());
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
