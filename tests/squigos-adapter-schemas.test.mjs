// Issue #240: the draft adapter.v1 JSON Schemas (docs/design/squigos/schemas) against good and bad examples.
// The repository has no JSON Schema library, so this file carries a small validator for the keywords the drafts use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const load = f => JSON.parse(fs.readFileSync(new URL(`../docs/design/squigos/schemas/${f}`, import.meta.url), 'utf8'));
const REQ = load('adapter-request.v1.schema.json');
const RES = load('adapter-result.v1.schema.json');

const typeOk = (t, v) => ({
  string: typeof v === 'string', boolean: typeof v === 'boolean', number: typeof v === 'number' && Number.isFinite(v),
  integer: Number.isInteger(v), null: v === null, array: Array.isArray(v),
  object: v !== null && typeof v === 'object' && !Array.isArray(v)
})[t];

// Returns a list of { path, keyword } failures; empty means valid.
function check(schema, value, root, path = '') {
  const errs = [];
  const add = keyword => errs.push({ path, keyword });
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
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add('pattern');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add('minimum');
    if (schema.maximum !== undefined && value > schema.maximum) add('maximum');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add('minItems');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add('maxItems');
    if (schema.items) value.forEach((v, i) => errs.push(...check(schema.items, v, root, `${path}/${i}`)));
    if (schema.contains && !value.some((v, i) => check(schema.contains, v, root, `${path}/${i}`).length === 0)) add('contains');
  }
  if (typeOk('object', value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push({ path: `${path}/${k}`, keyword: 'required' });
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...check(s, value[k], root, `${path}/${k}`));
    if (schema.additionalProperties === false)
      for (const k of Object.keys(value)) if (!(k in (schema.properties ?? {}))) errs.push({ path: `${path}/${k}`, keyword: 'additionalProperties' });
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map(s => check(s, value, root, path));
    const passing = results.filter(r => r.length === 0).length;
    if (passing !== 1) {
      // Report only the branches the document was aiming at: those that do not fail on the top-level `op` discriminator.
      const aimed = results.filter(r => !r.some(e => e.path === `${path}/op`));
      errs.push(...(passing > 1 ? [{ path, keyword: 'oneOf' }] : (aimed.length ? aimed : results).flat()));
    }
  }
  return errs;
}
const validate = (schema, doc) => check(schema, doc, schema);
const reasons = errs => errs.map(e => `${e.keyword}@${e.path}`);
function assertValid(schema, doc) { assert.deepEqual(reasons(validate(schema, doc)), []); }
function assertInvalid(schema, doc, keyword, path) {
  const errs = validate(schema, doc);
  assert.ok(errs.some(e => e.keyword === keyword && e.path === path), `expected ${keyword}@${path}, got ${JSON.stringify(reasons(errs))}`);
}

const SHA = 'a'.repeat(40), RID = i => `01JD8Z3K9Q000000000000000${i}`;
const usage = { inputTokens: 120000, outputTokens: 9000, cachedTokens: 80000, costEquivalentUsd: null };

const runReq = () => ({
  contract: 'adapter.v1', op: 'run', requestId: RID(1),
  task: { ref: 'issue-237', brief: 'Write the ADR.', inScope: ['docs/'], outOfScope: ['code'], allowedPaths: ['docs/**'], changeBudget: { maxFiles: 3, maxChangedLines: 800 } },
  target: { kind: 'git', name: 'devtest-infrastructure' }, riskTier: 1, worktree: '/work/wt', model: 'sonnet',
  timeLimitSeconds: 1800, outputDir: '/work/out', sessionRef: null, answers: []
});
const reviewReq = () => ({
  contract: 'adapter.v1', op: 'review', requestId: RID(2),
  subject: { ref: 'pr-512', headSha: SHA }, issue: { title: 'ADR draft', body: 'Part of #107' }, diff: 'diff --git a/x b/x',
  checkResults: { source: 'host', headSha: SHA, steps: [{ name: 'validate-project', status: 'passed', failures: [] }] },
  riskTier: 1, model: 'opus', timeLimitSeconds: 1200, outputDir: '/work/out'
});
const usageReq = () => ({ contract: 'adapter.v1', op: 'usage', requestId: RID(3) });
const capsReq = () => ({ contract: 'adapter.v1', op: 'capabilities', requestId: RID(4) });

