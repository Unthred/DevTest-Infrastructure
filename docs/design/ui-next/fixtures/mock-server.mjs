// Mock Foreman core for the ui-next prototype. Plain Node, built-ins only, no build step.
//   node ui-next/fixtures/mock-server.mjs            then open http://127.0.0.1:8732/
// It serves the fixtures over the v1 contract (queries, a fake command endpoint, an event stream) and the static prototype.
// State lives in memory: a restart returns to the fixtures. The actor is taken from the x-foreman-actor header here only;
// the real core derives it from the credential (dashboard access proof = homeowner, MCP account = overseer).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createValidator } from '../schemas/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8732, HOST = process.env.HOST || '127.0.0.1';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const MODELS = ['meta', 'appbar', 'overview', 'queue', 'inbox', 'jobs', 'allowance', 'audit'];
const db = Object.fromEntries(MODELS.map(name => [name, readJson(path.join(HERE, `${name}.json`))]));
const schemaDir = path.join(HERE, '..', 'schemas');
const schemas = Object.fromEntries(fs.readdirSync(schemaDir).filter(n => n.endsWith('.schema.json')).map(n => [n, readJson(path.join(schemaDir, n))]));
const validate = createValidator(schemas);
const staticDir = path.join(HERE, '..', 'prototype');
const STATIC = new Map(fs.existsSync(staticDir) ? fs.readdirSync(staticDir).map(n => [`/${n}`, path.join(staticDir, n)]) : []);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

// ---- events: a monotonic id, a short buffer for reconnects, and the open streams
let seq = 412; const buffer = [], streams = new Set(), BUFFER_MAX = 200;
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const cursor = () => `e-${String(seq).padStart(6, '0')}`;
function emit(type, fields = {}) {
  seq += 1;
  const event = { id: cursor(), type, at: nowIso(), ...fields };
  buffer.push(event); if (buffer.length > BUFFER_MAX) buffer.shift();
  for (const res of streams) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  return event;
}
// The mock clock stands still at the fixture time (generated_at is kept), so ages in the fixtures stay true; only the cursor moves.
const stamp = model => ({ ...model, cursor: cursor() });
setInterval(() => emit('heartbeat', { freshness: db.appbar.freshness }), 10000).unref();

// ---- queries
function inboxQuery(q) {
  const all = db.inbox.data.items, text = (q.get('q') || '').toLowerCase();
  const states = (q.get('state') || '').split(',').filter(Boolean), kinds = (q.get('kind') || '').split(',').filter(Boolean);
  const matched = all.filter(i => (!states.length || states.includes(i.state)) && (!kinds.length || kinds.includes(i.kind)) && (!text || `${i.id} ${i.title}`.toLowerCase().includes(text)));
  const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 50)), start = Math.max(0, Number(q.get('cursor')) || 0);
  const items = matched.slice(start, start + limit);
  const count = key => all.reduce((m, i) => { m[i[key]] = (m[i[key]] || 0) + 1; return m; }, {});
  return { ...db.inbox, data: { facets: { state: count('state'), kind: count('kind') }, page: { total: all.length, matched: matched.length, returned: items.length, next_cursor: start + limit < matched.length ? String(start + limit) : null }, items } };
}

// ---- commands
const catalogue = () => new Map(db.meta.data.commands.map(c => [c.name, c]));
const seen = new Map();   // idempotency key -> reply
const refuse = (command, code, text) => ({ status: 409, body: { ok: false, command, outcome: 'refused', audit_id: null, refusal_code: code, refusal_text: text, result: null, undo: null, cursor: cursor() } });
const INBOX_NEXT = { 'inbox.approve': 'approved', 'inbox.reject': 'rejected', 'inbox.undo_decision': 'waiting_for_approval', 'inbox.requeue': 'waiting_for_approval', 'inbox.dismiss': 'done' };
const inboxActions = (id, state) => (state === 'waiting_for_approval'
  ? ['approve', 'reject', 'park'].map((verb, n) => ({ command: `inbox.${verb}`, input: { id }, enabled: true, tier: 'person_only', reversible: true, ...(n === 0 ? { primary: true } : {}) })) : []);

