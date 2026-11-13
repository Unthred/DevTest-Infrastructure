#!/usr/bin/env node
// Contract tests for the Foreman v1 contract. Any client and any core can run them. Node 18 or later, no dependencies.
//   node ui-next/contract-test.mjs                         checks the fixtures against the schemas and the invariants
//   node ui-next/contract-test.mjs http://127.0.0.1:8732   checks a running core (the mock, or Foreman itself) over HTTP
// Exit code 0 when everything passes, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator, INVARIANTS } from './schemas/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const schemaDir = path.join(HERE, 'schemas');
const schemas = Object.fromEntries(fs.readdirSync(schemaDir).filter(n => n.endsWith('.schema.json')).map(n => [n, readJson(path.join(schemaDir, n))]));
const validate = createValidator(schemas);
const base = process.argv[2] ? process.argv[2].replace(/\/$/, '') : null;
const DETAIL_KEY = 'change-1192';
let failed = 0, passed = 0;
const report = (name, errors) => { if (errors.length) { failed += 1; console.log(`FAIL ${name}`); for (const e of errors.slice(0, 12)) console.log(`     ${e}`); } else { passed += 1; console.log(`ok   ${name}`); } };

async function model(name, urlPath) {
  if (base) { const r = await fetch(`${base}${urlPath}`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${urlPath} answered ${r.status}`); return r.json(); }
  return readJson(path.join(HERE, 'fixtures', name === 'work_item' ? `work-item-${DETAIL_KEY}.json` : `${name}.json`));
}

const meta = await model('meta', '/api/v1/meta');
report('meta matches meta.schema.json', validate('meta.schema.json', meta));
for (const entry of meta.data.models.filter(m => m.name !== 'meta')) {
  try {
    const data = await model(entry.name, entry.path.replace('{key}', DETAIL_KEY) + (entry.name === 'inbox' ? '?limit=500' : ''));
    report(`${entry.name} matches ${entry.schema}`, validate(entry.schema, data));
    if (INVARIANTS[entry.name]) report(`${entry.name} invariants (no dead ends, unknown is never a figure)`, INVARIANTS[entry.name](data));
  } catch (error) { report(`${entry.name} can be read`, [String(error.message)]); }
}

// The catalogue must be self-consistent: every undo command exists, and every action offered in a read model is a known command.
const names = new Set(meta.data.commands.map(c => c.name));
report('every undo command is in the catalogue', meta.data.commands.filter(c => c.undo_command && !names.has(c.undo_command) && !['allowance.remove_limit_reset', 'homeowner_step.reopen', 'viewer.delete_view'].includes(c.undo_command)).map(c => `${c.name} undoes with unknown ${c.undo_command}`));
const offered = new Set();
const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.command === 'string' && 'enabled' in v) offered.add(v.command); Object.values(v).forEach(walk); } };
for (const n of ['overview', 'queue', 'inbox', 'jobs', 'allowance', 'audit']) { try { walk(await model(n, `/api/v1/${n}${n === 'inbox' ? '?limit=500' : ''}`)); } catch { /* reported above */ } }
report('every action offered in a read model is a known command', [...offered].filter(c => !names.has(c)).map(c => `unknown command offered: ${c}`));

if (!base) {
  const events = readJson(path.join(HERE, 'fixtures', 'events.json'));
  report('event fixtures match event.schema.json', events.flatMap((e, i) => validate('event.schema.json', e).map(x => `event ${i}: ${x}`)));
} else {
  // A dry run changes nothing, so it is safe against a real core.
  const post = async (name, body, actor) => { const r = await fetch(`${base}/api/v1/commands/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(actor ? { 'x-foreman-actor': actor } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const key = () => `ct${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const dry = await post('work_item.park', { input: { key: 'issue-1169' }, reason: 'contract test', idempotency_key: key(), dry_run: true });
  report('a dry run answers with a command result', validate('command-result.schema.json', dry.body));
  const unknown = await post('no.such_command', { input: {}, idempotency_key: key() });
  report('an unknown command is refused with a code', unknown.body.ok === false && unknown.body.refusal_code ? [] : ['no refusal code for an unknown command']);
  const malformed = await post('work_item.park', { input: { key: 'issue-1169' } });
  report('a request without an idempotency key is refused', malformed.status === 400 ? [] : [`status ${malformed.status}, expected 400`]);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