const runRes = () => ({
  contract: 'adapter.v1', op: 'run', requestId: RID(1), status: 'finished', summary: 'Added the ADR.',
  changes: [{ path: 'docs/a.md', why: 'the ADR draft' }], claims: [{ text: 'validate-project passes' }], question: null,
  transcriptRef: 'transcript.jsonl', sessionRef: 'opaque', usage
});
const reviewRes = () => ({ contract: 'adapter.v1', op: 'review', requestId: RID(2), headSha: SHA, verdict: 'approve', findings: [{ kind: 'follow-up', text: 'Link the table.' }], usage });
const usageRes = () => ({
  contract: 'adapter.v1', op: 'usage', requestId: RID(3), metered: true, observedAt: '2026-11-03T10:15:00Z',
  limits: [{ name: 'weekly', used: 0.42, unit: 'fraction', resetsAt: '2026-11-08T09:00:00Z' }, { name: '5h', used: 0.1, unit: 'fraction', resetsAt: null }]
});
const capsRes = () => ({
  contract: 'adapter.v1', op: 'capabilities', requestId: RID(4), adapter: { name: 'claude', version: '1.0.0' },
  operations: ['run', 'review', 'usage', 'capabilities'],
  models: [{ id: 'sonnet', contextTokens: 200000, costTier: 'medium', roles: ['implement', 'review'] }],
  shell: true, resumable: true, trustedForHighRisk: false
});

