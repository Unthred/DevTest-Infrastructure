// Issue #1257: POST /api/v1/commands/{name}, the one command endpoint. Every reply has the shape of command-result.schema.json and carries
// the new state, so a client updates in place. The checks run in this order: origin and access proof (the dashboard's own write checks,
// through the guard), the command name, the body, the input, a repeated idempotency key, dry_run, and the Inbox cooldown. Command modules are
// found by listing ../commands/; each exports commands, and only their catalogue (without run) is exported here for the meta model.
// Every request that gets past the proof for a known command writes one audit entry and one command_applied event, refused or applied,
// except a dry run (it has no effect) and a repeated key (its reply is the first one, so nothing new happened).
import fs from 'node:fs';
import { append as auditAppend, replayOf, markUndone } from '../audit.mjs';
import { append as appendEvent, newestId } from '../eventlog.mjs';
import { readBody, parseRequest, checkInput } from '../command-request.mjs';
import { INBOX_COOLDOWN_MS } from '../../dashwrite.mjs';

export const name = 'commands';
export const method = 'POST';
export const path = 'commands/{name}';

const COOLDOWN_KEY = 'inbox';
const ACTOR = 'homeowner';
const STATUS = { origin_refused: 403, bad_proof: 403, unknown_command: 404, malformed_request: 400, missing_input: 400, reason_required: 400, cooldown: 429 };

const loadCommands = () => {
  const dir = new URL('../commands/', import.meta.url);
  const found = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) found.push(import(new URL(file, dir)));
  return Promise.all(found).then(mods => mods.flatMap(mod => (Array.isArray(mod.commands) ? mod.commands : [])));
};
const registry = await loadCommands();
export const commands = registry.map(({ run, ...catalogue }) => catalogue);
export const cursor = newestId;

const statusOf = code => STATUS[code] ?? 409;
const refusedReply = (command, code, text, cursorId) => ({
  ok: false, command, outcome: 'refused', audit_id: null, refusal_code: code, refusal_text: text, result: null, undo: null, cursor: cursorId,
});
const appliedReply = (command, done, cursorId) => ({
  ok: true, command, outcome: done.outcome, audit_id: null, refusal_code: null, refusal_text: null,
  result: { target: done.target, condition: done.after }, undo: done.undo ?? null, cursor: cursorId,
});

function send(context, req, res, status, reply) {
  context.reply(req, res, status, 'application/json; charset=utf-8', JSON.stringify(reply), { 'cache-control': 'no-store' });
}

// Writes the audit entry and the event, marks a reversed entry, and drops the prepared view. Returns the reply with its audit_id and cursor.
function record(context, { command, request, reply, status, done }) {
  const { root } = context;
  const at = context.now;
  const refused = !reply.ok;
  const undo = done?.undo ? { ...done.undo, available: true, undone_by: null } : null;
  const remember = request && status !== 429 ? { key: `${command.name}:${request.key}`, status, reply } : null;
  const entry = auditAppend(root, {
    actor: ACTOR, client: 'web', command: command.name, target: done?.target ?? null, input: request?.input ?? null, reason: request?.reason ?? null,
    before: done?.before ?? null, after: done?.after ?? null, outcome: reply.outcome, refusal_code: reply.refusal_code, refusal_text: reply.refusal_text, undo,
  }, at, remember);
  const isUndo = registry.some(other => other.undo_command === command.name);
  if (!refused && isUndo && done?.target) markUndone(root, { undoCommand: command.name, targetKey: done.target.key, byId: entry.id });
  const models = refused ? [] : done.models ?? [];
  appendEvent(root, { type: 'command_applied', actor: ACTOR, command: command.name, audit_id: entry.id, models }, at);
  context.guard.invalidateView();
  return { ...reply, audit_id: entry.id, cursor: newestId(root) };
}

async function execute(context, command, request) {
  const slot = context.guard.reserveCooldown(COOLDOWN_KEY, INBOX_COOLDOWN_MS);
  if (!slot.ok) return { status: 429, reply: refusedReply(command.name, 'cooldown', 'That was too soon after the last decision; wait a second and try again.', newestId(context.root)) };
  const wake = reason => {
    try { context.guard.wake(reason); } catch { /* the schedule is the fallback */ }
  };
  const inboxDir = context.config?.inbox?.dir ?? null;
  const runContext = { now: context.now, root: context.root, inboxDir, reason: request.reason, wake, github: context.github, call: request.key };
  const done = await command.run(request.input, runContext);
  if (done.refusal_code) {
    context.guard.releaseCooldown(COOLDOWN_KEY);
    return { status: 409, reply: refusedReply(command.name, done.refusal_code, done.refusal_text, newestId(context.root)) };
  }
  return { status: 200, reply: appliedReply(command.name, done, newestId(context.root)), done };
}

export async function handle(req, res, context) {
  const commandName = context.params.name;
  const cursorId = () => newestId(context.root);
  const early = (status, code, text) => send(context, req, res, status, refusedReply(commandName, code, text, cursorId()));
  if (!context.guard.originAllowed(req)) return early(403, 'origin_refused', 'The request came from an address that is not allowed. Nothing was changed.');
  if (!context.guard.proofValid(req.headers['x-foreman-proof'])) return early(403, 'bad_proof', 'The access proof was missing or wrong. Nothing was changed.');
  const command = registry.find(candidate => candidate.name === commandName);
  if (!command) return early(404, 'unknown_command', 'No command has that name.');
  const refuse = (code, text) => {
    const reply = record(context, { command, request: null, reply: refusedReply(command.name, code, text, cursorId()), status: statusOf(code) });
    return send(context, req, res, statusOf(code), reply);
  };
  const text = await readBody(req);
  if (text === null) return refuse('malformed_request', 'The body is larger than 16384 bytes.');
  const parsed = parseRequest(text);
  if (!parsed.request) return refuse(parsed.code, parsed.text);
  const { request } = parsed;
  const flaw = checkInput(command, request);
  if (flaw) return refuse(flaw.code, flaw.text);
  const first = replayOf(context.root, `${command.name}:${request.key}`, context.now);
  if (first) return send(context, req, res, first.status, { ...first.reply, cursor: cursorId() });
  if (request.dryRun) {
    const reply = { ...appliedReply(command.name, { outcome: 'no_change', target: null, after: null, undo: null }, cursorId()), result: null };
    return send(context, req, res, 200, reply);
  }
  const { status, reply, done } = await execute(context, command, request);
  return send(context, req, res, status, record(context, { command, request, reply, status, done }));
}