function recount() {
  const waiting = db.inbox.data.items.filter(i => i.state === 'waiting_for_approval').length;
  db.appbar.data.counts.inbox_waiting = waiting;
  const group = db.overview.data.needs_you.find(n => n.id === 'inbox-waiting');
  if (group && waiting) { group.count = waiting; group.title = `${waiting} Inbox item${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} for approval`; }
  if (group && !waiting) db.overview.data.needs_you = db.overview.data.needs_you.filter(n => n !== group);
  db.appbar.data.counts.needs_you = db.overview.data.needs_you.length;
}

// Applies the few commands the prototype shows end to end; every other known command is accepted and audited only.
function apply(name, input, actor) {
  if (name in INBOX_NEXT || name === 'inbox.park' || name === 'inbox.unpark') {
    const item = db.inbox.data.items.find(i => i.id === input.id || i.full_id === input.id);
    if (!item) return { refusal: ['unknown_item', `No Inbox item ${input.id}.`] };
    const before = { state: item.state, parked: item.parked };
    if (name === 'inbox.park' || name === 'inbox.unpark') item.parked = name === 'inbox.park';
    else {
      const allowed = { 'inbox.approve': ['waiting_for_approval'], 'inbox.reject': ['waiting_for_approval'], 'inbox.undo_decision': ['approved', 'rejected'], 'inbox.requeue': ['failed', 'rejected'], 'inbox.dismiss': ['failed'] }[name];
      if (!allowed.includes(item.state)) return { refusal: ['wrong_state', `The item is already ${item.state.replace(/_/g, ' ')}; nothing was changed.`] };
      item.state = INBOX_NEXT[name];
      item.decided_at = item.state === 'waiting_for_approval' ? null : nowIso();
      item.undo_until = ['approved', 'rejected'].includes(item.state) ? new Date(Date.now() + 30000).toISOString().replace(/\.\d+Z$/, 'Z') : null;
      item.attention = item.state === 'waiting_for_approval' ? 'homeowner' : 'none';
      item.actions = inboxActions(item.id, item.state);
    }
    recount();
    const undo = { 'inbox.approve': 'inbox.undo_decision', 'inbox.reject': 'inbox.undo_decision', 'inbox.park': 'inbox.unpark', 'inbox.unpark': 'inbox.park' }[name];
    return { target: { kind: 'inbox_item', key: item.id, label: `Inbox ${item.id}`, title: item.title }, before, after: { state: item.state, parked: item.parked }, state: item.state, attention: item.attention,
      undo: undo ? { command: undo, input: { id: item.id }, until: item.undo_until } : null, models: ['inbox', 'appbar', 'overview', 'audit'] };
  }
  if (name === 'direct_control.set') {
    const before = { enabled: db.appbar.data.direct_control.enabled }, enabled = input.enabled === true;
    for (const holder of [db.appbar.data.direct_control, db.audit.data.direct_control]) Object.assign(holder, { enabled, changed_at: nowIso(), changed_by: actor });
    db.audit.data.direct_control.actions = [{ command: 'direct_control.set', input: { enabled: !enabled }, enabled: true, tier: 'person_only', reversible: true }];
    return { target: null, before, after: { enabled }, state: enabled ? 'on' : 'off', attention: 'none', undo: { command: 'direct_control.set', input: { enabled: before.enabled }, until: null }, models: ['appbar', 'audit'] };
  }
  if (name === 'audit.undo') {
    const entry = db.audit.data.entries.find(e => e.id === input.audit_id);
    if (!entry) return { refusal: ['unknown_entry', `No audit entry ${input.audit_id}.`] };
    if (!entry.undo) return { refusal: ['not_reversible', 'That action cannot be undone.'] };
    if (!entry.undo.available) return { refusal: ['already_undone', 'That action was already undone or its undo window has passed.'] };
    entry.outcome = 'undone'; entry.undo.available = false;
    return { target: entry.target, before: entry.after, after: entry.before, state: 'undone', attention: 'none', undo: null, models: ['audit', 'queue', 'jobs'], undoes: entry };
  }
  if (name === 'agent.refresh_allowance') {
    const fresh = { read_at: nowIso(), age_seconds: 0, stale: false, max_age_seconds: 3600 };
    for (const agent of [...db.appbar.data.agents, ...db.allowance.data.agents.map(a => a.brief)]) if (agent.id === input.agent) {
      agent.reading = fresh;
      if (agent.short.state === 'unknown') agent.short = { state: 'known', used_fraction: 0.02, level: 'normal', resets_at: new Date(Date.now() + 18000000).toISOString().replace(/\.\d+Z$/, 'Z'), window_seconds: 18000, reason_code: null, reason_text: null };
    }
    db.overview.data.faults = db.overview.data.faults.filter(f => !(f.kind === 'stale_reading' && f.target?.key === input.agent));
    db.appbar.data.counts.faults = db.overview.data.faults.length;
    return { target: { kind: 'agent', key: input.agent, label: input.agent }, before: { stale: true }, after: { stale: false }, state: 'fresh', attention: 'none', undo: null, models: ['appbar', 'allowance', 'overview'] };
  }
  return { target: null, before: null, after: null, state: null, attention: 'none', undo: null, models: [], accepted: true };
}