test('schema files are well-formed drafts with the four operations', () => {
  for (const s of [REQ, RES]) { assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema'); assert.match(s.title, /DRAFT/); }
  for (const k of ['runRequest', 'reviewRequest', 'usageRequest', 'capabilitiesRequest']) assert.ok(REQ.$defs[k], k);
  for (const k of ['runResult', 'reviewResult', 'usageResult', 'capabilitiesResult', 'errorResult']) assert.ok(RES.$defs[k], k);
  // The validator itself must reject, or the valid examples below prove nothing.
  assertInvalid(REQ, {}, 'required', '/op');
});

test('run request: valid, and invalid for the right reason', () => {
  assertValid(REQ, runReq());
  const minimal = runReq(); delete minimal.sessionRef; delete minimal.answers; minimal.task = { ref: 'x', brief: 'y' }; assertValid(REQ, minimal);
  assertInvalid(REQ, { ...runReq(), riskTier: 4 }, 'maximum', '/riskTier');
  assertInvalid(REQ, { ...runReq(), riskTier: 'high' }, 'type', '/riskTier');
  assertInvalid(REQ, { ...runReq(), target: { kind: 'cloud', name: 'x' } }, 'enum', '/target/kind');
  assertInvalid(REQ, { ...runReq(), worktree: 'relative/path' }, 'pattern', '/worktree');
  assertInvalid(REQ, { ...runReq(), githubToken: 'x' }, 'additionalProperties', '/githubToken');
  assertInvalid(REQ, { ...runReq(), contract: 'adapter.v2' }, 'const', '/contract');
  const noTask = runReq(); delete noTask.task; assertInvalid(REQ, noTask, 'required', '/task');
});

test('review request: valid, and invalid for the right reason', () => {
  assertValid(REQ, reviewReq());
  assertInvalid(REQ, { ...reviewReq(), subject: { ref: 'pr-1', headSha: 'abc' } }, 'pattern', '/subject/headSha');
  assertInvalid(REQ, { ...reviewReq(), checkResults: { ...reviewReq().checkResults, source: 'adapter' } }, 'const', '/checkResults/source');
  assertInvalid(REQ, { ...reviewReq(), checkResults: { ...reviewReq().checkResults, steps: [{ name: 'x', status: 'ok', failures: [] }] } }, 'enum', '/checkResults/steps/0/status');
  assertInvalid(REQ, { ...reviewReq(), diff: '' }, 'minLength', '/diff');
  const noIssue = reviewReq(); delete noIssue.issue; assertInvalid(REQ, noIssue, 'required', '/issue');
});

test('usage request: valid, and invalid for the right reason', () => {
  assertValid(REQ, usageReq());
  assertInvalid(REQ, { ...usageReq(), model: 'sonnet' }, 'additionalProperties', '/model');
  assertInvalid(REQ, { ...usageReq(), requestId: 'short' }, 'pattern', '/requestId');
});

test('capabilities request: valid, and invalid for the right reason', () => {
  assertValid(REQ, capsReq());
  assertInvalid(REQ, { ...capsReq(), worktree: '/x' }, 'additionalProperties', '/worktree');
  const noId = capsReq(); delete noId.requestId; assertInvalid(REQ, noId, 'required', '/requestId');
  assertInvalid(REQ, { ...capsReq(), op: 'deploy' }, 'const', '/op');
});

test('run result: finished, failed and needs-input are valid; broken ones fail for the right reason', () => {
  assertValid(RES, runRes());
  assertValid(RES, { contract: 'adapter.v1', op: 'run', requestId: RID(1), status: 'failed', reason: 'limit-reached', summary: 'Usage limit reached.' });
  assertValid(RES, { contract: 'adapter.v1', op: 'run', requestId: RID(1), status: 'needs-input', summary: 'Blocked.', question: { text: 'Which port?', choices: ['80', '8080'] }, sessionRef: 'opaque' });
  // Unknown fields (and so a smuggled riskTier) do not invalidate a result: the host ignores and logs them.
  assertValid(RES, { ...runRes(), riskTier: 0 });
  const noChanges = runRes(); delete noChanges.changes; assertInvalid(RES, noChanges, 'required', '/changes');
  assertInvalid(RES, { ...runRes(), changes: [{ path: 'a.md' }] }, 'required', '/changes/0/why');
  assertInvalid(RES, { contract: 'adapter.v1', op: 'run', requestId: RID(1), status: 'failed', summary: 'x' }, 'required', '/reason');
  assertInvalid(RES, { contract: 'adapter.v1', op: 'run', requestId: RID(1), status: 'needs-input', summary: 'x' }, 'required', '/question');
  assertInvalid(RES, { ...runRes(), status: 'done' }, 'const', '/status'); // no status branch matches
  assertInvalid(RES, { ...runRes(), usage: { inputTokens: -1, outputTokens: 0 } }, 'minimum', '/usage/inputTokens');
});

test('review result: approve/reject rules', () => {
  assertValid(RES, reviewRes());
  assertValid(RES, { ...reviewRes(), verdict: 'approve', findings: [] });
  assertValid(RES, { ...reviewRes(), verdict: 'reject', findings: [{ kind: 'blocking', text: 'AC fails' }, { kind: 'follow-up', text: 'x' }] });
  assertInvalid(RES, { ...reviewRes(), verdict: 'reject', findings: [{ kind: 'follow-up', text: 'x' }] }, 'contains', '/findings');
  assertInvalid(RES, { ...reviewRes(), verdict: 'reject', findings: [] }, 'contains', '/findings');
  assertInvalid(RES, { ...reviewRes(), verdict: 'approve', findings: [{ kind: 'blocking', text: 'x' }] }, 'const', '/findings/0/kind');
  assertInvalid(RES, { ...reviewRes(), verdict: 'PASS' }, 'const', '/verdict');
  assertInvalid(RES, { ...reviewRes(), headSha: 'deadbeef' }, 'pattern', '/headSha');
  const noSha = reviewRes(); delete noSha.headSha; assertInvalid(RES, noSha, 'required', '/headSha');
  assertInvalid(RES, { ...reviewRes(), findings: [{ kind: 'nit', text: 'x' }] }, 'enum', '/findings/0/kind');
});

test('usage result: metered and unmetered shapes', () => {
  assertValid(RES, usageRes());
  assertValid(RES, { contract: 'adapter.v1', op: 'usage', requestId: RID(3), metered: false, limits: [], observedAt: '2026-11-03T10:15:00Z' });
  assertInvalid(RES, { ...usageRes(), metered: false }, 'maxItems', '/limits'); // unmetered must report no limits
  assertInvalid(RES, { ...usageRes(), limits: [{ name: 'w', used: 0.1, unit: 'percent', resetsAt: null }] }, 'enum', '/limits/0/unit');
  assertInvalid(RES, { ...usageRes(), limits: [{ name: 'w', used: -1, unit: 'fraction', resetsAt: null }] }, 'minimum', '/limits/0/used');
  assertInvalid(RES, { ...usageRes(), observedAt: 'yesterday' }, 'pattern', '/observedAt');
  const noMetered = usageRes(); delete noMetered.metered; assertInvalid(RES, noMetered, 'required', '/metered');
});

test('capabilities result: valid, and invalid for the right reason', () => {
  assertValid(RES, capsRes());
  assertInvalid(RES, { ...capsRes(), trustedForHighRisk: 'yes' }, 'type', '/trustedForHighRisk');
  assertInvalid(RES, { ...capsRes(), operations: ['run', 'deploy'] }, 'enum', '/operations/1');
  assertInvalid(RES, { ...capsRes(), models: [{ id: 'x', contextTokens: 0, costTier: 'medium', roles: ['implement'] }] }, 'minimum', '/models/0/contextTokens');
  assertInvalid(RES, { ...capsRes(), adapter: { name: 'claude', version: 'one' } }, 'pattern', '/adapter/version');
  const noRes = capsRes(); delete noRes.resumable; assertInvalid(RES, noRes, 'required', '/resumable');
});

test('error objects for exit codes 2-7 and 70', () => {
  const err = code => ({ contract: 'adapter.v1', op: 'run', requestId: RID(1), error: { code, message: 'short reason' } });
  for (const c of ['bad-request', 'unsupported', 'refused', 'bad-result', 'unavailable', 'timeout', 'internal']) assertValid(RES, err(c));
  assertInvalid(RES, err('ok'), 'enum', '/error/code');
  assertInvalid(RES, { ...err('refused'), error: { code: 'refused' } }, 'required', '/error/message');
});

test('the documented examples in the contract ADR validate', () => {
  const md = fs.readFileSync(new URL('../docs/design/squigos/adr-adapter-contract.md', import.meta.url), 'utf8');
  const docs = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1])).filter(d => d.contract === 'adapter.v1' && !d.error);
  assert.ok(docs.length >= 8, `found ${docs.length} ADR examples`);
  for (const d of docs) assertValid('task' in d || 'subject' in d || (d.op === 'usage' || d.op === 'capabilities') && !('limits' in d) && !('adapter' in d) ? REQ : RES, d);
});
