// Issue #242: the draft event.v1 JSON Schema (docs/design/squigos/schemas/event.v1.schema.json) against good and bad events.
// The repository has no JSON Schema library, so this file carries a small validator for the keywords the draft uses.
// Secret-shaped fixtures are assembled at runtime from parts, never written literally (issue #142).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../docs/design/squigos/schemas/event.v1.schema.json', import.meta.url), 'utf8'));

const typeOk = (t, v) => ({
  string: typeof v === 'string', boolean: typeof v === 'boolean', number: typeof v === 'number' && Number.isFinite(v),
  integer: Number.isInteger(v), null: v === null, array: Array.isArray(v),
  object: v !== null && typeof v === 'object' && !Array.isArray(v)
})[t];

// Returns a list of { path, keyword } failures; empty means valid.
function check(schema, value, root, path = '') {
  const errs = [];
  const add = (keyword, p = path) => errs.push({ path: p, keyword });
  if (schema.$ref) {
    const target = schema.$ref.slice(2).split('/').reduce((o, k) => o?.[k], root);
    assert.ok(target, `unresolved ${schema.$ref}`);
    errs.push(...check(target, value, root, path));
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) add('const');
  if (schema.enum && !schema.enum.includes(value)) add('enum');
  if (schema.type && ![].concat(schema.type).some(t => typeOk(t, value))) { add('type'); return errs; }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) add('minLength');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) add('maxLength');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) add('pattern');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add('minimum');
    if (schema.maximum !== undefined && value > schema.maximum) add('maximum');
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add('maxItems');
    if (schema.items) value.forEach((v, i) => errs.push(...check(schema.items, v, root, `${path}/${i}`)));
  }
  if (typeOk('object', value)) {
    for (const k of schema.required ?? []) if (!(k in value)) add('required', `${path}/${k}`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...check(s, value[k], root, `${path}/${k}`));
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) add('maxProperties');
    for (const k of Object.keys(value)) {
      if (schema.propertyNames && check(schema.propertyNames, k, root, `${path}/${k}`).length) add('propertyNames', `${path}/${k}`);
      if (!(k in (schema.properties ?? {}))) {
        if (schema.additionalProperties === false) add('additionalProperties', `${path}/${k}`);
        else if (typeof schema.additionalProperties === 'object') errs.push(...check(schema.additionalProperties, value[k], root, `${path}/${k}`));
      }
    }
  }
  if (schema.allOf) for (const s of schema.allOf) errs.push(...check(s, value, root, path));
  if (schema.not && check(schema.not, value, root, path).length === 0) add('not');
  if (schema.oneOf) {
    const results = schema.oneOf.map(s => check(s, value, root, path));
    const passing = results.filter(r => r.length === 0).length;
    if (passing > 1) add('oneOf');
    else if (passing === 0) {
      // Report the branch the event was aiming at: the one whose `type` constant matches. If none does, the type is unknown.
      const aimed = results.filter(r => !r.some(e => e.path === `${path}/type`));
      if (aimed.length === 1) errs.push(...aimed[0]);
      else add('oneOf');
    }
  }
  return errs;
}
const validate = doc => check(SCHEMA, doc, SCHEMA);
const reasons = errs => errs.map(e => `${e.keyword}@${e.path}`);
function assertValid(doc) { assert.deepEqual(reasons(validate(doc)), []); }
function assertInvalid(doc, keyword, path) {
  const errs = validate(doc);
  assert.ok(errs.some(e => e.keyword === keyword && e.path === path), `expected ${keyword}@${path}, got ${JSON.stringify(reasons(errs))}`);
}