function command(name, body, actor) {
  const spec = catalogue().get(name);
  if (!spec) return { status: 404, body: { ok: false, command: name, outcome: 'refused', audit_id: null, refusal_code: 'unknown_command', refusal_text: `There is no command ${name}.`, result: null, undo: null, cursor: cursor() } };
  const shape = validate('command-request.schema.json', body);
  if (shape.length) return { status: 400, body: { ok: false, command: name, outcome: 'refused', audit_id: null, refusal_code: 'malformed_request', refusal_text: shape.slice(0, 3).join('; '), result: null, undo: null, cursor: cursor() } };
  if (seen.has(body.idempotency_key)) return seen.get(body.idempotency_key);
  const input = body.input, reason = (body.reason || '').trim() || null;
  const audited = (outcome, extra) => {
    const entry = { id: crypto.randomBytes(4).toString('hex'), at: nowIso(), actor, client: actor === 'overseer' ? 'mcp' : 'web', command: name, target: extra.target ?? null, input, reason, before: extra.before ?? null, after: extra.after ?? null,
      outcome, refusal_code: extra.code ?? null, refusal_text: extra.text ?? null, undo: extra.undo ? { ...extra.undo, available: true, undone_by: null } : null };
    db.audit.data.entries.unshift(entry);
    db.audit.data.summary[outcome === 'refused' ? 'refused' : 'applied'] += 1;
    return entry;
  };
  const refused = (code, text) => { const entry = audited('refused', { code, text }); const r = refuse(name, code, text); r.body.audit_id = entry.id; emit('command_applied', { actor, command: name, audit_id: entry.id, models: ['audit'] }); return r; };
  const missing = spec.inputs.filter(i => i.required && input[i.name] === undefined).map(i => i.name);
  if (missing.length) return refused('missing_input', `Missing input: ${missing.join(', ')}.`);
  if ((spec.reason_required || actor === 'overseer') && !reason) return refused('reason_required', 'This command needs a reason; nothing was changed.');
  if (actor === 'overseer' && spec.tier !== 'direct') return refused('needs_homeowner', 'This command needs the homeowner. Propose it instead; nothing was changed.');
  if (actor === 'overseer' && !db.appbar.data.direct_control.enabled) return refused('direct_control_off', 'Direct control is switched off. Propose the action for approval instead; nothing was changed.');
  if (body.dry_run) return { status: 200, body: { ok: true, command: name, outcome: 'no_change', audit_id: null, refusal_code: null, refusal_text: null, result: null, undo: null, cursor: cursor() } };
  const done = apply(name, input, actor);
  if (done.refusal) return refused(done.refusal[0], done.refusal[1]);
  const entry = audited('applied', done);
  if (done.undoes) { done.undoes.undo.undone_by = entry.id; db.audit.data.summary.undone += 1; }
  emit('command_applied', { actor, command: name, audit_id: entry.id, models: done.models });
  const reply = { status: 200, body: { ok: true, command: name, outcome: done.accepted ? 'accepted' : 'applied', audit_id: entry.id, refusal_code: null, refusal_text: null,
    result: done.state ? { ...(done.target ? { target: done.target } : {}), condition: { state: done.state, attention: done.attention, reason_code: null, reason_text: null, since: nowIso() } } : null, undo: done.undo, cursor: cursor() } };
  seen.set(body.idempotency_key, reply);
  return reply;
}

