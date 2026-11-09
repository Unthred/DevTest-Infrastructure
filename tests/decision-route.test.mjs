import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleDecision } from '../supervisor/decision-route.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { allStatuses } from '../supervisor/inbox.mjs';

const temp = () => fs.mkdtempSync(path.join(process.env.TMPDIR, 'decision-route-'));
const invoke = async ({ root, dir, body, at = 1000 }) => {
  const req = { headers: { host: 'dash.test:8080', origin: 'http://dash.test:8080' }, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } };
  const out = {};
  await handleDecision({ req, root, source: () => ({ inbox: { dir } }), allowedHost: 'dash.test:8080', originAllowed: () => true,
    refuseWith: (send, code, title, text) => send(code, 'text/plain', `${title}: ${text}`),
    refuseHost: () => {}, refuseOrigin: () => {}, tooLarge: () => {}, badProof: () => {},
    now: () => at, wake: () => {}, invalidate: () => {}, send: (code, type, body, headers = {}) => Object.assign(out, { code, type, body, headers }) });
  return out;
};

test('decision route records only table actions and leaves invalid requests without an inbox item', async t => {
  const root = temp(), dir = path.join(root, 'inbox');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proof = writeToken(root);
  const valid = await invoke({ root, dir,
    body: new URLSearchParams({ proof, action: 'clear_retry_cap', target: '12', reason: 'the fault is fixed' }).toString() });
  assert.equal(valid.code, 303);
  assert.equal(allStatuses(dir)[0].decisionReason, 'the fault is fixed');
  const invalid = await invoke({ root, dir, at: 2001, body: new URLSearchParams({ proof, action: 'unknown', target: '12', reason: 'x' }).toString() });
  assert.equal(invalid.code, 409);
  assert.equal(allStatuses(dir).length, 1);
});

test('strong actions require the typed pull request number and retain the homeowner override', async t => {
  const root = temp(), dir = path.join(root, 'inbox');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proof = writeToken(root);
  const wrong = await invoke({ root, dir, body: new URLSearchParams({ proof, action: 'merge', target: '12', confirm: '13', reason: 'ready to merge' }).toString() });
  assert.equal(wrong.code, 409);
  const accepted = await invoke({ root, dir, at: 2001, body: new URLSearchParams({ proof, action: 'merge', target: '12', confirm: '12', reason: 'ready to merge' }).toString() });
  assert.equal(accepted.code, 303);
  assert.equal(allStatuses(dir)[0].homeownerOverride, true);
});