const H = '9f3c2ab', M = 'c41d7e0', P = 'b5dd647';
const host = { kind: 'host', id: 'foreman' };
const ev = (n, type, kind, id, payload, extra = {}) => ({
  contract: 'event.v1', id: `01JC0A00000000000000000${String(n).padStart(3, '0')}`, seq: 4100 + n,
  time: '2026-11-03T08:00:00.120Z', subject: { kind, id }, actor: host, type, payload, ...extra
});
const target = { kind: 'host', name: 'foreman' };
// One valid example per event type (the ADR-0012 examples).
const VALID = {
  TaskQueued: ev(1, 'TaskQueued', 'task', 'task:239', { task: 'task:239', title: 'SquigOS ADR draft: event contract', source: 'github-issue', reference: 'issue:239', priority: 'normal' }),
  AgentAssigned: ev(2, 'AgentAssigned', 'run', 'run:r-0192', { task: 'task:239', role: 'implement', adapter: 'claude', model: 'sonnet-5-5', tier: 1 }, { causedBy: '01JC0A00000000000000000001' }),
  RunStarted: ev(3, 'RunStarted', 'run', 'run:r-0192', { task: 'task:239', operation: 'run', adapter: 'claude', model: 'sonnet-5-5', tier: 1, worktree: 'worktrees/claude-239', dedupeKey: 'r-0192:run' }),
  RunFinished: ev(4, 'RunFinished', 'run', 'run:r-0192', { task: 'task:239', outcome: 'ok', exitCode: 0, durationMs: 876560, usage: { inputTokens: 412000, outputTokens: 18400 } }),
  ChecksCompleted: ev(5, 'ChecksCompleted', 'pr', 'pr:470', { task: 'task:239', head: H, result: 'pass', checks: [{ name: 'validate-project', result: 'pass' }, { name: 'unit-tests', result: 'pass' }], evidence: ['evidence/pr-470/9f3c2ab/checks.json'] }, { actor: { kind: 'ci', id: 'validate-project' } }),
  ReviewSubmitted: ev(6, 'ReviewSubmitted', 'pr', 'pr:470', { task: 'task:239', head: H, verdict: 'pass', reviewer: { adapter: 'codex', model: 'gpt-5-codex' }, findings: [] }, { actor: { kind: 'agent', id: 'codex/gpt-5-codex' } }),
  FailureClassified: ev(7, 'FailureClassified', 'run', 'run:r-0197', { task: 'task:240', class: 'provider-usage-limit', retryable: true, summary: 'The provider reported a usage limit; retry after its reset.' }),
  ActionRequired: ev(8, 'ActionRequired', 'card', 'card:c-0031', { action: 'commit.install', onSubject: 'commit:b5dd647', tier: 2, reason: 'No enabled policy entry covers this install.', onReject: 'The commit stays uninstalled; it is not offered again for 24 hours.' }),
  ActionResolved: ev(9, 'ActionResolved', 'card', 'card:c-0031', { decision: 'approved', action: 'commit.install', onSubject: 'commit:b5dd647', tier: 2 }, { actor: { kind: 'human', id: 'homeowner' }, causedBy: '01JC0A00000000000000000008' }),
  Merged: ev(10, 'Merged', 'pr', 'pr:470', { task: 'task:239', head: H, mergeCommit: M, gates: { checks: 'pass', review: 'pass', mergeable: true } }),
  Installed: ev(11, 'Installed', 'install', 'install:i-0044', { commit: M, target, previous: P, result: 'ok' }),
  RolledBack: ev(12, 'RolledBack', 'install', 'install:i-0044', { commit: M, target, restored: P, reason: 'Health check failed after install.' }),
  PolicyActionTaken: ev(13, 'PolicyActionTaken', 'policy', 'policy:release-dead-lease', { entry: 'release-dead-lease', policyVersion: 7, action: 'lease.release', onSubject: 'lease:l-0012', tier: 1 }),
  PolicyRejected: ev(14, 'PolicyRejected', 'policy', 'policy:local-override', { policyVersion: 7, source: 'local-override', rule: 'override-widens-bound', entry: 'retry-after-provider-reset' })
};
const clone = o => structuredClone(o);

test('the schema declares exactly the fourteen ADR-0012 event types', () => {
  const declared = SCHEMA.oneOf.map(b => b.properties.type.const).sort();
  assert.deepEqual(declared, Object.keys(VALID).sort());
});

for (const [type, doc] of Object.entries(VALID)) {
  test(`valid ${type} example passes`, () => assertValid(doc));
}