// ---- http
const send = (res, status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'foreman-contract': '1.0' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const notFound = res => send(res, 404, { error: { code: 'not_found', text: 'No such resource in contract v1.' } });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`), p = url.pathname;
  try {
    if (req.method === 'POST' && p.startsWith('/api/v1/commands/')) {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return send(res, 413, { error: { code: 'too_large', text: 'Request too large.' } }); }
      let body; try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: { code: 'malformed_request', text: 'The body is not JSON.' } }); }
      const actor = req.headers['x-foreman-actor'] === 'overseer' ? 'overseer' : 'homeowner';
      const reply = command(p.slice('/api/v1/commands/'.length), body, actor);
      return send(res, reply.status, reply.body);
    }
    if (req.method !== 'GET') return send(res, 405, { error: { code: 'method_not_allowed', text: 'GET, or POST to a command.' } });
    if (p === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      const last = req.headers['last-event-id'] || url.searchParams.get('cursor');
      const hello = { id: cursor(), type: 'hello', at: nowIso(), contract: '1.0' };
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      if (last) {
        const from = buffer.findIndex(e => e.id > last);
        const tooOld = buffer.length && buffer[0].id > last && Number(buffer[0].id.slice(2)) - Number(String(last).slice(2)) > 1;
        if (tooOld) res.write(`event: resync_required\ndata: ${JSON.stringify({ id: cursor(), type: 'resync_required', at: nowIso(), reason_code: 'cursor_too_old' })}\n\n`);
        else if (from >= 0) for (const e of buffer.slice(from)) res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (p === '/api/v1/inbox') return send(res, 200, stamp(inboxQuery(url.searchParams)));
    let m;
    if ((m = /^\/api\/v1\/([a-z]+)$/.exec(p)) && db[m[1]]) return send(res, 200, stamp(db[m[1]]));
    if ((m = /^\/api\/v1\/work-items\/([a-z]+-\d+)$/.exec(p))) {
      const file = path.join(HERE, `work-item-${m[1]}.json`);
      return fs.existsSync(file) ? send(res, 200, stamp(readJson(file))) : notFound(res);
    }
    if ((m = /^\/api\/v1\/schemas\/([a-z-]+\.schema\.json)$/.exec(p)) && schemas[m[1]]) return send(res, 200, schemas[m[1]]);
    if (p === '/api/v1/schemas/validate.mjs') return send(res, 200, fs.readFileSync(path.join(schemaDir, 'validate.mjs')), TYPES['.mjs']);
    if (p === '/api/v1/fixtures/events') return send(res, 200, readJson(path.join(HERE, 'events.json')));
    const file = STATIC.get(p === '/' ? '/index.html' : p);
    if (file) return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    return notFound(res);
  } catch (error) {
    return send(res, 500, { error: { code: 'internal', text: String(error?.message || error).slice(0, 200) } });
  }
}).listen(PORT, HOST, () => console.log(`Foreman mock core (contract 1.0): http://${HOST}:${PORT}/  api: /api/v1/meta  events: /api/v1/events`));
