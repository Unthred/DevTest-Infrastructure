// Issue #241: draft JSON Schema for the SquigOS policy file (design only). Valid and invalid policies, incl. tier-3 grants.
// A small validator covers exactly the keywords the schema uses (the repository has no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/design/squigos/schemas/policy.v1.schema.json'), 'utf8'));
const ADR = fs.readFileSync(path.join(ROOT, 'docs/design/squigos/adr-policy-contract.md'), 'utf8');

// Keywords the validator implements; any other schema keyword makes the suite fail instead of being ignored.
const KNOWN = new Set(['$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'const', 'enum', 'not', 'pattern', 'minLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'required', 'properties', 'additionalProperties', 'if', 'then']);
function unknownKeywords(s, where = '$') {
  const out = [];
  for (const [k, v] of Object.entries(s)) {
    if (!KNOWN.has(k)) out.push(`${where}: ${k}`);
    if (['not', 'items', 'if', 'then', 'additionalProperties'].includes(k) && v && typeof v === 'object') out.push(...unknownKeywords(v, `${where}.${k}`));
    if (['properties', '$defs'].includes(k)) for (const [n, x] of Object.entries(v)) out.push(...unknownKeywords(x, `${where}.${k}.${n}`));
  }
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function errorsFor(v, s, where = '$') {
  const out = [];
  if (s.$ref) return errorsFor(v, s.$ref.split('/').reduce((n, k) => (k === '#' ? SCHEMA : n[k]), SCHEMA) , where);
  if ('const' in s && !same(v, s.const)) out.push(`${where}: must equal ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e) => same(e, v))) out.push(`${where}: not in enum`);
  if (s.not && errorsFor(v, s.not, where).length === 0) out.push(`${where}: matches a forbidden form`);
  if (s.type === 'string' || (s.pattern && typeof v === 'string')) {
    if (typeof v !== 'string') out.push(`${where}: must be a string`);
    else {
      if (s.minLength && v.length < s.minLength) out.push(`${where}: too short`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) out.push(`${where}: does not match pattern`);
    }
  }
  if (s.type === 'boolean' && typeof v !== 'boolean') out.push(`${where}: must be a boolean`);
  if (s.type === 'integer') {
    if (!Number.isInteger(v)) out.push(`${where}: must be an integer`);
    else {
      if (s.minimum !== undefined && v < s.minimum) out.push(`${where}: below minimum`);
      if (s.maximum !== undefined && v > s.maximum) out.push(`${where}: above maximum`);
    }
  }
  if (s.type === 'array' || s.items || s.minItems) {
    if (!Array.isArray(v)) { if (s.type === 'array') out.push(`${where}: must be an array`); }
    else {
      if (s.minItems && v.length < s.minItems) out.push(`${where}: too few items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${where}: too many items`);
      if (s.items) v.forEach((x, i) => out.push(...errorsFor(x, s.items, `${where}[${i}]`)));
    }
  }
  const isObj = v && typeof v === 'object' && !Array.isArray(v);
  if (s.type === 'object' && !isObj) out.push(`${where}: must be an object`);
  if (isObj) {
    for (const k of s.required || []) if (!(k in v)) out.push(`${where}: missing "${k}"`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) out.push(...errorsFor(x, s.properties[k], `${where}.${k}`));
      else if (s.additionalProperties === false) out.push(`${where}: unknown field "${k}"`);
    }
  }
  if (s.if && errorsFor(v, s.if, where).length === 0 && s.then) out.push(...errorsFor(v, s.then, where));
  return out;
}
const check = (policy) => errorsFor(policy, SCHEMA);

// The valid example comes from the ADR draft itself, so the two cannot drift apart.
const example = JSON.parse(ADR.match(/## Example policy[\s\S]*?```json\n([\s\S]*?)\n```/)[1]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const withEntry = (patch, base = 'release-dead-lease') => {
  const p = clone(example);
  const e = p.entries.find((x) => x.id === base);
  patch(e, p);
  return p;
};

test('schema is valid JSON with the draft 2020-12 dialect', () => {
  assert.equal(SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('the ADR example policy (tiers 0-2, five entries) is valid', () => {
  assert.equal(example.entries.length, 5);
  assert.deepEqual(check(example), []);
});

test('an empty policy is valid (nothing pre-authorised)', () => {
  assert.deepEqual(check({ contract: 'policy.v1', policyVersion: 1, entries: [] }), []);
});

test('tier 0, 1 and 2 tags are accepted', () => {
  for (const tier of [0, 1]) assert.deepEqual(check(withEntry((e) => { e.tier = tier; })), []);
  // Tier 2 is built from a tier-2 entry, which carries the extra bounds, targets and conditions it needs.
  assert.deepEqual(check(withEntry((e) => { e.tier = 2; }, 'rebase-conflicting-pr')), []);
});

// Strict-mode lint (ajv strictTypes): a keyword that applies to one JSON type needs that type declared in the same subschema.
// Verified once against ajv@8 Ajv2020 {strict: true, strictTypes: true, strictRequired: true}; this keeps it from regressing without a dependency.
function strictTypeProblems(s, where = '$', inherited = null) {
  const out = [];
  const need = (kw, type) => { if (kw.some((k) => k in s) && (s.type ?? inherited) !== type && !(type === 'number' && s.type === 'integer')) out.push(`${where}: needs type ${type}`); };
  need(['properties', 'required', 'additionalProperties'], 'object');
  need(['items', 'minItems', 'maxItems'], 'array');
  need(['pattern', 'minLength'], 'string');
  need(['minimum', 'maximum'], 'number');
  for (const k of s.required || []) if (!s.properties || !(k in s.properties)) out.push(`${where}: required "${k}" not in same-level properties`);
  // not/if/then apply to the same instance, so they inherit the parent's type; items and additionalProperties start fresh.
  for (const k of ['not', 'if', 'then']) if (s[k] && typeof s[k] === 'object') out.push(...strictTypeProblems(s[k], `${where}.${k}`, s.type ?? inherited));
  for (const k of ['items', 'additionalProperties']) if (s[k] && typeof s[k] === 'object') out.push(...strictTypeProblems(s[k], `${where}.${k}`));
  for (const k of ['properties', '$defs']) for (const [n, x] of Object.entries(s[k] || {})) out.push(...strictTypeProblems(x, `${where}.${k}.${n}`));
  return out;
}

test('the schema is strict-mode clean (types declared, required keys defined alongside)', () => {
  assert.deepEqual(strictTypeProblems(SCHEMA), []);
});

test('the schema uses only keywords the test validator implements', () => {
  assert.deepEqual(unknownKeywords(SCHEMA), []);
});

test('hard-limit action synonyms in any namespace are rejected', () => {
  for (const action of ['host.restart', 'vm.reboot', 'machine.reboot', 'secret.rotate', 'token.create', 'openbao.write', 'pr.auto-merge', 'gate.bypass', 'dns.publish', 'tunnel.open', 'ha.config-write', 'ha.automation-update', 'billing-api.enable']) {
    assert.ok(check(withEntry((e) => { e.action = action; })).some((x) => x.includes('.action')), action);
  }
  for (const action of ['lease.release', 'job.retry', 'commit.install', 'pr.rebase', 'issue.file']) {
    assert.deepEqual(check(withEntry((e) => { e.action = action; })), [], action);
  }
});

test('live-system names are an allow-list of non-production names, case-insensitively', () => {
  for (const name of ['Home-Assistant-Production', 'PRODUCTION', 'homeassistant-live', 'home-assistant', 'home-assistant-prod']) {
    assert.ok(check(withEntry((e) => { e.scope.targets = [{ kind: 'live-system', name }]; })).length > 0, name);
  }
  for (const name of ['home-assistant-test', 'ha-sandbox']) {
    assert.deepEqual(check(withEntry((e) => { e.scope.targets = [{ kind: 'live-system', name }]; })), [], name);
  }
});

test('hard-limit paths and conditions are rejected', () => {
  assert.ok(check(withEntry((e) => { e.scope.paths = ['/root/.ssh/**']; })).length > 0);
  assert.ok(check(withEntry((e) => { e.scope.conditions = ['skip-review']; })).length > 0);
});

test('tier 2 rejects wildcard patterns in target names', () => {
  for (const name of ['*', '**', 'repo-*', 'Unthred/*', 'repo-?', 'repo-[ab]', 'Unthred/{a,b}']) {
    assert.ok(check(withEntry((e) => { e.scope.targets = [{ kind: 'git', name }]; }, 'rebase-conflicting-pr')).length > 0, name);
  }
});

test('bounds.window is constrained', () => {
  assert.deepEqual(check(withEntry((e) => { e.bounds.window = { days: ['mon', 'tue'], hours: [8, 18] }; })), []);
  for (const window of [{ days: ['funday'] }, { hours: [8] }, { hours: [8, 30] }, { x: 1 }, 'always']) {
    assert.ok(check(withEntry((e) => { e.bounds.window = window; })).length > 0, JSON.stringify(window));
  }
});

test('entry ids are unique (not expressible in JSON Schema, checked here for the ADR example)', () => {
  const ids = example.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a tier-3 grant is rejected', () => {
  const errs = check(withEntry((e) => { e.tier = 3; }));
  assert.ok(errs.some((x) => x.includes('.tier')), errs.join('\n'));
  assert.ok(check(withEntry((e) => { e.tier = 3; e.action = 'pr.rebase'; }, 'rebase-conflicting-pr')).length > 0);
});

test('tier outside 0-2 or not an integer is rejected', () => {
  for (const tier of [-1, 4, '1', 1.5, null]) assert.ok(check(withEntry((e) => { e.tier = tier; })).length > 0, String(tier));
});

test('hard-limit action classes are rejected', () => {
  for (const action of ['host.reboot', 'ha.service-call', 'pr.merge', 'credential.rotate', 'credential.create', 'billing.enable-overage', 'firewall.open-port', 'exposure.publish', 'remote-access.enable', 'review.bypass']) {
    assert.ok(check(withEntry((e) => { e.action = action; })).some((x) => x.includes('.action')), action);
  }
});

test('a production live-system target is rejected, a non-production one is not', () => {
  const bad = withEntry((e) => { e.scope.targets = [{ kind: 'live-system', name: 'home-assistant-production' }]; });
  assert.ok(check(bad).some((x) => x.includes('name')));
  const ok = withEntry((e) => { e.scope.targets = [{ kind: 'live-system', name: 'home-assistant-test' }]; });
  assert.deepEqual(check(ok), []);
});

test('tier 2 needs maxPerDay, targets, conditions and no wildcard target', () => {
  const id = 'rebase-conflicting-pr';
  assert.ok(check(withEntry((e) => { delete e.bounds.maxPerDay; }, id)).length > 0);
  assert.ok(check(withEntry((e) => { delete e.scope.targets; }, id)).length > 0);
  assert.ok(check(withEntry((e) => { e.scope.conditions = []; }, id)).length > 0);
  assert.ok(check(withEntry((e) => { delete e.scope.conditions; }, id)).length > 0);
  assert.ok(check(withEntry((e) => { e.scope.targets = [{ kind: 'git', name: '*' }]; }, id)).length > 0);
});

test('structure: unknown fields, missing fields, bad contract, bad types', () => {
  assert.ok(check({ ...clone(example), contract: 'policy.v2' }).length > 0);
  assert.ok(check({ ...clone(example), extra: 1 }).length > 0);
  const noEntries = clone(example); delete noEntries.entries;
  assert.ok(check(noEntries).length > 0);
  assert.ok(check({ ...clone(example), policyVersion: 0 }).length > 0);
  assert.ok(check(withEntry((e) => { e.unknown = true; })).length > 0);
  assert.ok(check(withEntry((e) => { delete e.enabled; })).length > 0);
  assert.ok(check(withEntry((e) => { e.id = 'Not Kebab'; })).length > 0);
  assert.ok(check(withEntry((e) => { e.bounds.maxPerHour = 0; })).length > 0);
  assert.ok(check(withEntry((e) => { e.bounds.maxPerHour = 1.5; })).length > 0);
  assert.ok(check(withEntry((e) => { e.scope.targets = [{ kind: 'cloud', name: 'x' }]; })).length > 0);
  assert.ok(check(withEntry((e) => { e.scope.command = 'rm -rf /'; })).length > 0);
  assert.ok(check(withEntry((e) => { e.action = 'rm -rf /'; })).length > 0);
});
