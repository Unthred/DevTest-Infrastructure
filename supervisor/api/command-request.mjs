// Issue #1257: reading and checking the body of POST /api/v1/commands/{name}. The shape is command-request.schema.json; the checks here are
// the same rules written as code, because the contract validator only runs in tests. Pure apart from reading the request stream.
import { secretShaped } from '../inbox.mjs';

export const MAX_BODY_BYTES = 16384;
export const MAX_REASON = 500;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const TYPES = { string: value => typeof value === 'string', integer: Number.isInteger, boolean: value => typeof value === 'boolean' };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The body as text, or null when it is over the limit. Reading stops at the first byte over, so a large body is never held.
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const bad = text => ({ code: 'malformed_request', text });

// Returns { request } or { code, text }.
export function parseRequest(text) {
  let body;
  try { body = JSON.parse(text); } catch { return bad('The body is not JSON.'); }
  if (!isObject(body)) return bad('The body must be a JSON object.');
  const unknown = Object.keys(body).find(key => !['input', 'reason', 'idempotency_key', 'dry_run'].includes(key));
  if (unknown) return bad(`The body has an unknown field: ${unknown.slice(0, 40)}.`);
  if (!isObject(body.input)) return bad('input must be an object.');
  if (!(typeof body.reason === 'string' || body.reason === null)) return bad('reason must be a string or null.');
  if (typeof body.reason === 'string' && body.reason.length > MAX_REASON) return bad(`reason is longer than ${MAX_REASON} characters.`);
  if (typeof body.reason === 'string' && secretShaped(body.reason)) return bad('reason looks like it holds a secret; the audit trail would keep it.');
  if (typeof body.idempotency_key !== 'string' || !KEY.test(body.idempotency_key)) return bad('idempotency_key must be 8 to 64 letters, digits, underscore or hyphen.');
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return bad('dry_run must be true or false.');
  return { request: { input: body.input, reason: body.reason, key: body.idempotency_key, dryRun: body.dry_run === true } };
}

// The command's own input list against what was sent: a missing required name is missing_input, an extra name or a wrong type is malformed.
export function checkInput(command, request) {
  const declared = new Map(command.inputs.map(input => [input.name, input]));
  for (const name of Object.keys(request.input)) {
    const spec = declared.get(name);
    if (!spec) return bad(`${command.name} has no input named ${name.slice(0, 40)}.`);
    if (!TYPES[spec.type]?.(request.input[name])) return bad(`input ${name} must be a ${spec.type}.`);
  }
  const missing = command.inputs.find(input => input.required && !Object.hasOwn(request.input, input.name));
  if (missing) return { code: 'missing_input', text: `input ${missing.name} is required.` };
  if (command.reason_required && !String(request.reason ?? '').trim()) return { code: 'reason_required', text: `${command.name} needs a reason.` };
  return null;
}