test('a first-in-chain Installed may have no previous commit; usage and exit code may be null where unknown', () => {
  const i = clone(VALID.Installed); i.payload.previous = null; assertValid(i);
  const r = clone(VALID.RunFinished); r.payload.outcome = 'timeout'; r.payload.exitCode = null; r.payload.usage.costEquivalentUsd = null; assertValid(r);
});

test('invalid: a missing envelope field is rejected, one test per field', () => {
  for (const f of ['contract', 'id', 'seq', 'time', 'subject', 'actor', 'type', 'payload']) {
    const d = clone(VALID.RunStarted); delete d[f];
    const errs = validate(d);
    assert.ok(errs.length > 0, `missing ${f} must fail`);
    if (f !== 'type') assert.ok(errs.some(e => e.keyword === 'required' && e.path === `/${f}`), `${f}: ${JSON.stringify(reasons(errs))}`);
  }
});

test('invalid: a missing payload field is rejected for every event type', () => {
  for (const [type, doc] of Object.entries(VALID)) {
    for (const k of Object.keys(doc.payload).filter(k => k !== 'dedupeKey')) {
      const d = clone(doc); delete d.payload[k];
      assertInvalid(d, 'required', `/payload/${k}`);
    }
    assert.ok(type);
  }
});

test('invalid: unknown type, wrong contract version, unknown envelope key', () => {
  const t = clone(VALID.Merged); t.type = 'Deployed'; assert.ok(validate(t).length > 0);
  const c = clone(VALID.Merged); c.contract = 'event.v2'; assertInvalid(c, 'const', '/contract');
  const e = clone(VALID.Merged); e.extra = 1; assertInvalid(e, 'additionalProperties', '/extra');
});

test('invalid: a type paired with the wrong subject kind is rejected', () => {
  const d = clone(VALID.Merged); d.subject = { kind: 'task', id: 'task:239' }; assertInvalid(d, 'const', '/subject/kind');
  const s = clone(VALID.Merged); s.subject.id = 'commit:470'; assertInvalid(s, 'pattern', '/subject/id');
});

test('invalid: envelope value formats (seq, time, id, actor kind, tier, enums)', () => {
  const m = (base, fn) => { const d = clone(VALID[base]); fn(d); return d; };
  assertInvalid(m('RunStarted', d => { d.seq = 0; }), 'minimum', '/seq');
  assertInvalid(m('RunStarted', d => { d.seq = 1.5; }), 'type', '/seq');
  assertInvalid(m('RunStarted', d => { d.time = '2026-11-03T08:00:00Z'; }), 'pattern', '/time');
  assertInvalid(m('RunStarted', d => { d.time = '2026-11-03T08:00:00.120+01:00'; }), 'pattern', '/time');
  assertInvalid(m('RunStarted', d => { d.id = 'not-an-id'; }), 'pattern', '/id');
  assertInvalid(m('RunStarted', d => { d.causedBy = 'x'; }), 'pattern', '/causedBy');
  assertInvalid(m('RunStarted', d => { d.actor.kind = 'robot'; }), 'enum', '/actor/kind');
  assertInvalid(m('RunStarted', d => { d.payload.tier = 4; }), 'maximum', '/payload/tier');
  assertInvalid(m('RunStarted', d => { d.payload.operation = 'deploy'; }), 'enum', '/payload/operation');
  assertInvalid(m('RunFinished', d => { d.payload.outcome = 'great'; }), 'enum', '/payload/outcome');
  assertInvalid(m('RunFinished', d => { d.payload.durationMs = -1; }), 'minimum', '/payload/durationMs');
  assertInvalid(m('ReviewSubmitted', d => { d.payload.verdict = 'lgtm'; }), 'enum', '/payload/verdict');
  assertInvalid(m('ActionResolved', d => { d.payload.decision = 'maybe'; }), 'enum', '/payload/decision');
  assertInvalid(m('Installed', d => { d.payload.target.kind = 'cloud'; }), 'enum', '/payload/target/kind');
  assertInvalid(m('Merged', d => { d.payload.gates.review = 'fail'; }), 'const', '/payload/gates/review');
  assertInvalid(m('Merged', d => { d.payload.head = 'HEAD'; }), 'pattern', '/payload/head');
});

test('invalid: forbidden payload fields are rejected (raw logs and secret-named fields)', () => {
  for (const key of ['log', 'logs', 'stdout', 'stderr', 'output', 'transcript', 'prompt', 'diff', 'content', 'env', 'secret', 'token', 'password', 'cookie', 'authorization', 'apiKey', 'privateKey', 'unlisted']) {
    const d = clone(VALID.RunFinished); d.payload[key] = '…full command output…';
    assertInvalid(d, 'additionalProperties', `/payload/${key}`);
  }
  // The explicit name guard fires too for the lower-case names.
  const d = clone(VALID.RunFinished); d.payload.log = 'x'; assertInvalid(d, 'propertyNames', '/payload/log');
  // A forbidden field is rejected on every type, not just one.
  for (const doc of Object.values(VALID)) { const x = clone(doc); x.payload.stderr = 'boom'; assertInvalid(x, 'additionalProperties', '/payload/stderr'); }
});

test('invalid: raw output smuggled into an allowed text field is rejected (newlines, over-long text)', () => {
  const d = clone(VALID.FailureClassified); d.payload.summary = 'line one\nline two'; assertInvalid(d, 'pattern', '/payload/summary');
  const l = clone(VALID.FailureClassified); l.payload.summary = 'x'.repeat(301); assertInvalid(l, 'maxLength', '/payload/summary');
  const ok = clone(VALID.FailureClassified); ok.payload.summary = 'x'.repeat(300); assertValid(ok);
  const u = clone(VALID.RunFinished); u.payload.usage.note = 'text'; assertInvalid(u, 'type', '/payload/usage/note');
});

// Secret-shaped values are built here from parts so no literal token exists in the repository.
const fakes = {
  githubToken: () => ['gh', 'p_', 'A1b2C3d4'.repeat(4)].join(''),
  bearer: () => ['Bearer', ' ', 'abcDEF0123456789', 'abcDEF0123456789'].join(''),
  awsKeyId: () => ['AK', 'IA', 'ABCDEFGH', '12345678'].join(''),
  privateKey: () => ['-----', 'BEGIN RSA PRIV', 'ATE KEY', '-----'].join(''),
  jwt: () => ['ey', 'J'.padEnd(12, 'a'), '.', 'b'.repeat(14), '.', 'c'.repeat(10)].join('')
};

test('invalid: secret-shaped values are rejected in text, reference and name fields', () => {
  for (const [name, make] of Object.entries(fakes)) {
    const s = clone(VALID.FailureClassified); s.payload.summary = `The token was ${make()} today`; assertInvalid(s, 'not', '/payload/summary');
    const f = clone(VALID.ActionRequired); f.payload.reason = make(); assertInvalid(f, 'not', '/payload/reason');
    if (/\s/.test(make())) continue; // identifier fields cannot hold whitespace at all
    const r = clone(VALID.TaskQueued); r.payload.reference = make(); assert.ok(validate(r).length > 0, `reference ${name}`);
    const t = clone(VALID.RunStarted); t.payload.adapter = make(); assert.ok(validate(t).length > 0, `adapter ${name}`);
    const k = clone(VALID.RunStarted); k.payload.dedupeKey = make(); assert.ok(validate(k).length > 0, `dedupeKey ${name}`);
  }
});

test('valid: ordinary text that merely mentions secrets is not a false positive', () => {
  const d = clone(VALID.ActionRequired); d.payload.reason = 'Needs a token rotation; a bearer header was not seen. Key sk is short.'; assertValid(d);
});

test('invalid: absolute or escaping paths and non-relative evidence are rejected', () => {
  for (const bad of ['/mnt/user/worktrees/x', '../x', 'a/../b', 'C:\\x', '\\\\host\\share', 'a b']) {
    const d = clone(VALID.RunStarted); d.payload.worktree = bad; assertInvalid(d, 'pattern', '/payload/worktree');
  }
  const e = clone(VALID.ChecksCompleted); e.payload.evidence = ['/abs/checks.json']; assertInvalid(e, 'pattern', '/payload/evidence/0');
});
